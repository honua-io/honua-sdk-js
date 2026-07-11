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
import { hashQueryPlan } from "../query-planner/planner.js";
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
  | "identity-missing"
  | "time-interval-invalid"
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

export type CesiumEntityGeometry =
  | { readonly kind: "point"; readonly coordinates: readonly [number, number, number] }
  | { readonly kind: "polyline"; readonly coordinates: readonly (readonly [number, number, number])[] }
  | { readonly kind: "polygon"; readonly coordinates: readonly (readonly [number, number, number])[] };

export interface CesiumEntityProjectionItem {
  readonly id: string;
  readonly featureId: string | number;
  readonly properties: Readonly<Record<string, unknown>>;
  readonly geometry: CesiumEntityGeometry;
  readonly interval?: CesiumEntityInterval;
}

export interface ProjectSourceToCesiumOptions {
  /** Attribute holding stable feature identity. Defaults to descriptor primaryKey. */
  readonly featureIdField?: string;
  /** Hard entity ceiling. The accepted query limit must not exceed this value. */
  readonly maxEntities?: number;
  /** Required before finite Z values are interpreted as Cesium ellipsoid heights. */
  readonly verticalDatum?: "ellipsoidal-wgs84";
  readonly time?: {
    readonly startField: string;
    readonly endField: string;
  };
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
  readonly PolygonHierarchy: new (positions: readonly unknown[]) => unknown;
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
  let unsupportedVerticalDatum = 0;
  const entityIds = new Set<string>();

  for (const feature of result.features) {
    const attributes = asAttributes(feature.attributes);
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
        properties: Object.freeze({ ...attributes }),
        geometry,
        ...(interval ? { interval } : {}),
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
        "equivalent",
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
        "equivalent",
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

  return Object.freeze({
    strategy: "entity-query" as const,
    sourceId,
    planId: plan.id,
    planFingerprint: plan.fingerprint,
    sourceVersion: plan.ir.source.sourceVersion,
    schemaVersion: plan.ir.source.schemaVersion,
    authorizationScope: plan.ir.source.authorizationScope,
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
  assertProjectionPlanContext(source, plan);
  validatePlanAndOptions(source, plan, options);
  const lifecycle = new AbortController();
  const initialSignal = combineSignals([lifecycle.signal, options.signal]);
  assertExecutionContext(source, plan, executionOptions(options));
  const cesium = await resolveCesium(options.cesium);
  initialSignal.throwIfAborted();
  const result = await executeAcceptedPlan(source, plan, initialSignal);
  initialSignal.throwIfAborted();
  let projection = projectSourceToCesium(source, plan, result, options);
  const initialSpecs = materializeProjection(cesium, projection);
  assertEntityIdsAvailable(collection, initialSpecs.keys());
  let mounted = new Map<string, Readonly<Record<string, unknown>>>();
  try {
    for (const [id, spec] of initialSpecs) {
      collection.add(spec);
      mounted.set(id, spec);
    }
  } catch (cause) {
    // Include every intended id: some renderer wrappers mutate and then throw.
    const failures = removeIds(collection, [...initialSpecs.keys()]);
    throw mutationError("Failed to mount Cesium entities transactionally.", cause, failures);
  }

  let state: CesiumEntityWorkflowState = projection.state;
  let diagnostics = [...projection.diagnostics];
  let refreshTail: Promise<void> = Promise.resolve();

  const runRefresh = async (refreshOptions: ExecuteQueryPlanOptions): Promise<CesiumEntityProjection> => {
    if (state === "disposed" || state === "disposing") {
      throw new HonuaCesiumEntityAdapterError("disposed", "Cannot refresh a disposed Cesium entity mount.");
    }
    const signal = combineSignals([lifecycle.signal, refreshOptions.signal]);
    signal.throwIfAborted();
    assertExecutionContext(source, plan, { ...executionOptions(options), ...refreshOptions });
    const nextResult = await executeAcceptedPlan(source, plan, signal);
    signal.throwIfAborted();
    const next = projectSourceToCesium(source, plan, nextResult, options);
    signal.throwIfAborted();
    const nextSpecs = materializeProjection(cesium, next);
    const previous = mounted;
    assertEntityIdsAvailable(
      collection,
      [...nextSpecs.keys()].filter((id) => !previous.has(id)),
    );
    const attemptedNextIds: string[] = [];
    try {
      removeIdsOrThrow(collection, [...previous.keys()]);
      mounted = new Map();
      for (const [id, spec] of nextSpecs) {
        signal.throwIfAborted();
        attemptedNextIds.push(id);
        collection.add(spec);
        mounted.set(id, spec);
      }
    } catch (cause) {
      const cleanupFailures = removeIds(collection, [...mounted.keys(), ...attemptedNextIds]);
      mounted = new Map();
      const restoreFailures: unknown[] = [];
      for (const [id, spec] of previous) {
        try {
          if (!collection.getById(id)) collection.add(spec);
          mounted.set(id, spec);
        } catch (error) {
          restoreFailures.push(error);
        }
      }
      state = "degraded";
      diagnostics = [
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
      ];
      throw mutationError("Failed to rebuild the mounted Cesium entity snapshot.", cause, [
        ...cleanupFailures,
        ...restoreFailures,
      ]);
    }
    diagnostics = [
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
    ];
    projection = { ...next, diagnostics };
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
      const value = refreshTail.then(() => runRefresh(refreshOptions));
      refreshTail = value.then(
        () => undefined,
        () => undefined,
      );
      return value;
    },
    dispose() {
      if (state === "disposed") return;
      lifecycle.abort(new DOMException("Cesium entity mount disposed", "AbortError"));
      state = "disposing";
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
    },
  };
}

async function resolveCesium(
  injected: CesiumEntityRuntimeModule | CesiumEntityRuntimeLoader | undefined,
): Promise<CesiumEntityRuntimeModule> {
  try {
    if (typeof injected === "function") return await injected();
    if (injected) return injected;
    return (await import("cesium")) as unknown as CesiumEntityRuntimeModule;
  } catch (cause) {
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
      ? { position: positions[0], point: { pixelSize: 8 } }
      : item.geometry.kind === "polyline"
        ? { polyline: { positions, width: 2 } }
        : { polygon: { hierarchy: new cesium.PolygonHierarchy(positions) } };
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

function toCartesian(cesium: CesiumEntityRuntimeModule, coordinate: readonly [number, number, number]): unknown {
  return cesium.Cartesian3.fromDegrees(coordinate[0], coordinate[1], coordinate[2]);
}

function projectGeometry<T>(feature: HonuaTypedFeature<T>): CesiumEntityGeometry | undefined {
  const value = feature.geometry;
  if (!value || typeof value !== "object") return undefined;
  const geometry = value as Record<string, unknown>;
  if (isFiniteNumber(geometry.x) && isFiniteNumber(geometry.y)) {
    return { kind: "point", coordinates: [geometry.x, geometry.y, finiteHeight(geometry.z)] };
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
    const rings = geometry.coordinates;
    if (!Array.isArray(rings) || rings.length !== 1) return undefined;
    const coordinates = coordinates3(rings[0]);
    return coordinates && coordinates.length >= 4 ? { kind: "polygon", coordinates } : undefined;
  }
  if (Array.isArray(geometry.paths) && geometry.paths.length === 1) {
    const coordinates = coordinates3(geometry.paths[0]);
    return coordinates && coordinates.length >= 2 ? { kind: "polyline", coordinates } : undefined;
  }
  if (Array.isArray(geometry.rings) && geometry.rings.length === 1) {
    const coordinates = coordinates3(geometry.rings[0]);
    return coordinates && coordinates.length >= 4 ? { kind: "polygon", coordinates } : undefined;
  }
  return undefined;
}

function geometryHasZ(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const geometry = value as Record<string, unknown>;
  if (isFiniteNumber(geometry.z)) return true;
  const candidate = geometry.coordinates ?? geometry.paths ?? geometry.rings;
  return coordinateTreeHasZ(candidate);
}

function coordinateTreeHasZ(value: unknown): boolean {
  if (!Array.isArray(value)) return false;
  if (isFiniteNumber(value[0]) && isFiniteNumber(value[1])) return isFiniteNumber(value[2]);
  return value.some(coordinateTreeHasZ);
}

function coordinate3(value: unknown): readonly [number, number, number] | undefined {
  if (!Array.isArray(value) || !isFiniteNumber(value[0]) || !isFiniteNumber(value[1])) return undefined;
  return [value[0], value[1], finiteHeight(value[2])];
}

function coordinates3(value: unknown): readonly (readonly [number, number, number])[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const result = value.map(coordinate3);
  return result.every((coordinate) => coordinate !== undefined)
    ? (result as readonly (readonly [number, number, number])[])
    : undefined;
}

function projectInterval(
  attributes: Readonly<Record<string, unknown>>,
  time: NonNullable<ProjectSourceToCesiumOptions["time"]>,
): CesiumEntityInterval | undefined {
  const start = isoInstant(attributes[time.startField]);
  const end = isoInstant(attributes[time.endField]);
  if (!start || !end || Date.parse(end) < Date.parse(start)) return undefined;
  return { start, end };
}

function isoInstant(value: unknown): string | undefined {
  const date = typeof value === "number" || typeof value === "string" ? new Date(value) : undefined;
  return date && Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
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
    plan.ir.query.returnGeometry === false ||
    !Number.isInteger(limit) ||
    (limit as number) <= 0
  ) {
    throw unsupportedPlan(plan);
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
  if (options.time !== undefined && (!options.time.startField || !options.time.endField)) {
    throw new HonuaCesiumEntityAdapterError("invalid-option", "time.startField and time.endField must be non-empty.");
  }
  return maxEntities;
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
  if (hashQueryPlan(plan) !== plan.fingerprint) {
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
  return {
    code,
    severity,
    stage,
    fidelity,
    sourceId: source.descriptor.id,
    planId: plan.id,
    message,
    ...(detail ? { detail } : {}),
  };
}

function executionOptions(options: MountSourceToCesiumOptions): ExecuteQueryPlanOptions {
  return {
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.schemaVersion ? { schemaVersion: options.schemaVersion } : {}),
    ...(options.sourceVersion ? { sourceVersion: options.sourceVersion } : {}),
    ...(options.authorizationScope ? { authorizationScope: options.authorizationScope } : {}),
  };
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

function asAttributes(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function finiteHeight(value: unknown): number {
  return isFiniteNumber(value) ? value : 0;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
