import { HonuaClient } from "@honua/sdk-js/honua";
import {
  type HonuaPmtilesJob,
  createHonuaPmtilesLifecycle,
  pmtilesCleanupDisposition,
  requirePmtilesJobSuccess,
} from "@honua/sdk-js/pmtiles";

const config = readConfig(process.env);
const client = new HonuaClient({
  baseUrl: config.baseUrl,
  auth: async () => (config.bearerToken ? { bearerToken: config.bearerToken } : { apiKey: config.apiKey }),
});
const lifecycle = createHonuaPmtilesLifecycle(client);
const controller = new AbortController();
let activeJob: HonuaPmtilesJob | undefined;

process.once("SIGINT", () => controller.abort());
process.once("SIGTERM", () => controller.abort());

try {
  activeJob = await lifecycle.submitPublish(
    {
      serviceId: config.serviceId,
      layerId: config.layerId,
      minZoom: config.minZoom,
      maxZoom: config.maxZoom,
      tileMatrixSetId: config.tileMatrixSetId,
      maxTiles: config.maxTiles,
    },
    { signal: controller.signal },
  );
  const unwatch = activeJob.watch((progress) => {
    process.stdout.write(
      `${JSON.stringify({ jobId: progress.jobId, status: progress.status, phase: progress.currentPhase, percent: progress.percentComplete })}\n`,
    );
  });
  try {
    const complete = requirePmtilesJobSuccess(
      await activeJob.wait({ signal: controller.signal, deadlineMs: 10 * 60_000, maxAttempts: 600 }),
    );
    if (!complete.publishedArtifact) throw new Error("Completed publish omitted its artifact.");
    const source = lifecycle.registerSource({ publishedArtifact: complete.publishedArtifact });
    process.stdout.write(
      `${JSON.stringify({ status: "ready", delivery: source.delivery, archiveUrl: source.archiveUrl, maplibreUrl: source.maplibreUrl, cleanup: pmtilesCleanupDisposition(source) })}\n`,
    );
  } finally {
    unwatch();
  }
} catch (cause) {
  if (controller.signal.aborted && activeJob) await activeJob.cancel().catch(() => undefined);
  throw cause;
} finally {
  activeJob?.dispose();
}

interface Config {
  baseUrl: string;
  bearerToken?: string;
  apiKey?: string;
  serviceId?: string;
  layerId: number;
  minZoom: number;
  maxZoom: number;
  tileMatrixSetId: string;
  maxTiles: number;
}

function readConfig(env: NodeJS.ProcessEnv): Config {
  const baseUrl = required(env.HONUA_BASE_URL, "HONUA_BASE_URL");
  const bearerToken = optional(env.HONUA_ADMIN_TOKEN);
  const apiKey = optional(env.HONUA_ADMIN_API_KEY);
  const serviceId = optional(env.HONUA_SERVICE_ID);
  if (!bearerToken && !apiKey) throw new Error("HONUA_ADMIN_TOKEN or HONUA_ADMIN_API_KEY is required.");
  const minZoom = integer(env.HONUA_MIN_ZOOM ?? "0", "HONUA_MIN_ZOOM", 0, 30);
  const maxZoom = integer(env.HONUA_MAX_ZOOM ?? "12", "HONUA_MAX_ZOOM", 0, 30);
  if (minZoom > maxZoom) throw new Error("HONUA_MIN_ZOOM must not exceed HONUA_MAX_ZOOM.");
  return {
    baseUrl,
    ...(bearerToken ? { bearerToken } : {}),
    ...(apiKey ? { apiKey } : {}),
    ...(serviceId ? { serviceId } : {}),
    layerId: integer(env.HONUA_LAYER_ID, "HONUA_LAYER_ID", 0, 2_147_483_647),
    minZoom,
    maxZoom,
    tileMatrixSetId: env.HONUA_TILE_MATRIX_SET_ID?.trim() || "WebMercatorQuad",
    maxTiles: integer(env.HONUA_MAX_TILES ?? "250000", "HONUA_MAX_TILES", 1, 10_000_000),
  };
}

function required(value: string | undefined, name: string): string {
  const result = optional(value);
  if (!result) throw new Error(`${name} is required.`);
  return result;
}

function optional(value: string | undefined): string | undefined {
  const result = value?.trim();
  return result ? result : undefined;
}

function integer(value: string | undefined, name: string, minimum: number, maximum: number): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} through ${maximum}.`);
  }
  return parsed;
}
