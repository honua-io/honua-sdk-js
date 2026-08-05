/**
 * Experimental accepted-plan Source -> Cesium entity workflow.
 *
 * The projection half is renderer-neutral and SSR safe. Cesium is resolved
 * only while mounting, either through an injected module/loader or a lazy
 * optional-peer import.
 *
 * `refresh()` is a diff, not a rebuild (issue #1050). It runs the same
 * discipline the beta primitive mount runs on (#930): identity is the projected
 * entity id qualified by geometry kind, configuration is an order-independent
 * fingerprint of the projected feature, a feature that cannot be fingerprinted
 * is treated as changed rather than reusable, and every crossing is reported.
 * The consequence a host can rely on is object identity: a feature whose row did
 * not change keeps the *same* live `Entity`, so `viewer.selectedEntity`, a
 * tracked entity, and a graphic the host mutated all survive a refresh. A
 * feature that did change keeps its `Entity` too — only the facets that moved
 * are written onto it.
 *
 * {@link mountCesiumScene} (`./cesium-scene-owner.ts`) composes this mount with
 * the primitive mount under one owner, so a host does not sequence two
 * teardowns itself.
 *
 * @experimental Held back from the beta `@honua/app-platform/scene-workspace`
 *   tier: the slice has no symbology surface, and adding one means new required
 *   shapes rather than purely additive ones (see `docs/cesium-entity-adapter.md`).
 *   Not covered by the pre-1.0 semver contract. The scene primitive adapter
 *   alongside it is beta.
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
  | "incremental-update-failed"
  | "rebuild-boundary";

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

/**
 * What one entity had to cross during a {@link MountedCesiumEntitySource.refresh}.
 *
 * The vocabulary mirrors the beta primitive mount's `SceneRebuildBoundary`
 * (issue #930) so the two halves of a Cesium scene answer "what did this update
 * have to rebuild" in the same shape. It is entity-scoped rather than shared
 * because an entity has one crossing the primitive path does not — an in-place
 * update, where the live `Entity` object survives a *changed* feature.
 *
 * - `none` — identity and configuration are unchanged; the live `Entity` was not
 *   touched at all. Anything the host attached to it (a selection, a tracked
 *   entity, a mutated graphic) survives.
 * - `entity-configuration` — the feature changed and the changed facets were
 *   written onto the live `Entity`, which survives by object identity.
 * - `entity-identity` — the feature was not previously mounted; an `Entity` was
 *   constructed for it.
 * - `snapshot-membership` — the feature left the snapshot; its `Entity` was
 *   released.
 * - `entity-geometry-kind` — the feature's geometry kind changed (a point became
 *   a polyline, say). Identity is kind-qualified, so this is a replacement:
 *   the old `Entity` is released and a new one constructed.
 * - `unfingerprintable` — the feature could not be fingerprinted deterministically
 *   and was replaced conservatively rather than assumed unchanged.
 */
export type CesiumEntityRebuildBoundary =
  | "none"
  | "entity-configuration"
  | "entity-identity"
  | "snapshot-membership"
  | "entity-geometry-kind"
  | "unfingerprintable";

/** The entity boundary vocabulary, in escalation order. */
export const CESIUM_ENTITY_REBUILD_BOUNDARIES: readonly CesiumEntityRebuildBoundary[] = Object.freeze([
  "none",
  "entity-configuration",
  "entity-identity",
  "snapshot-membership",
  "entity-geometry-kind",
  "unfingerprintable",
]);

/** One entity's outcome across a refresh. */
export interface CesiumEntityRebuildBoundaryReport {
  readonly entityId: string;
  readonly boundary: CesiumEntityRebuildBoundary;
  /** `true` when the entity was not touched at all. */
  readonly incremental: boolean;
  /** `true` when the live Cesium `Entity` object survived this refresh by identity. */
  readonly preserved: boolean;
  readonly reason: string;
}

const ENTITY_BOUNDARY_REASONS: Readonly<Record<CesiumEntityRebuildBoundary, string>> = Object.freeze({
  none: "Identity and configuration are unchanged; the live entity was reused untouched.",
  "entity-configuration": "The configuration fingerprint changed; the live entity was updated in place.",
  "entity-identity": "The feature was not previously mounted; an entity was constructed for it.",
  "snapshot-membership": "The feature left the snapshot; its entity was released.",
  "entity-geometry-kind": "The feature's geometry kind changed; the entity was released and rebuilt.",
  unfingerprintable: "The feature could not be fingerprinted deterministically and was rebuilt conservatively.",
});

/** Build one boundary report with the vocabulary's own stable reason text. */
function entityRebuildBoundaryReport(
  entityId: string,
  boundary: CesiumEntityRebuildBoundary,
): CesiumEntityRebuildBoundaryReport {
  return Object.freeze({
    entityId,
    boundary,
    incremental: boundary === "none",
    preserved: boundary === "none" || boundary === "entity-configuration",
    reason: ENTITY_BOUNDARY_REASONS[boundary],
  });
}

/**
 * The result of one {@link MountedCesiumEntitySource.refresh}: the projection the
 * refreshed snapshot produced, plus the diff that reconciled it onto the live
 * collection.
 *
 * The four id lists partition the refresh. A replaced entity — a geometry-kind
 * change or an unfingerprintable feature — appears in both `created` and
 * `disposed`, because that is exactly what happened to it.
 */
export interface CesiumEntityRefreshResult extends CesiumEntityProjection {
  /** 1 after the initial mount, incremented for every refresh. */
  readonly revision: number;
  /** Ids whose live `Entity` was carried forward untouched. */
  readonly reused: readonly string[];
  /** Ids whose live `Entity` survived by identity and was updated in place. */
  readonly updated: readonly string[];
  /** Ids whose `Entity` was constructed by this refresh. */
  readonly created: readonly string[];
  /** Ids whose `Entity` was released because the feature left or had to be replaced. */
  readonly disposed: readonly string[];
  /**
   * One entry per entity that crossed a boundary. Entities reused untouched are
   * deliberately *not* reported: a steady-state refresh of a bounded snapshot is
   * the common case, and it should cost nothing to report. `reused` names them.
   */
  readonly rebuildBoundaries: readonly CesiumEntityRebuildBoundaryReport[];
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
  /** 1 after the initial mount, incremented for every refresh. */
  readonly revision: number;
  /** Boundaries crossed by the most recent refresh. Empty after the initial mount. */
  readonly rebuildBoundaries: readonly CesiumEntityRebuildBoundaryReport[];
  /**
   * Re-execute the accepted plan and reconcile the result onto the live
   * collection.
   *
   * This is a **diff**, not a rebuild. Identity is the projected entity id
   * qualified by geometry kind; configuration is an order-independent
   * fingerprint of the projected feature. A feature whose fingerprint is
   * unchanged keeps its live `Entity` untouched — so a selection, a tracked
   * entity, or a graphic the host mutated survives the refresh — a changed
   * feature has its changed facets written onto the same `Entity`, and only
   * features that departed, changed geometry kind, or could not be fingerprinted
   * cost an `Entity`.
   */
  refresh(options?: ExecuteQueryPlanOptions): Promise<CesiumEntityRefreshResult>;
  /** Cleanup is idempotent; a failed cleanup remains retryable. */
  dispose(): void;
}

/**
 * One entity this mount owns: its stable identity, the fingerprints the diff
 * runs on, and the materialized specification it was constructed from.
 *
 * The per-facet fingerprints are what make an in-place update surgical: only the
 * facets that actually changed are written back onto the live `Entity`, so a
 * moved feature does not also replace its unchanged graphics or property bag.
 */
interface MountedEntityRecord {
  readonly id: string;
  readonly kind: CesiumEntityGeometry["kind"];
  readonly fingerprint: string | undefined;
  readonly facets: EntityFacetFingerprints;
  readonly spec: Readonly<Record<string, unknown>>;
}

interface EntityFacetFingerprints {
  readonly geometry: string | undefined;
  readonly properties: string | undefined;
  readonly availability: string | undefined;
}

/** One field assignment made against a live entity, with the value it displaced. */
interface AppliedEntityWrite {
  readonly target: Record<string, unknown>;
  readonly key: string;
  readonly previous: unknown;
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
  const initialRecords = materializeProjection(cesium, projection);
  assertEntityIdsAvailable(collection, initialRecords.keys());
  let mounted = new Map<string, MountedEntityRecord>();
  const attemptedInitialIds: string[] = [];
  try {
    for (const [id, record] of initialRecords) {
      initialSignal.throwIfAborted();
      attemptedInitialIds.push(id);
      mounted.set(id, record);
      collection.add(record.spec);
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
  let rebuildBoundaries: readonly CesiumEntityRebuildBoundaryReport[] = Object.freeze([]);
  let revision = 1;
  let refreshTail: Promise<void> = Promise.resolve();
  let lifecycleEpoch = 0;
  let disposeActive = false;

  const runRefresh = async (refreshOptions: ExecuteQueryPlanOptions): Promise<CesiumEntityRefreshResult> => {
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

    // ── Identity + configuration diff ──────────────────────────────
    //
    // Identity is the projected entity id qualified by geometry kind, exactly
    // the discipline the beta primitive mount runs on (#930): a kind change owns
    // a different renderer object, so it is a replacement rather than an update.
    // A feature that cannot be fingerprinted is treated as changed, never as
    // unchanged, so a stale entity can never claim to satisfy a snapshot it no
    // longer matches. Nothing is materialized for a feature that is reused, so a
    // steady-state refresh allocates no Cesium values at all.
    const previous = mounted;
    const nextRecords = new Map<string, MountedEntityRecord>();
    const boundaries: CesiumEntityRebuildBoundaryReport[] = [];
    const reusedIds: string[] = [];
    const updatedIds: string[] = [];
    const createdIds: string[] = [];
    const updates: { readonly previous: MountedEntityRecord; readonly next: MountedEntityRecord }[] = [];
    const replacements: MountedEntityRecord[] = [];
    const creations: MountedEntityRecord[] = [];
    for (const item of next.entities) {
      const existing = previous.get(item.id);
      const facets = entityFacetFingerprints(item);
      const boundary = entityRebuildBoundary(existing, item.geometry.kind, entityFingerprint(facets));
      if (boundary === "none" && existing) {
        nextRecords.set(item.id, existing);
        reusedIds.push(item.id);
        continue;
      }
      const record = materializeEntityRecord(cesium, item, facets);
      nextRecords.set(item.id, record);
      boundaries.push(entityRebuildBoundaryReport(item.id, boundary));
      if (boundary === "entity-configuration" && existing) {
        updates.push({ previous: existing, next: record });
        updatedIds.push(item.id);
      } else if (existing) {
        replacements.push(record);
        createdIds.push(item.id);
      } else {
        creations.push(record);
        createdIds.push(item.id);
      }
    }
    const departed: MountedEntityRecord[] = [];
    for (const record of previous.values()) {
      if (nextRecords.has(record.id)) continue;
      departed.push(record);
      boundaries.push(entityRebuildBoundaryReport(record.id, "snapshot-membership"));
    }
    const disposedIds = [...replacements.map((record) => record.id), ...departed.map((record) => record.id)];

    assertEntityIdsAvailable(
      collection,
      creations.map((record) => record.id),
    );

    // Mutation order is chosen so that every step before the last is undoable:
    // in-place writes are journaled, additions can be removed, and the entities
    // that left the snapshot are released only once everything else has landed.
    const writes: AppliedEntityWrite[] = [];
    const addedIds: string[] = [];
    const replacedRecords: MountedEntityRecord[] = [];
    try {
      for (const update of updates) {
        assertLifecycleActive(currentEpoch, lifecycleEpoch, state, signal);
        updateEntityInPlace(collection, update.previous, update.next, writes);
        assertLifecycleActive(currentEpoch, lifecycleEpoch, state, signal);
      }
      for (const record of replacements) {
        assertLifecycleActive(currentEpoch, lifecycleEpoch, state, signal);
        const displaced = previous.get(record.id);
        removeIdsOrThrow(collection, [record.id]);
        if (displaced) replacedRecords.push(displaced);
        collection.add(record.spec);
        addedIds.push(record.id);
        assertLifecycleActive(currentEpoch, lifecycleEpoch, state, signal);
      }
      for (const record of creations) {
        assertLifecycleActive(currentEpoch, lifecycleEpoch, state, signal);
        collection.add(record.spec);
        addedIds.push(record.id);
        assertLifecycleActive(currentEpoch, lifecycleEpoch, state, signal);
      }
      removeIdsOrThrow(
        collection,
        departed.map((record) => record.id),
      );
      assertLifecycleActive(currentEpoch, lifecycleEpoch, state, signal);
    } catch (cause) {
      // Roll back only what this refresh touched. Entities it reused were never
      // mutated, and the departed set is still attached because its removal is
      // the last step, so recovery is a matter of undoing this refresh's own
      // additions and writes rather than rebuilding the previous snapshot.
      const cleanupFailures = removeIds(collection, addedIds);
      const restoreFailures: unknown[] = [];
      for (const record of replacedRecords) {
        try {
          if (!collection.getById(record.id)) collection.add(record.spec);
        } catch (error) {
          restoreFailures.push(error);
        }
      }
      for (const write of [...writes].reverse()) {
        try {
          write.target[write.key] = write.previous;
        } catch (error) {
          restoreFailures.push(error);
        }
      }
      mounted = presentOwnedRecords(collection, previous);
      if (lifecycleInvalidated(currentEpoch, lifecycleEpoch, state)) {
        const owned = new Map(mounted);
        const disposalCleanupFailures = removeIds(collection, [...owned.keys()]);
        mounted = presentOwnedRecords(collection, owned);
        const failures = [...cleanupFailures, ...restoreFailures, ...disposalCleanupFailures];
        if (failures.length > 0) {
          throw mutationError(
            "Cesium entity disposal interrupted refresh and cleanup was incomplete.",
            cause,
            failures,
          );
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
          "Cesium entity reconciliation failed; restoration was attempted.",
          {
            rollbackSucceeded: cleanupFailures.length === 0 && restoreFailures.length === 0,
          },
        ),
      ]);
      throw mutationError("Failed to reconcile the mounted Cesium entity snapshot.", cause, [
        ...cleanupFailures,
        ...restoreFailures,
      ]);
    }
    mounted = nextRecords;
    revision += 1;
    rebuildBoundaries = Object.freeze([...boundaries]);
    const escalated = escalatedEntityBoundary(rebuildBoundaries);
    diagnostics = Object.freeze([
      ...next.diagnostics,
      diagnostic(
        source,
        plan,
        "incremental-update",
        "info",
        "update",
        "equivalent",
        `Reconciled the bounded entity snapshot: reused ${reusedIds.length}, updated ${updatedIds.length} in place, created ${createdIds.length}, disposed ${disposedIds.length}.`,
        {
          revision,
          previousEntityCount: previous.size,
          nextEntityCount: mounted.size,
          reusedEntityCount: reusedIds.length,
          updatedEntityCount: updatedIds.length,
          createdEntityCount: createdIds.length,
          disposedEntityCount: disposedIds.length,
          rebuildBoundary: escalated,
          rebuildBoundaryCounts: boundaryCounts(rebuildBoundaries),
        },
      ),
      ...(rebuildBoundaries.some((report) => !report.preserved)
        ? [
            diagnostic(
              source,
              plan,
              "rebuild-boundary",
              "info",
              "update",
              "equivalent",
              `Revision ${revision} could not carry every entity across in place; the highest boundary crossed was ${escalated}.`,
              {
                revision,
                rebuildBoundary: escalated,
                rebuildBoundaryCounts: boundaryCounts(rebuildBoundaries),
                replacedEntityCount: replacements.length,
                departedEntityCount: departed.length,
              },
            ),
          ]
        : []),
    ]);
    projection = Object.freeze({ ...next, diagnostics });
    state = next.state;
    return Object.freeze({
      ...projection,
      revision,
      reused: Object.freeze(reusedIds),
      updated: Object.freeze(updatedIds),
      created: Object.freeze(createdIds),
      disposed: Object.freeze(disposedIds),
      rebuildBoundaries,
    });
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
    get revision() {
      return revision;
    },
    get rebuildBoundaries() {
      return rebuildBoundaries;
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
): Map<string, MountedEntityRecord> {
  return new Map(
    projection.entities.map((item) => [item.id, materializeEntityRecord(cesium, item, entityFacetFingerprints(item))]),
  );
}

function materializeEntityRecord(
  cesium: CesiumEntityRuntimeModule,
  item: CesiumEntityProjectionItem,
  facets: EntityFacetFingerprints,
): MountedEntityRecord {
  return {
    id: item.id,
    kind: item.geometry.kind,
    fingerprint: entityFingerprint(facets),
    facets,
    spec: materializeEntity(cesium, item),
  };
}

/**
 * Per-facet, order-independent fingerprints of one projected feature.
 *
 * Splitting the fingerprint by facet is what lets a changed feature be updated
 * in place surgically: a feature that only moved rewrites its position and
 * leaves its property bag and availability — and anything the host attached to
 * them — alone.
 *
 * A facet is `undefined` when it cannot be fingerprinted deterministically.
 * `projectSourceToCesium` only ever emits deeply frozen JSON-like snapshots, so
 * that is unreachable through the public path today; it is the fail-closed
 * backstop for the day the projection admits a value canonicalization refuses,
 * and it resolves to "assume changed" rather than "assume reusable".
 */
function entityFacetFingerprints(item: CesiumEntityProjectionItem): EntityFacetFingerprints {
  return {
    geometry: fingerprintFacet({ geometry: item.geometry, positionSamples: item.positionSamples ?? null }),
    properties: fingerprintFacet(item.properties),
    availability: fingerprintFacet(item.interval ?? null),
  };
}

function fingerprintFacet(value: unknown): string | undefined {
  try {
    return canonicalStringify(toJsonValue(value));
  } catch {
    return undefined;
  }
}

/**
 * A stable, order-independent fingerprint of a projected feature's whole
 * configuration, or `undefined` when any facet could not be fingerprinted.
 *
 * @internal Exported for unit coverage of the diff's fail-closed behavior; not
 *   part of the `scene-workspace` barrel.
 */
export function cesiumEntityFingerprint(item: CesiumEntityProjectionItem): string | undefined {
  return entityFingerprint(entityFacetFingerprints(item));
}

function entityFingerprint(facets: EntityFacetFingerprints): string | undefined {
  if (facets.geometry === undefined || facets.properties === undefined || facets.availability === undefined) {
    return undefined;
  }
  return `${facets.geometry} ${facets.properties} ${facets.availability}`;
}

/**
 * Classify one projected feature against what this mount already owns.
 *
 * The order matters, and mirrors the primitive mount's: a feature the mount has
 * never seen is an identity crossing regardless of whether it can be
 * fingerprinted, a geometry-kind change is a replacement rather than a
 * configuration change, and an unfingerprintable feature is called out as such
 * instead of being reported as a change nobody made.
 */
function entityRebuildBoundary(
  previous: MountedEntityRecord | undefined,
  kind: CesiumEntityGeometry["kind"],
  fingerprint: string | undefined,
): CesiumEntityRebuildBoundary {
  if (previous === undefined) return "entity-identity";
  if (previous.kind !== kind) return "entity-geometry-kind";
  if (fingerprint === undefined || previous.fingerprint === undefined) return "unfingerprintable";
  return previous.fingerprint === fingerprint ? "none" : "entity-configuration";
}

function escalatedEntityBoundary(reports: readonly CesiumEntityRebuildBoundaryReport[]): CesiumEntityRebuildBoundary {
  let escalated: CesiumEntityRebuildBoundary = "none";
  for (const report of reports) {
    if (
      CESIUM_ENTITY_REBUILD_BOUNDARIES.indexOf(report.boundary) > CESIUM_ENTITY_REBUILD_BOUNDARIES.indexOf(escalated)
    ) {
      escalated = report.boundary;
    }
  }
  return escalated;
}

function boundaryCounts(reports: readonly CesiumEntityRebuildBoundaryReport[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const report of reports) counts[report.boundary] = (counts[report.boundary] ?? 0) + 1;
  return counts;
}

/**
 * Write a changed feature onto the `Entity` that already represents it.
 *
 * Only the facets whose fingerprint moved are assigned, and geometry is written
 * at the deepest field Cesium accepts — `polyline.positions` rather than a fresh
 * `polyline` — so a host that adjusted the graphic's width or material keeps it.
 * Every assignment is journaled with the value it displaced so a later failure
 * in the same refresh can undo it exactly.
 */
function updateEntityInPlace(
  collection: CesiumEntityCollectionTarget,
  previous: MountedEntityRecord,
  next: MountedEntityRecord,
  writes: AppliedEntityWrite[],
): void {
  const live = collection.getById(next.id);
  if (!isMutableRecord(live)) {
    throw new HonuaCesiumEntityAdapterError(
      "renderer-mutation-failed",
      `Cesium entity "${next.id}" is no longer available for an in-place update.`,
      { entityId: next.id },
    );
  }
  if (previous.facets.geometry !== next.facets.geometry) {
    for (const write of geometryWrites(live, next)) applyEntityWrite(write.target, write.key, write.value, writes);
  }
  if (previous.facets.properties !== next.facets.properties) {
    applyEntityWrite(live, "properties", next.spec.properties, writes);
  }
  if (previous.facets.availability !== next.facets.availability) {
    applyEntityWrite(live, "availability", next.spec.availability, writes);
  }
}

function geometryWrites(
  live: Record<string, unknown>,
  next: MountedEntityRecord,
): readonly { readonly target: Record<string, unknown>; readonly key: string; readonly value: unknown }[] {
  if (next.kind === "point") return [{ target: live, key: "position", value: next.spec.position }];
  const graphicsKey = next.kind === "polyline" ? "polyline" : "polygon";
  const positionsKey = next.kind === "polyline" ? "positions" : "hierarchy";
  const graphics = live[graphicsKey];
  const nextGraphics = next.spec[graphicsKey];
  if (isMutableRecord(graphics) && isMutableRecord(nextGraphics)) {
    return [{ target: graphics, key: positionsKey, value: nextGraphics[positionsKey] }];
  }
  return [{ target: live, key: graphicsKey, value: nextGraphics }];
}

function applyEntityWrite(
  target: Record<string, unknown>,
  key: string,
  value: unknown,
  writes: AppliedEntityWrite[],
): void {
  writes.push({ target, key, previous: target[key] });
  target[key] = value;
}

function isMutableRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Object.isFrozen(value);
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

function presentOwnedRecords(
  collection: CesiumEntityCollectionTarget,
  records: ReadonlyMap<string, MountedEntityRecord>,
): Map<string, MountedEntityRecord> {
  const present = new Map<string, MountedEntityRecord>();
  for (const [id, record] of records) {
    try {
      if (collection.getById(id)) present.set(id, record);
    } catch {
      // Conservatively retain ownership so a later disposal can retry the id.
      present.set(id, record);
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
