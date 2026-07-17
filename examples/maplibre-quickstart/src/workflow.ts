import { HonuaCapabilityNotSupportedError, HonuaHttpError, createHonua, isHonuaError } from "@honua/sdk-js";
import type { ConnectionInspection, HonuaKernel } from "@honua/sdk-js";
import { maplibreRenderer } from "@honua/sdk-js/runtime";

import type { FirstMapConfig } from "./first-map-config.js";
import type * as Model from "./first-map-model.js";

export type { FirstMapReady, FirstMapWorkflowResult } from "./first-map-model.js";

export async function runFirstMapWorkflow<T = Record<string, unknown>>(
  config: FirstMapConfig<T>,
  options: Model.FirstMapWorkflowOptions,
): Promise<Model.FirstMapWorkflowResult<T>> {
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
    const source = sources.find(({ id }) => id === selectedId)!;
    const maxFeatures = config.maxFeatures;
    const view = { mode: config.mode, connection: connectionView(inspection, selectedId), source, maxFeatures };
    const explainOptions = { sourceId: selectedId, ...(options.signal ? { signal: options.signal } : {}) };
    const plan = await connection.explain(config.query, explainOptions);
    const query = await connection.query(plan, options.signal ? { signal: options.signal } : {});
    if (query.exceededTransferLimit || query.execution.terminal.exceededTransferLimit) {
      return close(honua, {
        state: "overflow",
        view,
        plan,
        query,
        error: {
          code: "first-map.query-overflow",
          message: "The source returned more features than the bounded First Map query can materialize.",
          retryable: false,
        },
      });
    }
    const mounted = await connection.mount(options.map, {
      renderer: maplibreRenderer(options.maplibre ?? {}),
      query: plan,
      ...(options.rendererOptions ? { rendererOptions: options.rendererOptions } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    });
    await mounted.ready;
    return { state: "ready", view, plan, query, mounted, dispose: () => honua.dispose() };
  } catch (error) {
    await honua.dispose();
    return classifyFailure(error);
  }
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
  if (
    error instanceof HonuaCapabilityNotSupportedError ||
    (isHonuaError(error) &&
      (error.sdkCode.endsWith("capability-not-supported") ||
        error.sdkCode === "map.automatic-strategy.no-eligible-strategy"))
  )
    return unsupported(error.sdkCode, error.message);
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
  return error instanceof HonuaHttpError ? error.statusCode : undefined;
}
