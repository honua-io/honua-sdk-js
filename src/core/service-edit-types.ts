import type { ApplyEditsRequest, HonuaApplyEditsResponse } from "./types.js";

/** One layer's edits inside {@link ApplyServiceEditsRequest}. */
export type ServiceLayerEditsRequest = Omit<
  ApplyEditsRequest,
  "serviceId" | "rollbackOnFailure" | "idempotencyKey" | "signal"
>;

/**
 * Edits to several layers of one service, applied in request order as one call. With
 * `rollbackOnFailure` (the default) the server commits all layers or none, so parent and
 * child rows land together.
 */
export interface ApplyServiceEditsRequest {
  serviceId: string;
  /** Distinct layers, executed in this order. */
  edits: readonly ServiceLayerEditsRequest[];
  rollbackOnFailure?: boolean;
  /** gRPC only: one retry identity for the whole request. */
  idempotencyKey?: string;
  signal?: AbortSignal;
}

/** Per-layer results of {@link ApplyServiceEditsRequest}, in request layer order. */
export interface HonuaApplyServiceEditsResponse {
  layers: Array<HonuaApplyEditsResponse & { layerId: number; error?: { code: number; description: string } }>;
}
