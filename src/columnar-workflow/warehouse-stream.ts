import {
  type ColumnarBatchMetrics,
  type ColumnarBatchV1,
  type ColumnarResult,
  columnarBatchToResult,
  inspectColumnarBatch,
} from "../columnar/index.js";
import { HonuaAbortError, HonuaCapabilityNotSupportedError } from "../core/errors.js";
import {
  type GeoArrowLineDeckGlBinding,
  type GeoArrowPointDeckGlBinding,
  type GeoArrowPolygonDeckGlBinding,
  bindGeoArrowLineBatchToDeckGl,
  bindGeoArrowPointBatchToDeckGl,
  bindGeoArrowPolygonBatchToDeckGl,
} from "../deckgl/columnar.js";
import { settleOrAbort } from "../export/abort.js";
import {
  type AcceptedWarehouseExecutionPlan,
  DEFAULT_WAREHOUSE_MAX_OBJECT_MATERIALIZATION_ROWS,
  type WarehouseExecutionReconciliation,
  reconcileWarehouseExecutionMetrics,
  warehouseExecutionDeadlineMs,
} from "./warehouse-plan.js";
import { HonuaWarehouseError } from "./warehouse-security.js";

export interface WarehouseColumnarStreamBudgets {
  readonly maxRows: number;
  readonly maxBatches: number;
  readonly maxTransferBytes: number;
  readonly maxBackingBytes: number;
  readonly maxObjectMaterializationRows?: number;
}

export const DEFAULT_WAREHOUSE_STREAM_BUDGETS: WarehouseColumnarStreamBudgets = Object.freeze({
  maxRows: 250_000,
  maxBatches: 256,
  maxTransferBytes: 64 * 1024 * 1024,
  maxBackingBytes: 64 * 1024 * 1024,
  maxObjectMaterializationRows: DEFAULT_WAREHOUSE_MAX_OBJECT_MATERIALIZATION_ROWS,
});

export interface WarehouseColumnarBatchChunk {
  readonly batch: ColumnarBatchV1;
  readonly transferBytes: number;
}

export interface WarehouseStreamTransportRequest {
  readonly plan: AcceptedWarehouseExecutionPlan;
  readonly signal: AbortSignal;
}

export type WarehouseColumnarStreamTransport = (
  request: WarehouseStreamTransportRequest,
) => AsyncIterable<WarehouseColumnarBatchChunk>;

export interface WarehouseStreamProgress {
  readonly batches: number;
  readonly rows: number;
  readonly transferBytes: number;
  readonly peakBackingBytes: number;
}

export interface WarehouseStreamBatch {
  readonly batch: ColumnarBatchV1;
  readonly metrics: ColumnarBatchMetrics;
  readonly progress: WarehouseStreamProgress;
}

export interface WarehouseStreamExecutionOptions {
  readonly budgets?: Partial<WarehouseColumnarStreamBudgets>;
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: WarehouseStreamProgress) => void;
  readonly now?: () => number;
}

export interface WarehouseStreamExecutionReceipt {
  readonly planId: string;
  readonly sourceId: string;
  readonly provider: AcceptedWarehouseExecutionPlan["provider"];
  readonly batches: readonly WarehouseStreamBatch[];
  readonly totals: WarehouseStreamProgress;
  readonly reconciliation: WarehouseExecutionReconciliation;
}

export type WarehouseDeckGlGeometryKind = "point" | "line" | "polygon";

export type WarehouseDeckGlHandoff =
  | ({ readonly kind: "deck.gl"; readonly geometry: "point" } & GeoArrowPointDeckGlBinding)
  | ({ readonly kind: "deck.gl"; readonly geometry: "line" } & GeoArrowLineDeckGlBinding)
  | ({ readonly kind: "deck.gl"; readonly geometry: "polygon" } & GeoArrowPolygonDeckGlBinding);

export interface WarehouseMapLibreHandoff {
  readonly kind: "maplibre-geojson";
  readonly sourceId: string;
  readonly planId: string;
  readonly policyScopeFingerprint: string;
  readonly result: ColumnarResult;
  readonly geojson: {
    readonly type: "FeatureCollection";
    readonly features: readonly {
      readonly type: "Feature";
      readonly id?: string | number;
      readonly geometry: unknown;
      readonly properties: Readonly<Record<string, unknown>>;
    }[];
  };
}

function resolveStreamBudgets(
  plan: AcceptedWarehouseExecutionPlan,
  overrides?: Partial<WarehouseColumnarStreamBudgets>,
): WarehouseColumnarStreamBudgets {
  const maxRows = Math.min(
    overrides?.maxRows ?? DEFAULT_WAREHOUSE_STREAM_BUDGETS.maxRows,
    plan.budgets.maxReturnedRows ?? Number.MAX_SAFE_INTEGER,
  );
  const maxTransferBytes = Math.min(
    overrides?.maxTransferBytes ?? DEFAULT_WAREHOUSE_STREAM_BUDGETS.maxTransferBytes,
    plan.budgets.maxTransferBytes ?? Number.MAX_SAFE_INTEGER,
  );
  const maxBackingBytes = Math.min(
    overrides?.maxBackingBytes ?? DEFAULT_WAREHOUSE_STREAM_BUDGETS.maxBackingBytes,
    plan.budgets.maxReturnedBytes ?? Number.MAX_SAFE_INTEGER,
  );
  const maxBatches = overrides?.maxBatches ?? DEFAULT_WAREHOUSE_STREAM_BUDGETS.maxBatches;
  const maxObjectMaterializationRows =
    overrides?.maxObjectMaterializationRows ??
    plan.budgets.maxObjectMaterializationRows ??
    DEFAULT_WAREHOUSE_MAX_OBJECT_MATERIALIZATION_ROWS;
  for (const [name, value] of Object.entries({ maxRows, maxBatches, maxTransferBytes, maxBackingBytes })) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new HonuaWarehouseError("budget-exceeded", `Stream budget ${name} must be a positive safe integer.`);
    }
  }
  return Object.freeze({ maxRows, maxBatches, maxTransferBytes, maxBackingBytes, maxObjectMaterializationRows });
}

function assertBatchIdentityMatchesPlan(batch: ColumnarBatchV1, plan: AcceptedWarehouseExecutionPlan): void {
  const identity = batch.identity;
  if (!identity) {
    throw new HonuaWarehouseError(
      "corrupt-batch",
      `Columnar batch "${batch.id}" is missing required identity metadata.`,
    );
  }
  if (
    identity.sourceId !== plan.sourceId ||
    identity.planId !== plan.planId ||
    identity.authorizationScope !== plan.policyScopeFingerprint
  ) {
    throw new HonuaWarehouseError(
      "corrupt-batch",
      `Columnar batch "${batch.id}" identity does not match accepted plan "${plan.planId}" and policy scope.`,
      { batchId: batch.id, expectedPlanId: plan.planId, actualPlanId: identity.planId },
    );
  }
}

function assertStreamChunk(chunk: WarehouseColumnarBatchChunk, signal: AbortSignal): void {
  if (signal.aborted) throw new HonuaAbortError("Warehouse columnar stream was aborted.");
  if (!Number.isFinite(chunk.transferBytes) || chunk.transferBytes < 0) {
    throw new HonuaWarehouseError("corrupt-batch", "Batch chunk transferBytes must be a non-negative finite number.");
  }
}

function lockBatchSchema(batch: ColumnarBatchV1, expected?: string): string {
  const actual = batch.schema.id;
  if (expected !== undefined && actual !== expected) {
    throw new HonuaWarehouseError("schema-drift", `Schema drifted mid-stream from "${expected}" to "${actual}".`, {
      expectedSchemaId: expected,
      actualSchemaId: actual,
    });
  }
  return actual;
}

function enforceStreamLimit(
  controller: AbortController,
  label: string,
  { observed, limit }: { observed: number; limit: number },
): void {
  if (observed <= limit) return;
  controller.abort();
  throw new HonuaWarehouseError("budget-exceeded", `${label} ${observed} exceeded limit ${limit}.`, {
    limit,
    observed,
  });
}

async function* abortableChunks(
  chunks: AsyncIterable<WarehouseColumnarBatchChunk>,
  signal: AbortSignal,
): AsyncIterable<WarehouseColumnarBatchChunk> {
  const iterator = chunks[Symbol.asyncIterator]();
  const advance = () => settleOrAbort(Promise.resolve(iterator.next()), signal);
  let done = false;
  try {
    let next = await advance();
    for (; !next.done; next = await advance()) yield next.value;
    done = true;
  } finally {
    if (!done)
      void Promise.resolve()
        .then(() => iterator.return?.())
        .catch(() => undefined);
  }
}

function scheduleStreamDeadline(plan: AcceptedWarehouseExecutionPlan, controller: AbortController) {
  const deadline = warehouseExecutionDeadlineMs(plan);
  if (deadline === Number.POSITIVE_INFINITY) return;
  if (!Number.isFinite(deadline) || deadline <= 0 || deadline > 2 ** 31 - 1) {
    throw new HonuaWarehouseError("plan-invalid", "Warehouse stream deadline is outside the supported duration.");
  }
  return setTimeout(() => controller.abort(new HonuaAbortError("Warehouse stream deadline exceeded.")), deadline);
}

/** Stream bounded Arrow/GeoArrow batches for an accepted warehouse plan with cooperative cancellation and budget guards. */
export async function* executeWarehouseColumnarStream(
  plan: AcceptedWarehouseExecutionPlan,
  transport: WarehouseColumnarStreamTransport,
  options: WarehouseStreamExecutionOptions = {},
): AsyncIterable<WarehouseStreamBatch> {
  if (plan.representation !== "geoarrow" && plan.representation !== "geoparquet") {
    throw new HonuaCapabilityNotSupportedError("columnar-stream", `warehouse:${plan.provider}`, plan.sourceId, {
      context: { representation: plan.representation },
    });
  }
  if (options.signal?.aborted) throw new HonuaAbortError("Warehouse columnar stream was aborted before start.");

  const budgets = resolveStreamBudgets(plan, options.budgets);
  const controller = new AbortController();
  const deadlineTimer = scheduleStreamDeadline(plan, controller);
  const forwardAbort = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener("abort", forwardAbort, { once: true });

  let batches = 0;
  let rows = 0;
  let transferBytes = 0;
  let peakBackingBytes = 0;
  let returnedBytes = 0;
  const maxReturnedBytes = plan.budgets.maxReturnedBytes ?? Number.MAX_SAFE_INTEGER;
  let lockedSchemaId: string | undefined;
  let completed = false;

  try {
    for await (const chunk of abortableChunks(transport({ plan, signal: controller.signal }), controller.signal)) {
      assertStreamChunk(chunk, controller.signal);
      const metrics = inspectColumnarBatch(chunk.batch, {
        maxRows: budgets.maxRows,
        maxBackingBytes: budgets.maxBackingBytes,
      });
      assertBatchIdentityMatchesPlan(chunk.batch, plan);
      lockedSchemaId = lockBatchSchema(chunk.batch, lockedSchemaId);

      batches += 1;
      rows += metrics.rows;
      transferBytes += chunk.transferBytes;
      peakBackingBytes = Math.max(peakBackingBytes, metrics.backingBytes);
      returnedBytes += metrics.backingBytes;

      enforceStreamLimit(controller, "Returned bytes", { observed: returnedBytes, limit: maxReturnedBytes });
      enforceStreamLimit(controller, "Batch count", { observed: batches, limit: budgets.maxBatches });
      enforceStreamLimit(controller, "Row count", { observed: rows, limit: budgets.maxRows });
      enforceStreamLimit(controller, "Transferred bytes", { observed: transferBytes, limit: budgets.maxTransferBytes });

      const progress: WarehouseStreamProgress = Object.freeze({ batches, rows, transferBytes, peakBackingBytes });
      options.onProgress?.(progress);
      yield Object.freeze({ batch: chunk.batch, metrics, progress });
    }
    if (options.signal?.aborted || controller.signal.aborted) {
      throw new HonuaAbortError("Warehouse columnar stream was aborted.");
    }
    completed = true;
  } catch (error) {
    if (controller.signal.reason instanceof HonuaAbortError) throw controller.signal.reason;
    throw error;
  } finally {
    if (!completed) controller.abort();
    clearTimeout(deadlineTimer);
    options.signal?.removeEventListener("abort", forwardAbort);
  }
}

/** Collect a bounded warehouse columnar stream and reconcile observed totals against the accepted plan. */
export async function collectWarehouseColumnarStream(
  plan: AcceptedWarehouseExecutionPlan,
  transport: WarehouseColumnarStreamTransport,
  options: WarehouseStreamExecutionOptions = {},
): Promise<WarehouseStreamExecutionReceipt> {
  const now = options.now ?? (() => Date.now());
  const started = now();
  const collected: WarehouseStreamBatch[] = [];
  const { maxBackingBytes } = resolveStreamBudgets(plan, options.budgets);
  let retainedBackingBytes = 0;
  let totals: WarehouseStreamProgress = { batches: 0, rows: 0, transferBytes: 0, peakBackingBytes: 0 };

  for await (const item of executeWarehouseColumnarStream(plan, transport, options)) {
    retainedBackingBytes += item.metrics.backingBytes;
    if (retainedBackingBytes > maxBackingBytes) {
      throw new HonuaWarehouseError(
        "budget-exceeded",
        `Collected backing bytes ${retainedBackingBytes} exceeded limit ${maxBackingBytes}.`,
        { limit: maxBackingBytes, observed: retainedBackingBytes },
      );
    }
    collected.push(item);
    totals = item.progress;
  }

  const reconciliation = reconcileWarehouseExecutionMetrics(plan, {
    returnedRows: totals.rows,
    returnedBytes: retainedBackingBytes,
    transferBytes: totals.transferBytes,
    elapsedMs: Math.max(0, now() - started),
  });

  return Object.freeze({
    planId: plan.planId,
    sourceId: plan.sourceId,
    provider: plan.provider,
    batches: Object.freeze(collected),
    totals: Object.freeze(totals),
    reconciliation,
  });
}

/** Zero-copy GPU-binary handoff from a normative GeoArrow warehouse batch directly to deck.gl. */
export function handoffWarehouseBatchToDeckGl(
  batch: ColumnarBatchV1,
  options: {
    readonly layerId: string;
    readonly geometry: WarehouseDeckGlGeometryKind;
    readonly props?: Readonly<Record<string, unknown>>;
  },
): WarehouseDeckGlHandoff {
  const request = { batch, layerId: options.layerId, ...(options.props ? { props: options.props } : {}) };
  if (options.geometry === "point") {
    return Object.freeze({
      kind: "deck.gl" as const,
      geometry: "point" as const,
      ...bindGeoArrowPointBatchToDeckGl(request),
    });
  }
  if (options.geometry === "line") {
    return Object.freeze({
      kind: "deck.gl" as const,
      geometry: "line" as const,
      ...bindGeoArrowLineBatchToDeckGl(request),
    });
  }
  return Object.freeze({
    kind: "deck.gl" as const,
    geometry: "polygon" as const,
    ...bindGeoArrowPolygonBatchToDeckGl(request),
  });
}

/** Bounded MapLibre GeoJSON handoff that refuses unbounded object materialization outside the plan budget. */
export function handoffWarehouseBatchToMapLibre(
  batch: ColumnarBatchV1,
  plan: AcceptedWarehouseExecutionPlan,
  options: { readonly maxFeatures?: number; readonly sourceId?: string } = {},
): WarehouseMapLibreHandoff {
  assertBatchIdentityMatchesPlan(batch, plan);
  const planCeiling = plan.budgets.maxObjectMaterializationRows ?? DEFAULT_WAREHOUSE_MAX_OBJECT_MATERIALIZATION_ROWS;
  const maxFeatures = Math.min(options.maxFeatures ?? planCeiling, planCeiling);
  if (batch.rowCount > maxFeatures) {
    throw new HonuaWarehouseError(
      "handoff-refused",
      `MapLibre GeoJSON handoff refused: batch has ${batch.rowCount} rows which exceeds the bounded object limit (${maxFeatures}). Render via deck.gl GeoArrow or vector tiles instead.`,
      { rowCount: batch.rowCount, maxFeatures },
    );
  }
  const result = columnarBatchToResult(batch, { maxFeatures });
  if (result.crs !== "OGC:CRS84" && result.features.some((feature) => feature.geometry != null)) {
    throw new HonuaWarehouseError(
      "handoff-refused",
      "MapLibre GeoJSON handoff requires longitude/latitude coordinates in OGC:CRS84.",
    );
  }
  const idAttribute = result.columnar.attributes.featureId?.attribute;
  const features = result.features.map((feature) => ({
    type: "Feature" as const,
    ...(idAttribute === undefined ? {} : { id: feature.attributes[idAttribute] as number }),
    geometry: feature.geometry ?? null,
    properties: Object.freeze({ ...(feature.attributes as Record<string, unknown>) }),
  }));
  return Object.freeze({
    kind: "maplibre-geojson",
    sourceId: options.sourceId ?? plan.sourceId,
    planId: plan.planId,
    policyScopeFingerprint: plan.policyScopeFingerprint,
    result,
    geojson: Object.freeze({ type: "FeatureCollection" as const, features: Object.freeze(features) }),
  });
}
