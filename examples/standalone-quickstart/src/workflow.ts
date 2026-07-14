import { FeatureLayerCompat, parseFeatureLayerUrl } from "@honua/sdk-js/esri-compat";
import { HonuaClient } from "@honua/sdk-js/honua";
import type { HonuaLayerMetadata } from "@honua/sdk-js/honua";
import { loadHonuaFeatureServiceGeoJson } from "@honua/sdk-js/map";

import type { StandaloneConfig } from "./config.js";
import { type StandaloneDataset, type StandaloneGeoJson, computeBounds, describeHost } from "./data.js";

export interface StandaloneWorkflowOptions {
  readonly signal?: AbortSignal;
  readonly fetchFn?: typeof fetch;
}

function abortableFetch(fetchFn: typeof fetch, signal: AbortSignal | undefined): typeof fetch {
  return (input, init = {}) => {
    const requestSignal = init.signal;
    const combined =
      signal && requestSignal && requestSignal !== signal
        ? AbortSignal.any([signal, requestSignal])
        : (signal ?? requestSignal);
    return fetchFn(input, { ...init, ...(combined ? { signal: combined } : {}) });
  };
}

/** Copyable SDK workflow. It has no dependency on the shared demo presentation shell. */
export async function runStandaloneWorkflow(
  config: StandaloneConfig,
  options: StandaloneWorkflowOptions = {},
): Promise<StandaloneDataset> {
  options.signal?.throwIfAborted();
  const parsed = parseFeatureLayerUrl(config.featureLayerUrl);
  const client = new HonuaClient({
    baseUrl: parsed.baseUrl,
    fetchFn: abortableFetch(options.fetchFn ?? globalThis.fetch.bind(globalThis), options.signal),
  });
  const source = (await loadHonuaFeatureServiceGeoJson(client, config.featureLayerUrl, {
    definitionExpression: config.where,
    outFields: config.outFields,
    maxPages: config.maxPages,
    signal: options.signal,
  })) as { type: "geojson"; data: StandaloneGeoJson };
  const geojson = source.data;
  let metadata: HonuaLayerMetadata | undefined;
  const degradationReasons: string[] = [];
  try {
    metadata = await client.getLayerMetadata(parsed.serviceId, parsed.layerId, { signal: options.signal });
  } catch (error) {
    options.signal?.throwIfAborted();
    degradationReasons.push(
      `Layer metadata unavailable; using the service id as the label (${error instanceof Error ? error.message : String(error)}).`,
    );
  }
  const featureLayer = new FeatureLayerCompat({ url: config.featureLayerUrl, client });
  const compatResponse = await featureLayer.queryFeatures({
    where: config.where,
    outFields: config.outFields,
    returnGeometry: false,
    signal: options.signal,
  });
  options.signal?.throwIfAborted();

  return {
    source,
    geojson,
    featureCount: geojson.features.length,
    compatFeatureCount: compatResponse.features?.length ?? 0,
    layerName: metadata?.name ?? parsed.serviceId,
    geometryType: metadata?.geometryType,
    degradationReasons,
    bounds: computeBounds(geojson),
    endpointHost: describeHost(config.featureLayerUrl),
  };
}
