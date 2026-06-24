import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { certify, isReadOnlyTool } from "../../src/certification/certifier.js";
import { createFixtureClient } from "../../src/certification/fixture-client.js";
import { checkConformance, checkWellFormed } from "../../src/certification/json-schema.js";
import { renderMarkdown } from "../../src/certification/report.js";
import { runCertification, writeArtifacts } from "../../src/certification/run.js";
import { loadSchemaFile, loadSchemaIndex } from "../../src/certification/schema-index.js";
import { createServer } from "../../src/index.js";

const tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "mcp-cert-"));
  tmpDirs.push(dir);
  return dir;
}

describe("MCP certification harness", () => {
  it("certifies the fixture-backed server with a PASS summary", async () => {
    const server = createServer(createFixtureClient());
    const report = await certify({ server, backend: "fixture" });

    expect(report.summary.pass).toBe(true);
    expect(report.summary.failures).toBe(0);
    expect(report.summary.toolsDiscovered).toBeGreaterThan(0);
    // Every advertised tool must expose a well-formed inputSchema.
    expect(report.summary.toolsSchemaValid).toBe(report.summary.toolsDiscovered);
  });

  it("round-trips every read-only tool with a fixture input", async () => {
    const server = createServer(createFixtureClient());
    const report = await certify({ server, backend: "fixture" });

    for (const tool of report.tools) {
      if (tool.readOnly) {
        expect(tool.roundTrip, `${tool.name} round-trip`).toBe("passed");
      }
      // Certification must never report a write/destructive round-trip.
      expect(tool.roundTrip).not.toBe("failed");
    }
  });

  it("conforms honua_query_features to the standard query_features schema", async () => {
    const server = createServer(createFixtureClient());
    const report = await certify({ server, backend: "fixture" });

    const queryFeatures = report.tools.find((t) => t.name === "honua_query_features");
    expect(queryFeatures).toBeDefined();
    expect(queryFeatures?.standardName).toBe("query_features");
    expect(queryFeatures?.conformant).toBe(true);
  });

  it("records known gaps for unimplemented standard tools without failing", async () => {
    const server = createServer(createFixtureClient());
    const report = await certify({ server, backend: "fixture" });

    expect(report.summary.knownGaps).toBeGreaterThan(0);
    const standardGap = report.knownGaps.find((g) => g.kind === "standard-tool" && g.name === "render_map");
    expect(standardGap).toBeDefined();
    // Absence of a standard tool is a recorded gap, not a failure.
    expect(report.summary.pass).toBe(true);
  });

  it("discovers MCP resources", async () => {
    const server = createServer(createFixtureClient());
    const report = await certify({ server, backend: "fixture" });

    expect(report.resources.length).toBeGreaterThan(0);
    expect(report.resources.map((r) => r.uri)).toContain("honua://services");
  });

  it("writes JSON and Markdown artifacts to a stable location", async () => {
    const dir = makeTmpDir();
    const report = await runCertification({ forceFixture: true });
    const paths = {
      json: join(dir, "mcp-certification-results.json"),
      markdown: join(dir, "mcp-certification-results.md"),
    };
    writeArtifacts(report, paths);

    const json = JSON.parse(readFileSync(paths.json, "utf8"));
    expect(json.schemaVersion).toBe(1);
    expect(json.summary.pass).toBe(true);

    const md = readFileSync(paths.markdown, "utf8");
    expect(md).toContain("# MCP Certification");
    expect(md).toContain("PASS");
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
    expect(isReadOnlyTool({ name: "honua_query_features" })).toBe(true);
  });
});

describe("markdown rendering", () => {
  it("renders a FAIL report with a failures section", () => {
    const md = renderMarkdown({
      schemaVersion: 1,
      generatedAt: "2026-06-21T00:00:00.000Z",
      server: { name: "honua", version: "0.0.0" },
      protocol: { mcpTransport: "in-memory", honuaTransport: "rest", backend: "live" },
      standard: { source: "x", indexDate: "2026-06-21", dialect: "draft-2020-12" },
      summary: {
        pass: false,
        toolsDiscovered: 1,
        toolsSchemaValid: 0,
        toolsConformanceChecked: 1,
        toolsConformant: 0,
        toolsRoundTripped: 0,
        resourcesDiscovered: 0,
        promptsDiscovered: 0,
        knownGaps: 0,
        failures: 1,
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
          errors: ["inputSchema not well-formed: boom"],
          notes: [],
        },
      ],
      resources: [],
      prompts: [],
      knownGaps: [],
    });
    expect(md).toContain("FAIL");
    expect(md).toContain("### Failures");
    expect(md).toContain("boom");
    expect(md).toContain("transport: `rest`");
  });
});

describe("vendored schema index", () => {
  it("maps reference tool names to standard schemas", () => {
    const index = loadSchemaIndex();
    const queryFeatures = index.tools.find((t) => t.standardName === "query_features");
    expect(queryFeatures?.referenceToolName).toBe("honua_query_features");
    expect(queryFeatures?.implementationStatus).toBe("implemented");
  });
});
