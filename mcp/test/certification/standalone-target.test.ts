import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type CertificationReport, certify } from "../../src/certification/certifier.js";
import { type CertificationTarget, openCertificationTarget } from "../../src/certification/target.js";

/**
 * Platform-free certification lane (issue #369, REQ-002).
 *
 * Certify the standalone `honua-mcp` surface against an in-process fixture of a
 * PLAIN public FeatureServer (recorded census layer, no Honua surfaces). The
 * acceptance bar: MCP tools certify GREEN with HONEST skips — no crashes, no
 * misleading empty data. Fixture-backed and deterministic: no network.
 */
describe("MCP certification — platform-free standalone target", () => {
  let target: CertificationTarget;
  let report: CertificationReport;

  beforeAll(async () => {
    target = await openCertificationTarget({ HONUA_MCP_CERT_TARGET: "standalone" } as NodeJS.ProcessEnv);
    report = await certify({
      client: target.client,
      targetMode: target.mode,
      backend: target.backend,
      surface: target.serverLabel,
      authMode: target.authMode,
      env: {} as NodeJS.ProcessEnv,
    });
  }, 30_000);

  afterAll(async () => {
    await target.close();
  });

  it("certifies the standalone surface GREEN (no failures)", () => {
    expect(report.protocol.targetMode).toBe("standalone");
    expect(report.summary.failures).toBe(0);
    expect(report.summary.pass).toBe(true);
  });

  it("discovers the nine standalone tools including the read-only query tool", () => {
    const names = report.tools.map((t) => t.name);
    expect(names).toContain("honua_query_features");
    expect(names).toContain("honua_count_features");
    expect(names).toContain("honua_get_style");
    expect(report.summary.toolsDiscovered).toBeGreaterThanOrEqual(9);
  });

  it("round-trips the working data tools against real recorded census data", () => {
    const roundTripped = report.tools.filter((t) => t.roundTrip === "passed").map((t) => t.name);
    expect(roundTripped).toContain("honua_count_features");
    expect(roundTripped).toContain("honua_query_features");
    expect(roundTripped).toContain("honua_statistics");
  });

  it("keeps honua_query_features conformant with the standard schema", () => {
    const query = report.tools.find((t) => t.name === "honua_query_features");
    expect(query?.conformant).toBe(true);
  });

  it("degrades the Honua-only style tools to a non-error result (not a crash)", () => {
    const getStyle = report.tools.find((t) => t.name === "honua_get_style");
    const applyStyle = report.tools.find((t) => t.name === "honua_apply_style_preset");
    // Round-trip is exercised and returns a structured, NON-error result.
    expect(getStyle?.roundTrip).toBe("passed");
    expect(applyStyle?.roundTrip).toBe("passed");
    expect(getStyle?.errors).toEqual([]);
    expect(applyStyle?.errors).toEqual([]);
  });

  it("skips the auth + mutation contracts with an explicit reason (honest skips)", () => {
    const skipped = report.contracts.filter((c) => c.status === "skipped");
    expect(skipped.length).toBeGreaterThan(0);
    for (const contract of skipped) {
      expect(contract.detail.length).toBeGreaterThan(0);
    }
    const auth = report.contracts.find((c) => c.contract === "auth-unauthenticated");
    expect(auth?.status).toBe("skipped");
  });

  it("records provenance for the platform-free surface", () => {
    expect(report.provenance.authMode).toBe("anonymous");
    expect(report.provenance.targetUrl).toContain("plain public FeatureServer");
  });
});
