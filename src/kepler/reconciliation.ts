/**
 * Snapshot replacement and bounded delta reconciliation (REQ-005).
 *
 * The bridge never silently rebuilds a Kepler workspace. A reconciliation
 * either produces bounded row operations against the dataset already loaded, or
 * it returns a single `rebuild-workspace` operation carrying an explicit
 * {@link KeplerRebuildReason} the caller must act on.
 *
 * Reconciliation is a pure function over
 * {@link KeplerWorkspaceDatasetState}: it returns the operations to dispatch
 * plus the next state, so a caller can drive it from realtime events, a
 * reconnect resume, or a test fixture without owning Kepler's store.
 *
 * @experimental
 * @module
 */

import { normalizeKeplerValue } from "./fields.js";
import { jsonByteLength, pointCoordinates, toKeplerGeoJsonGeometry } from "./geometry.js";
import { DEFAULT_KEPLER_BRIDGE_LIMITS } from "./ingest.js";
import type { KeplerBridgeLimits, KeplerDatasetMetadata, KeplerDatasetProjection, KeplerField } from "./types.js";
import { HonuaKeplerBridgeError } from "./types.js";

/** Live state the bridge tracks for one open Kepler dataset. */
export interface KeplerWorkspaceDatasetState {
  readonly datasetId: string;
  readonly fields: readonly KeplerField[];
  readonly rows: ReadonlyArray<readonly unknown[]>;
  /** Row identity is mandatory for bounded deltas. */
  readonly rowIdentityField?: string;
  readonly schemaVersion?: string;
  readonly planId?: string;
  readonly authorizationScope?: string;
  /** Resume cursor of the last applied event. */
  readonly cursor?: string;
  /** Columns a point layer binds to, when geometry is a lon/lat pair. */
  readonly pointColumns?: { readonly longitude: string; readonly latitude: string };
}

export type KeplerRebuildReason =
  | "schema-changed"
  | "plan-identity-changed"
  | "authorization-scope-changed"
  | "missing-row-identity"
  | "resume-gap"
  | "delta-budget-exceeded"
  | "row-budget-exceeded";

export interface KeplerDeltaUpsert {
  readonly id: string | number;
  readonly attributes: Readonly<Record<string, unknown>>;
  readonly geometry?: unknown;
}

export interface KeplerDeltaDelete {
  readonly id: string | number;
}

/**
 * Reconciliation input. Structurally compatible with
 * `@honua/sdk-js/realtime`'s snapshot and delta events, so a resumable
 * subscription can feed this directly.
 */
export type KeplerReconciliationEvent =
  | {
      readonly type: "snapshot";
      readonly projection: KeplerDatasetProjection;
      readonly cursor?: string;
    }
  | {
      readonly type: "delta";
      readonly upserts?: readonly KeplerDeltaUpsert[];
      readonly deletes?: readonly KeplerDeltaDelete[];
      readonly cursor?: string;
      /** Cursor the producer expected the consumer to already hold. */
      readonly expectedPreviousCursor?: string;
      readonly schemaVersion?: string;
      readonly planId?: string;
      readonly authorizationScope?: string;
    };

export type KeplerReconciliationOperation =
  | {
      readonly kind: "replace-rows";
      readonly datasetId: string;
      readonly fields: readonly KeplerField[];
      readonly rows: ReadonlyArray<readonly unknown[]>;
    }
  | {
      readonly kind: "update-rows";
      readonly datasetId: string;
      readonly updates: ReadonlyArray<{ readonly rowIndex: number; readonly row: readonly unknown[] }>;
    }
  | {
      readonly kind: "append-rows";
      readonly datasetId: string;
      readonly rows: ReadonlyArray<readonly unknown[]>;
    }
  | {
      readonly kind: "remove-rows";
      readonly datasetId: string;
      /** Descending row indexes so a caller can splice safely. */
      readonly rowIndexes: readonly number[];
    }
  | {
      readonly kind: "rebuild-workspace";
      readonly datasetId: string;
      readonly reason: KeplerRebuildReason;
      readonly detail: string;
    };

export interface KeplerReconciliationDiagnostic {
  readonly mode: "snapshot-replace" | "bounded-delta" | "rebuild-required";
  readonly bounded: boolean;
  readonly rowsAppended: number;
  readonly rowsUpdated: number;
  readonly rowsRemoved: number;
  readonly rowsUnmatchedDeletes: number;
  readonly rebuildReason?: KeplerRebuildReason;
  readonly detail: string;
}

export interface KeplerReconciliationPlan {
  readonly operations: readonly KeplerReconciliationOperation[];
  readonly diagnostic: KeplerReconciliationDiagnostic;
  /** Next dataset state. Absent when a rebuild is required. */
  readonly nextState?: KeplerWorkspaceDatasetState;
}

function fieldsEqual(left: readonly KeplerField[], right: readonly KeplerField[]): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index].name !== right[index].name || left[index].type !== right[index].type) return false;
  }
  return true;
}

function rebuild(
  datasetId: string,
  reason: KeplerRebuildReason,
  detail: string,
  counts?: Partial<Pick<KeplerReconciliationDiagnostic, "rowsAppended" | "rowsUpdated" | "rowsRemoved">>,
): KeplerReconciliationPlan {
  return Object.freeze({
    operations: Object.freeze([Object.freeze({ kind: "rebuild-workspace" as const, datasetId, reason, detail })]),
    diagnostic: Object.freeze({
      mode: "rebuild-required" as const,
      bounded: false,
      rowsAppended: counts?.rowsAppended ?? 0,
      rowsUpdated: counts?.rowsUpdated ?? 0,
      rowsRemoved: counts?.rowsRemoved ?? 0,
      rowsUnmatchedDeletes: 0,
      rebuildReason: reason,
      detail,
    }),
  });
}

/** Build the identity → row-index map for a dataset state. */
function rowIndexById(state: KeplerWorkspaceDatasetState, identityIndex: number): Map<string, number> {
  const index = new Map<string, number>();
  for (let rowIndex = 0; rowIndex < state.rows.length; rowIndex += 1) {
    const value = state.rows[rowIndex][identityIndex];
    if (value === null || value === undefined) continue;
    index.set(String(value), rowIndex);
  }
  return index;
}

/** Project one delta record through the dataset's already-fixed field plan. */
function buildRow(state: KeplerWorkspaceDatasetState, upsert: KeplerDeltaUpsert): unknown[] {
  const point = state.pointColumns === undefined ? undefined : pointCoordinates(upsert.geometry);
  const row: unknown[] = [];
  for (const field of state.fields) {
    if (state.pointColumns !== undefined && field.name === state.pointColumns.longitude) {
      row.push(point?.[0] ?? null);
      continue;
    }
    if (state.pointColumns !== undefined && field.name === state.pointColumns.latitude) {
      row.push(point?.[1] ?? null);
      continue;
    }
    if (field.type === "geojson") {
      const geometry = toKeplerGeoJsonGeometry(upsert.geometry);
      row.push(geometry === null ? null : { type: "Feature", geometry, properties: {} });
      continue;
    }
    row.push(normalizeKeplerValue(upsert.attributes[field.name], field.type));
  }
  return row;
}

function estimateRowBytes(rows: ReadonlyArray<readonly unknown[]>): number {
  let bytes = 0;
  for (const row of rows) {
    for (const value of row) {
      if (typeof value === "string") bytes += 2 * value.length;
      else if (value !== null && typeof value === "object") bytes += jsonByteLength(value);
      else bytes += 8;
    }
  }
  return bytes;
}

/** Dataset state for a freshly opened projection. */
export function keplerDatasetStateFromProjection(
  projection: KeplerDatasetProjection,
  cursor?: string,
): KeplerWorkspaceDatasetState {
  const metadata: KeplerDatasetMetadata = projection.dataset.metadata;
  return Object.freeze({
    datasetId: projection.dataset.info.id,
    fields: projection.dataset.data.fields,
    rows: projection.dataset.data.rows,
    ...(metadata.rowIdentityField === undefined ? {} : { rowIdentityField: metadata.rowIdentityField }),
    ...(metadata.provenance.schemaVersion === undefined ? {} : { schemaVersion: metadata.provenance.schemaVersion }),
    ...(metadata.provenance.planId === undefined ? {} : { planId: metadata.provenance.planId }),
    ...(metadata.provenance.authorizationScope === undefined
      ? {}
      : { authorizationScope: metadata.provenance.authorizationScope }),
    ...(metadata.pointColumns === undefined ? {} : { pointColumns: metadata.pointColumns }),
    ...(cursor === undefined ? {} : { cursor }),
  });
}

/**
 * Reconcile one snapshot or delta event against the loaded Kepler dataset.
 *
 * A snapshot whose field plan is unchanged becomes a bounded `replace-rows`
 * operation. A delta becomes bounded `update-rows` / `append-rows` /
 * `remove-rows` operations. Anything the bridge cannot bound — a changed
 * schema, plan, or authorization scope, a resume gap, a missing row identity,
 * or a delta over budget — returns a single `rebuild-workspace` operation with
 * an explicit reason.
 */
export function reconcileKeplerDataset(
  state: KeplerWorkspaceDatasetState,
  event: KeplerReconciliationEvent,
  limits: KeplerBridgeLimits = DEFAULT_KEPLER_BRIDGE_LIMITS,
): KeplerReconciliationPlan {
  if (typeof state !== "object" || state === null || !Array.isArray(state.fields) || !Array.isArray(state.rows)) {
    throw new HonuaKeplerBridgeError(
      "invalid-request",
      "reconcileKeplerDataset requires a dataset state with fields and rows.",
    );
  }
  if (typeof event !== "object" || event === null) {
    throw new HonuaKeplerBridgeError("invalid-request", "reconcileKeplerDataset requires a snapshot or delta event.");
  }

  if (event.type === "snapshot") {
    const projection = event.projection;
    if (projection?.dataset?.info?.id !== state.datasetId) {
      throw new HonuaKeplerBridgeError(
        "unknown-dataset",
        `A snapshot for "${projection?.dataset?.info?.id}" cannot reconcile dataset "${state.datasetId}".`,
      );
    }
    const nextFields = projection.dataset.data.fields;
    if (!fieldsEqual(state.fields, nextFields)) {
      return rebuild(
        state.datasetId,
        "schema-changed",
        "The snapshot's field plan differs from the loaded dataset, so Kepler layer and filter bindings must be rebuilt.",
      );
    }
    const nextState = keplerDatasetStateFromProjection(projection, event.cursor ?? state.cursor);
    return Object.freeze({
      operations: Object.freeze([
        Object.freeze({
          kind: "replace-rows" as const,
          datasetId: state.datasetId,
          fields: nextFields,
          rows: projection.dataset.data.rows,
        }),
      ]),
      diagnostic: Object.freeze({
        mode: "snapshot-replace" as const,
        bounded: true,
        rowsAppended: 0,
        rowsUpdated: projection.dataset.data.rows.length,
        rowsRemoved: state.rows.length,
        rowsUnmatchedDeletes: 0,
        detail:
          "The field plan is unchanged, so the snapshot replaces the dataset rows in place without rebuilding the workspace.",
      }),
      nextState,
    });
  }

  if (state.rowIdentityField === undefined) {
    return rebuild(
      state.datasetId,
      "missing-row-identity",
      "The dataset was opened without a rowIdentityField, so delta rows cannot be addressed. Re-open it with a row identity or apply a full snapshot.",
    );
  }
  const identityIndex = state.fields.findIndex((field) => field.name === state.rowIdentityField);
  if (identityIndex < 0) {
    return rebuild(
      state.datasetId,
      "missing-row-identity",
      `The declared rowIdentityField "${state.rowIdentityField}" is not present in the loaded field plan.`,
    );
  }
  if (
    event.schemaVersion !== undefined &&
    state.schemaVersion !== undefined &&
    event.schemaVersion !== state.schemaVersion
  ) {
    return rebuild(
      state.datasetId,
      "schema-changed",
      `The delta declares schema "${event.schemaVersion}" but the workspace holds "${state.schemaVersion}".`,
    );
  }
  if (event.planId !== undefined && state.planId !== undefined && event.planId !== state.planId) {
    return rebuild(
      state.datasetId,
      "plan-identity-changed",
      `The delta declares plan "${event.planId}" but the workspace holds "${state.planId}"; results are not comparable.`,
    );
  }
  if (
    event.authorizationScope !== undefined &&
    state.authorizationScope !== undefined &&
    event.authorizationScope !== state.authorizationScope
  ) {
    return rebuild(
      state.datasetId,
      "authorization-scope-changed",
      "The delta was produced under a different authorization scope; rows from two scopes must never be merged.",
    );
  }
  if (event.expectedPreviousCursor !== undefined && event.expectedPreviousCursor !== state.cursor) {
    return rebuild(
      state.datasetId,
      "resume-gap",
      `The producer expected cursor "${event.expectedPreviousCursor}" but the workspace holds "${state.cursor ?? "none"}"; the delta stream has a gap.`,
    );
  }

  const upserts = event.upserts ?? [];
  const deletes = event.deletes ?? [];
  const touched = upserts.length + deletes.length;
  if (touched > limits.maxDeltaRows) {
    return rebuild(
      state.datasetId,
      "delta-budget-exceeded",
      `The delta touches ${touched} rows, over the ${limits.maxDeltaRows}-row bounded-delta budget.`,
    );
  }

  const index = rowIndexById(state, identityIndex);
  const rows = state.rows.map((row) => row);
  const updates: Array<{ rowIndex: number; row: readonly unknown[] }> = [];
  const appends: Array<readonly unknown[]> = [];

  for (const upsert of upserts) {
    if (
      upsert === null ||
      typeof upsert !== "object" ||
      (typeof upsert.id !== "string" && typeof upsert.id !== "number")
    ) {
      throw new HonuaKeplerBridgeError("invalid-request", "Every delta upsert requires a string or number id.");
    }
    if (typeof upsert.attributes !== "object" || upsert.attributes === null) {
      throw new HonuaKeplerBridgeError(
        "invalid-request",
        `Delta upsert "${String(upsert.id)}" requires an attributes object.`,
      );
    }
    const row = buildRow(state, upsert);
    const existing = index.get(String(upsert.id));
    if (existing === undefined) {
      index.set(String(upsert.id), rows.length);
      rows.push(row);
      appends.push(row);
    } else {
      rows[existing] = row;
      updates.push({ rowIndex: existing, row });
    }
  }

  const removedIndexes: number[] = [];
  let unmatched = 0;
  for (const remove of deletes) {
    const existing = index.get(String(remove?.id));
    if (existing === undefined) {
      unmatched += 1;
      continue;
    }
    removedIndexes.push(existing);
  }
  removedIndexes.sort((left, right) => right - left);
  for (const rowIndex of removedIndexes) rows.splice(rowIndex, 1);

  if (rows.length > limits.maxRowsPerDataset) {
    return rebuild(
      state.datasetId,
      "row-budget-exceeded",
      `Applying the delta would grow the dataset to ${rows.length} rows, over the ${limits.maxRowsPerDataset}-row budget.`,
      { rowsAppended: appends.length, rowsUpdated: updates.length, rowsRemoved: removedIndexes.length },
    );
  }
  const bytes = estimateRowBytes(rows);
  if (bytes > limits.maxRetainedRowBytes) {
    return rebuild(
      state.datasetId,
      "row-budget-exceeded",
      `Applying the delta would retain approximately ${bytes} bytes, over the ${limits.maxRetainedRowBytes}-byte budget.`,
      { rowsAppended: appends.length, rowsUpdated: updates.length, rowsRemoved: removedIndexes.length },
    );
  }

  const operations: KeplerReconciliationOperation[] = [];
  if (updates.length > 0) {
    operations.push(
      Object.freeze({ kind: "update-rows" as const, datasetId: state.datasetId, updates: Object.freeze(updates) }),
    );
  }
  if (appends.length > 0) {
    operations.push(
      Object.freeze({ kind: "append-rows" as const, datasetId: state.datasetId, rows: Object.freeze(appends) }),
    );
  }
  if (removedIndexes.length > 0) {
    operations.push(
      Object.freeze({
        kind: "remove-rows" as const,
        datasetId: state.datasetId,
        rowIndexes: Object.freeze(removedIndexes),
      }),
    );
  }

  return Object.freeze({
    operations: Object.freeze(operations),
    diagnostic: Object.freeze({
      mode: "bounded-delta" as const,
      bounded: true,
      rowsAppended: appends.length,
      rowsUpdated: updates.length,
      rowsRemoved: removedIndexes.length,
      rowsUnmatchedDeletes: unmatched,
      detail:
        unmatched === 0
          ? "The delta was applied as bounded row operations against the loaded dataset."
          : `The delta was applied as bounded row operations; ${unmatched} delete(s) referenced rows this workspace never held.`,
    }),
    nextState: Object.freeze({
      ...state,
      rows: Object.freeze(rows),
      ...(event.cursor === undefined ? {} : { cursor: event.cursor }),
    }),
  });
}
