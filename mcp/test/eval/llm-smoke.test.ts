import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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

  it.each([true, false])("requires the Bedrock scenario to pass (%s)", async (modelPass) => {
    const outDir = outputDirectory();
    const fetch = vi.fn(async (url: URL, init?: RequestInit) => {
      expect(new URL(url).pathname).toBe("/rest/services/test_service/FeatureServer/0");
      expect(new Headers(init?.headers).get("x-api-key")).toBe(env.HONUA_API_KEY);
      return Response.json({ id: 0, name: "Seeded layer", fields: [{ name: "objectid", type: "esriFieldTypeOID" }] });
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
              const transcript = await control.runWorkflow(scenario, ctx);
              return {
                ...transcript,
                modelId: bedrock.id,
                ...(modelPass ? {} : { driverError: "stubbed model failure" }),
              };
            },
          },
        ],
      });
    });

    expect(result).toBe(modelPass);
    expect(fetch).toHaveBeenCalledOnce();
    const report = JSON.parse(readFileSync(join(outDir, "llm-smoke-results.json"), "utf8"));
    expect(report).toMatchObject({ pass: modelPass, summary: { pass: true } });
    expect(readFileSync(join(outDir, "llm-smoke-results.md"), "utf8")).toContain(modelPass ? "PASS" : "FAIL");
    expect(readFileSync(join(outDir, "llm-smoke-transcripts", "bedrock.json"), "utf8")).toContain("MODEL_SELECTED");
    expect(readFileSync(join(outDir, "llm-smoke-transcripts", "control.json"), "utf8")).toContain("HARNESS_DRIVEN");
  });

  it("fails before evaluating when Bedrock is disabled", async () => {
    const outDir = outputDirectory();
    const evaluate = vi.fn();
    expect(await runLlmSmoke({ ...env, HONUA_EVAL_BEDROCK: "0" }, outDir, evaluate)).toBe(false);
    expect(evaluate).not.toHaveBeenCalled();
    expect(JSON.parse(readFileSync(join(outDir, "llm-smoke-results.json"), "utf8"))).toMatchObject({ pass: false });
  });
});
