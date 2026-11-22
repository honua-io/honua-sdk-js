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
import {
  type AcceptedWarehouseExecutionPlan,
  DEFAULT_WAREHOUSE_MAX_OBJECT_MATERIALIZATION_ROWS,
  type WarehouseExecutionReconciliation,
  reconcileWarehouseExecutionMetrics,
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
  const forwardAbort = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener("abort", forwardAbort, { once: true });

  let batches = 0;
  let rows = 0;
  let transferBytes = 0;
  let peakBackingBytes = 0;
  let lockedSchemaId: string | undefined;

  try {
    for await (const chunk of transport({ plan, signal: controller.signal })) {
      if (options.signal?.aborted || controller.signal.aborted) {
        throw new HonuaAbortError("Warehouse columnar stream was aborted.");
      }
      if (!Number.isFinite(chunk.transferBytes) || chunk.transferBytes < 0) {
        throw new HonuaWarehouseError(
          "corrupt-batch",
          "Batch chunk transferBytes must be a non-negative finite number.",
        );
      }
      const metrics = inspectColumnarBatch(chunk.batch, {
        maxRows: budgets.maxRows,
        maxBackingBytes: budgets.maxBackingBytes,
      });
      assertBatchIdentityMatchesPlan(chunk.batch, plan);
      if (lockedSchemaId === undefined) {
        lockedSchemaId = chunk.batch.schema.id;
      } else if (chunk.batch.schema.id !== lockedSchemaId) {
        throw new HonuaWarehouseError(
          "schema-drift",
          `Schema drifted mid-stream from "${lockedSchemaId}" to "${chunk.batch.schema.id}".`,
          { expectedSchemaId: lockedSchemaId, actualSchemaId: chunk.batch.schema.id },
        );
      }

      batches += 1;
      rows += metrics.rows;
      transferBytes += chunk.transferBytes;
      peakBackingBytes = Math.max(peakBackingBytes, metrics.backingBytes);

      if (batches > budgets.maxBatches) {
        controller.abort();
        throw new HonuaWarehouseError(
          "budget-exceeded",
          `Batch count ${batches} exceeded limit ${budgets.maxBatches}.`,
          {
            limit: budgets.maxBatches,
            observed: batches,
          },
        );
      }
      if (rows > budgets.maxRows) {
        controller.abort();
        throw new HonuaWarehouseError("budget-exceeded", `Row count ${rows} exceeded limit ${budgets.maxRows}.`, {
          limit: budgets.maxRows,
          observed: rows,
        });
      }
      if (transferBytes > budgets.maxTransferBytes) {
        controller.abort();
        throw new HonuaWarehouseError(
          "budget-exceeded",
          `Transferred bytes ${transferBytes} exceeded limit ${budgets.maxTransferBytes}.`,
          { limit: budgets.maxTransferBytes, observed: transferBytes },
        );
      }
      if (metrics.backingBytes > budgets.maxBackingBytes) {
        controller.abort();
        throw new HonuaWarehouseError(
          "budget-exceeded",
          `Batch backing bytes ${metrics.backingBytes} exceeded limit ${budgets.maxBackingBytes}.`,
          { limit: budgets.maxBackingBytes, observed: metrics.backingBytes },
        );
      }

      const progress: WarehouseStreamProgress = Object.freeze({ batches, rows, transferBytes, peakBackingBytes });
      options.onProgress?.(progress);
      yield Object.freeze({ batch: chunk.batch, metrics, progress });
    }
    if (options.signal?.aborted || controller.signal.aborted) {
      throw new HonuaAbortError("Warehouse columnar stream was aborted.");
    }
  } finally {
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
  let totals: WarehouseStreamProgress = { batches: 0, rows: 0, transferBytes: 0, peakBackingBytes: 0 };

  for await (const item of executeWarehouseColumnarStream(plan, transport, options)) {
    collected.push(item);
    totals = item.progress;
  }

  const reconciliation = reconcileWarehouseExecutionMetrics(plan, {
    returnedRows: totals.rows,
    returnedBytes: totals.peakBackingBytes,
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
  const features = result.features.map((feature, index) => ({
    type: "Feature" as const,
    id: ((feature.attributes as Record<string, unknown>).id as string | number | undefined) ?? index,
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
