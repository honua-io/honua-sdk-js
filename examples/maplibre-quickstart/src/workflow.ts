import { HonuaCapabilityNotSupportedError, HonuaHttpError, createHonua, isHonuaError } from "@honua/sdk-js";
import type { ConnectionInspection, HonuaKernel } from "@honua/sdk-js";
import { type MountedSource, explainDataToMapStrategy, mountSource } from "@honua/sdk-js/map";

import type { FirstMapConfig } from "./first-map-config.js";
import type * as Model from "./first-map-model.js";

export type { FirstMapReady, FirstMapStrategyBoundary, FirstMapWorkflowResult } from "./first-map-model.js";

export async function runFirstMapWorkflow<T = Record<string, unknown>>(
  config: FirstMapConfig<T>,
  options: Model.FirstMapWorkflowOptions<T>,
): Promise<Model.FirstMapWorkflowResult<T>> {
  const honua = options.createKernel?.() ?? createHonua();
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
    const mounted = await mountSource(options.map, source, {
      ...options.mount,
      ...mount.options,
      ...(options.signal ? { signal: options.signal } : {}),
    });
    let disposal: Promise<void> | undefined;
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
      mounted,
      // biome-ignore lint/suspicious/noAssignInExpressions: memoizing preserves disposal idempotence.
      dispose: () => (disposal ??= disposeReady(mounted, honua)),
    };
  } catch (error) {
    await honua.dispose();
    return classifyFailure(error);
  }
}

async function disposeReady(mounted: MountedSource, honua: HonuaKernel): Promise<void> {
  const safely = (cleanup: () => unknown) => Promise.resolve().then(cleanup);
  const settled = await Promise.allSettled([safely(() => mounted.dispose()), safely(() => honua.dispose())]);
  const failures = settled.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, "First Map workflow cleanup failed.");
}

function sourceChoice(descriptor: Model.FirstMapSourceDescriptor): Model.FirstMapSourceChoice {
  return {
    id: descriptor.id,
    protocol: descriptor.protocol,
    capabilities: [...descriptor.capabilities].sort(),
    ...(descriptor.attribution ? { attribution: descriptor.attribution } : {}),
  };
}

function connectionView(inspection: ConnectionInspection, sourceId?: string): Model.FirstMapConnectionView {
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

function close<T>(honua: HonuaKernel, result: T): Promise<T> {
  return honua.dispose().then(() => result);
}

function unsupported(code: string, message: string): Model.FirstMapFailure {
  return { state: "unsupported", error: { code, message, retryable: false } };
}

function classifyFailure(error: unknown): Model.FirstMapFailure {
  if (error instanceof HonuaCapabilityNotSupportedError) return unsupported(error.sdkCode, error.message);
  if (
    (isHonuaError(error) && error.category === "authentication") ||
    [401, 403, 498, 499].includes(httpStatus(error) ?? 0)
  )
    return { state: "authentication-required", error: errorView(error) };
  return { state: "error", error: errorView(error) };
}

function errorView(error: unknown): Model.FirstMapFailure["error"] {
  const status = httpStatus(error);
  return {
    code: isHonuaError(error) ? error.sdkCode : status ? "core.http.rejected" : "first-map.unexpected",
    message: error instanceof Error ? error.message : "The endpoint could not be inspected.",
    retryable: isHonuaError(error) ? error.retryable : false,
  };
}

function httpStatus(error: unknown): number | undefined {
  if (error instanceof HonuaHttpError) return error.statusCode;
  const match = error instanceof Error && error.name === "HonuaHttpError" ? /^HTTP (\d{3}):/.exec(error.message) : null;
  return match ? Number(match[1]) : undefined;
}
