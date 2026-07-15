import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { run } from "../src/cli/main.js";

function captureStdout(): { text: () => string; restore: () => void } {
  const lines: string[] = [];
  const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    lines.push(String(chunk));
    return true;
  });
  return { text: () => lines.join(""), restore: () => spy.mockRestore() };
}

function captureStderr(): { text: () => string; restore: () => void } {
  const lines: string[] = [];
  const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    lines.push(String(chunk));
    return true;
  });
  return { text: () => lines.join(""), restore: () => spy.mockRestore() };
}

describe("honua explain (plan consumer)", () => {
  let cap: ReturnType<typeof captureStdout>;
  let errCap: ReturnType<typeof captureStderr>;
  beforeEach(() => {
    cap = captureStdout();
    errCap = captureStderr();
  });
  afterEach(() => {
    cap.restore();
    errCap.restore();
  });

  it("explains a GeoServices query into a full-pushdown plan without contacting a server", async () => {
    const code = await run(["explain", "incidents/0", "--where", "status = 'open'", "--json"], {
      baseUrl: "https://demo.honua.io/FeatureServer",
    });
    expect(code).toBe(0);
    const plan = JSON.parse(cap.text());
    expect(plan.kind).toBe("honua.query-plan");
    expect(plan.pushdown).toBe("full");
    expect(plan.steps[0].compiled.compiler).toBe("geoservices-rest-query-v1");
    expect(plan.steps[0].compiled.where).toBe("status = 'open'");
    expect(plan.fingerprint).toMatch(/^sha256:/);
  });

  it("explains an opaque DuckDB/GeoParquet plan without printing a locator", async () => {
    const code = await run([
      "explain",
      "parcels:current",
      "--protocol",
      "geoparquet",
      "--resolver",
      "io.honua.cli-test",
      "--authorization-context",
      "tenant:alpha/role:analyst",
      "--resource-version",
      "snapshot:42",
      "--capabilities",
      "query",
      "--where",
      "pop > 5",
      "--json",
    ]);
    expect(code).toBe(0);
    const plan = JSON.parse(cap.text());
    expect(plan.version).toBe("2.0");
    expect(plan.ir.source).toMatchObject({ id: "parcels:current", endpoint: "[opaque-resource]" });
    expect(plan.steps[0].compiled.compiler).toBe("duckdb-sql-v2");
    expect(plan.steps[0].compiled.sqlTemplate).toContain("honua-resource://resolve-at-execution");
  });

  it("rejects credential-shaped GeoParquet positional ids without echoing them", async () => {
    const marker = "cli-signature-secret";
    const code = await run([
      "explain",
      `https://data.example.test/parcels.parquet?X-Amz-Signature=${marker}`,
      "--protocol",
      "geoparquet",
      "--json",
    ]);
    expect(code).toBe(2);
    expect(`${cap.text()}${errCap.text()}`).not.toContain(marker);
  });

  it("renders a human summary with stages and fingerprint by default", async () => {
    const code = await run(["explain", "incidents/0"], { baseUrl: "https://demo.honua.io/FeatureServer" });
    expect(code).toBe(0);
    const text = cap.text();
    expect(text).toContain("remote/query");
    expect(text).toContain("compiled: geoservices-rest-query-v1");
    expect(text).toContain("fingerprint: sha256:");
  });

  it("exits with an argument error for an unknown protocol", async () => {
    const code = await run(["explain", "x/0", "--protocol", "nope"]);
    expect(code).toBe(2);
  });
});
