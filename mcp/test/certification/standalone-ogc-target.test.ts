import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type CertificationReport, certify } from "../../src/certification/certifier.js";
import { type CertificationTarget, openCertificationTarget } from "../../src/certification/target.js";

/**
 * NON-GeoServices certification lane (issue #1005, REQ-003).
 *
 * The `standalone` lane proves the surface works against a plain Esri
 * FeatureServer. This one runs the SAME tool catalog against a plain OGC API
 * Features endpoint (recorded pygeoapi collections) where nothing Esri exists:
 * no `/rest/services`, no `serviceId`, no `layerId`. A tool that still secretly
 * required GeoServices addressing cannot pass here.
 *
 * The acceptance bar is identical: certify GREEN with honest skips, and degrade
 * — never crash, never return misleading empty data.
 */
describe("MCP certification — non-GeoServices (OGC API Features) target", () => {
  let target: CertificationTarget;
  let report: CertificationReport;

  beforeAll(async () => {
    target = await openCertificationTarget({ HONUA_MCP_CERT_TARGET: "standalone-ogc" } as NodeJS.ProcessEnv);
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

  it("certifies the non-GeoServices surface GREEN (no failures)", () => {
    expect(report.protocol.targetMode).toBe("standalone-ogc");
    expect(report.summary.failures).toBe(0);
    expect(report.summary.pass).toBe(true);
  });

  it("round-trips the full tool catalog against an endpoint with no Esri surface", () => {
    const roundTripped = report.tools.filter((t) => t.roundTrip === "passed").map((t) => t.name);
    for (const tool of [
      "honua_list_sources",
      "honua_describe_layer",
      "honua_query_features",
      "honua_count_features",
      "honua_get_extent",
      "honua_statistics",
    ]) {
      expect(roundTripped, `${tool} did not round-trip`).toContain(tool);
    }
  });

  it("keeps honua_query_features conformant with the standard schema", () => {
    const query = report.tools.find((t) => t.name === "honua_query_features");
    expect(query?.conformant).toBe(true);
  });

  it("advertises schemas with no required Esri-only field", () => {
    for (const tool of report.tools) {
      expect(tool.schemaValid, `${tool.name} advertises a malformed inputSchema`).toBe(true);
    }
  });

  it("emits a structured validation envelope for an invalid argument set", () => {
    const errorShape = report.contracts.find((c) => c.contract === "error-shape");
    expect(errorShape?.status).toBe("passed");
  });

  it("records provenance naming the recorded OGC endpoint", () => {
    expect(report.provenance.authMode).toBe("anonymous");
    expect(report.provenance.targetUrl).toContain("OGC API Features");
  });
});
