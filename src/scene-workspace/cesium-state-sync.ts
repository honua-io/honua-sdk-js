/**
 * The shipped 3D {@link SceneStateSyncPort}: a live Cesium `Viewer` bound to the
 * shared scene state.
 *
 * The camera half reuses the adapter's existing conversion
 * (`cameraStateToCesiumView` / `cesiumCameraToSceneState` /
 * `applyCameraStateToCesiumCamera`) rather than re-deriving it, because the
 * renderer-neutral camera *is* a globe pose — there is nothing to project. The
 * slices that a globe expresses differently from a 2D map are declared
 * differently by this port's own `mappings`, so a fidelity claim is always
 * backed by the code that makes it.
 *
 * CesiumJS stays an optional peer: the viewer is duck-typed, and the only
 * reference to the package is a lazy `import("cesium")` performed on the first
 * apply that actually needs a Cesium constructor.
 *
 * @beta Part of the beta `@honua/app-platform/scene-workspace` surface.
 * @module
 */

import type { FeatureSelectionTarget, FilterClause } from "../exploration/index.js";
import { type CesiumCameraLike, applyCameraStateToCesiumCamera, cesiumCameraToSceneState } from "./cesium-adapter.js";
import {
  type CesiumClockLike,
  type CesiumClockSnapshot,
  type CesiumClockTarget,
  applyCesiumClockPlan,
  cesiumClockPlanWrites,
  readCesiumClock,
  restoreCesiumClock,
  sceneTimelineToCesiumClockPlan,
} from "./cesium-time.js";
import {
  type SceneStateSyncPortDegradation,
  type SceneStateSyncRendererPort,
  createPortCore,
} from "./state-sync-port-kit.js";
import {
  HonuaSceneStateSyncError,
  type SceneStateSyncDelivery,
  type SceneStateSyncIdentity,
  type SceneStateSyncMapping,
  type SceneStateSyncMappings,
} from "./state-sync.js";
import type { SceneCameraState, SceneTimelineState } from "./types.js";

/** A Cesium `Event`: `addEventListener` returns its own remover. */
export interface CesiumStateSyncEvent {
  addEventListener(listener: (...args: never[]) => void): unknown;
  removeEventListener?(listener: (...args: never[]) => void): unknown;
}

/** The bits of a Cesium `Entity` this port reads and writes. */
export interface CesiumStateSyncEntity {
  readonly id: string;
  show?: boolean;
  readonly properties?: unknown;
}

/** The bits of a Cesium `EntityCollection` this port reads. */
export interface CesiumStateSyncEntityCollection {
  readonly values: readonly CesiumStateSyncEntity[];
  getById?(id: string): CesiumStateSyncEntity | undefined;
}

/**
 * The subset of a live Cesium `Viewer` this port drives.
 *
 * The clock half is {@link CesiumClockTarget}, so the shared `time` slice writes
 * a globe through exactly the binding the scene adapter uses — including its
 * `clockOwnership` declaration, which this port honours by standing down rather
 * than fighting a host-owned transport.
 */
export interface CesiumStateSyncTarget extends CesiumClockTarget {
  readonly camera: CesiumCameraLike & {
    readonly changed?: CesiumStateSyncEvent;
    readonly moveEnd?: CesiumStateSyncEvent;
  };
  readonly entities?: CesiumStateSyncEntityCollection;
  selectedEntity?: unknown;
  readonly selectedEntityChanged?: CesiumStateSyncEvent;
  readonly scene?: { requestRender?(): void };
}

/**
 * The Cesium symbols this port needs, modelled as the minimal slice of
 * `typeof import("cesium")` so a mocked module satisfies it.
 */
export interface CesiumStateSyncModule {
  readonly Cartesian3: { fromDegrees(longitude: number, latitude: number, height?: number): unknown };
  readonly JulianDate: {
    fromIso8601(iso: string): unknown;
    toIso8601(date: unknown, precision?: number): string;
  };
}

export interface CreateCesiumStateSyncPortOptions {
  readonly id?: string;
  /** Shared-plan identity stamped onto everything this port publishes. */
  readonly identity: SceneStateSyncIdentity;
  readonly now?: () => string;
  /** Inject the Cesium module. Defaults to a lazy `import("cesium")`. */
  readonly cesium?: CesiumStateSyncModule | (() => Promise<CesiumStateSyncModule>);
  /** Map a shared selection target onto an entity id. Defaults to the target's id. */
  readonly entityIdForTarget?: (target: FeatureSelectionTarget) => string | undefined;
  /** The inverse; defaults to `{ sourceId: identity.sourceId, id: entityId }`. */
  readonly targetForEntityId?: (entityId: string) => FeatureSelectionTarget | undefined;
  /** Read a filterable property off an entity. Defaults to its `properties` bag. */
  readonly entityProperty?: (entity: CesiumStateSyncEntity, field: string) => unknown;
  /** Source id the entity collection stands for, for `appliesTo` scoping. Defaults to `identity.sourceId`. */
  readonly sourceId?: string;
  readonly onDegraded?: (degradation: SceneStateSyncPortDegradation) => void;
}

const DEFAULT_PORT_ID = "cesium-state-sync";

/**
 * Bind a live Cesium viewer to the shared scene state.
 *
 * Camera and selection changes are published automatically where the viewer
 * raises an event for them (`camera.changed`, `camera.moveEnd`,
 * `selectedEntityChanged`); everything else is published by the host. Because a
 * globe's camera event is frame-driven, {@link SceneStateSyncRendererPort.readFromRenderer}
 * is the deterministic pull complement.
 */
export function createCesiumStateSyncPort(
  viewer: CesiumStateSyncTarget,
  options: CreateCesiumStateSyncPortOptions,
): SceneStateSyncRendererPort {
  if (viewer === null || typeof viewer !== "object" || viewer.camera === null || typeof viewer.camera !== "object")
    throw new HonuaSceneStateSyncError("invalid-input", "viewer.camera must be a live Cesium camera");
  if (typeof viewer.camera.setView !== "function")
    throw new HonuaSceneStateSyncError("invalid-input", "viewer.camera.setView must be a function");
  if (options === null || typeof options !== "object" || options.identity === undefined)
    throw new HonuaSceneStateSyncError("invalid-input", "options.identity is required");

  const id = options.id ?? DEFAULT_PORT_ID;
  const sourceId = options.sourceId ?? options.identity.sourceId;
  const entitiesCapable = viewer.entities !== undefined && Array.isArray(viewer.entities.values);
  const selectionCapable = entitiesCapable && "selectedEntity" in viewer;
  const clockOwned = viewer.clock !== undefined && viewer.clock !== null && viewer.clockOwnership !== "host";
  const baselineShow = new Map<string, boolean | undefined>();
  let displacedClock: CesiumClockSnapshot | undefined;
  let module: CesiumStateSyncModule | undefined = typeof options.cesium === "object" ? options.cesium : undefined;
  // Renderer events raised *during* an apply are echoes by construction. They
  // are deferred rather than dropped so the acknowledgement still reaches the
  // synchronizer (as `loop-suppressed`) once the read-back has been recorded.
  let applyingCamera = false;
  let cameraEventDuringApply = false;
  let applyingSelection = false;
  let selectionEventDuringApply = false;

  const entityIdForTarget =
    options.entityIdForTarget ??
    ((target: FeatureSelectionTarget): string | undefined => {
      if (typeof target === "string" || typeof target === "number") return String(target);
      const record = target as { id?: unknown };
      return typeof record.id === "string" || typeof record.id === "number" ? String(record.id) : undefined;
    });
  const targetForEntityId =
    options.targetForEntityId ?? ((entityId: string): FeatureSelectionTarget => ({ sourceId, id: entityId }));
  const entityProperty = options.entityProperty ?? defaultEntityProperty;

  const core = createPortCore({
    id,
    renderer: "cesium",
    identity: options.identity,
    ...(options.now ? { now: options.now } : {}),
    ...(options.onDegraded ? { onDegraded: options.onDegraded } : {}),
    bind: () => {
      const releases: (() => void)[] = [];
      const publishCamera = (): void => {
        if (applyingCamera) {
          cameraEventDuringApply = true;
          return;
        }
        core.publish("camera", readCamera());
      };
      releases.push(listen(viewer.camera.changed, publishCamera));
      releases.push(listen(viewer.camera.moveEnd, publishCamera));
      if (selectionCapable) {
        releases.push(
          listen(viewer.selectedEntityChanged, () => {
            if (applyingSelection) {
              selectionEventDuringApply = true;
              return;
            }
            core.publish("selection", readSelection());
          }),
        );
      }
      return () => {
        for (const release of releases.reverse()) release();
      };
    },
  });

  async function cesium(): Promise<CesiumStateSyncModule> {
    if (module) return module;
    module =
      typeof options.cesium === "function"
        ? await options.cesium()
        : ((await import("cesium")) as unknown as CesiumStateSyncModule);
    return module;
  }

  function readCamera(): SceneCameraState {
    return cesiumCameraToSceneState(viewer.camera);
  }

  function readSelection(): readonly FeatureSelectionTarget[] {
    const entity = viewer.selectedEntity as CesiumStateSyncEntity | undefined | null;
    if (!entity || typeof entity.id !== "string") return Object.freeze([]);
    const target = targetForEntityId(entity.id);
    return target === undefined ? Object.freeze([]) : Object.freeze([target]);
  }

  function readTime(): SceneTimelineState {
    if (!module || !viewer.clock) return Object.freeze({});
    const clock = readCesiumClock(viewer.clock);
    const currentTime = isoFromJulian(module, clock.currentTime);
    const startTime = isoFromJulian(module, clock.startTime);
    const endTime = isoFromJulian(module, clock.stopTime);
    return Object.freeze({
      ...(currentTime === undefined ? {} : { currentTime }),
      ...(startTime === undefined ? {} : { startTime }),
      ...(endTime === undefined ? {} : { endTime }),
      ...(typeof clock.shouldAnimate === "boolean" ? { playing: clock.shouldAnimate } : {}),
      ...(typeof clock.multiplier === "number" && Number.isFinite(clock.multiplier) ? { speed: clock.multiplier } : {}),
    });
  }

  async function applyCamera(camera: SceneCameraState | undefined, revision: number): Promise<void> {
    if (camera === undefined) return;
    const mod = await cesium();
    cameraEventDuringApply = false;
    applyingCamera = true;
    try {
      applyCameraStateToCesiumCamera(viewer.camera, camera, (longitude, latitude, height) =>
        mod.Cartesian3.fromDegrees(longitude, latitude, height),
      );
    } finally {
      applyingCamera = false;
    }
    viewer.scene?.requestRender?.();
    core.markApplied("camera", revision, readCamera(), camera);
    if (cameraEventDuringApply) {
      cameraEventDuringApply = false;
      core.publish("camera", readCamera());
    }
  }

  async function applyTime(time: SceneTimelineState, revision: number): Promise<void> {
    const clock: CesiumClockLike | undefined = viewer.clock;
    if (!clock) {
      core.degrade(
        "time",
        "time-clock-unavailable",
        "This viewer exposes no clock, so shared time cannot advance it.",
        {
          revision,
        },
      );
      return;
    }
    if (viewer.clockOwnership === "host") {
      core.degrade(
        "time",
        "time-clock-host-owned",
        "This viewer declares host-owned transport, so the port stood down instead of writing the clock.",
        { revision },
      );
      return;
    }
    // Reuse the scene adapter's clock plan rather than re-deriving the writes:
    // it names what a timeline cannot express, and it orders the extent before
    // the instant so a range-clamped clock accepts the new current time.
    const plan = sceneTimelineToCesiumClockPlan(time);
    if (plan && plan.rejected.length > 0) {
      core.degrade(
        "time",
        "time-plan-rejected",
        `Shared time fields were not interpretable: ${plan.rejected.join(", ")}.`,
        {
          revision,
        },
      );
    }
    if (!cesiumClockPlanWrites(plan) || !plan) {
      core.markApplied("time", revision, readTime(), time);
      return;
    }
    const mod = await cesium();
    const previous = applyCesiumClockPlan(clock, plan, mod);
    displacedClock ??= previous;
    viewer.scene?.requestRender?.();
    core.markApplied("time", revision, readTime(), time);
  }

  function applySelection(targets: readonly FeatureSelectionTarget[], revision: number): void {
    if (!selectionCapable) return;
    const resolved: CesiumStateSyncEntity[] = [];
    for (const target of targets) {
      const entityId = entityIdForTarget(target);
      const entity = entityId === undefined ? undefined : findEntity(entityId);
      if (!entity) {
        core.degrade(
          "selection",
          "selection-target-unresolved",
          `Selection target ${entityId ?? "(unaddressable)"} matches no entity in this scene.`,
          { revision },
        );
        continue;
      }
      resolved.push(entity);
    }
    if (resolved.length > 1) {
      core.degrade(
        "selection",
        "selection-not-fully-expressible",
        "A globe expresses one focused entity; the first resolvable target was applied and the rest were not drawn.",
        { revision, requested: resolved.length, applied: 1 },
      );
    }
    selectionEventDuringApply = false;
    applyingSelection = true;
    try {
      viewer.selectedEntity = resolved[0];
    } finally {
      applyingSelection = false;
    }
    viewer.scene?.requestRender?.();
    core.markApplied("selection", revision, readSelection(), targets);
    if (selectionEventDuringApply) {
      selectionEventDuringApply = false;
      core.publish("selection", readSelection());
    }
  }

  function applyFilters(filters: Readonly<Record<string, FilterClause>>, revision: number): void {
    if (!entitiesCapable || !viewer.entities) return;
    const clauses = Object.values(filters).filter(
      (clause) => !clause.appliesTo || clause.appliesTo.length === 0 || clause.appliesTo.includes(sourceId),
    );
    for (const entity of viewer.entities.values) {
      if (!baselineShow.has(entity.id)) baselineShow.set(entity.id, entity.show);
      if (clauses.length === 0) {
        entity.show = baselineShow.get(entity.id) ?? true;
        continue;
      }
      entity.show = (baselineShow.get(entity.id) ?? true) && clauses.every((clause) => matches(entity, clause));
    }
    viewer.scene?.requestRender?.();
    core.markApplied("filters", revision, filters);
  }

  function matches(entity: CesiumStateSyncEntity, clause: FilterClause): boolean {
    const value = entityProperty(entity, clause.field);
    switch (clause.operator) {
      case "=":
        return value === clause.value;
      case "!=":
        return value !== clause.value;
      case "<":
      case "<=":
      case ">":
      case ">=":
        return compare(value, clause.value, clause.operator);
      case "in":
        return Array.isArray(clause.value) && clause.value.includes(value as never);
      case "not-in":
        return Array.isArray(clause.value) && !clause.value.includes(value as never);
      case "between":
        return (
          Array.isArray(clause.value) && compare(value, clause.value[0], ">=") && compare(value, clause.value[1], "<=")
        );
      case "is-null":
        return value === null || value === undefined;
      case "is-not-null":
        return value !== null && value !== undefined;
      case "like":
        return typeof value === "string" && typeof clause.value === "string" && likeMatches(value, clause.value);
    }
  }

  function findEntity(entityId: string): CesiumStateSyncEntity | undefined {
    if (!viewer.entities) return undefined;
    if (typeof viewer.entities.getById === "function") return viewer.entities.getById(entityId) ?? undefined;
    return viewer.entities.values.find((entity) => entity.id === entityId);
  }

  async function apply(delivery: SceneStateSyncDelivery): Promise<void> {
    const { slice, value, revision } = delivery.envelope;
    switch (slice) {
      case "camera":
        await applyCamera(value as SceneCameraState | undefined, revision);
        return;
      case "time":
        await applyTime(value as SceneTimelineState, revision);
        return;
      case "selection":
        applySelection(value as readonly FeatureSelectionTarget[], revision);
        return;
      case "filters":
        applyFilters(value as Readonly<Record<string, FilterClause>>, revision);
        return;
      default:
        // `attribution` and `realtime` are credential-free host read models;
        // `detail` never arrives because this port declares it unsupported.
        core.markApplied(slice, revision, value);
    }
  }

  const port: SceneStateSyncRendererPort = {
    id,
    renderer: "cesium",
    mappings: buildMappings({ selectionCapable, entitiesCapable, clockOwned }),
    subscribe(listener, signal) {
      return core.subscribe(listener, signal);
    },
    apply(delivery) {
      return apply(delivery);
    },
    publish(slice, value) {
      return core.publish(slice, value);
    },
    readFromRenderer(slice) {
      if (slice === "camera") return core.publish("camera", readCamera());
      if (slice === "selection" && selectionCapable) return core.publish("selection", readSelection());
      if (slice === "time" && viewer.clock !== undefined && module) return core.publish("time", readTime());
      return "unsupported";
    },
    get degradations() {
      return core.degradations;
    },
    get disposed() {
      return core.disposed;
    },
    dispose() {
      if (core.disposed) return;
      if (displacedClock && viewer.clock) {
        restoreCesiumClock(viewer.clock, displacedClock);
        displacedClock = undefined;
      }
      if (viewer.entities) {
        for (const entity of viewer.entities.values) {
          if (baselineShow.has(entity.id)) entity.show = baselineShow.get(entity.id) ?? true;
        }
      }
      baselineShow.clear();
      core.dispose();
    },
  };
  return port;
}

function buildMappings(capabilities: {
  readonly selectionCapable: boolean;
  readonly entitiesCapable: boolean;
  readonly clockOwned: boolean;
}): SceneStateSyncMappings {
  const mapping = (
    inbound: SceneStateSyncMapping["inbound"],
    outbound: SceneStateSyncMapping["outbound"],
    code: string,
    message: string,
  ): SceneStateSyncMapping => Object.freeze({ inbound, outbound, code, message });
  return Object.freeze({
    camera: mapping(
      "exact",
      "exact",
      "cesium-3d-camera",
      "The renderer-neutral camera is a globe pose, so longitude, latitude, height, heading, pitch, and roll all map without projection.",
    ),
    selection: capabilities.selectionCapable
      ? mapping(
          "equivalent",
          "equivalent",
          "cesium-selected-entity",
          "A globe expresses one focused entity; the first resolvable target becomes the selected entity and additional targets are reported rather than drawn.",
        )
      : mapping(
          "exact",
          "unsupported",
          "cesium-entities-unavailable",
          "This viewer exposes no entity collection, so shared selection cannot be focused.",
        ),
    filters: capabilities.entitiesCapable
      ? mapping(
          "exact",
          "equivalent",
          "cesium-entity-visibility-filter",
          "Protocol-neutral clauses are evaluated against entity properties and applied as entity visibility; the original visibility is restored when the clauses clear.",
        )
      : mapping(
          "exact",
          "unsupported",
          "cesium-entities-unavailable",
          "This viewer exposes no entity collection, so shared filters have nothing to hide.",
        ),
    time: capabilities.clockOwned
      ? mapping(
          "exact",
          "exact",
          "cesium-clock",
          "Shared application time maps to the viewer clock's extent, current instant, rate, and transport, through the same clock plan the scene adapter applies.",
        )
      : mapping(
          "exact",
          "unsupported",
          "cesium-clock-unbound",
          "This viewer exposes no clock, or declares host-owned transport, so shared time does not advance the scene.",
        ),
    detail: mapping(
      "exact",
      "unsupported",
      "cesium-detail-focus-owned-by-selection",
      "A globe has exactly one focused-entity channel and the selection slice owns it. A detail chosen in this view is shared, but a detail chosen elsewhere is refused rather than double-driving the focus.",
    ),
    attribution: mapping(
      "exact",
      "equivalent",
      "cesium-attribution-ids",
      "Credential-free attribution identifiers are shared for the host to render; the globe's own credit display is driven by its providers.",
    ),
    realtime: mapping(
      "exact",
      "equivalent",
      "cesium-realtime-status",
      "Realtime status is shared for the host to render; the globe has no realtime surface of its own.",
    ),
  }) as SceneStateSyncMappings;
}

function listen(event: CesiumStateSyncEvent | undefined, listener: () => void): () => void {
  if (!event || typeof event.addEventListener !== "function") return () => undefined;
  const removed = event.addEventListener(listener);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (typeof removed === "function") {
      (removed as () => void)();
      return;
    }
    event.removeEventListener?.(listener);
  };
}

function defaultEntityProperty(entity: CesiumStateSyncEntity, field: string): unknown {
  const bag = entity.properties;
  if (bag === null || typeof bag !== "object") return undefined;
  const property = (bag as Record<string, unknown>)[field];
  if (property === null || property === undefined) return property ?? undefined;
  const getValue = (property as { getValue?: unknown }).getValue;
  return typeof getValue === "function" ? (getValue as () => unknown).call(property) : property;
}

function isoFromJulian(module: CesiumStateSyncModule, value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  try {
    const iso = module.JulianDate.toIso8601(value, 3);
    return typeof iso === "string" && new Date(iso).toISOString() === iso ? iso : undefined;
  } catch {
    return undefined;
  }
}

function compare(left: unknown, right: unknown, operator: "<" | "<=" | ">" | ">="): boolean {
  if (typeof left !== "number" || typeof right !== "number") return false;
  switch (operator) {
    case "<":
      return left < right;
    case "<=":
      return left <= right;
    case ">":
      return left > right;
    case ">=":
      return left >= right;
  }
}

/**
 * SQL `LIKE` with `%`/`_` wildcards, matched without a regular expression so a
 * hostile pattern cannot drive backtracking.
 */
function likeMatches(value: string, pattern: string): boolean {
  const text = value.toLowerCase();
  const needle = pattern.toLowerCase();
  let textIndex = 0;
  let patternIndex = 0;
  let starText = -1;
  let starPattern = -1;
  while (textIndex < text.length) {
    const patternCharacter = needle[patternIndex];
    if (patternIndex < needle.length && (patternCharacter === "_" || patternCharacter === text[textIndex])) {
      textIndex += 1;
      patternIndex += 1;
    } else if (patternIndex < needle.length && patternCharacter === "%") {
      starPattern = patternIndex;
      starText = textIndex;
      patternIndex += 1;
    } else if (starPattern !== -1) {
      patternIndex = starPattern + 1;
      starText += 1;
      textIndex = starText;
    } else {
      return false;
    }
  }
  while (patternIndex < needle.length && needle[patternIndex] === "%") patternIndex += 1;
  return patternIndex === needle.length;
}
