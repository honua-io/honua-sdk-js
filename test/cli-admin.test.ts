import { afterEach, describe, expect, it, vi } from "vitest";

import { run } from "../src/cli/main.js";

afterEach(() => vi.restoreAllMocks());

function capture() {
  const output: string[] = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    output.push(String(chunk));
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    output.push(String(chunk));
    return true;
  });
  return output;
}

describe("honua admin", () => {
  it("lists the generated operation inventory without contacting a server", async () => {
    const output = capture();
    expect(await run(["admin", "operations", "connect"])).toBe(0);
    const parsed = JSON.parse(output.join("")) as Array<{ operationId: string; group: string }>;
    expect(parsed.length).toBeGreaterThan(0);
    expect(parsed.every((entry) => entry.group === "connect")).toBe(true);
    expect(parsed.some((entry) => entry.operationId === "createConnection")).toBe(true);
  });

  it("prints a deterministic dry-run for a mutating grouped operation", async () => {
    const output = capture();
    const code = await run([
      "admin",
      "connect",
      "createConnection",
      "--body",
      '{"name":"local"}',
      "--dry-run",
      "--json",
    ]);
    expect(code).toBe(0);
    expect(JSON.parse(output.join(""))).toMatchObject({
      operationId: "createConnection",
      method: "POST",
      executed: false,
      request: { body: { name: "local" } },
    });
  });

  it("requires --yes before a mutating request", async () => {
    const output = capture();
    const code = await run([
      "admin",
      "api",
      "createConnection",
      "--base-url",
      "https://example.test",
      "--body",
      '{"name":"local"}',
    ]);
    expect(code).toBe(2);
    expect(output.join("")).toContain("--yes");
  });

  it("rejects a grouped spelling when the operation belongs elsewhere", async () => {
    const output = capture();
    expect(await run(["admin", "secure", "createConnection", "--dry-run"])).toBe(2);
    expect(output.join("")).toContain("belongs to the connect group");
  });
});
