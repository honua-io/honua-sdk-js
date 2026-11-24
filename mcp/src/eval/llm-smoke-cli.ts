import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseSourceRef, toSourceLocator } from "../neutral/source-ref.js";
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
  for (const filename of ["bedrock.json", "control.json"]) {
    rmSync(join(transcriptDir, filename), { force: true });
  }
  const writeJson = (path: string, data: unknown) => writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`);
  const jsonPath = join(outDir, "llm-smoke-results.json");
  const markdownPath = join(outDir, "llm-smoke-results.md");

  const fail = (error: string) => {
    writeJson(jsonPath, { pass: false, error });
    writeFileSync(markdownPath, `# MCP LLM smoke — FAIL\n\n${error}\n`);
    return false;
  };

  try {
    const { HONUA_SERVICE_ID: serviceId, HONUA_LAYER_ID: rawLayerId, HONUA_BASE_URL: baseUrl } = env;
    const layerId = Number(rawLayerId);
    if (!serviceId || !rawLayerId || !/^\d+$/.test(rawLayerId) || !Number.isSafeInteger(layerId)) {
      return fail("HONUA_SERVICE_ID and a non-negative integer HONUA_LAYER_ID are required.");
    }
    if (!baseUrl || !env.HONUA_API_KEY) {
      return fail("HONUA_BASE_URL and HONUA_API_KEY are required.");
    }
    if (env.HONUA_EVAL_BEDROCK !== "1") {
      return fail("HONUA_EVAL_BEDROCK must be set to 1 for the live smoke.");
    }
    const bedrock = new BedrockDriver({
      enabled: env.HONUA_EVAL_BEDROCK,
      model: env.HONUA_EVAL_BEDROCK_MODEL,
      region: env.AWS_REGION,
    });
    const report = await evaluate({
      env,
      drivers: [new DeterministicDriver(), bedrock],
      liveStandalone: true,
      forceOffline: false,
      forceStandaloneSurface: false,
      forceOgcSurface: false,
      allowedTools: [tool],
      validateToolResult: (text) => {
        const result = JSON.parse(text) as {
          source?: string;
          schemaAvailable?: boolean;
          fields?: Array<{ name?: string; type?: string }>;
        } | null;
        if (typeof result?.source !== "string") return false;
        const ref = parseSourceRef(result.source);
        if (ref.protocol !== "geoservices-feature-service") return false;
        const locator = toSourceLocator(ref, baseUrl);
        return (
          locator.serviceId === serviceId &&
          locator.layerId === layerId &&
          result.schemaAvailable === true &&
          Array.isArray(result.fields) &&
          result.fields.some((field) => field?.name?.toLowerCase() === "objectid" && field.type === "esriFieldTypeOID")
        );
      },
      corpus: [
        {
          id: "describe-seeded-layer",
          title: "Describe the seeded GeoServices layer",
          category: "discovery",
          prompt: `Use honua_describe_layer with serviceId ${serviceId} and layerId ${layerId} to fetch the layer schema. Reply with only the schema name of the object ID field.`,
          criteria: {
            requiredTools: [tool],
            failOnToolError: true,
            modelAnswerMustMatch: ["^\\s*objectid\\s*$"],
          },
          script: [{ tool, args: { serviceId, layerId } }],
        },
      ],
      onTranscript: (transcript) => {
        const modelSelected = transcript.attribution === "MODEL_SELECTED";
        const filename = modelSelected ? "bedrock.json" : "control.json";
        writeJson(join(transcriptDir, filename), transcript);
      },
    });
    const model = report.models.find((entry) => entry.vendor === "bedrock");
    const pass =
      report.surface.backend === "live" &&
      report.surface.auth === "api-key" &&
      report.summary.pass &&
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
