import { HonuaAbortError, HonuaCapabilityNotSupportedError } from "../core/errors.js";
import { type GrpcEditSchema, memoizedGrpcEditSchema } from "../core/grpc-edit-schema.js";
import { trimTrailingSlashes } from "../core/path-utils.js";
import { assertDistinctServiceLayers } from "../core/service-edit-layers.js";
import type { ServiceLayerEditsRequest } from "../core/service-edit-types.js";
import { canonicalEditResult } from "./edit-result.js";
import { toApplyEditsRequest } from "./feature-layer-edits.js";
import type { Dataset, EditEnvelope, EditResult, SourceDescriptor, SourceId } from "./types.js";

/** One source's edits in a service transaction; cancellation and rollback apply to the whole call. */
export interface ServiceSourceEdits {
  sourceId: SourceId;
  edits: Omit<EditEnvelope, "rollbackOnFailure" | "signal">;
}

/** Native edits to distinct sources of one service, applied in this order. */
export interface ServiceEditSubmitOptions {
  edits: readonly ServiceSourceEdits[];
  /** Defaults to true: all layers commit or none do. */
  rollbackOnFailure?: boolean;
  /** Caller-controlled retry identity for the entire transaction. */
  idempotencyKey?: string;
  signal?: AbortSignal;
}

/** Canonical outcomes for a source, including a layer-wide failure when rollback is disabled. */
export interface ServiceSourceEditResult {
  sourceId: SourceId;
  layerId: number;
  result: EditResult;
  error?: { code: number; description: string };
}

/** Per-source outcomes in submission order; whole-call failures reject instead. */
export interface ServiceEditSubmitResult {
  sources: readonly ServiceSourceEditResult[];
}

/** A native multi-source editor that submits one gRPC-Web transaction without REST fallback. */
export interface ServiceEditSession {
  submit(options: ServiceEditSubmitOptions): Promise<ServiceEditSubmitResult>;
}

/** Create an editor for sources registered in one dataset; requires a gRPC-Web client. */
export function createServiceEditSession({ dataset }: { dataset: Dataset }): ServiceEditSession {
  const schemas = new Map<SourceId, (signal?: AbortSignal) => Promise<GrpcEditSchema>>();
  return {
    async submit(options) {
      if (options.signal?.aborted) throw new HonuaAbortError();
      const layers = prepareLayers(dataset, options.edits);
      const edits = await Promise.all(
        layers.map(async ({ sourceId, request }) => {
          let read = schemas.get(sourceId);
          if (!read) {
            read = memoizedGrpcEditSchema(dataset.client, layers[0].serviceId, request.layerId);
            schemas.set(sourceId, read);
          }
          return { ...request, ...(await read(options.signal)) };
        }),
      );
      if (options.signal?.aborted) throw new HonuaAbortError();
      const response = await dataset.client.applyServiceEdits({
        serviceId: layers[0].serviceId,
        edits,
        rollbackOnFailure: options.rollbackOnFailure ?? true,
        idempotencyKey: options.idempotencyKey,
        signal: options.signal,
      });
      return {
        sources: response.layers.map((layer, index) => ({
          sourceId: layers[index].sourceId,
          layerId: layer.layerId,
          result: canonicalEditResult(layer),
          ...(layer.error ? { error: layer.error } : {}),
        })),
      };
    },
  };
}

interface PreparedLayer {
  sourceId: SourceId;
  serviceId: string;
  endpoint: string;
  request: ServiceLayerEditsRequest;
}

function prepareLayers(dataset: Dataset, edits: readonly ServiceSourceEdits[]): PreparedLayer[] {
  if (!dataset.client.isGrpcWeb) {
    throw new HonuaCapabilityNotSupportedError("applyServiceEdits", "rest");
  }
  if (edits.length === 0) throw new Error("A service edit requires at least one source.");
  const layers = edits.map((entry) => prepareLayer(dataset, entry));
  const endpoint = trimTrailingSlashes(new URL(dataset.client.serverBaseUrl).href);
  for (const layer of layers) {
    if (layer.serviceId !== layers[0].serviceId || layer.endpoint !== endpoint) {
      throw new Error("Service edits require sources from the same service and endpoint.");
    }
  }
  assertDistinctServiceLayers({ serviceId: layers[0].serviceId, edits: layers.map((layer) => layer.request) });
  return layers;
}

function prepareLayer(dataset: Dataset, entry: ServiceSourceEdits): PreparedLayer {
  const source = dataset.source(entry.sourceId);
  if (!source) throw new Error(`Source "${entry.sourceId}" is not registered in this dataset.`);
  const descriptor = source.descriptor;
  if (descriptor.protocol !== "grpc" || !source.supports("applyEdits")) {
    throw new HonuaCapabilityNotSupportedError("applyServiceEdits", descriptor.protocol, entry.sourceId);
  }
  const { serviceId, layerId } = nativeLayerIdentity(descriptor);
  const envelope: EditEnvelope = entry.edits;
  if (envelope.signal !== undefined || envelope.rollbackOnFailure !== undefined) {
    throw new Error("Cancellation and rollback must be set on the whole service edit.");
  }
  const request = toApplyEditsRequest(envelope, descriptor.schema?.primaryKey);
  return {
    sourceId: entry.sourceId,
    serviceId,
    endpoint: trimTrailingSlashes(new URL(descriptor.locator.url).href),
    request: { ...request, layerId, objectIdField: descriptor.schema?.primaryKey },
  };
}

const MAX_LAYER_ID = 2_147_483_647;

function nativeLayerIdentity(descriptor: SourceDescriptor): { serviceId: string; layerId: number } {
  const { serviceId, layerId } = descriptor.locator;
  if (
    !serviceId?.trim() ||
    layerId === undefined ||
    !Number.isInteger(layerId) ||
    layerId < 0 ||
    layerId > MAX_LAYER_ID
  ) {
    throw new Error(`Source "${descriptor.id}" requires a service ID and a nonnegative int32 layer ID.`);
  }
  return { serviceId, layerId };
}
