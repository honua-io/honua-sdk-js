/**
 * Renderer-neutral 3D scene workspace contracts.
 *
 * These types intentionally describe state and adapter events without
 * importing Cesium, MapLibre, or any rendering package.
 *
 * @beta Part of the beta `@honua/app-platform/scene-workspace` surface; these
 *   state shapes are not renamed or removed through 0.1.x and grow additively.
 * @module
 */

import type { FeatureId, SourceId } from "../contract/types.js";
import type { FeatureSelectionTarget, FilterClause } from "../exploration/index.js";
import type { RealtimeConnectionStatus } from "../realtime/index.js";
import type { ScenePrimitiveDiagnostic, SceneRuntimePrimitive } from "./primitives.js";

export type SceneWorkspaceSlice =
  | "all"
  | "scene"
  | "camera"
  | "layers"
  | "primitives"
  | "diagnostics"
  | "filters"
  | "detail"
  | "selection"
  | "timeline"
  | "evidence"
  | "realtime"
  | "history";

export const SCENE_WORKSPACE_SLICES: readonly SceneWorkspaceSlice[] = [
  "all",
  "scene",
  "camera",
  "layers",
  "primitives",
  "diagnostics",
  "filters",
  "detail",
  "selection",
  "timeline",
  "evidence",
  "realtime",
  "history",
] as const;

export interface SceneLayerState {
  readonly id: string;
  readonly sourceId?: SourceId;
  readonly title?: string;
  readonly visible: boolean;
  readonly opacity?: number;
  readonly kind?: "scene" | "feature" | "imagery" | "tiles" | "evidence" | "custom";
}

export interface SceneCameraState {
  readonly longitude: number;
  readonly latitude: number;
  readonly height: number;
  readonly heading?: number;
  readonly pitch?: number;
  readonly roll?: number;
}

export interface SceneBookmark {
  readonly id: string;
  readonly label: string;
  readonly camera: SceneCameraState;
}

export interface SceneTimelineState {
  readonly currentTime?: string;
  readonly startTime?: string;
  readonly endTime?: string;
  readonly playing?: boolean;
  readonly progress?: number;
}

export interface SceneEvidenceReference {
  readonly id: string;
  readonly label: string;
  readonly kind: "image" | "video" | "document" | "point-cloud" | "model" | "sensor" | "custom";
  readonly sourceId?: SourceId;
  readonly featureId?: FeatureId;
  readonly url?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface SceneRealtimeState {
  readonly status: RealtimeConnectionStatus;
  readonly cursor?: string;
  readonly staleSince?: number;
}

export interface SceneDetailState {
  readonly target?: FeatureSelectionTarget;
  readonly sourceId?: SourceId;
  readonly featureId?: FeatureId;
  readonly title?: string;
  readonly status?: "empty" | "loading" | "ready" | "stale" | "error";
  readonly attributes?: Readonly<Record<string, unknown>>;
}

export interface SceneWorkspaceState {
  readonly sceneId?: string;
  readonly title?: string;
  readonly layers: Readonly<Record<string, SceneLayerState>>;
  readonly primitives: Readonly<Record<string, SceneRuntimePrimitive>>;
  readonly diagnostics: ReadonlyArray<ScenePrimitiveDiagnostic>;
  readonly filters: Readonly<Record<string, FilterClause>>;
  readonly detail: SceneDetailState;
  readonly camera?: SceneCameraState;
  readonly bookmarks: Readonly<Record<string, SceneBookmark>>;
  readonly selection: ReadonlyArray<FeatureSelectionTarget>;
  readonly activeAssetId?: FeatureId;
  readonly timeline: SceneTimelineState;
  readonly evidence: Readonly<Record<string, SceneEvidenceReference>>;
  readonly realtime: SceneRealtimeState;
  readonly history: ReadonlyArray<SceneWorkspaceHistoryEntry>;
}

export interface SceneWorkspaceHistoryEntry {
  readonly id: string;
  readonly label: string;
  readonly at: string;
  readonly intentKind: SceneWorkspaceIntent["kind"];
}

export interface SceneWorkspaceSnapshot {
  readonly version: 1;
  readonly state: SceneWorkspaceState;
}

export type SceneWorkspaceIntent =
  | SetSceneIntent
  | SetSceneLayersIntent
  | SetScenePrimitivesIntent
  | SetSceneDiagnosticsIntent
  | SetLayerVisibilityIntent
  | SetCameraIntent
  | ApplyBookmarkIntent
  | SetSceneFilterIntent
  | ClearSceneFilterIntent
  | SetSelectionIntent
  | ClearSelectionIntent
  | SetSceneDetailIntent
  | SetActiveAssetIntent
  | SetTimelineIntent
  | AddEvidenceIntent
  | RemoveEvidenceIntent
  | SetRealtimeIntent
  | RestoreSceneWorkspaceIntent;

interface IntentBase {
  readonly source?: "scene" | "map" | "table" | "detail" | "timeline" | "realtime" | "workspace" | "custom";
  readonly historyLabel?: string;
  readonly at?: string;
}

export interface SetSceneIntent extends IntentBase {
  readonly kind: "set-scene";
  readonly sceneId: string | undefined;
  readonly title?: string;
}

export interface SetSceneLayersIntent extends IntentBase {
  readonly kind: "set-layers";
  readonly layers: ReadonlyArray<SceneLayerState>;
}

export interface SetScenePrimitivesIntent extends IntentBase {
  readonly kind: "set-primitives";
  readonly primitives: ReadonlyArray<SceneRuntimePrimitive>;
}

export interface SetSceneDiagnosticsIntent extends IntentBase {
  readonly kind: "set-diagnostics";
  readonly diagnostics: ReadonlyArray<ScenePrimitiveDiagnostic>;
}

export interface SetLayerVisibilityIntent extends IntentBase {
  readonly kind: "set-layer-visibility";
  readonly layerId: string;
  readonly visible: boolean;
}

export interface SetCameraIntent extends IntentBase {
  readonly kind: "set-camera";
  readonly camera: SceneCameraState | undefined;
}

export interface ApplyBookmarkIntent extends IntentBase {
  readonly kind: "apply-bookmark";
  readonly bookmark: SceneBookmark;
}

export interface SetSceneFilterIntent extends IntentBase {
  readonly kind: "set-filter";
  readonly id: string;
  readonly clause: FilterClause;
}

export interface ClearSceneFilterIntent extends IntentBase {
  readonly kind: "clear-filter";
  readonly id: string;
}

export interface SetSelectionIntent extends IntentBase {
  readonly kind: "set-selection";
  readonly selection: ReadonlyArray<FeatureSelectionTarget>;
}

export interface ClearSelectionIntent extends IntentBase {
  readonly kind: "clear-selection";
}

export interface SetSceneDetailIntent extends IntentBase {
  readonly kind: "set-detail";
  readonly detail: SceneDetailState;
}

export interface SetActiveAssetIntent extends IntentBase {
  readonly kind: "set-active-asset";
  readonly id: FeatureId | undefined;
}

export interface SetTimelineIntent extends IntentBase {
  readonly kind: "set-timeline";
  readonly timeline: SceneTimelineState;
}

export interface AddEvidenceIntent extends IntentBase {
  readonly kind: "add-evidence";
  readonly evidence: SceneEvidenceReference;
}

export interface RemoveEvidenceIntent extends IntentBase {
  readonly kind: "remove-evidence";
  readonly id: string;
}

export interface SetRealtimeIntent extends IntentBase {
  readonly kind: "set-realtime";
  readonly realtime: SceneRealtimeState;
}

export interface RestoreSceneWorkspaceIntent extends IntentBase {
  readonly kind: "restore";
  readonly snapshot: SceneWorkspaceSnapshot;
}

export type SceneWorkspaceAdapterEvent =
  | SceneWorkspaceCameraEvent
  | SceneWorkspaceLayerVisibilityEvent
  | SceneWorkspacePrimitiveDiagnosticsEvent
  | SceneWorkspaceFilterEvent
  | SceneWorkspaceSelectionEvent
  | SceneWorkspaceDetailEvent
  | SceneWorkspaceTimelineEvent
  | SceneWorkspaceEvidenceEvent
  | SceneWorkspaceRealtimeEvent;

export interface SceneWorkspaceCameraEvent {
  readonly type: "camera-change";
  readonly camera: SceneCameraState | undefined;
}

export interface SceneWorkspaceLayerVisibilityEvent {
  readonly type: "layer-visibility-change";
  readonly layerId: string;
  readonly visible: boolean;
}

export interface SceneWorkspacePrimitiveDiagnosticsEvent {
  readonly type: "primitive-diagnostics";
  readonly diagnostics: ReadonlyArray<ScenePrimitiveDiagnostic>;
}

export interface SceneWorkspaceFilterEvent {
  readonly type: "filter-change";
  readonly id: string;
  readonly clause: FilterClause | undefined;
}

export interface SceneWorkspaceSelectionEvent {
  readonly type: "selection-change";
  readonly selection: ReadonlyArray<FeatureSelectionTarget>;
}

export interface SceneWorkspaceDetailEvent {
  readonly type: "detail-change";
  readonly detail: SceneDetailState;
}

export interface SceneWorkspaceTimelineEvent {
  readonly type: "timeline-change";
  readonly timeline: SceneTimelineState;
}

export interface SceneWorkspaceEvidenceEvent {
  readonly type: "evidence-add" | "evidence-remove";
  readonly evidence?: SceneEvidenceReference;
  readonly id?: string;
}

export interface SceneWorkspaceRealtimeEvent {
  readonly type: "realtime-status";
  readonly realtime: SceneRealtimeState;
}

export interface SceneWorkspaceChangeEvent {
  readonly state: SceneWorkspaceState;
  readonly previous: SceneWorkspaceState;
  readonly changedSlices: ReadonlySet<SceneWorkspaceSlice>;
  readonly intent: SceneWorkspaceIntent;
}

export type SceneWorkspaceListener = (event: SceneWorkspaceChangeEvent) => void;
export type SceneWorkspaceUnsubscribe = () => void;

export interface SceneWorkspace {
  readonly state: SceneWorkspaceState;
  dispatch(intent: SceneWorkspaceIntent): SceneWorkspaceState;
  subscribe(slice: SceneWorkspaceSlice, listener: SceneWorkspaceListener): SceneWorkspaceUnsubscribe;
  snapshot(): SceneWorkspaceSnapshot;
  restore(snapshot: SceneWorkspaceSnapshot): SceneWorkspaceState;
  dispose(): void;
}
