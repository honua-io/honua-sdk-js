import { HonuaCapabilityNotSupportedError, HonuaHttpError, createHonua, isHonuaError } from "@honua/sdk-js";
import type { ConnectionInspection, HonuaKernel } from "@honua/sdk-js";
import { explainDataToMapStrategy } from "@honua/sdk-js/map";

import type { FirstMapConfig } from "./first-map-config.js";
import type {
  FirstMapConnectionView,
  FirstMapFailure,
  FirstMapSourceChoice,
  FirstMapSourceDescriptor,
  FirstMapWorkflowOptions,
  FirstMapWorkflowResult,
} from "./first-map-model.js";

export type {
  FirstMapReady,
  FirstMapStrategyBoundary,
  FirstMapWorkflowResult,
} from "./first-map-model.js";

export async function runFirstMapWorkflow<T = Record<string, unknown>>(
  config: FirstMapConfig<T>,
  options: FirstMapWorkflowOptions = {},
): Promise<FirstMapWorkflowResult<T>> {
  const honua = createHonua();
  try {
    const connection = await honua.connect<T>(
      { url: config.endpoint, protocol: config.protocol },
      {
        authorizationScopeFingerprint: "anonymous-public",
        ...(options.fetchFn ? { clientOptions: { fetchFn: options.fetchFn } } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
      },
    );
    const inspection = await connection.inspect(options.signal ? { signal: options.signal } : {});
    const sources = inspection.sources.map(({ descriptor }) => sourceChoice(descriptor));
    if (sources.length === 0) return close(honua, unsupported("first-map.no-sources", "No sources were advertised."));
    const selectedId = config.sourceId ?? inspection.defaultSourceId;
    if (!selectedId || !sources.some(({ id }) => id === selectedId)) {
      return close(honua, {
        state: "source-selection-required",
        reason: config.sourceId ? "invalid-selection" : "ambiguous",
        connection: connectionView(inspection),
        sources,
      });
    }
    const source = connection.source<T>(selectedId);
    const seedOptions = { query: config.query, maxGeoJsonFeatures: config.maxFeatures };
    const explanation = await explainDataToMapStrategy(source, seedOptions);
    const mount = Object.freeze({ source, options: Object.freeze({ ...seedOptions, strategy: explanation.strategy }) });
    return {
      state: "ready",
      view: {
        mode: config.mode,
        connection: connectionView(inspection, selectedId),
        source: sources.find(({ id }) => id === selectedId)!,
        strategy: explanation.strategy,
        strategyReasons: explanation.reasons,
        maxFeatures: config.maxFeatures,
      },
      mount,
      dispose: () => honua.dispose(),
    };
  } catch (error) {
    await honua.dispose();
    return classifyFailure(error);
  }
}

function sourceChoice(descriptor: FirstMapSourceDescriptor): FirstMapSourceChoice {
  return {
    id: descriptor.id,
    protocol: descriptor.protocol,
    capabilities: [...descriptor.capabilities].sort(),
    ...(descriptor.attribution ? { attribution: descriptor.attribution } : {}),
  };
}

function connectionView(inspection: ConnectionInspection, sourceId?: string): FirstMapConnectionView {
  const selected = sourceId ? inspection.sources.find(({ descriptor }) => descriptor.id === sourceId) : undefined;
  const provenance = selected?.provenance ?? inspection.sources.flatMap((source) => source.provenance);
  const observedAt = provenance
    .flatMap(({ retrievedAt }) => (retrievedAt ? [retrievedAt] : []))
    .sort()
    .at(-1);
  return {
    id: inspection.id,
    endpoint: inspection.endpoint,
    protocol: inspection.protocol,
    cacheStatus: inspection.cacheStatus,
    ...(observedAt ? { observedAt } : {}),
    diagnostics: [...inspection.diagnostics, ...(selected?.diagnostics ?? [])],
  };
}

async function close<T>(honua: HonuaKernel, result: T): Promise<T> {
  await honua.dispose();
  return result;
}

function unsupported(code: string, message: string): FirstMapFailure {
  return { state: "unsupported", error: { code, message, retryable: false } };
}

function classifyFailure(error: unknown): FirstMapFailure {
  if (error instanceof HonuaCapabilityNotSupportedError) return unsupported(error.sdkCode, error.message);
  if (isHonuaError(error) && error.category === "authentication") {
    return { state: "authentication-required", error: errorView(error) };
  }
  if ([401, 403, 498, 499].includes(httpStatus(error) ?? 0)) {
    return { state: "authentication-required", error: errorView(error) };
  }
  return { state: "error", error: errorView(error) };
}

function errorView(error: unknown): FirstMapFailure["error"] {
  const status = httpStatus(error);
  return {
    code: isHonuaError(error) ? error.sdkCode : status ? "core.http.rejected" : "first-map.unexpected",
    message: error instanceof Error ? error.message : "The endpoint could not be inspected.",
    retryable: isHonuaError(error) ? error.retryable : false,
  };
}

function httpStatus(error: unknown): number | undefined {
  if (error instanceof HonuaHttpError) return error.statusCode;
  if (!(error instanceof Error) || error.name !== "HonuaHttpError") return undefined;
  const match = /^HTTP (\d{3}):/.exec(error.message);
  return match ? Number(match[1]) : undefined;
}
