import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runLlmSmoke } from "../../src/eval/llm-smoke-cli.js";
import { runEval } from "../../src/eval/runner.js";

const env = {
  HONUA_BASE_URL: "http://localhost:5000",
  HONUA_TRANSPORT: "rest",
  HONUA_SERVICE_ID: "test_service",
  HONUA_LAYER_ID: "0",
  HONUA_API_KEY: "fixture-key",
  HONUA_EVAL_BEDROCK: "1",
};

describe("MCP LLM smoke", () => {
  const directories: string[] = [];
  function outputDirectory() {
    const dir = mkdtempSync(join(tmpdir(), "honua-mcp-llm-smoke-"));
    directories.push(dir);
    return dir;
  }

  afterEach(() => {
    vi.unstubAllGlobals();
    for (const dir of directories.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each([
    { name: "legacy arguments", pass: true },
    { name: "canonical source", pass: true, source: "geoservices-feature-service:test_service/0" },
    { name: "equivalent source", pass: true, source: "geoservices-feature-service:test_service/00" },
    { name: "different layer", pass: false, source: "geoservices-feature-service:test_service/1" },
    { name: "missing schema", pass: false, missingSchema: true },
    { name: "empty final answer", pass: false, answer: "" },
    { name: "incorrect final answer", pass: false, answer: "The layer has no objectid field." },
    { name: "driver failure", pass: false, driverError: "stubbed model failure" },
  ])("checks the seeded layer and model answer ($name)", async (fixture) => {
    const outDir = outputDirectory();
    const fetch = vi.fn(async (url: URL, init?: RequestInit) => {
      expect(new URL(url).pathname).toMatch(/^\/rest\/services\/test_service\/FeatureServer\/[01]$/);
      expect(new Headers(init?.headers).get("x-api-key")).toBe(env.HONUA_API_KEY);
      return Response.json({
        id: 0,
        name: "Seeded layer",
        fields: fixture.missingSchema ? [] : [{ name: "objectid", type: "esriFieldTypeOID" }],
      });
    });
    vi.stubGlobal("fetch", fetch);

    const result = await runLlmSmoke(env, outDir, async (options) => {
      const [control, bedrock] = options.drivers ?? [];
      expect(bedrock.vendor).toBe("bedrock");
      return runEval({
        ...options,
        drivers: [
          control,
          {
            id: bedrock.id,
            vendor: "bedrock",
            isAvailable: () => true,
            async runWorkflow(scenario, ctx) {
              expect(ctx.tools.map((tool) => tool.name)).toEqual(["honua_describe_layer"]);
              const transcript = await control.runWorkflow(
                fixture.source
                  ? { ...scenario, script: [{ tool: "honua_describe_layer", args: { source: fixture.source } }] }
                  : scenario,
                ctx,
              );
              return {
                ...transcript,
                modelId: bedrock.id,
                finalAnswer: fixture.answer ?? "objectid",
                driverError: fixture.driverError,
              };
            },
          },
        ],
      });
    });

    expect(result).toBe(fixture.pass);
    expect(fetch).toHaveBeenCalledTimes(fixture.name === "different layer" ? 2 : 1);
    const report = JSON.parse(readFileSync(join(outDir, "llm-smoke-results.json"), "utf8"));
    expect(report).toMatchObject({ pass: fixture.pass });
    expect(readFileSync(join(outDir, "llm-smoke-results.md"), "utf8")).toContain(fixture.pass ? "PASS" : "FAIL");
    expect(readFileSync(join(outDir, "llm-smoke-transcripts", "bedrock.json"), "utf8")).toContain("MODEL_SELECTED");
    expect(readFileSync(join(outDir, "llm-smoke-transcripts", "control.json"), "utf8")).toContain("HARNESS_DRIVEN");
  });

  it("fails before evaluating when Bedrock is disabled", async () => {
    const outDir = outputDirectory();
    const transcriptDir = join(outDir, "llm-smoke-transcripts");
    mkdirSync(transcriptDir);
    for (const filename of ["bedrock.json", "control.json"]) {
      writeFileSync(join(transcriptDir, filename), "{}");
    }
    const evaluate = vi.fn();
    expect(await runLlmSmoke({ ...env, HONUA_EVAL_BEDROCK: "disabled" }, outDir, evaluate)).toBe(false);
    expect(evaluate).not.toHaveBeenCalled();
    expect(existsSync(join(transcriptDir, "bedrock.json"))).toBe(false);
    expect(existsSync(join(transcriptDir, "control.json"))).toBe(false);
    expect(JSON.parse(readFileSync(join(outDir, "llm-smoke-results.json"), "utf8"))).toMatchObject({ pass: false });
  });
});
