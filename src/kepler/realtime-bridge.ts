/**
 * Adapters from the repository's real realtime event shapes
 * (`@honua/sdk-js/realtime`) into this bridge's reconciliation inputs.
 *
 * The two models are close but not identical, and the difference is not
 * cosmetic:
 *
 * - `RealtimeFeaturePatch` carries the row under `feature` (an adapter-shaped
 *   payload), while {@link KeplerDeltaUpsert} needs `attributes` plus optional
 *   `geometry` so it can be projected through the dataset's fixed field plan.
 * - `RealtimeSnapshotEvent` carries `features`, not an already-projected
 *   {@link KeplerDatasetProjection} — a snapshot has to be re-projected before
 *   it can replace rows.
 *
 * These functions close that gap explicitly rather than leaving callers to
 * hand-roll a mapping that silently produces empty attribute rows.
 *
 * @experimental
 * @module
 */

import type {
  RealtimeDeleteEvent,
  RealtimeDeltaEvent,
  RealtimeFeaturePatch,
  RealtimeSnapshotEvent,
  RealtimeUpsertEvent,
} from "../realtime/types.js";
import { DEFAULT_KEPLER_BRIDGE_LIMITS, projectResultToKeplerDataset } from "./ingest.js";
import type { KeplerDeltaDelete, KeplerDeltaUpsert, KeplerReconciliationEvent } from "./reconciliation.js";
import type { KeplerBridgeLimits, KeplerResultProjectionRequest } from "./types.js";
import { HonuaKeplerBridgeError } from "./types.js";

/** The `{ attributes, geometry }` shape every Kepler projection consumes. */
export interface KeplerFeatureShape {
  readonly attributes: Readonly<Record<string, unknown>>;
  readonly geometry?: unknown;
}

/**
 * Projects one realtime `feature` payload onto `{ attributes, geometry }`.
 * Supply this whenever a subscription carries an adapter-specific shape the
 * default cannot recognize.
 */
export type KeplerRealtimeFeatureProjector<TFeature> = (feature: TFeature, id: string | number) => KeplerFeatureShape;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Default projection covering the shapes Honua subscriptions actually emit:
 *
 * - a canonical `HonuaTypedFeature` (`{ attributes, geometry? }`),
 * - a GeoJSON `Feature` (`{ properties, geometry }`),
 * - a plain attribute record (everything else object-shaped).
 */
export function defaultKeplerRealtimeFeatureProjector(feature: unknown): KeplerFeatureShape {
  if (!isRecord(feature)) {
    throw new HonuaKeplerBridgeError(
      "invalid-request",
      "A realtime feature payload must be an object; supply projectFeature for a scalar or adapter-specific shape.",
    );
  }
  if (isRecord(feature["attributes"])) {
    return {
      attributes: feature["attributes"],
      ...("geometry" in feature ? { geometry: feature["geometry"] } : {}),
    };
  }
  if (feature["type"] === "Feature") {
    const properties = feature["properties"];
    return {
      attributes: isRecord(properties) ? properties : {},
      ...("geometry" in feature ? { geometry: feature["geometry"] } : {}),
    };
  }
  const { geometry, ...attributes } = feature;
  return {
    attributes,
    ...(geometry === undefined ? {} : { geometry }),
  };
}

export interface KeplerRealtimeAdapterOptions<TFeature> {
  readonly projectFeature?: KeplerRealtimeFeatureProjector<TFeature>;
  /**
   * Cursor the producer expects the workspace to already hold. Realtime events
   * do not carry it, so a caller driving resume semantics supplies it here to
   * get a `resume-gap` rebuild instead of a silently misapplied delta.
   */
  readonly expectedPreviousCursor?: string;
  readonly schemaVersion?: string;
  readonly planId?: string;
  readonly authorizationScope?: string;
}

function projectPatch<TFeature>(
  patch: RealtimeFeaturePatch<TFeature>,
  options: KeplerRealtimeAdapterOptions<TFeature>,
): KeplerDeltaUpsert {
  if (!isRecord(patch) || (typeof patch.id !== "string" && typeof patch.id !== "number")) {
    throw new HonuaKeplerBridgeError("invalid-request", "A realtime feature patch requires a string or number id.");
  }
  const shape = options.projectFeature
    ? options.projectFeature(patch.feature, patch.id)
    : defaultKeplerRealtimeFeatureProjector(patch.feature);
  if (!isRecord(shape?.attributes)) {
    throw new HonuaKeplerBridgeError(
      "invalid-request",
      `projectFeature must return an attributes object for realtime feature "${String(patch.id)}".`,
      { id: patch.id },
    );
  }
  return {
    id: patch.id,
    attributes: shape.attributes,
    ...(shape.geometry === undefined ? {} : { geometry: shape.geometry }),
  };
}

/**
 * Convert a realtime `delta`, `upsert`, or `delete` event into the bridge's
 * delta reconciliation input. `deletes` map straight across (both sides
 * address rows by `FeatureId`); `upserts` are projected out of the patch's
 * `feature` payload.
 */
export function keplerDeltaFromRealtimeEvent<TFeature>(
  event: RealtimeDeltaEvent<TFeature> | RealtimeUpsertEvent<TFeature> | RealtimeDeleteEvent,
  options: KeplerRealtimeAdapterOptions<TFeature> = {},
): Extract<KeplerReconciliationEvent, { type: "delta" }> {
  if (!isRecord(event)) {
    throw new HonuaKeplerBridgeError("invalid-request", "keplerDeltaFromRealtimeEvent requires a realtime event.");
  }
  const upserts: KeplerDeltaUpsert[] = [];
  const deletes: KeplerDeltaDelete[] = [];

  if (event.type === "delta") {
    for (const patch of event.upserts ?? []) upserts.push(projectPatch(patch, options));
    for (const removal of event.deletes ?? []) {
      if (typeof removal?.id !== "string" && typeof removal?.id !== "number") {
        throw new HonuaKeplerBridgeError("invalid-request", "A realtime delete patch requires a string or number id.");
      }
      deletes.push({ id: removal.id });
    }
  } else if (event.type === "upsert") {
    upserts.push(projectPatch(event.feature, options));
  } else if (event.type === "delete") {
    if (typeof event.id !== "string" && typeof event.id !== "number") {
      throw new HonuaKeplerBridgeError("invalid-request", "A realtime delete event requires a string or number id.");
    }
    deletes.push({ id: event.id });
  } else {
    throw new HonuaKeplerBridgeError(
      "invalid-request",
      `Realtime event type "${String((event as { type?: unknown }).type)}" carries no rows to reconcile.`,
    );
  }

  return Object.freeze({
    type: "delta" as const,
    ...(upserts.length > 0 ? { upserts: Object.freeze(upserts) } : {}),
    ...(deletes.length > 0 ? { deletes: Object.freeze(deletes) } : {}),
    ...(event.cursor === undefined ? {} : { cursor: event.cursor }),
    ...(options.expectedPreviousCursor === undefined ? {} : { expectedPreviousCursor: options.expectedPreviousCursor }),
    ...(options.schemaVersion === undefined ? {} : { schemaVersion: options.schemaVersion }),
    ...(options.planId === undefined ? {} : { planId: options.planId }),
    ...(options.authorizationScope === undefined ? {} : { authorizationScope: options.authorizationScope }),
  });
}

export interface KeplerRealtimeSnapshotOptions<TFeature> extends KeplerRealtimeAdapterOptions<TFeature> {
  readonly limits?: KeplerBridgeLimits;
}

/**
 * Convert a realtime `snapshot` event into the bridge's snapshot
 * reconciliation input by re-projecting its `features` through the same
 * ingestion mapping `openResult` uses. `request` supplies everything the
 * projection needs beyond the rows themselves (dataset id, provenance, row
 * identity, temporal fields, CRS).
 */
export function keplerSnapshotFromRealtimeEvent<TFeature>(
  event: RealtimeSnapshotEvent<TFeature>,
  request: Omit<KeplerResultProjectionRequest, "result">,
  options: KeplerRealtimeSnapshotOptions<TFeature> = {},
): Extract<KeplerReconciliationEvent, { type: "snapshot" }> {
  if (!isRecord(event) || event.type !== "snapshot" || !Array.isArray(event.features)) {
    throw new HonuaKeplerBridgeError(
      "invalid-request",
      "keplerSnapshotFromRealtimeEvent requires a realtime snapshot event carrying features.",
    );
  }
  const features = event.features.map((patch) => {
    const upsert = projectPatch(patch, options);
    return {
      attributes: upsert.attributes,
      ...(upsert.geometry === undefined ? {} : { geometry: upsert.geometry }),
    };
  });
  const projection = projectResultToKeplerDataset(
    { ...request, result: { features, exceededTransferLimit: false } },
    options.limits ?? DEFAULT_KEPLER_BRIDGE_LIMITS,
  );
  return Object.freeze({
    type: "snapshot" as const,
    projection,
    ...(event.cursor === undefined ? {} : { cursor: event.cursor }),
  });
}
