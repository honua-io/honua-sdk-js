import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CLI_VERSION, run } from "../src/cli/main.js";

function captureStdout(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    lines.push(String(chunk));
    return true;
  });
  return { lines, restore: () => spy.mockRestore() };
}

describe("run() dispatch", () => {
  let cap: ReturnType<typeof captureStdout>;
  beforeEach(() => {
    cap = captureStdout();
  });
  afterEach(() => {
    cap.restore();
  });

  it("prints help and exits 0 with no command", async () => {
    const code = await run([]);
    expect(code).toBe(0);
    expect(cap.lines.join("")).toContain("USAGE");
  });

  it("prints version", async () => {
    const code = await run(["--version"]);
    expect(code).toBe(0);
    expect(cap.lines.join("")).toContain(CLI_VERSION);
  });

  it("returns exit code 2 for an unknown command", async () => {
    // Diagnostics belong on stderr so stdout remains usable for command output
    // and machine-readable pipelines.
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const code = await run(["frobnicate"]);
      expect(code).toBe(2);
      expect(stderr).toHaveBeenCalledWith(expect.stringContaining("Unknown command: frobnicate"));
    } finally {
      stderr.mockRestore();
    }
  });

  it("returns exit code 2 for an unknown flag on a real command", async () => {
    const code = await run(["services", "--bogus"]);
    expect(code).toBe(2);
  });

  it("writes parser errors to stderr", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    await run(["services", "--bogus"]);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining("error: Unknown option"));
  });

  it("shows command help without contacting a server", async () => {
    const code = await run(["query", "--help"]);
    expect(code).toBe(0);
    expect(cap.lines.join("")).toContain("USAGE");
  });
});
