/**
 * Normalized 3D scene picking and bookmark serialization/round-trip helpers.
 *
 * Maps raw Cesium `scene.pick` outputs (entities, 3D-Tiles features, point-cloud
 * features, glTF models, or empty hits) onto stable renderer-neutral
 * source/feature/primitive identities with explicit unresolvable diagnostics.
 *
 * @experimental Held back from the beta `@honua/app-platform/scene-workspace`
 *   tier while real-Cesium browser picking fixtures are collected.
 * @module
 */

import type { FeatureId, SourceId } from "../contract/types.js";
import type { FeatureSelectionTarget } from "../exploration/index.js";
import type { SceneAnalysisPosition } from "./analysis-widgets.js";
import { type CesiumSceneLike, resolvePickedFeatureAttributes } from "./cesium-adapter.js";
import type { SceneBookmark, SceneCameraState, SceneStoreState, SceneTimelineState } from "./types.js";

/** Normalized target kind produced by {@link normalizeCesiumPick}. */
export type ScenePickTargetKind = "entity" | "3d-tiles-feature" | "point-cloud" | "model" | "unresolvable";

/** Diagnostic explaining why a scene pick could not be resolved or was degraded. */
export interface ScenePickDiagnostic {
  readonly code: "pick-empty" | "pick-unresolvable-primitive" | "pick-missing-identity";
  readonly message: string;
  readonly primitiveType?: string;
}

/** Normalized renderer-neutral pick result. */
export type NormalizedScenePickResult =
  | {
      readonly resolved: true;
      readonly kind: Exclude<ScenePickTargetKind, "unresolvable">;
      readonly sourceId?: SourceId;
      readonly featureId?: FeatureId;
      readonly primitiveId?: string;
      readonly position?: SceneAnalysisPosition;
      readonly attributes: Readonly<Record<string, unknown>>;
      readonly selectionTarget?: FeatureSelectionTarget;
    }
  | {
      readonly resolved: false;
      readonly kind: "unresolvable";
      readonly position?: SceneAnalysisPosition;
      readonly diagnostic: ScenePickDiagnostic;
    };

/** Options for {@link normalizeCesiumPick} and {@link pickNormalizedSceneFeature}. */
export interface NormalizeCesiumPickOptions {
  readonly position?: SceneAnalysisPosition;
  readonly defaultSourceId?: SourceId;
  readonly featureIdFields?: readonly string[];
}

const DEFAULT_FEATURE_ID_FIELDS: readonly string[] = ["objectId", "OBJECTID", "id", "featureId", "fid", "gml_id"];
const HONUA_ENTITY_ID_RE = /^honua-([^:]+):(n|s):(.+)$/;

/**
 * Normalize any raw Cesium `scene.pick(...)` result into a stable,
 * renderer-neutral pick outcome with source/feature identity, attributes, and
 * explicit unresolvable diagnostics. Pure.
 */
export function normalizeCesiumPick(
  picked: unknown,
  options: NormalizeCesiumPickOptions = {},
): NormalizedScenePickResult {
  if (picked === null || picked === undefined) {
    return unresolvable("pick-empty", "Scene pick did not intersect any renderable feature.", options.position);
  }
  if (typeof picked !== "object") {
    return unresolvable(
      "pick-unresolvable-primitive",
      "Scene pick returned a non-object value.",
      options.position,
      typeof picked,
    );
  }

  const featureAttributes = resolvePickedFeatureAttributes(picked);
  if (featureAttributes !== undefined) {
    return normalizeTilesetOrPointCloudPick(picked as Record<string, unknown>, featureAttributes, options);
  }

  const record = picked as Record<string, unknown>;
  const entityCandidate = record.id;
  if (
    entityCandidate &&
    typeof entityCandidate === "object" &&
    typeof (entityCandidate as { id?: unknown }).id === "string"
  ) {
    return normalizeEntityPick(entityCandidate as Record<string, unknown>, options);
  }

  if (typeof record.id === "string" || (record.primitive && typeof record.primitive === "object")) {
    return normalizeModelPick(record, options);
  }

  return unresolvable(
    "pick-unresolvable-primitive",
    "Picked Cesium object does not expose a Honua entity, model, or 3D-Tiles feature contract.",
    options.position,
    record.constructor?.name,
  );
}

/**
 * Pick at a screen coordinate on a Cesium scene and return a normalized
 * renderer-neutral {@link NormalizedScenePickResult}.
 */
export function pickNormalizedSceneFeature(
  scene: CesiumSceneLike,
  windowPosition: unknown,
  options: NormalizeCesiumPickOptions = {},
): NormalizedScenePickResult {
  if (typeof scene.pick !== "function") {
    return unresolvable(
      "pick-unresolvable-primitive",
      "Attached Cesium scene does not expose pick().",
      options.position,
    );
  }
  return normalizeCesiumPick(scene.pick(windowPosition), options);
}

/**
 * Capture a {@link SceneBookmark} from workspace state, preserving camera pose,
 * optional projection/vertical-datum metadata, and current timeline state.
 */
export function captureSceneBookmark(
  state: Pick<SceneStoreState, "camera" | "timeline">,
  options: {
    readonly id: string;
    readonly label: string;
    readonly projection?: string;
    readonly verticalDatum?: string;
  },
): SceneBookmark {
  if (!state.camera) {
    throw new Error("Cannot capture a scene bookmark before a camera position is set.");
  }
  const hasTime = hasTimelineFields(state.timeline);
  return {
    id: options.id,
    label: options.label,
    camera: { ...state.camera },
    ...(options.projection !== undefined ? { projection: options.projection } : {}),
    ...(options.verticalDatum !== undefined ? { verticalDatum: options.verticalDatum } : {}),
    ...(hasTime ? { time: { ...state.timeline } } : {}),
  };
}

/** Serialize a {@link SceneBookmark} (including projection, vertical datum, and time) to JSON. */
export function serializeSceneBookmark(bookmark: SceneBookmark): string {
  return JSON.stringify(bookmark);
}

/** Parse and validate a serialized {@link SceneBookmark} JSON payload for round-trip restoration. */
export function parseSceneBookmark(raw: string | unknown): SceneBookmark {
  const parsed: unknown = typeof raw === "string" ? JSON.parse(raw) : raw;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Scene bookmark payload must be a JSON object.");
  }
  const record = parsed as Record<string, unknown>;
  const id = typeof record.id === "string" && record.id.trim() !== "" ? record.id.trim() : undefined;
  const label = typeof record.label === "string" && record.label.trim() !== "" ? record.label.trim() : undefined;
  if (!id || !label) {
    throw new Error("Scene bookmark requires non-empty id and label.");
  }
  const camera = parseBookmarkCamera(record.camera);
  const projection =
    typeof record.projection === "string" && record.projection.trim() !== "" ? record.projection.trim() : undefined;
  const verticalDatum =
    typeof record.verticalDatum === "string" && record.verticalDatum.trim() !== ""
      ? record.verticalDatum.trim()
      : undefined;
  const time = parseBookmarkTime(record.time);
  return {
    id,
    label,
    camera,
    ...(projection !== undefined ? { projection } : {}),
    ...(verticalDatum !== undefined ? { verticalDatum } : {}),
    ...(time !== undefined ? { time } : {}),
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function normalizeTilesetOrPointCloudPick(
  picked: Record<string, unknown>,
  attributes: Record<string, unknown>,
  options: NormalizeCesiumPickOptions,
): NormalizedScenePickResult {
  const isPointCloud =
    picked.constructor?.name?.toLowerCase().includes("pointcloud") === true ||
    typeof picked.pointId === "number" ||
    "classification" in attributes ||
    "Classification" in attributes;
  const kind = isPointCloud ? "point-cloud" : "3d-tiles-feature";
  const primitiveId = readPrimitiveId(picked.tileset) ?? readPrimitiveId(picked.primitive);
  const sourceId = options.defaultSourceId ?? primitiveId;
  const featureId = findFeatureId(attributes, options.featureIdFields ?? DEFAULT_FEATURE_ID_FIELDS);
  const selectionTarget = sourceId !== undefined && featureId !== undefined ? { sourceId, id: featureId } : undefined;
  return {
    resolved: true,
    kind,
    ...(sourceId !== undefined ? { sourceId } : {}),
    ...(featureId !== undefined ? { featureId } : {}),
    ...(primitiveId !== undefined ? { primitiveId } : {}),
    ...(options.position ? { position: options.position } : {}),
    attributes: Object.freeze({ ...attributes }),
    ...(selectionTarget ? { selectionTarget } : {}),
  };
}

function normalizeEntityPick(
  entity: Record<string, unknown>,
  options: NormalizeCesiumPickOptions,
): NormalizedScenePickResult {
  const entityId = entity.id as string;
  const parsedIdentity = parseHonuaEntityId(entityId);
  const attributes = readEntityProperties(entity.properties);
  const sourceId = parsedIdentity?.sourceId ?? options.defaultSourceId;
  const featureId =
    parsedIdentity?.featureId ??
    findFeatureId(attributes, options.featureIdFields ?? DEFAULT_FEATURE_ID_FIELDS) ??
    entityId;
  const selectionTarget = sourceId !== undefined ? { sourceId, id: featureId } : undefined;
  return {
    resolved: true,
    kind: "entity",
    ...(sourceId !== undefined ? { sourceId } : {}),
    featureId,
    primitiveId: entityId,
    ...(options.position ? { position: options.position } : {}),
    attributes: Object.freeze(attributes),
    ...(selectionTarget ? { selectionTarget } : {}),
  };
}

function normalizeModelPick(
  record: Record<string, unknown>,
  options: NormalizeCesiumPickOptions,
): NormalizedScenePickResult {
  const primitiveId = typeof record.id === "string" ? record.id : readPrimitiveId(record.primitive);
  if (!primitiveId) {
    return unresolvable(
      "pick-missing-identity",
      "Picked model primitive carries no stable identifier.",
      options.position,
      record.primitive?.constructor?.name,
    );
  }
  const sourceId = options.defaultSourceId;
  const node = record.node && typeof record.node === "object" ? (record.node as Record<string, unknown>) : undefined;
  const attributes: Record<string, unknown> = {
    ...(typeof node?.name === "string" ? { nodeName: node.name } : {}),
    ...(typeof record.mesh === "object" && record.mesh && typeof (record.mesh as { name?: unknown }).name === "string"
      ? { meshName: (record.mesh as { name: string }).name }
      : {}),
  };
  return {
    resolved: true,
    kind: "model",
    ...(sourceId !== undefined ? { sourceId } : {}),
    featureId: primitiveId,
    primitiveId,
    ...(options.position ? { position: options.position } : {}),
    attributes: Object.freeze(attributes),
    ...(sourceId !== undefined ? { selectionTarget: { sourceId, id: primitiveId } } : {}),
  };
}

function parseHonuaEntityId(id: string): { readonly sourceId: string; readonly featureId: FeatureId } | undefined {
  const match = HONUA_ENTITY_ID_RE.exec(id);
  if (!match) return undefined;
  const sourceId = match[1]!;
  const kind = match[2]!;
  const decoded = decodeURIComponent(match[3]!);
  const featureId: FeatureId = kind === "n" && Number.isFinite(Number(decoded)) ? Number(decoded) : decoded;
  return { sourceId, featureId };
}

function readEntityProperties(bag: unknown): Record<string, unknown> {
  if (!bag || typeof bag !== "object") return {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(bag as Record<string, unknown>)) {
    const getter = value && typeof value === "object" ? (value as { getValue?: () => unknown }).getValue : undefined;
    out[key] = typeof getter === "function" ? getter.call(value) : value;
  }
  return out;
}

function readPrimitiveId(candidate: unknown): string | undefined {
  if (!candidate || typeof candidate !== "object") return undefined;
  const record = candidate as Record<string, unknown>;
  if (typeof record.id === "string" && record.id.trim() !== "") return record.id.trim();
  if (typeof record.url === "string" && record.url.trim() !== "") return record.url.trim();
  return undefined;
}

function findFeatureId(
  attributes: Readonly<Record<string, unknown>>,
  fields: readonly string[],
): FeatureId | undefined {
  for (const field of fields) {
    const value = attributes[field];
    if (typeof value === "string" && value.trim() !== "") return value;
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return undefined;
}

function unresolvable(
  code: ScenePickDiagnostic["code"],
  message: string,
  position?: SceneAnalysisPosition,
  primitiveType?: string,
): NormalizedScenePickResult {
  return {
    resolved: false,
    kind: "unresolvable",
    ...(position ? { position } : {}),
    diagnostic: { code, message, ...(primitiveType ? { primitiveType } : {}) },
  };
}

function parseBookmarkCamera(raw: unknown): SceneCameraState {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Scene bookmark requires a camera object.");
  }
  const cam = raw as Record<string, unknown>;
  if (
    typeof cam.longitude !== "number" ||
    !Number.isFinite(cam.longitude) ||
    typeof cam.latitude !== "number" ||
    !Number.isFinite(cam.latitude) ||
    typeof cam.height !== "number" ||
    !Number.isFinite(cam.height)
  ) {
    throw new Error("Scene bookmark camera requires finite longitude, latitude, and height.");
  }
  const heading = typeof cam.heading === "number" && Number.isFinite(cam.heading) ? cam.heading : undefined;
  const pitch = typeof cam.pitch === "number" && Number.isFinite(cam.pitch) ? cam.pitch : undefined;
  const roll = typeof cam.roll === "number" && Number.isFinite(cam.roll) ? cam.roll : undefined;
  return {
    longitude: cam.longitude,
    latitude: cam.latitude,
    height: cam.height,
    ...(heading !== undefined ? { heading } : {}),
    ...(pitch !== undefined ? { pitch } : {}),
    ...(roll !== undefined ? { roll } : {}),
  };
}

function parseBookmarkTime(raw: unknown): SceneTimelineState | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Scene bookmark time must be an object when present.");
  }
  const t = raw as Record<string, unknown>;
  const time: SceneTimelineState = {
    ...(typeof t.currentTime === "string" ? { currentTime: t.currentTime } : {}),
    ...(typeof t.startTime === "string" ? { startTime: t.startTime } : {}),
    ...(typeof t.endTime === "string" ? { endTime: t.endTime } : {}),
    ...(typeof t.playing === "boolean" ? { playing: t.playing } : {}),
    ...(typeof t.progress === "number" && Number.isFinite(t.progress) ? { progress: t.progress } : {}),
    ...(typeof t.speed === "number" && Number.isFinite(t.speed) ? { speed: t.speed } : {}),
  };
  return hasTimelineFields(time) ? time : undefined;
}

function hasTimelineFields(timeline: SceneTimelineState): boolean {
  return (
    timeline.currentTime !== undefined ||
    timeline.startTime !== undefined ||
    timeline.endTime !== undefined ||
    timeline.playing !== undefined ||
    timeline.progress !== undefined ||
    timeline.speed !== undefined
  );
}
