import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { BedrockDriver, DeterministicDriver } from "./drivers/index.js";
import { renderMarkdown } from "./report.js";
import { runEval } from "./runner.js";

const tool = "honua_describe_layer";

export async function runLlmSmoke(
  env: NodeJS.ProcessEnv = process.env,
  outDir = process.cwd(),
  evaluate = runEval,
): Promise<boolean> {
  const transcriptDir = join(outDir, "llm-smoke-transcripts");
  mkdirSync(transcriptDir, { recursive: true });
  const writeJson = (path: string, data: unknown) => writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`);
  const jsonPath = join(outDir, "llm-smoke-results.json");
  const markdownPath = join(outDir, "llm-smoke-results.md");

  const fail = (error: string) => {
    writeJson(jsonPath, { pass: false, error });
    writeFileSync(markdownPath, `# MCP LLM smoke — FAIL\n\n${error}\n`);
    return false;
  };

  try {
    const { HONUA_SERVICE_ID: serviceId, HONUA_LAYER_ID: rawLayerId } = env;
    const layerId = Number(rawLayerId);
    if (!serviceId || !rawLayerId || !/^\d+$/.test(rawLayerId) || !Number.isSafeInteger(layerId)) {
      return fail("HONUA_SERVICE_ID and a non-negative integer HONUA_LAYER_ID are required.");
    }
    if (!env.HONUA_BASE_URL || !env.HONUA_API_KEY) {
      return fail("HONUA_BASE_URL and HONUA_API_KEY are required.");
    }
    const bedrock = new BedrockDriver({
      enabled: env.HONUA_EVAL_BEDROCK ?? "",
      model: env.HONUA_EVAL_BEDROCK_MODEL,
      region: env.AWS_REGION,
    });
    if (!bedrock.isAvailable()) {
      return fail("HONUA_EVAL_BEDROCK must be enabled for the live smoke.");
    }
    let modelUsedSeed = false;
    const report = await evaluate({
      env,
      drivers: [new DeterministicDriver(), bedrock],
      liveStandalone: true,
      forceOffline: false,
      forceStandaloneSurface: false,
      forceOgcSurface: false,
      allowedTools: [tool],
      corpus: [
        {
          id: "describe-seeded-layer",
          title: "Describe the seeded GeoServices layer",
          category: "discovery",
          prompt: `Describe layer ${layerId} in service ${serviceId}. Use serviceId and layerId to fetch its schema, then summarize the fields.`,
          criteria: {
            requiredTools: [tool],
            failOnToolError: true,
          },
          script: [{ tool, args: { serviceId, layerId } }],
        },
      ],
      onTranscript: (transcript) => {
        const modelSelected = transcript.attribution === "MODEL_SELECTED";
        if (modelSelected) {
          modelUsedSeed = transcript.steps.some(
            (step) =>
              step.tool === tool && !step.isError && step.args.serviceId === serviceId && step.args.layerId === layerId,
          );
        }
        const filename = modelSelected ? "bedrock.json" : "control.json";
        writeJson(join(transcriptDir, filename), transcript);
      },
    });
    const model = report.models.find((entry) => entry.vendor === "bedrock");
    const pass =
      report.surface.backend === "live" &&
      report.surface.auth === "api-key" &&
      report.summary.pass &&
      modelUsedSeed &&
      model?.available === true &&
      model.scenarios === 1 &&
      model.pass === 1;
    writeJson(jsonPath, { ...report, pass });
    writeFileSync(markdownPath, `# MCP LLM smoke — ${pass ? "PASS" : "FAIL"}\n\n${renderMarkdown(report)}`);
    return pass;
  } catch {
    return fail("MCP smoke could not complete. Check the Honua connection and artifact directory.");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = (await runLlmSmoke()) ? 0 : 1;
}
