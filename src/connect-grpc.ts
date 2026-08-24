/**
 * Internal Honua gRPC FeatureService discovery projection for `connect()`.
 *
 * Honua's gRPC-Web facade is a transport-selectable fast path over the same
 * canonical FeatureServer semantics as raw GeoServices REST discovery: the
 * generated `geospatial.v1.FeatureService` proto exposes only `QueryFeatures` /
 * `QueryFeaturesStream` (no separate descriptor RPC), so this adapter fetches
 * service/layer metadata through the identical REST metadata endpoints
 * `discoverGeoServicesSources` uses (those endpoints are transport-agnostic —
 * they answer the same JSON regardless of `HonuaClient` transport) and
 * derives capabilities through the exact same
 * {@link capabilitiesFromMetadata} algorithm, so a `protocol: "grpc"`
 * descriptor's capability truth is a verified subset of the equivalent
 * `geoservices-feature-service` descriptor's truth by construction, never an
 * invented superset.
 *
 * The adapter-specific contribution is a bounded `QueryFeatures` RPC per
 * layer, executed over the gRPC-Web transport, that proves the facade's read
 * path actually agrees with the REST-declared schema (fields, object-id
 * field, geometry type) before `query` / `stream` are advertised — this is
 * the "raw-endpoint parity" contract in issue #554. A disagreeing probe
 * response throws `protocol-mismatch`; a failing probe (network / gRPC
 * transport error, not a schema disagreement) degrades `query` / `stream`
 * to unavailable evidence for that layer without failing the whole
 * discovery, matching the partial-failure precedent in
 * `discoverGeoServicesSources`.
 */

import {
  type ConnectTarget,
  type GeoServicesDiscoveryOptions,
  type GeoServicesDiscoveryResult,
  capabilitiesFromMetadata,
  layerUrl,
  mapWithConcurrency,
  provenanceFor,
} from "./connect-geoservices.js";
import type { ConnectDiscoverySourceSnapshot, ConnectSourceSchemaProjection } from "./connect.js";
import type { DiscoveryCapabilityEvidence } from "./contract/discovery.js";
import { type Capability, PROTOCOL_DEFAULT_CAPABILITIES, type SourceSchema } from "./contract/types.js";
import type { HonuaMetadataRequestOptions } from "./core/cache-state.js";
import type { HonuaClient } from "./core/client.js";
import { HonuaAbortError, HonuaDiscoveryError } from "./core/errors.js";
import type { HonuaLayerMetadata, HonuaQueryResponse } from "./core/types.js";

/** The full capability surface Honua gRPC discovery may ever advertise. */
const GRPC_LAYER_SCOPE: readonly Capability[] = Object.freeze([...PROTOCOL_DEFAULT_CAPABILITIES.grpc]);

/**
 * The capabilities that require a successful live `QueryFeatures` parity
 * probe before being advertised — the two operations that actually exercise
 * the gRPC read path (`queryObjectIds`, `queryAggregate`, `queryExtent`, and
 * `applyEdits` are trusted from metadata alone, exactly as raw GeoServices
 * REST discovery trusts them without probing).
 */
// Every capability that executes through the grpc-web `client.queryFeatures` path must be
// narrowed when the live probe fails, not just `query`/`stream`: `queryExtent`,
// `queryObjectIds`, and `queryAggregate` hit the identical transport.
const GRPC_PROBE_GATED_CAPABILITIES: readonly Capability[] = Object.freeze([
  "query",
  "stream",
  "queryExtent",
  "queryObjectIds",
  "queryAggregate",
]);

/** Bounded row count for the parity probe — enough to populate schema metadata without pulling a working set. */
const GRPC_PROBE_RESULT_RECORD_COUNT = 1;

export async function discoverGrpcSources(
  client: HonuaClient,
  target: ConnectTarget,
  options: GeoServicesDiscoveryOptions,
  sourceSchemaProjection?: ConnectSourceSchemaProjection,
): Promise<GeoServicesDiscoveryResult> {
  const serviceId = target.serviceId;
  if (!serviceId) {
    throw new HonuaDiscoveryError("invalid-endpoint", "Honua gRPC discovery requires a service id.");
  }
  if (!client.isGrpcWeb) {
    throw new HonuaDiscoveryError(
      "invalid-endpoint",
      'connect() protocol: "grpc" requires a client configured with transport: "grpc-web"; pass clientOptions: { transport: "grpc-web" } or an already-configured client with that transport.',
      { endpoint: target.endpoint },
    );
  }
  await assertServerCompatible(client, options);
  throwIfAborted(options.signal);

  const request: HonuaMetadataRequestOptions = {
    ...options.metadata,
    ...(options.signal ? { signal: options.signal } : {}),
    refresh: options.refresh === true,
  };
  const retrievedAt = new Date().toISOString();

  if (target.layerId !== undefined) {
    const metadata = await client.getLayerMetadata(serviceId, target.layerId, request);
    throwIfAborted(options.signal);
    if (metadata.id !== target.layerId) {
      throw new HonuaDiscoveryError("invalid-endpoint", "GeoServices layer metadata id does not match the URL.", {
        expectedLayerId: target.layerId,
        receivedLayerId: metadata.id,
      });
    }
    const source = await discoverLayer(client, target, metadata, retrievedAt, options, sourceSchemaProjection);
    return Object.freeze({ retrievedAt, sources: Object.freeze([source]) });
  }

  const service = await client.getFeatureServiceMetadata(serviceId, request);
  throwIfAborted(options.signal);
  const summaries = [...(service.layers ?? []), ...(service.tables ?? [])];
  if (summaries.length === 0) {
    throw new HonuaDiscoveryError("invalid-endpoint", "Honua gRPC discovery returned no layers or tables.", {
      serviceId,
    });
  }
  validateLayerSummaries(summaries);
  const sources = await mapWithConcurrency(summaries, 4, async (summary) => {
    const metadata = await client.getLayerMetadata(serviceId, summary.id, request);
    if (metadata.id !== summary.id) {
      throw new HonuaDiscoveryError("invalid-endpoint", "GeoServices layer metadata id does not match its listing.");
    }
    return discoverLayer(client, target, metadata, retrievedAt, options, sourceSchemaProjection);
  });
  throwIfAborted(options.signal);
  return Object.freeze({ retrievedAt, sources: Object.freeze(sources) });
}

async function discoverLayer(
  client: HonuaClient,
  target: ConnectTarget,
  metadata: HonuaLayerMetadata,
  retrievedAt: string,
  options: GeoServicesDiscoveryOptions,
  sourceSchemaProjection: ConnectSourceSchemaProjection | undefined,
): Promise<ConnectDiscoverySourceSnapshot> {
  if (!Number.isInteger(metadata.id) || metadata.id < 0 || typeof metadata.name !== "string" || !metadata.name.trim()) {
    throw new HonuaDiscoveryError("invalid-endpoint", "GeoServices returned invalid layer metadata.");
  }
  const serviceId = target.serviceId;
  if (!serviceId) throw new HonuaDiscoveryError("invalid-endpoint", "Honua gRPC discovery requires a service id.");

  const evidence = await layerEvidenceWithGrpcProbe(client, target, metadata, retrievedAt, options);

  const fields = Array.isArray(metadata.fields) ? Object.freeze([...metadata.fields]) : undefined;
  const primaryKey = fields?.find((field) => field.type === "esriFieldTypeOID")?.name;
  const schema: SourceSchema | undefined = fields
    ? Object.freeze({ fields, ...(primaryKey ? { primaryKey } : {}) })
    : undefined;
  const schemaV2 = sourceSchemaProjection?.geoServices(metadata, {
    protocol: "geoservices-feature-service",
    source: layerUrl(target, metadata.id),
    observedAt: retrievedAt,
  });
  const attribution = metadata.copyrightText?.trim();

  return Object.freeze({
    id: String(metadata.id),
    locator: Object.freeze({ url: target.clientBaseUrl, serviceId, layerId: metadata.id }),
    title: metadata.name,
    ...(metadata.description ? { description: metadata.description } : {}),
    ...(attribution ? { attribution } : {}),
    ...(schema ? { schema } : {}),
    ...(schemaV2 ? { schemaV2 } : {}),
    evidence,
  });
}

async function layerEvidenceWithGrpcProbe(
  client: HonuaClient,
  target: ConnectTarget,
  metadata: HonuaLayerMetadata,
  retrievedAt: string,
  options: GeoServicesDiscoveryOptions,
): Promise<readonly DiscoveryCapabilityEvidence[]> {
  const layerSource = layerUrl(target, metadata.id);
  const metadataProvenance = Object.freeze([provenanceFor(layerSource, retrievedAt, metadata)]);

  if (typeof metadata.capabilities !== "string" || !metadata.capabilities.trim()) {
    return Object.freeze([
      Object.freeze({
        kind: "unavailable" as const,
        scope: GRPC_LAYER_SCOPE,
        reason: "Layer metadata did not advertise a GeoServices capabilities value.",
        provenance: metadataProvenance,
      }),
    ]);
  }

  // Reuses the same algorithm raw GeoServices REST discovery uses, so the
  // capability truth is identical wherever the two adapters overlap; only
  // `query` / `stream` are then narrowed by the live gRPC probe below.
  const metadataCapabilities = capabilitiesFromMetadata("geoservices-feature-service", metadata).filter((capability) =>
    GRPC_LAYER_SCOPE.includes(capability),
  );

  let probe: HonuaQueryResponse | undefined;
  try {
    probe = await client.queryFeatures({
      serviceId: target.serviceId as string,
      layerId: metadata.id,
      where: "1=1",
      returnGeometry: false,
      resultRecordCount: GRPC_PROBE_RESULT_RECORD_COUNT,
      ...(options.signal ? { signal: options.signal } : {}),
    });
  } catch (error) {
    if (error instanceof HonuaAbortError || options.signal?.aborted) throw new HonuaAbortError();
    const gatedCapabilities = metadataCapabilities.filter(
      (capability) => !GRPC_PROBE_GATED_CAPABILITIES.includes(capability),
    );
    const probeProvenance = Object.freeze([
      provenanceFor(`${layerSource}#queryFeatures`, new Date().toISOString(), metadata),
    ]);
    return Object.freeze([
      Object.freeze({
        kind: "unavailable" as const,
        scope: GRPC_PROBE_GATED_CAPABILITIES,
        reason: `Honua gRPC QueryFeatures parity probe failed: ${error instanceof Error ? error.message : String(error)}`,
        provenance: probeProvenance,
      }),
      Object.freeze({
        kind: "metadata" as const,
        capabilities: Object.freeze(gatedCapabilities),
        scope: Object.freeze(
          GRPC_LAYER_SCOPE.filter((capability) => !GRPC_PROBE_GATED_CAPABILITIES.includes(capability)),
        ),
        provenance: metadataProvenance,
      }),
    ]);
  }
  throwIfAborted(options.signal);

  assertProbeParity(target, metadata, probe);

  return Object.freeze([
    Object.freeze({
      kind: "metadata" as const,
      capabilities: Object.freeze(metadataCapabilities),
      scope: GRPC_LAYER_SCOPE,
      provenance: Object.freeze([
        ...metadataProvenance,
        provenanceFor(`${layerSource}#queryFeatures`, retrievedAt, metadata),
      ]),
    }),
  ]);
}

/**
 * Asserts the live gRPC `QueryFeatures` schema metadata agrees with the
 * REST-declared layer metadata. A disagreement here is a genuine data
 * integrity problem (the facade and the raw endpoint disagree about the same
 * layer's shape), not a transient probe failure, so it throws rather than
 * degrading evidence.
 */
function assertProbeParity(target: ConnectTarget, metadata: HonuaLayerMetadata, probe: HonuaQueryResponse): void {
  const declaredFields = new Set((metadata.fields ?? []).map((field) => field.name));
  const probedFields = new Set((probe.fields ?? []).map((field) => field.name));
  const missingFromGrpc = [...declaredFields].filter((name) => !probedFields.has(name));
  const extraFromGrpc = [...probedFields].filter((name) => !declaredFields.has(name));
  if (missingFromGrpc.length > 0 || extraFromGrpc.length > 0) {
    throw new HonuaDiscoveryError(
      "protocol-mismatch",
      `Honua gRPC QueryFeatures fields disagree with GeoServices layer metadata for layer ${metadata.id}.`,
      { serviceId: target.serviceId, layerId: metadata.id, missingFromGrpc, extraFromGrpc },
    );
  }
  if (metadata.objectIdField && probe.objectIdFieldName && metadata.objectIdField !== probe.objectIdFieldName) {
    throw new HonuaDiscoveryError(
      "protocol-mismatch",
      `Honua gRPC QueryFeatures objectIdFieldName disagrees with GeoServices layer metadata for layer ${metadata.id}.`,
      {
        serviceId: target.serviceId,
        layerId: metadata.id,
        restObjectIdField: metadata.objectIdField,
        grpcObjectIdFieldName: probe.objectIdFieldName,
      },
    );
  }
  if (metadata.geometryType && probe.geometryType && metadata.geometryType !== probe.geometryType) {
    throw new HonuaDiscoveryError(
      "protocol-mismatch",
      `Honua gRPC QueryFeatures geometryType disagrees with GeoServices layer metadata for layer ${metadata.id}.`,
      {
        serviceId: target.serviceId,
        layerId: metadata.id,
        restGeometryType: metadata.geometryType,
        grpcGeometryType: probe.geometryType,
      },
    );
  }
}

/**
 * Preserves server descriptor/version provenance and fails closed with an
 * actionable diagnostic when the connected server predates the SDK's
 * minimum supported contract — reusing the same compatibility contract the
 * REST control-plane surfaces already establish rather than inventing a
 * gRPC-specific version check.
 */
async function assertServerCompatible(client: HonuaClient, options: GeoServicesDiscoveryOptions): Promise<void> {
  const status = await client.checkCompatibility({
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.refresh !== undefined ? { refresh: options.refresh } : {}),
  });
  throwIfAborted(options.signal);
  if (!status.supported) {
    throw new HonuaDiscoveryError(
      "invalid-endpoint",
      `Honua gRPC discovery requires a server compatible with this SDK (minimum ${status.minimumSupportedServerVersion}): ${
        status.reasons.join("; ") || "the server did not report a compatible descriptor."
      }`,
      {
        minimumSupportedServerVersion: status.minimumSupportedServerVersion,
        serverVersion: status.compatibility?.serverVersion,
        reasons: status.reasons,
      },
    );
  }
}

function validateLayerSummaries(summaries: readonly { readonly id: number; readonly name: string }[]): void {
  const ids = new Set<number>();
  for (const summary of summaries) {
    if (!Number.isInteger(summary.id) || summary.id < 0 || ids.has(summary.id)) {
      throw new HonuaDiscoveryError(
        "invalid-endpoint",
        "GeoServices layer identifiers must be unique non-negative integers.",
        { layerId: summary.id },
      );
    }
    ids.add(summary.id);
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new HonuaAbortError();
}
