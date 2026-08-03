/**
 * Experimental accepted-plan Source -> Cesium entity workflow.
 *
 * The projection half is renderer-neutral and SSR safe. Cesium is resolved
 * only while mounting, either through an injected module/loader or a lazy
 * optional-peer import.
 *
 * @experimental Not covered by the pre-1.0 semver contract.
 */

import type { Result, Source } from "../contract/types.js";
import { HonuaCapabilityNotSupportedError } from "../core/errors.js";
import type { HonuaTypedFeature } from "../core/types.js";
import { canonicalStringify, toJsonValue } from "../query-planner/canonical.js";
import { queryFromCanonical, queryIrSourceIdentity } from "../query-planner/ir.js";
import { hashQueryPlanV1 } from "../query-planner/planner.js";
import {
  type ExecuteQueryPlanOptions,
  HonuaQueryPlanExecutionError,
  type QueryExecutionPlanV1,
} from "../query-planner/types.js";

export const DEFAULT_CESIUM_ENTITY_LIMIT = 10_000;

export type CesiumEntityWorkflowState = "ready" | "empty" | "degraded" | "disposing" | "disposed";
export type CesiumEntityDiagnosticCode =
  | "strategy-selected"
  | "empty-result"
  | "transfer-limit"
  | "source-degraded"
  | "geometry-unsupported"
  | "vertical-datum-unsupported"
  | "attributes-unsupported"
  | "identity-missing"
  | "time-interval-invalid"
  | "time-position-invalid"
  | "incremental-update"
  | "incremental-update-failed";

export interface CesiumEntityDiagnostic {
  readonly code: CesiumEntityDiagnosticCode;
  readonly severity: "info" | "warning";
  readonly stage: "project" | "execute" | "update" | "dispose";
  readonly fidelity: "exact" | "equivalent" | "unsupported";
  readonly sourceId: string;
  readonly planId: string;
  readonly message: string;
  readonly detail?: Readonly<Record<string, unknown>>;
}

export type CesiumEntityAdapterErrorCode =
  | "disposed"
  | "entity-conflict"
  | "entity-limit-exceeded"
  | "invalid-option"
  | "peer-unavailable"
  | "unsupported-crs"
  | "unsupported-plan"
  | "renderer-mutation-failed";

export class HonuaCesiumEntityAdapterError extends Error {
  public constructor(
    public readonly code: CesiumEntityAdapterErrorCode,
    message: string,
    public readonly detail?: Readonly<Record<string, unknown>>,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "HonuaCesiumEntityAdapterError";
  }
}

export interface CesiumEntityInterval {
  readonly start: string;
  readonly end: string;
}

export interface CesiumEntityPositionSample {
  readonly time: string;
  readonly coordinates: readonly [number, number, number];
}

/**
 * Temporal field mapping for accepted-plan entity projections.
 *
 * An instant is represented as a zero-duration Cesium availability interval,
 * preserving the source timestamp without inventing a playback duration.
 */
export type CesiumEntityTimeOptions =
  | {
      readonly instantField: string;
      readonly startField?: never;
      readonly endField?: never;
      /** JSON array of { time, coordinates } samples for point entities. */
      readonly positionField?: string;
    }
  | {
      readonly startField: string;
      readonly endField: string;
      readonly instantField?: never;
      /** JSON array of { time, coordinates } samples for point entities. */
      readonly positionField?: string;
    };

export type CesiumEntityGeometry =
  | { readonly kind: "point"; readonly coordinates: readonly [number, number, number] }
  | { readonly kind: "polyline"; readonly coordinates: readonly (readonly [number, number, number])[] }
  | {
      readonly kind: "polygon";
      readonly coordinates: readonly (readonly [number, number, number])[];
      readonly holes?: readonly (readonly (readonly [number, number, number])[])[];
    };

export interface CesiumEntityProjectionItem {
  readonly id: string;
  readonly featureId: string | number;
  readonly properties: Readonly<Record<string, unknown>>;
  readonly geometry: CesiumEntityGeometry;
  readonly interval?: CesiumEntityInterval;
  readonly positionSamples?: readonly CesiumEntityPositionSample[];
}

export interface ProjectSourceToCesiumOptions {
  /** Attribute holding stable feature identity. Defaults to descriptor primaryKey. */
  readonly featureIdField?: string;
  /** Hard entity ceiling. The accepted query limit must not exceed this value. */
  readonly maxEntities?: number;
  /** Required before finite Z values are interpreted as Cesium ellipsoid heights. */
  readonly verticalDatum?: "ellipsoidal-wgs84";
  readonly time?: CesiumEntityTimeOptions;
}

export interface CesiumEntityProjection {
  readonly strategy: "entity-query";
  readonly sourceId: string;
  readonly planId: string;
  readonly planFingerprint: string;
  readonly sourceVersion?: string;
  readonly schemaVersion?: string;
  readonly authorizationScope: readonly string[];
  readonly entities: readonly CesiumEntityProjectionItem[];
  readonly diagnostics: readonly CesiumEntityDiagnostic[];
  readonly state: Exclude<CesiumEntityWorkflowState, "disposing" | "disposed">;
}

/** Minimal Cesium EntityCollection surface; real viewer.entities satisfies it. */
export interface CesiumEntityCollectionTarget {
  getById(id: string): unknown;
  add(entity: Readonly<Record<string, unknown>>): unknown;
  removeById(id: string): boolean;
}

/** Minimal optional Cesium peer surface used to materialize entity values. */
export interface CesiumEntityRuntimeModule {
  readonly Cartesian3: {
    fromDegrees(longitude: number, latitude: number, height?: number): unknown;
  };
  readonly JulianDate: {
    fromIso8601(value: string): unknown;
  };
  readonly TimeInterval: new (options: { start: unknown; stop: unknown }) => unknown;
  readonly TimeIntervalCollection: new (intervals?: readonly unknown[]) => unknown;
  readonly PolygonHierarchy: new (positions: readonly unknown[], holes?: readonly unknown[]) => unknown;
  readonly SampledPositionProperty?: new () => {
    addSample(time: unknown, position: unknown): void;
  };
}

export type CesiumEntityRuntimeLoader = () => Promise<CesiumEntityRuntimeModule>;

export interface MountSourceToCesiumOptions extends ProjectSourceToCesiumOptions, ExecuteQueryPlanOptions {
  /** Inject the peer or a lazy loader. Omit to use `import("cesium")` at mount time. */
  readonly cesium?: CesiumEntityRuntimeModule | CesiumEntityRuntimeLoader;
}

export interface MountedCesiumEntitySource {
  readonly strategy: "entity-query";
  readonly sourceId: string;
  readonly entityIds: readonly string[];
  readonly planId: string;
  readonly planFingerprint: string;
  readonly state: CesiumEntityWorkflowState;
  readonly diagnostics: readonly CesiumEntityDiagnostic[];
  refresh(options?: ExecuteQueryPlanOptions): Promise<CesiumEntityProjection>;
  /** Cleanup is idempotent; a failed cleanup remains retryable. */
  dispose(): void;
}

export function projectSourceToCesium<T>(
  source: Source<T>,
  plan: QueryExecutionPlanV1,
  result: Result<T>,
  options: ProjectSourceToCesiumOptions = {},
): CesiumEntityProjection {
  assertProjectionPlanContext(source, plan);
  const maxEntities = validatePlanAndOptions(source, plan, options);
  if (result.aggregateRows !== undefined) throw unsupportedPlan(plan);
  const queryLimit = plan.ir.query.pagination?.limit as number;
  if (result.features.length > queryLimit) {
    throw new HonuaCesiumEntityAdapterError(
      "entity-limit-exceeded",
      `Source returned ${result.features.length} features for accepted query limit ${queryLimit}.`,
      { queryLimit, returnedFeatureCount: result.features.length },
    );
  }

  const sourceId = `honua-${safeId(source.descriptor.id)}`;
  const idField = options.featureIdField ?? source.descriptor.schema?.primaryKey;
  const diagnostics: CesiumEntityDiagnostic[] = [
    diagnostic(
      source,
      plan,
      "strategy-selected",
      "info",
      "project",
      "exact",
      "Selected bounded Cesium entity query strategy.",
      {
        maxEntities,
      },
    ),
  ];
  const entities: CesiumEntityProjectionItem[] = [];
  let unsupportedGeometry = 0;
  let missingIdentity = 0;
  let invalidIntervals = 0;
  let invalidPositionSamples = 0;
  let unsupportedVerticalDatum = 0;
  let unsupportedAttributes = 0;
  const entityIds = new Set<string>();

  for (const feature of result.features) {
    const attributes = snapshotJsonAttributes(feature.attributes);
    if (!attributes) {
      unsupportedAttributes += 1;
      continue;
    }
    const featureId = idField ? attributes[idField] : undefined;
    if (typeof featureId !== "string" && typeof featureId !== "number") {
      missingIdentity += 1;
      continue;
    }
    if (geometryHasZ(feature.geometry) && options.verticalDatum !== "ellipsoidal-wgs84") {
      unsupportedVerticalDatum += 1;
      continue;
    }
    const geometry = projectGeometry(feature);
    if (!geometry) {
      unsupportedGeometry += 1;
      continue;
    }
    const interval = options.time ? projectInterval(attributes, options.time) : undefined;
    if (options.time && !interval) {
      invalidIntervals += 1;
      continue;
    }
    const positionSamples = options.time?.positionField
      ? projectPositionSamples(attributes, options.time.positionField, geometry, options.verticalDatum)
      : undefined;
    if (positionSamples === null) {
      invalidPositionSamples += 1;
      continue;
    }
    const entityId = `${sourceId}:${typeof featureId === "number" ? "n" : "s"}:${encodeURIComponent(String(featureId))}`;
    if (entityIds.has(entityId)) {
      throw new HonuaCesiumEntityAdapterError(
        "entity-conflict",
        `Accepted query returned duplicate stable feature identity "${String(featureId)}".`,
        { entityId, featureId },
      );
    }
    entityIds.add(entityId);
    entities.push(
      Object.freeze({
        id: entityId,
        featureId,
        properties: attributes,
        geometry: immutableJsonSnapshot(geometry),
        ...(interval ? { interval: immutableJsonSnapshot(interval) } : {}),
        ...(positionSamples ? { positionSamples: immutableJsonSnapshot(positionSamples) } : {}),
      }),
    );
    if (entities.length > maxEntities) {
      throw new HonuaCesiumEntityAdapterError(
        "entity-limit-exceeded",
        `Cesium projection exceeded the ${maxEntities} entity safety ceiling.`,
        { maxEntities, sourceId: source.descriptor.id },
      );
    }
  }

  if (result.features.length === 0) {
    diagnostics.push(
      diagnostic(source, plan, "empty-result", "info", "execute", "exact", "The accepted plan returned no features."),
    );
  }
  if (result.exceededTransferLimit) {
    diagnostics.push(
      diagnostic(
        source,
        plan,
        "transfer-limit",
        "warning",
        "execute",
        "unsupported",
        "The rendered page is not the complete source result.",
        {
          renderedEntityCount: entities.length,
        },
      ),
    );
  }
  if (result.degraded?.length) {
    diagnostics.push(
      diagnostic(
        source,
        plan,
        "source-degraded",
        "warning",
        "execute",
        "unsupported",
        "The source reported degraded execution semantics.",
        {
          reasons: result.degraded.map((entry) => entry.reason),
        },
      ),
    );
  }
  if (missingIdentity > 0) {
    diagnostics.push(
      diagnostic(
        source,
        plan,
        "identity-missing",
        "warning",
        "project",
        "unsupported",
        `${missingIdentity} feature(s) lacked stable identity and were omitted.`,
        {
          featureIdField: idField,
          omittedFeatureCount: missingIdentity,
        },
      ),
    );
  }
  if (unsupportedAttributes > 0) {
    diagnostics.push(
      diagnostic(
        source,
        plan,
        "attributes-unsupported",
        "warning",
        "project",
        "unsupported",
        `${unsupportedAttributes} feature attribute object(s) were not strict JSON-like values and were omitted.`,
        { omittedFeatureCount: unsupportedAttributes },
      ),
    );
  }
  if (unsupportedGeometry > 0) {
    diagnostics.push(
      diagnostic(
        source,
        plan,
        "geometry-unsupported",
        "warning",
        "project",
        "unsupported",
        `${unsupportedGeometry} feature geometry value(s) were omitted.`,
        {
          omittedFeatureCount: unsupportedGeometry,
        },
      ),
    );
  }
  if (unsupportedVerticalDatum > 0) {
    diagnostics.push(
      diagnostic(
        source,
        plan,
        "vertical-datum-unsupported",
        "warning",
        "project",
        "unsupported",
        `${unsupportedVerticalDatum} feature(s) carried Z values without an explicit supported vertical datum and were omitted.`,
        { supportedVerticalDatum: "ellipsoidal-wgs84", omittedFeatureCount: unsupportedVerticalDatum },
      ),
    );
  }
  if (invalidIntervals > 0) {
    diagnostics.push(
      diagnostic(
        source,
        plan,
        "time-interval-invalid",
        "warning",
        "project",
        "unsupported",
        `${invalidIntervals} feature time interval(s) were invalid and omitted.`,
        {
          omittedFeatureCount: invalidIntervals,
        },
      ),
    );
  }
  if (invalidPositionSamples > 0) {
    diagnostics.push(
      diagnostic(
        source,
        plan,
        "time-position-invalid",
        "warning",
        "project",
        "unsupported",
        `${invalidPositionSamples} temporal point track(s) were invalid and omitted.`,
        { omittedFeatureCount: invalidPositionSamples },
      ),
    );
  }

  return Object.freeze({
    strategy: "entity-query" as const,
    sourceId,
    planId: plan.id,
    planFingerprint: plan.fingerprint,
    sourceVersion: plan.ir.source.sourceVersion,
    schemaVersion: plan.ir.source.schemaVersion,
    authorizationScope: Object.freeze([...plan.ir.source.authorizationScope]),
    entities: Object.freeze(entities),
    diagnostics: Object.freeze(diagnostics),
    state: diagnostics.some((entry) => entry.severity === "warning")
      ? ("degraded" as const)
      : entities.length === 0
        ? ("empty" as const)
        : ("ready" as const),
  });
}

export async function mountSourceToCesium<T>(
  collection: CesiumEntityCollectionTarget,
  source: Source<T>,
  plan: QueryExecutionPlanV1,
  options: MountSourceToCesiumOptions = {},
): Promise<MountedCesiumEntitySource> {
  const mountOptions = snapshotMountOptions(options);
  assertProjectionPlanContext(source, plan);
  validatePlanAndOptions(source, plan, mountOptions);
  const lifecycle = new AbortController();
  const initialSignal = combineSignals([lifecycle.signal, mountOptions.signal]);
  initialSignal.throwIfAborted();
  assertExecutionContext(source, plan, executionOptions(mountOptions));
  const cesium = await resolveCesium(mountOptions.cesium);
  initialSignal.throwIfAborted();
  const result = await executeAcceptedPlan(source, plan, initialSignal);
  initialSignal.throwIfAborted();
  let projection = projectSourceToCesium(source, plan, result, mountOptions);
  const initialSpecs = materializeProjection(cesium, projection);
  assertEntityIdsAvailable(collection, initialSpecs.keys());
  let mounted = new Map<string, Readonly<Record<string, unknown>>>();
  const attemptedInitialIds: string[] = [];
  try {
    for (const [id, spec] of initialSpecs) {
      initialSignal.throwIfAborted();
      attemptedInitialIds.push(id);
      mounted.set(id, spec);
      collection.add(spec);
      initialSignal.throwIfAborted();
    }
  } catch (cause) {
    // Include each attempted id: some renderer wrappers mutate and then throw.
    const failures = removeIds(collection, attemptedInitialIds);
    mounted = new Map();
    if (initialSignal.aborted && failures.length === 0) throw initialSignal.reason;
    throw mutationError("Failed to mount Cesium entities transactionally.", cause, failures);
  }

  let state: CesiumEntityWorkflowState = projection.state;
  let diagnostics: readonly CesiumEntityDiagnostic[] = projection.diagnostics;
  let refreshTail: Promise<void> = Promise.resolve();
  let lifecycleEpoch = 0;
  let disposeActive = false;

  const runRefresh = async (refreshOptions: ExecuteQueryPlanOptions): Promise<CesiumEntityProjection> => {
    if (state === "disposed" || state === "disposing") {
      throw new HonuaCesiumEntityAdapterError("disposed", "Cannot refresh a disposed Cesium entity mount.");
    }
    const currentEpoch = lifecycleEpoch;
    const refreshContext = snapshotExecutionOptions(refreshOptions);
    const signal = combineSignals([lifecycle.signal, refreshContext.signal]);
    signal.throwIfAborted();
    assertExecutionContext(source, plan, { ...executionOptions(mountOptions), ...refreshContext });
    const nextResult = await executeAcceptedPlan(source, plan, signal);
    signal.throwIfAborted();
    assertLifecycleActive(currentEpoch, lifecycleEpoch, state, signal);
    const next = projectSourceToCesium(source, plan, nextResult, mountOptions);
    signal.throwIfAborted();
    const nextSpecs = materializeProjection(cesium, next);
    const previous = new Map(mounted);
    assertEntityIdsAvailable(
      collection,
      [...nextSpecs.keys()].filter((id) => !previous.has(id)),
    );
    const attemptedNextIds: string[] = [];
    try {
      removeIdsOrThrow(collection, [...previous.keys()]);
      assertLifecycleActive(currentEpoch, lifecycleEpoch, state, signal);
      mounted = new Map();
      for (const [id, spec] of nextSpecs) {
        assertLifecycleActive(currentEpoch, lifecycleEpoch, state, signal);
        attemptedNextIds.push(id);
        mounted.set(id, spec);
        collection.add(spec);
        assertLifecycleActive(currentEpoch, lifecycleEpoch, state, signal);
      }
    } catch (cause) {
      const ownedSpecs = new Map([...previous, ...nextSpecs]);
      const cleanupFailures = removeIds(collection, [...mounted.keys(), ...attemptedNextIds]);
      mounted = presentOwnedSpecs(collection, ownedSpecs);
      if (lifecycleInvalidated(currentEpoch, lifecycleEpoch, state)) {
        if (cleanupFailures.length > 0) {
          throw mutationError(
            "Cesium entity disposal interrupted refresh and cleanup was incomplete.",
            cause,
            cleanupFailures,
          );
        }
        throw lifecycle.signal.reason;
      }
      const restoreFailures: unknown[] = [];
      for (const [id, spec] of previous) {
        try {
          assertLifecycleActive(currentEpoch, lifecycleEpoch, state, lifecycle.signal);
          mounted.set(id, spec);
          if (!collection.getById(id)) collection.add(spec);
          assertLifecycleActive(currentEpoch, lifecycleEpoch, state, lifecycle.signal);
        } catch (error) {
          mounted.delete(id);
          restoreFailures.push(error);
          if (lifecycleInvalidated(currentEpoch, lifecycleEpoch, state)) break;
        }
      }
      if (lifecycleInvalidated(currentEpoch, lifecycleEpoch, state)) {
        const rollbackOwnedSpecs = new Map(mounted);
        const disposalCleanupFailures = removeIds(collection, [...rollbackOwnedSpecs.keys()]);
        mounted = presentOwnedSpecs(collection, rollbackOwnedSpecs);
        if (disposalCleanupFailures.length > 0) {
          throw mutationError("Cesium entity disposal interrupted rollback and cleanup was incomplete.", cause, [
            ...cleanupFailures,
            ...restoreFailures,
            ...disposalCleanupFailures,
          ]);
        }
        throw lifecycle.signal.reason;
      }
      if (signal.aborted && cleanupFailures.length === 0 && restoreFailures.length === 0) throw signal.reason;
      state = "degraded";
      diagnostics = Object.freeze([
        ...diagnostics,
        diagnostic(
          source,
          plan,
          "incremental-update-failed",
          "warning",
          "update",
          "unsupported",
          "Cesium entity rebuild failed; restoration was attempted.",
          {
            rollbackSucceeded: cleanupFailures.length === 0 && restoreFailures.length === 0,
          },
        ),
      ]);
      throw mutationError("Failed to rebuild the mounted Cesium entity snapshot.", cause, [
        ...cleanupFailures,
        ...restoreFailures,
      ]);
    }
    assertLifecycleActive(currentEpoch, lifecycleEpoch, state, signal);
    diagnostics = Object.freeze([
      ...next.diagnostics,
      diagnostic(
        source,
        plan,
        "incremental-update",
        "info",
        "update",
        "equivalent",
        "Rebuilt the bounded entity snapshot while preserving stable entity ids.",
        {
          previousEntityCount: previous.size,
          nextEntityCount: mounted.size,
          rebuildBoundary: "entity-snapshot",
        },
      ),
    ]);
    projection = Object.freeze({ ...next, diagnostics });
    state = next.state;
    return projection;
  };

  return {
    strategy: "entity-query",
    sourceId: projection.sourceId,
    get entityIds() {
      return [...mounted.keys()];
    },
    planId: plan.id,
    planFingerprint: plan.fingerprint,
    get state() {
      return state;
    },
    get diagnostics() {
      return diagnostics;
    },
    refresh(refreshOptions = {}) {
      const refreshContext = snapshotExecutionOptions(refreshOptions);
      const value = refreshTail.then(() => runRefresh(refreshContext));
      refreshTail = value.then(
        () => undefined,
        () => undefined,
      );
      return value;
    },
    dispose() {
      if (state === "disposed") return;
      if (disposeActive) return;
      disposeActive = true;
      lifecycleEpoch += 1;
      lifecycle.abort(new DOMException("Cesium entity mount disposed", "AbortError"));
      state = "disposing";
      try {
        const failures: unknown[] = [];
        for (const id of [...mounted.keys()]) {
          try {
            if (!collection.getById(id) || collection.removeById(id)) mounted.delete(id);
            else failures.push(new Error(`Cesium refused to remove entity "${id}".`));
          } catch (error) {
            failures.push(error);
          }
        }
        if (failures.length > 0) {
          throw mutationError("Cesium entity disposal is incomplete and may be retried.", failures[0], failures);
        }
        state = "disposed";
      } finally {
        disposeActive = false;
      }
    },
  };
}

async function resolveCesium(
  injected: CesiumEntityRuntimeModule | CesiumEntityRuntimeLoader | undefined,
): Promise<CesiumEntityRuntimeModule> {
  try {
    const runtime =
      typeof injected === "function"
        ? await injected()
        : (injected ?? ((await import("cesium")) as unknown as CesiumEntityRuntimeModule));
    assertCesiumRuntime(runtime);
    return runtime;
  } catch (cause) {
    if (cause instanceof HonuaCesiumEntityAdapterError) throw cause;
    throw new HonuaCesiumEntityAdapterError(
      "peer-unavailable",
      "Cesium entity mounting requires the optional cesium peer or an injected runtime module.",
      undefined,
      { cause },
    );
  }
}

function materializeProjection(
  cesium: CesiumEntityRuntimeModule,
  projection: CesiumEntityProjection,
): Map<string, Readonly<Record<string, unknown>>> {
  return new Map(projection.entities.map((item) => [item.id, materializeEntity(cesium, item)]));
}

function materializeEntity(
  cesium: CesiumEntityRuntimeModule,
  item: CesiumEntityProjectionItem,
): Readonly<Record<string, unknown>> {
  const positions =
    item.geometry.kind === "point"
      ? [toCartesian(cesium, item.geometry.coordinates)]
      : item.geometry.coordinates.map((coordinate) => toCartesian(cesium, coordinate));
  const geometry =
    item.geometry.kind === "point"
      ? {
          position: item.positionSamples ? sampledPosition(cesium, item.positionSamples) : positions[0],
          point: { pixelSize: 8 },
        }
      : item.geometry.kind === "polyline"
        ? { polyline: { positions, width: 2 } }
        : {
            polygon: {
              hierarchy: new cesium.PolygonHierarchy(
                positions,
                item.geometry.holes?.map(
                  (hole) => new cesium.PolygonHierarchy(hole.map((coordinate) => toCartesian(cesium, coordinate))),
                ),
              ),
            },
          };
  const availability = item.interval
    ? new cesium.TimeIntervalCollection([
        new cesium.TimeInterval({
          start: cesium.JulianDate.fromIso8601(item.interval.start),
          stop: cesium.JulianDate.fromIso8601(item.interval.end),
        }),
      ])
    : undefined;
  return Object.freeze({
    id: item.id,
    properties: item.properties,
    ...geometry,
    ...(availability ? { availability } : {}),
  });
}

function sampledPosition(cesium: CesiumEntityRuntimeModule, samples: readonly CesiumEntityPositionSample[]): unknown {
  if (!cesium.SampledPositionProperty) {
    throw new HonuaCesiumEntityAdapterError(
      "peer-unavailable",
      "The Cesium runtime does not provide SampledPositionProperty for temporal entities.",
    );
  }
  const property = new cesium.SampledPositionProperty();
  for (const sample of samples) {
    property.addSample(cesium.JulianDate.fromIso8601(sample.time), toCartesian(cesium, sample.coordinates));
  }
  return property;
}

function toCartesian(cesium: CesiumEntityRuntimeModule, coordinate: readonly [number, number, number]): unknown {
  return cesium.Cartesian3.fromDegrees(coordinate[0], coordinate[1], coordinate[2]);
}

function projectGeometry<T>(feature: HonuaTypedFeature<T>): CesiumEntityGeometry | undefined {
  const value = feature.geometry;
  if (!value || typeof value !== "object") return undefined;
  const geometry = value as Record<string, unknown>;
  if (isFiniteNumber(geometry.x) && isFiniteNumber(geometry.y)) {
    if (!validLongitudeLatitude(geometry.x, geometry.y) || !validOptionalHeight(geometry, "z")) return undefined;
    const height = isFiniteNumber(geometry.z) ? geometry.z : 0;
    return { kind: "point", coordinates: [geometry.x, geometry.y, height] };
  }
  if (geometry.type === "Point") {
    const coordinate = coordinate3(geometry.coordinates);
    return coordinate ? { kind: "point", coordinates: coordinate } : undefined;
  }
  if (geometry.type === "LineString") {
    const coordinates = coordinates3(geometry.coordinates);
    return coordinates && coordinates.length >= 2 ? { kind: "polyline", coordinates } : undefined;
  }
  if (geometry.type === "Polygon") {
    const rings = polygonRings(geometry.coordinates);
    return rings
      ? { kind: "polygon", coordinates: rings.outer, ...(rings.holes.length ? { holes: rings.holes } : {}) }
      : undefined;
  }
  if (Array.isArray(geometry.paths) && geometry.paths.length === 1 && Object.hasOwn(geometry.paths, 0)) {
    const coordinates = coordinates3(geometry.paths[0]);
    return coordinates && coordinates.length >= 2 ? { kind: "polyline", coordinates } : undefined;
  }
  if (Array.isArray(geometry.rings)) {
    const rings = polygonRings(geometry.rings, true);
    return rings
      ? { kind: "polygon", coordinates: rings.outer, ...(rings.holes.length ? { holes: rings.holes } : {}) }
      : undefined;
  }
  return undefined;
}

function polygonRings(
  value: unknown,
  esriConvention = false,
):
  | {
      readonly outer: readonly (readonly [number, number, number])[];
      readonly holes: readonly (readonly (readonly [number, number, number])[])[];
    }
  | undefined {
  return polygonRingsWithConvention(value, esriConvention);
}

function polygonRingsWithConvention(
  value: unknown,
  esriConvention: boolean,
):
  | {
      readonly outer: readonly (readonly [number, number, number])[];
      readonly holes: readonly (readonly (readonly [number, number, number])[])[];
    }
  | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) return undefined;
  }
  const projected = value.map((ring) => {
    const coordinates = coordinates3(ring);
    return coordinates && validRing(coordinates) ? coordinates : undefined;
  });
  if (projected.some((ring) => ring === undefined)) return undefined;
  const rings = projected as readonly (readonly (readonly [number, number, number])[])[];
  if (esriConvention) return classifyEsriPolygonRings(rings);
  const [outer, ...holes] = rings as [
    readonly (readonly [number, number, number])[],
    ...(readonly (readonly (readonly [number, number, number])[])[]),
  ];
  return { outer, holes };
}

function classifyEsriPolygonRings(rings: readonly (readonly (readonly [number, number, number])[])[]):
  | {
      readonly outer: readonly (readonly [number, number, number])[];
      readonly holes: readonly (readonly (readonly [number, number, number])[])[];
    }
  | undefined {
  const exteriors = rings.filter((ring) => signedRingArea(ring) < 0);
  if (exteriors.length !== 1) return undefined;
  const outer = exteriors[0];
  if (!outer) return undefined;

  const holes: (readonly (readonly [number, number, number])[])[] = [];
  for (const ring of rings) {
    if (ring === outer) continue;
    if (signedRingArea(ring) <= 0 || !ringPointInside(ring[0], outer)) return undefined;
    holes.push(ring);
  }
  return { outer, holes };
}

function signedRingArea(ring: readonly (readonly [number, number, number])[]): number {
  let area = 0;
  for (let index = 0; index < ring.length - 1; index += 1) {
    const current = ring[index];
    const next = ring[index + 1];
    if (!current || !next) return 0;
    area += current[0] * next[1] - next[0] * current[1];
  }
  return area / 2;
}

function ringPointInside(
  point: readonly [number, number, number] | undefined,
  ring: readonly (readonly [number, number, number])[],
): boolean {
  if (!point) return false;
  let inside = false;
  for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index, index += 1) {
    const current = ring[index];
    const prior = ring[previous];
    if (!current || !prior) return false;
    const intersects =
      current[1] > point[1] !== prior[1] > point[1] &&
      point[0] < ((prior[0] - current[0]) * (point[1] - current[1])) / (prior[1] - current[1]) + current[0];
    if (intersects) inside = !inside;
  }
  return inside;
}

function geometryHasZ(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const geometry = value as Record<string, unknown>;
  if (Object.hasOwn(geometry, "z")) return true;
  const candidate = geometry.coordinates ?? geometry.paths ?? geometry.rings;
  return coordinateTreeHasZ(candidate);
}

function coordinateTreeHasZ(value: unknown): boolean {
  if (!Array.isArray(value)) return false;
  if (Object.hasOwn(value, 0) && Object.hasOwn(value, 1) && isFiniteNumber(value[0]) && isFiniteNumber(value[1]))
    return value.length >= 3 && Object.hasOwn(value, 2);
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) return false;
    if (coordinateTreeHasZ(value[index])) return true;
  }
  return false;
}

function coordinate3(value: unknown): readonly [number, number, number] | undefined {
  if (
    !Array.isArray(value) ||
    value.length < 2 ||
    value.length > 3 ||
    !Object.hasOwn(value, 0) ||
    !Object.hasOwn(value, 1) ||
    (value.length === 3 && !Object.hasOwn(value, 2)) ||
    !isFiniteNumber(value[0]) ||
    !isFiniteNumber(value[1]) ||
    !validLongitudeLatitude(value[0], value[1]) ||
    (value.length === 3 && !isFiniteNumber(value[2]))
  )
    return undefined;
  return [value[0], value[1], value.length === 3 ? (value[2] as number) : 0];
}

function coordinates3(value: unknown): readonly (readonly [number, number, number])[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const result: (readonly [number, number, number])[] = [];
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) return undefined;
    const coordinate = coordinate3(value[index]);
    if (!coordinate) return undefined;
    result.push(coordinate);
  }
  return result;
}

function validLongitudeLatitude(longitude: number, latitude: number): boolean {
  return longitude >= -180 && longitude <= 180 && latitude >= -90 && latitude <= 90;
}

function validOptionalHeight(geometry: Readonly<Record<string, unknown>>, key: string): boolean {
  return !Object.hasOwn(geometry, key) || geometry[key] === undefined || isFiniteNumber(geometry[key]);
}

function validRing(coordinates: readonly (readonly [number, number, number])[]): boolean {
  if (coordinates.length < 4) return false;
  const first = coordinates[0];
  const last = coordinates.at(-1);
  return first !== undefined && last !== undefined && first.every((value, index) => value === last[index]);
}

function projectInterval(
  attributes: Readonly<Record<string, unknown>>,
  time: CesiumEntityTimeOptions,
): CesiumEntityInterval | undefined {
  if (time.instantField !== undefined) {
    const instant = isoInstant(attributes[time.instantField]);
    return instant ? { start: instant, end: instant } : undefined;
  }
  const start = isoInstant(attributes[time.startField]);
  const end = isoInstant(attributes[time.endField]);
  if (!start || !end || Date.parse(end) < Date.parse(start)) return undefined;
  return { start, end };
}

function projectPositionSamples(
  attributes: Readonly<Record<string, unknown>>,
  field: string,
  geometry: CesiumEntityGeometry,
  verticalDatum: ProjectSourceToCesiumOptions["verticalDatum"],
): readonly CesiumEntityPositionSample[] | null | undefined {
  if (geometry.kind !== "point") return null;
  const value = attributes[field];
  if (value === undefined) return null;
  if (!Array.isArray(value) || value.length < 2) return null;
  const samples: CesiumEntityPositionSample[] = [];
  let previous = Number.NEGATIVE_INFINITY;
  for (const entry of value) {
    if (!entry || typeof entry !== "object") return null;
    const record = entry as Record<string, unknown>;
    const time = isoInstant(record.time);
    if (Array.isArray(record.coordinates) && record.coordinates.length >= 3 && verticalDatum !== "ellipsoidal-wgs84") {
      return null;
    }
    const coordinates = coordinate3(record.coordinates);
    if (!time || !coordinates) return null;
    const epoch = Date.parse(time);
    if (epoch <= previous) return null;
    previous = epoch;
    samples.push({ time, coordinates });
  }
  return samples;
}

function isoInstant(value: unknown): string | undefined {
  if (typeof value === "number" && !Number.isSafeInteger(value)) return undefined;
  if (typeof value === "string" && !validOffsetIsoInstant(value)) return undefined;
  const date = typeof value === "number" || typeof value === "string" ? new Date(value) : undefined;
  return date && Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}

const OFFSET_ISO_INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(?:Z|([+-])(\d{2}):(\d{2}))$/;

function validOffsetIsoInstant(value: string): boolean {
  const match = OFFSET_ISO_INSTANT.exec(value);
  if (!match) return false;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, , offsetHourText, offsetMinuteText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const offsetHour = offsetHourText === undefined ? 0 : Number(offsetHourText);
  const offsetMinute = offsetMinuteText === undefined ? 0 : Number(offsetMinuteText);
  const daysInMonth = month >= 1 && month <= 12 ? new Date(Date.UTC(year, month, 0)).getUTCDate() : 0;
  return (
    day >= 1 &&
    day <= daysInMonth &&
    hour <= 23 &&
    minute <= 59 &&
    second <= 59 &&
    offsetHour <= 14 &&
    offsetMinute <= 59 &&
    (offsetHour < 14 || offsetMinute === 0)
  );
}

function validatePlanAndOptions<T>(
  source: Source<T>,
  plan: QueryExecutionPlanV1,
  options: ProjectSourceToCesiumOptions,
): number {
  if (!source.capabilities.has("query")) {
    throw new HonuaCapabilityNotSupportedError("query", source.descriptor.protocol, source.descriptor.id);
  }
  const step = plan.steps[0];
  const limit = plan.ir.query.pagination?.limit;
  if (
    plan.steps.length !== 1 ||
    step?.engine !== "remote" ||
    step.operation !== "query" ||
    plan.ir.query.aggregation !== undefined ||
    plan.ir.query.returnGeometry !== true ||
    !Number.isSafeInteger(limit) ||
    (limit as number) <= 0
  ) {
    throw unsupportedPlan(plan);
  }
  if (canonicalStringify(toJsonValue(step.query)) !== canonicalStringify(toJsonValue(plan.ir.query))) {
    throw new HonuaQueryPlanExecutionError(
      "invalid-plan",
      "Remote query step does not match the accepted canonical query IR.",
    );
  }
  const maxEntities = positiveInteger(options.maxEntities, DEFAULT_CESIUM_ENTITY_LIMIT, "maxEntities");
  if ((limit as number) > maxEntities) {
    throw new HonuaCesiumEntityAdapterError(
      "entity-limit-exceeded",
      `Accepted query limit ${limit} exceeds the Cesium entity ceiling ${maxEntities}.`,
      { queryLimit: limit, maxEntities },
    );
  }
  const outSr = plan.ir.query.outSr;
  if (outSr !== 4326 && outSr !== "4326" && outSr !== "EPSG:4326") {
    throw new HonuaCesiumEntityAdapterError(
      "unsupported-crs",
      "Cesium entity projection requires an accepted query with outSr 4326; implicit or non-WGS84 coordinates are not reinterpreted.",
      { outSr },
    );
  }
  const idField = options.featureIdField ?? source.descriptor.schema?.primaryKey;
  if (!idField) {
    throw new HonuaCesiumEntityAdapterError(
      "invalid-option",
      "Cesium entity projection requires featureIdField or descriptor.schema.primaryKey.",
    );
  }
  if (options.time !== undefined) assertTimeOptions(options.time);
  return maxEntities;
}

/**
 * Accept exactly one temporal mapping. A mixed instant/interval request is a
 * caller mistake that TypeScript unions and untyped callers cannot both catch,
 * so it is rejected instead of silently preferring either variant.
 */
function assertTimeOptions(time: CesiumEntityTimeOptions): void {
  const declared = time as Readonly<Record<string, unknown>>;
  const instantMapping = declared.instantField !== undefined;
  const intervalMapping = declared.startField !== undefined || declared.endField !== undefined;
  if (instantMapping === intervalMapping) {
    throw new HonuaCesiumEntityAdapterError(
      "invalid-option",
      "time must declare exactly one of instantField or startField/endField.",
    );
  }
  const fields = instantMapping ? [declared.instantField] : [declared.startField, declared.endField];
  if (fields.some((field) => typeof field !== "string" || field.length === 0)) {
    throw new HonuaCesiumEntityAdapterError(
      "invalid-option",
      "time.instantField or time.startField/time.endField must be non-empty.",
    );
  }
}

function unsupportedPlan(plan: QueryExecutionPlanV1): HonuaCesiumEntityAdapterError {
  return new HonuaCesiumEntityAdapterError(
    "unsupported-plan",
    "Cesium entity mounting requires one bounded remote feature query with geometry.",
    { planId: plan.id, operations: plan.steps.map((step) => step.operation) },
  );
}

function executeAcceptedPlan<T>(
  source: Source<T>,
  plan: QueryExecutionPlanV1,
  signal: AbortSignal,
): Promise<Result<T>> {
  const step = plan.steps[0];
  if (!step || step.engine !== "remote" || step.operation !== "query") throw unsupportedPlan(plan);
  return source.query(queryFromCanonical<T>(step.query, signal));
}

function assertProjectionPlanContext<T>(source: Source<T>, plan: QueryExecutionPlanV1): void {
  if (hashQueryPlanV1(plan) !== plan.fingerprint) {
    throw new HonuaQueryPlanExecutionError("invalid-plan", "Plan content does not match its fingerprint.");
  }
  const identity = queryIrSourceIdentity(source.descriptor, {
    schemaVersion: plan.ir.source.schemaVersion,
    sourceVersion: plan.ir.source.sourceVersion,
    authorizationScope: plan.ir.source.authorizationScope,
  });
  const runtimeCapabilities = [...source.capabilities].sort();
  if (
    canonicalStringify(toJsonValue(identity)) !== canonicalStringify(toJsonValue(plan.ir.source)) ||
    canonicalStringify(toJsonValue(runtimeCapabilities)) !==
      canonicalStringify(toJsonValue([...source.descriptor.capabilities].sort()))
  ) {
    throw new HonuaQueryPlanExecutionError(
      "plan-context-mismatch",
      "Source identity or capabilities do not match the accepted Cesium projection context.",
    );
  }
}

function assertExecutionContext<T>(
  source: Source<T>,
  plan: QueryExecutionPlanV1,
  options: ExecuteQueryPlanOptions,
): void {
  const current = queryIrSourceIdentity(source.descriptor, options);
  if (canonicalStringify(toJsonValue(current)) !== canonicalStringify(toJsonValue(plan.ir.source))) {
    throw new HonuaQueryPlanExecutionError(
      "plan-context-mismatch",
      "Source identity, version, capabilities, or authorization scope changed after planning.",
    );
  }
}

function diagnostic<T>(
  source: Source<T>,
  plan: QueryExecutionPlanV1,
  code: CesiumEntityDiagnosticCode,
  severity: CesiumEntityDiagnostic["severity"],
  stage: CesiumEntityDiagnostic["stage"],
  fidelity: CesiumEntityDiagnostic["fidelity"],
  message: string,
  detail?: Readonly<Record<string, unknown>>,
): CesiumEntityDiagnostic {
  return Object.freeze({
    code,
    severity,
    stage,
    fidelity,
    sourceId: source.descriptor.id,
    planId: plan.id,
    message,
    ...(detail ? { detail: immutableJsonSnapshot(detail) } : {}),
  });
}

function executionOptions(options: MountSourceToCesiumOptions): ExecuteQueryPlanOptions {
  return {
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.schemaVersion ? { schemaVersion: options.schemaVersion } : {}),
    ...(options.sourceVersion ? { sourceVersion: options.sourceVersion } : {}),
    ...(options.authorizationScope ? { authorizationScope: options.authorizationScope } : {}),
  };
}

function snapshotExecutionOptions(options: ExecuteQueryPlanOptions): ExecuteQueryPlanOptions {
  return Object.freeze({
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.schemaVersion !== undefined ? { schemaVersion: options.schemaVersion } : {}),
    ...(options.sourceVersion !== undefined ? { sourceVersion: options.sourceVersion } : {}),
    ...(options.authorizationScope ? { authorizationScope: Object.freeze([...options.authorizationScope]) } : {}),
  });
}

function snapshotMountOptions(options: MountSourceToCesiumOptions): MountSourceToCesiumOptions {
  const execution = snapshotExecutionOptions(options);
  return Object.freeze({
    ...execution,
    ...(options.cesium ? { cesium: options.cesium } : {}),
    ...(options.featureIdField !== undefined ? { featureIdField: options.featureIdField } : {}),
    ...(options.maxEntities !== undefined ? { maxEntities: options.maxEntities } : {}),
    ...(options.verticalDatum !== undefined ? { verticalDatum: options.verticalDatum } : {}),
    ...(options.time ? { time: snapshotTimeOptions(options.time) } : {}),
  });
}

/** Validate before narrowing so a mixed mapping cannot be normalized away. */
function snapshotTimeOptions(time: CesiumEntityTimeOptions): CesiumEntityTimeOptions {
  assertTimeOptions(time);
  const position = time.positionField !== undefined ? { positionField: time.positionField } : {};
  if (time.instantField !== undefined) return Object.freeze({ instantField: time.instantField, ...position });
  return Object.freeze({ startField: time.startField, endField: time.endField, ...position });
}

function assertLifecycleActive(
  expectedEpoch: number,
  currentEpoch: number,
  state: CesiumEntityWorkflowState,
  signal: AbortSignal,
): void {
  if (lifecycleInvalidated(expectedEpoch, currentEpoch, state)) {
    throw new DOMException("Cesium entity mount disposed", "AbortError");
  }
  signal.throwIfAborted();
}

function lifecycleInvalidated(expectedEpoch: number, currentEpoch: number, state: CesiumEntityWorkflowState): boolean {
  return expectedEpoch !== currentEpoch || state === "disposed" || state === "disposing";
}

function assertCesiumRuntime(value: unknown): asserts value is CesiumEntityRuntimeModule {
  const runtime = value as Partial<CesiumEntityRuntimeModule> | null | undefined;
  if (
    !runtime ||
    typeof runtime.Cartesian3?.fromDegrees !== "function" ||
    typeof runtime.JulianDate?.fromIso8601 !== "function" ||
    typeof runtime.TimeInterval !== "function" ||
    typeof runtime.TimeIntervalCollection !== "function" ||
    typeof runtime.PolygonHierarchy !== "function"
  ) {
    throw new HonuaCesiumEntityAdapterError(
      "peer-unavailable",
      "The Cesium runtime does not provide the entity adapter APIs required by this mount.",
    );
  }
}

const INVALID_JSON_ATTRIBUTE = Symbol("invalid-json-attribute");

function immutableJsonSnapshot<T>(value: T): T {
  const snapshot = snapshotJsonValue(value, new Set());
  if (snapshot === INVALID_JSON_ATTRIBUTE) throw new TypeError("Internal value is not JSON-like.");
  return snapshot as T;
}

function snapshotJsonAttributes(value: unknown): Readonly<Record<string, unknown>> | undefined {
  const snapshot = snapshotJsonValue(value, new Set());
  return snapshot !== INVALID_JSON_ATTRIBUTE && isPlainObject(snapshot)
    ? (snapshot as Readonly<Record<string, unknown>>)
    : undefined;
}

function snapshotJsonValue(value: unknown, ancestors: Set<object>): unknown | typeof INVALID_JSON_ATTRIBUTE {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : INVALID_JSON_ATTRIBUTE;
  if (typeof value !== "object") return INVALID_JSON_ATTRIBUTE;
  if (ancestors.has(value)) return INVALID_JSON_ATTRIBUTE;
  ancestors.add(value);
  if (Array.isArray(value)) {
    const copy: unknown[] = [];
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.hasOwn(value, index)) {
        ancestors.delete(value);
        return INVALID_JSON_ATTRIBUTE;
      }
      const entry = snapshotJsonValue(value[index], ancestors);
      if (entry === INVALID_JSON_ATTRIBUTE) {
        ancestors.delete(value);
        return INVALID_JSON_ATTRIBUTE;
      }
      copy.push(entry);
    }
    ancestors.delete(value);
    return Object.freeze(copy);
  }
  if (!isPlainObject(value)) {
    ancestors.delete(value);
    return INVALID_JSON_ATTRIBUTE;
  }
  const copy: Record<string, unknown> = {};
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") {
      ancestors.delete(value);
      return INVALID_JSON_ATTRIBUTE;
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      ancestors.delete(value);
      return INVALID_JSON_ATTRIBUTE;
    }
    const entry = snapshotJsonValue(descriptor.value, ancestors);
    if (entry === INVALID_JSON_ATTRIBUTE) {
      ancestors.delete(value);
      return INVALID_JSON_ATTRIBUTE;
    }
    Object.defineProperty(copy, key, {
      value: entry,
      enumerable: true,
      writable: false,
      configurable: false,
    });
  }
  ancestors.delete(value);
  return Object.freeze(copy);
}

function isPlainObject(value: unknown): value is Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function removeIds(collection: CesiumEntityCollectionTarget, ids: readonly string[]): unknown[] {
  const failures: unknown[] = [];
  for (const id of new Set(ids)) {
    try {
      if (collection.getById(id) && !collection.removeById(id))
        failures.push(new Error(`Cesium refused to remove entity "${id}".`));
    } catch (error) {
      failures.push(error);
    }
  }
  return failures;
}

function removeIdsOrThrow(collection: CesiumEntityCollectionTarget, ids: readonly string[]): void {
  const failures = removeIds(collection, ids);
  if (failures.length > 0) throw failures[0];
}

function presentOwnedSpecs(
  collection: CesiumEntityCollectionTarget,
  specs: ReadonlyMap<string, Readonly<Record<string, unknown>>>,
): Map<string, Readonly<Record<string, unknown>>> {
  const present = new Map<string, Readonly<Record<string, unknown>>>();
  for (const [id, spec] of specs) {
    try {
      if (collection.getById(id)) present.set(id, spec);
    } catch {
      // Conservatively retain ownership so a later disposal can retry the id.
      present.set(id, spec);
    }
  }
  return present;
}

function mutationError(message: string, cause: unknown, failures: readonly unknown[]): HonuaCesiumEntityAdapterError {
  return new HonuaCesiumEntityAdapterError(
    "renderer-mutation-failed",
    message,
    { cleanupFailureCount: failures.length, cleanupFailures: failures.map(errorMessage) },
    { cause },
  );
}

function entityConflict(id: string): HonuaCesiumEntityAdapterError {
  return new HonuaCesiumEntityAdapterError("entity-conflict", `Cesium entity "${id}" already exists.`, {
    entityId: id,
  });
}

function assertEntityIdsAvailable(collection: CesiumEntityCollectionTarget, ids: Iterable<string>): void {
  for (const id of ids) {
    if (collection.getById(id)) throw entityConflict(id);
  }
}

function combineSignals(signals: readonly (AbortSignal | undefined)[]): AbortSignal {
  const available = signals.filter((signal): signal is AbortSignal => signal !== undefined);
  return available.length === 1 ? (available[0] as AbortSignal) : AbortSignal.any(available);
}

function safeId(value: string): string {
  const normalized = value.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  let start = 0;
  let end = normalized.length;
  while (start < end && normalized.charCodeAt(start) === 45) start += 1;
  while (end > start && normalized.charCodeAt(end - 1) === 45) end -= 1;
  return normalized.slice(start, end) || "source";
}

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  const candidate = value ?? fallback;
  if (!Number.isSafeInteger(candidate) || candidate <= 0) {
    throw new HonuaCesiumEntityAdapterError("invalid-option", `${name} must be a positive safe integer.`, {
      [name]: value,
    });
  }
  return candidate;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
