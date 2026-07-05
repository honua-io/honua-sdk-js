import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type CertificationReport, certify, isReadOnlyTool } from "../../src/certification/certifier.js";
import { checkConformance, checkWellFormed } from "../../src/certification/json-schema.js";
import { renderMarkdown } from "../../src/certification/report.js";
import { writeArtifacts } from "../../src/certification/run.js";
import { loadSchemaFile, loadSchemaIndex } from "../../src/certification/schema-index.js";
import { type CertificationTarget, openCertificationTarget } from "../../src/certification/target.js";

const tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "mcp-cert-"));
  tmpDirs.push(dir);
  return dir;
}

describe("MCP certification harness — offline operator upstream", () => {
  // Certification is a real HTTP round-trip; run it once and assert on the shared report.
  let target: CertificationTarget;
  let report: CertificationReport;

  beforeAll(async () => {
    target = await openCertificationTarget({ HONUA_MCP_CERT_TARGET: "offline" } as NodeJS.ProcessEnv);
    report = await certify({
      client: target.client,
      targetMode: target.mode,
      backend: target.backend,
      surface: target.serverLabel,
      connectUnauthenticated: () => target.connectUnauthenticated(),
    });
  }, 30_000);

  afterAll(async () => {
    await target.close();
    for (const dir of tmpDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("certifies the mock /mcp operator surface with a PASS summary", () => {
    expect(report.summary.pass).toBe(true);
    expect(report.summary.failures).toBe(0);
    // The certified surface is the ~20-tool operator catalog, not the 9-tool static server.
    expect(report.summary.toolsDiscovered).toBeGreaterThanOrEqual(18);
    expect(report.summary.toolsSchemaValid).toBe(report.summary.toolsDiscovered);
    expect(report.protocol.backend).toBe("mock-upstream");
    expect(report.protocol.targetMode).toBe("offline");
  });

  it("advertises output schemas and validates structuredContent for read-only tools", () => {
    for (const tool of report.tools) {
      expect(tool.hasOutputSchema, `${tool.name} outputSchema`).toBe(true);
    }
    expect(report.summary.toolsOutputValidated).toBeGreaterThan(0);
    for (const tool of report.tools) {
      if (tool.readOnly && tool.roundTrip === "passed") {
        expect(tool.structuredOutputValidated, `${tool.name} output validated`).toBe(true);
      }
      expect(tool.roundTrip).not.toBe("failed");
    }
  });

  it("conforms the widened operator tool set to their standard schemas", () => {
    const mapped = report.tools.filter((t) => t.standardName !== null);
    // Many more than the single honua_query_features the old static server matched.
    expect(mapped.length).toBeGreaterThanOrEqual(12);
    for (const tool of mapped) {
      expect(tool.conformant, `${tool.name} conformant`).toBe(true);
    }
    const names = mapped.map((t) => t.name);
    expect(names).toContain("honua_plan_analysis");
    expect(names).toContain("honua_execute_plan");
    expect(names).toContain("honua_dry_run_plan");
    expect(names).toContain("honua_create_map_package");
    expect(names).toContain("honua_publish_service");
  });

  it("passes the pagination, error-shape, and auth contracts", () => {
    expect(report.summary.contractsFailed).toBe(0);
    expect(report.summary.contractsChecked).toBeGreaterThan(0);

    const byContract = (name: string, target2?: string) =>
      report.contracts.find((c) => c.contract === name && (target2 ? c.target === target2 : true));

    expect(byContract("list-pagination", "tools")?.status).toBe("passed");
    expect(byContract("error-shape")?.status).toBe("passed");
    expect(byContract("auth-unauthenticated", "tools/call")?.status).toBe("passed");
    expect(byContract("auth-unauthenticated", "resources/read")?.status).toBe("passed");
  });

  it("discovers operator resources", () => {
    expect(report.resources.length).toBeGreaterThan(0);
    expect(report.resources.map((r) => r.uri)).toContain("honua://results/res-001");
  });

  it("writes JSON and Markdown artifacts describing the operator catalog", () => {
    const dir = makeTmpDir();
    const paths = {
      json: join(dir, "mcp-certification-results.json"),
      markdown: join(dir, "mcp-certification-results.md"),
    };
    writeArtifacts(report, paths);

    const json = JSON.parse(readFileSync(paths.json, "utf8"));
    expect(json.schemaVersion).toBe(2);
    expect(json.summary.pass).toBe(true);

    const md = readFileSync(paths.markdown, "utf8");
    expect(md).toContain("# MCP Certification");
    expect(md).toContain("PASS");
    expect(md).toContain("operator catalog");
    expect(md).toContain("## Contracts");
  });
});

describe("JSON Schema utilities", () => {
  it("accepts well-formed draft-07 and draft 2020-12 schemas", () => {
    const draft07 = { $schema: "http://json-schema.org/draft-07/schema#", type: "object" };
    const draft2020 = loadSchemaFile("tools/query_features.schema.json");
    expect(checkWellFormed(draft07).wellFormed).toBe(true);
    expect(checkWellFormed(draft2020).wellFormed).toBe(true);
  });

  it("rejects a malformed schema", () => {
    const bad = { type: 123 };
    expect(checkWellFormed(bad).wellFormed).toBe(false);
    expect(checkWellFormed(null).wellFormed).toBe(false);
  });

  it("flags a missing required standard property as non-conformant", () => {
    const standard = loadSchemaFile("tools/query_features.schema.json");
    const advertised = { type: "object", properties: { serviceId: { type: "string" } } };
    const result = checkConformance(advertised, standard);
    expect(result.conformant).toBe(false);
    expect(result.violations.join(" ")).toContain("layerId");
  });

  it("treats integer as compatible with a standard number", () => {
    const standard = { type: "object", required: ["n"], properties: { n: { type: "number" } } };
    const advertised = { type: "object", properties: { n: { type: "integer" } } };
    expect(checkConformance(advertised, standard).conformant).toBe(true);
  });
});

describe("conformance edge cases", () => {
  it("flags an incompatible required property type as non-conformant", () => {
    const standard = { type: "object", required: ["layerId"], properties: { layerId: { type: "integer" } } };
    const advertised = { type: "object", properties: { layerId: { type: "string" } } };
    const result = checkConformance(advertised, standard);
    expect(result.conformant).toBe(false);
    expect(result.violations.join(" ")).toContain("incompatible");
  });

  it("records advertised-only properties as informational notes", () => {
    const standard = { type: "object", required: ["a"], properties: { a: { type: "string" } } };
    const advertised = { type: "object", properties: { a: { type: "string" }, extra: { type: "number" } } };
    const result = checkConformance(advertised, standard);
    expect(result.conformant).toBe(true);
    expect(result.notes.join(" ")).toContain("extra");
  });
});

describe("read-only classification", () => {
  it("honors an explicit readOnlyHint annotation", () => {
    expect(isReadOnlyTool({ name: "honua_anything", annotations: { readOnlyHint: false } })).toBe(false);
    expect(isReadOnlyTool({ name: "honua_delete_thing", annotations: { readOnlyHint: true } })).toBe(true);
  });

  it("treats mutation-shaped names as not read-only by default", () => {
    expect(isReadOnlyTool({ name: "honua_create_map_package" })).toBe(false);
    expect(isReadOnlyTool({ name: "honua_propose_operation" })).toBe(false);
    expect(isReadOnlyTool({ name: "honua_query_features" })).toBe(true);
  });
});

describe("markdown rendering", () => {
  it("renders a FAIL report with a tool-failures section and contracts", () => {
    const md = renderMarkdown({
      schemaVersion: 2,
      generatedAt: "2026-07-05T00:00:00.000Z",
      server: { name: "honua", version: "0.0.0" },
      protocol: {
        mcpTransport: "streamable-http",
        honuaTransport: "rest",
        backend: "live",
        targetMode: "remote",
        surface: "live honua /mcp",
      },
      standard: { source: "x", indexDate: "2026-06-21", dialect: "draft-2020-12" },
      summary: {
        pass: false,
        toolsDiscovered: 1,
        toolsSchemaValid: 0,
        toolsConformanceChecked: 1,
        toolsConformant: 0,
        toolsRoundTripped: 0,
        toolsOutputValidated: 0,
        resourcesDiscovered: 0,
        promptsDiscovered: 0,
        contractsChecked: 1,
        contractsPassed: 0,
        contractsFailed: 1,
        knownGaps: 0,
        failures: 2,
      },
      tools: [
        {
          name: "honua_bad",
          discovered: true,
          schemaValid: false,
          hasOutputSchema: false,
          standardName: "query_features",
          conformant: false,
          readOnly: true,
          roundTrip: "failed",
          structuredOutputValidated: false,
          errors: ["inputSchema not well-formed: boom"],
          notes: [],
        },
      ],
      resources: [],
      prompts: [],
      contracts: [{ contract: "error-shape", target: "honua_bad", status: "failed", detail: "kaboom" }],
      knownGaps: [],
    });
    expect(md).toContain("FAIL");
    expect(md).toContain("### Tool failures");
    expect(md).toContain("boom");
    expect(md).toContain("## Contracts");
    expect(md).toContain("kaboom");
    expect(md).toContain("Honua transport: `rest`");
  });
});

describe("vendored schema index", () => {
  it("maps reference tool names and aliases to standard schemas", () => {
    const index = loadSchemaIndex();
    const queryFeatures = index.tools.find((t) => t.standardName === "query_features");
    expect(queryFeatures?.referenceToolName).toBe("honua_query_features");
    expect(queryFeatures?.implementationStatus).toBe("implemented");

    const validate = index.tools.find((t) => t.standardName === "validate_plan");
    expect(validate?.referenceToolAliases).toContain("honua_dry_run_plan");

    // Publishing / composition tools are now mapped to reference names (widened).
    expect(index.tools.find((t) => t.standardName === "publish_result")?.referenceToolName).toBe(
      "honua_publish_service",
    );
    expect(index.tools.find((t) => t.standardName === "create_map_package")?.referenceToolName).toBe(
      "honua_create_map_package",
    );
  });
});
