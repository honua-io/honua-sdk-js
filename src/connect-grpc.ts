/** Native gRPC-Web discovery. Descriptor RPCs are the sole metadata authority. */
import type { ConnectTarget, GeoServicesDiscoveryOptions, GeoServicesDiscoveryResult } from "./connect-geoservices.js";
import type { ConnectDiscoverySourceSnapshot, ConnectSourceSchemaProjection } from "./connect.js";
import type { DiscoveryCapabilityEvidence } from "./contract/discovery.js";
import { type Capability, PROTOCOL_DEFAULT_CAPABILITIES } from "./contract/types.js";
import type { HonuaClient } from "./core/client.js";
import { HonuaAbortError, HonuaDiscoveryError } from "./core/errors.js";
import { mapWithConcurrency } from "./core/map-with-concurrency.js";
import type { LayerDescriptor, LayerSummary } from "./gen/geospatial/v1/metadata_types_pb.js";

const SCOPE = Object.freeze([...PROTOCOL_DEFAULT_CAPABILITIES.grpc]);
const MAX_DISCOVERY_LAYERS = 10_000;

export async function discoverGrpcSources(
  client: HonuaClient,
  target: ConnectTarget,
  options: GeoServicesDiscoveryOptions & { sourceSchemaProjection?: ConnectSourceSchemaProjection },
): Promise<GeoServicesDiscoveryResult> {
  const serviceId = target.serviceId;
  if (!serviceId || !client.isGrpcWeb) {
    throw new HonuaDiscoveryError(
      "invalid-endpoint",
      "Native discovery requires a service id and transport: grpc-web.",
    );
  }
  abort(options.signal);
  const retrievedAt = new Date().toISOString();
  const ids = target.layerId === undefined ? await discoverIds(client, serviceId, options.signal) : [target.layerId];
  const sources = await mapWithConcurrency(ids, 4, async (layerId) => {
    abort(options.signal);
    const response = await client.describeLayer({
      serviceId,
      layerId,
      ...(options.signal ? { signal: options.signal } : {}),
    });
    abort(options.signal);
    const layer = response.layer;
    if (!layer || layer.serviceId !== serviceId || layer.layerId !== layerId || !layer.name.trim()) {
      throw new HonuaDiscoveryError("protocol-mismatch", "DescribeLayer returned a missing or mismatched descriptor.");
    }
    return projectLayer(target, layer, { retrievedAt, projection: options.sourceSchemaProjection });
  });
  abort(options.signal);
  return Object.freeze({ retrievedAt, sources: Object.freeze(sources) });
}

async function discoverIds(client: HonuaClient, serviceId: string, signal?: AbortSignal): Promise<number[]> {
  let ids = new Set<number>();
  const tokens = new Set<string>();
  let pageToken = "";
  do {
    abort(signal);
    const page = await client.describeService({ serviceId, pageSize: 100, pageToken, ...(signal ? { signal } : {}) });
    abort(signal);
    if (page.service?.serviceId !== serviceId) {
      throw new HonuaDiscoveryError("protocol-mismatch", "DescribeService returned a mismatched service.");
    }
    ids = withLayerIds(ids, page.layers);
    pageToken = page.nextPageToken;
    if (pageToken && (tokens.has(pageToken) || page.layers.length === 0 || ids.size >= MAX_DISCOVERY_LAYERS)) {
      throw new HonuaDiscoveryError("protocol-mismatch", "DescribeService pagination did not make bounded progress.");
    }
    if (ids.size > MAX_DISCOVERY_LAYERS)
      throw new HonuaDiscoveryError("protocol-mismatch", "Too many discovery layers.");
    tokens.add(pageToken);
  } while (pageToken);
  return [...ids];
}

function withLayerIds(current: ReadonlySet<number>, layers: LayerSummary[]): Set<number> {
  const ids = new Set(current);
  for (const layer of layers) {
    if (!Number.isInteger(layer.layerId) || layer.layerId < 0 || layer.layerId > 2147483647 || ids.has(layer.layerId)) {
      throw new HonuaDiscoveryError("protocol-mismatch", "DescribeService returned an invalid or duplicate layer id.");
    }
    ids.add(layer.layerId);
  }
  return ids;
}

function projectLayer(
  target: ConnectTarget,
  layer: LayerDescriptor,
  context: { retrievedAt: string; projection: ConnectSourceSchemaProjection | undefined },
): ConnectDiscoverySourceSnapshot {
  const { retrievedAt, projection } = context;
  const source = `${target.clientBaseUrl}/geospatial.v1.FeatureService/DescribeLayer#${encodeURIComponent(layer.serviceId)}/${layer.layerId}`;
  const advertised: Capability[] = [];
  if (layer.capabilities?.query) {
    if (layer.capabilities.queryPagination) advertised.push("query");
    advertised.push("queryExtent", "queryObjectIds");
  }
  if (layer.capabilities?.queryStream) advertised.push("stream");
  if (layer.capabilities?.create || layer.capabilities?.update || layer.capabilities?.delete)
    advertised.push("applyEdits");
  const provenance = Object.freeze([{ source, retrievedAt }]);
  const evidence: readonly DiscoveryCapabilityEvidence[] = layer.capabilities
    ? [{ kind: "metadata", scope: SCOPE, capabilities: Object.freeze(advertised), provenance }]
    : [{ kind: "unavailable", scope: SCOPE, reason: "DescribeLayer omitted caller capabilities.", provenance }];
  const schemaV2 = projection?.grpc(layer, { source, observedAt: retrievedAt });
  return Object.freeze({
    id: String(layer.layerId),
    locator: Object.freeze({ url: target.clientBaseUrl, serviceId: layer.serviceId, layerId: layer.layerId }),
    title: layer.name,
    ...(layer.description ? { description: layer.description } : {}),
    ...(schemaV2 ? { schemaV2 } : {}),
    evidence: Object.freeze(evidence),
  });
}

function abort(signal?: AbortSignal): void {
  if (signal?.aborted) throw new HonuaAbortError();
}
