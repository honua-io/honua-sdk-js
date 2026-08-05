/**
 * Renderer-neutral scene workspace store: intents in, typed slices out.
 *
 * The reducer, the selectors, and the adapter-event mapping never import a
 * renderer, so the same workspace drives Cesium, MapLibre, a table, or a test.
 *
 * @beta Part of the beta `@honua/app-platform/scene-workspace` surface; these
 *   exports are not renamed or removed through 0.1.x, and intents, slices, and
 *   diagnostics grow additively.
 * @module
 */

import { featureSelectionKey } from "../exploration/index.js";
import {
  type ScenePrimitiveDiagnostic,
  type SceneRuntimePrimitive,
  assertScenePrimitiveSerializable,
} from "./primitives.js";
import type {
  SceneEvidenceReference,
  SceneLayerState,
  SceneWorkspace,
  SceneWorkspaceAdapterEvent,
  SceneWorkspaceChangeEvent,
  SceneWorkspaceIntent,
  SceneWorkspaceListener,
  SceneWorkspaceSlice,
  SceneWorkspaceState,
} from "./types.js";

export function emptySceneWorkspaceState(): SceneWorkspaceState {
  return {
    layers: {},
    primitives: {},
    diagnostics: [],
    filters: {},
    detail: {},
    bookmarks: {},
    selection: [],
    timeline: {},
    evidence: {},
    realtime: { status: "idle" },
    history: [],
  };
}

export function createSceneWorkspace(initialState: Partial<SceneWorkspaceState> = {}): SceneWorkspace {
  let state: SceneWorkspaceState = mergeState(emptySceneWorkspaceState(), initialState);
  const listeners = new Map<SceneWorkspaceSlice, Set<SceneWorkspaceListener>>();
  let disposed = false;

  function ensureLive(): void {
    if (disposed) throw new Error("SceneWorkspace has been disposed.");
  }

  function emit(event: SceneWorkspaceChangeEvent): void {
    for (const listener of listeners.get("all") ?? []) listener(event);
    for (const slice of event.changedSlices) {
      if (slice === "all") continue;
      for (const listener of listeners.get(slice) ?? []) listener(event);
    }
  }

  return {
    get state() {
      return state;
    },
    dispatch(intent) {
      ensureLive();
      const previous = state;
      const next = reduceSceneWorkspaceState(state, intent);
      const changedSlices = changedSceneWorkspaceSlices(previous, next);
      if (changedSlices.size === 0) return state;
      state = next;
      emit({ state, previous, changedSlices, intent });
      return state;
    },
    subscribe(slice, listener) {
      ensureLive();
      const sliceListeners = listeners.get(slice) ?? new Set<SceneWorkspaceListener>();
      sliceListeners.add(listener);
      listeners.set(slice, sliceListeners);
      return () => {
        sliceListeners.delete(listener);
      };
    },
    snapshot() {
      ensureLive();
      return { version: 1, state: cloneSceneWorkspaceState(state) };
    },
    restore(snapshot) {
      return this.dispatch({ kind: "restore", snapshot, source: "workspace" });
    },
    dispose() {
      disposed = true;
      listeners.clear();
    },
  };
}

export function reduceSceneWorkspaceState(
  state: SceneWorkspaceState,
  intent: SceneWorkspaceIntent,
): SceneWorkspaceState {
  const base = applyIntent(state, intent);
  return appendHistory(base, intent);
}

export function sceneWorkspaceIntentFromAdapterEvent(
  event: SceneWorkspaceAdapterEvent,
  source: SceneWorkspaceIntent["source"] = "scene",
): SceneWorkspaceIntent {
  switch (event.type) {
    case "camera-change":
      return { kind: "set-camera", camera: event.camera, source, historyLabel: "Scene camera changed" };
    case "layer-visibility-change":
      return {
        kind: "set-layer-visibility",
        layerId: event.layerId,
        visible: event.visible,
        source,
        historyLabel: "Scene layer visibility changed",
      };
    case "primitive-diagnostics":
      return {
        kind: "set-diagnostics",
        diagnostics: event.diagnostics,
        source,
        historyLabel: "Scene primitive diagnostics changed",
      };
    case "filter-change":
      return event.clause
        ? {
            kind: "set-filter",
            id: event.id,
            clause: event.clause,
            source,
            historyLabel: "Scene filter changed",
          }
        : { kind: "clear-filter", id: event.id, source, historyLabel: "Scene filter cleared" };
    case "selection-change":
      return { kind: "set-selection", selection: event.selection, source, historyLabel: "Scene selection changed" };
    case "detail-change":
      return { kind: "set-detail", detail: event.detail, source, historyLabel: "Scene detail changed" };
    case "timeline-change":
      return { kind: "set-timeline", timeline: event.timeline, source, historyLabel: "Scene timeline changed" };
    case "evidence-add":
      if (!event.evidence) throw new Error("evidence-add adapter event requires evidence.");
      return { kind: "add-evidence", evidence: event.evidence, source, historyLabel: "Scene evidence added" };
    case "evidence-remove":
      if (!event.id) throw new Error("evidence-remove adapter event requires id.");
      return { kind: "remove-evidence", id: event.id, source, historyLabel: "Scene evidence removed" };
    case "realtime-status":
      return { kind: "set-realtime", realtime: event.realtime, source, historyLabel: "Scene realtime status changed" };
  }
}

export function selectSceneVisibleLayers(state: SceneWorkspaceState): SceneLayerState[] {
  return Object.values(state.layers).filter((layer) => layer.visible);
}

export function selectScenePrimitivesByKind<K extends SceneRuntimePrimitive["kind"]>(
  state: SceneWorkspaceState,
  kind: K,
): Array<Extract<SceneRuntimePrimitive, { readonly kind: K }>> {
  return Object.values(state.primitives).filter(
    (primitive): primitive is Extract<SceneRuntimePrimitive, { readonly kind: K }> => primitive.kind === kind,
  );
}

export function selectSceneDiagnosticsByStatus(
  state: SceneWorkspaceState,
  status: ScenePrimitiveDiagnostic["status"],
): ScenePrimitiveDiagnostic[] {
  return state.diagnostics.filter((diagnostic) => diagnostic.status === status);
}

export function selectSceneEvidenceForFeature(
  state: SceneWorkspaceState,
  featureId: string | number | undefined,
): SceneEvidenceReference[] {
  if (featureId === undefined) return [];
  return Object.values(state.evidence).filter((evidence) => evidence.featureId === featureId);
}

function applyIntent(state: SceneWorkspaceState, intent: SceneWorkspaceIntent): SceneWorkspaceState {
  switch (intent.kind) {
    case "set-scene":
      return {
        ...state,
        sceneId: intent.sceneId,
        title: intent.title,
      };
    case "set-layers":
      return {
        ...state,
        layers: Object.fromEntries(intent.layers.map((layer) => [layer.id, { ...layer }])),
      };
    case "set-primitives":
      return {
        ...state,
        primitives: Object.fromEntries(intent.primitives.map((primitive) => [primitive.id, clonePrimitive(primitive)])),
      };
    case "set-diagnostics":
      return {
        ...state,
        diagnostics: intent.diagnostics.map(cloneDiagnostic),
      };
    case "set-layer-visibility": {
      const existing = state.layers[intent.layerId];
      return {
        ...state,
        layers: {
          ...state.layers,
          [intent.layerId]: {
            ...existing,
            id: intent.layerId,
            visible: intent.visible,
          },
        },
      };
    }
    case "set-camera":
      return {
        ...state,
        camera: intent.camera ? { ...intent.camera } : undefined,
      };
    case "apply-bookmark":
      return {
        ...state,
        camera: { ...intent.bookmark.camera },
        bookmarks: {
          ...state.bookmarks,
          [intent.bookmark.id]: { ...intent.bookmark, camera: { ...intent.bookmark.camera } },
        },
      };
    case "set-filter":
      return {
        ...state,
        filters: {
          ...state.filters,
          [intent.id]: cloneValue(intent.clause),
        },
      };
    case "clear-filter": {
      const filters = { ...state.filters };
      delete filters[intent.id];
      return { ...state, filters };
    }
    case "set-selection":
      return {
        ...state,
        selection: dedupeSelection(intent.selection),
      };
    case "clear-selection":
      return {
        ...state,
        selection: [],
      };
    case "set-detail":
      return {
        ...state,
        detail: cloneDetail(intent.detail),
      };
    case "set-active-asset":
      return {
        ...state,
        activeAssetId: intent.id,
      };
    case "set-timeline":
      return {
        ...state,
        timeline: { ...intent.timeline },
      };
    case "add-evidence":
      return {
        ...state,
        evidence: {
          ...state.evidence,
          [intent.evidence.id]: cloneEvidence(intent.evidence),
        },
      };
    case "remove-evidence": {
      const evidence = { ...state.evidence };
      delete evidence[intent.id];
      return { ...state, evidence };
    }
    case "set-realtime":
      return {
        ...state,
        realtime: { ...intent.realtime },
      };
    case "restore":
      return cloneSceneWorkspaceState(intent.snapshot.state);
  }
}

function appendHistory(state: SceneWorkspaceState, intent: SceneWorkspaceIntent): SceneWorkspaceState {
  if (intent.kind === "restore") return state;
  const label = intent.historyLabel ?? intent.kind;
  const at = intent.at ?? new Date().toISOString();
  const entry = {
    id: `${state.history.length + 1}:${intent.kind}`,
    label,
    at,
    intentKind: intent.kind,
  };
  return {
    ...state,
    history: [...state.history, entry].slice(-50),
  };
}

function changedSceneWorkspaceSlices(
  previous: SceneWorkspaceState,
  next: SceneWorkspaceState,
): ReadonlySet<SceneWorkspaceSlice> {
  const changed = new Set<SceneWorkspaceSlice>();
  if (previous.sceneId !== next.sceneId || previous.title !== next.title) changed.add("scene");
  if (previous.camera !== next.camera) changed.add("camera");
  if (previous.layers !== next.layers) changed.add("layers");
  if (previous.primitives !== next.primitives) changed.add("primitives");
  if (previous.diagnostics !== next.diagnostics) changed.add("diagnostics");
  if (previous.filters !== next.filters) changed.add("filters");
  if (previous.detail !== next.detail) changed.add("detail");
  if (previous.selection !== next.selection) changed.add("selection");
  if (previous.timeline !== next.timeline) changed.add("timeline");
  if (previous.evidence !== next.evidence) changed.add("evidence");
  if (previous.realtime !== next.realtime) changed.add("realtime");
  if (previous.history !== next.history) changed.add("history");
  return changed;
}

function mergeState(base: SceneWorkspaceState, initial: Partial<SceneWorkspaceState>): SceneWorkspaceState {
  return cloneSceneWorkspaceState({
    ...base,
    ...initial,
    layers: {
      ...base.layers,
      ...Object.fromEntries(Object.entries(initial.layers ?? {}).map(([id, layer]) => [id, cloneLayer(layer)])),
    },
    primitives: {
      ...base.primitives,
      ...Object.fromEntries(
        Object.entries(initial.primitives ?? {}).map(([id, primitive]) => [id, clonePrimitive(primitive)]),
      ),
    },
    diagnostics: initial.diagnostics ? initial.diagnostics.map(cloneDiagnostic) : base.diagnostics,
    filters: {
      ...base.filters,
      ...cloneValue(initial.filters ?? {}),
    },
    detail: cloneDetail({ ...base.detail, ...initial.detail }),
    bookmarks: {
      ...base.bookmarks,
      ...Object.fromEntries(
        Object.entries(initial.bookmarks ?? {}).map(([id, bookmark]) => [id, cloneBookmark(bookmark)]),
      ),
    },
    selection: initial.selection ? dedupeSelection(initial.selection) : base.selection,
    timeline: { ...base.timeline, ...initial.timeline },
    evidence: {
      ...base.evidence,
      ...Object.fromEntries(
        Object.entries(initial.evidence ?? {}).map(([id, evidence]) => [id, cloneEvidence(evidence)]),
      ),
    },
    realtime: { ...base.realtime, ...initial.realtime },
    history: [...(initial.history ?? base.history)],
  });
}

function cloneSceneWorkspaceState(state: SceneWorkspaceState): SceneWorkspaceState {
  return {
    ...state,
    layers: Object.fromEntries(Object.entries(state.layers).map(([id, layer]) => [id, cloneLayer(layer)])),
    primitives: Object.fromEntries(
      Object.entries(state.primitives).map(([id, primitive]) => [id, clonePrimitive(primitive)]),
    ),
    diagnostics: state.diagnostics.map(cloneDiagnostic),
    filters: cloneValue(state.filters),
    detail: cloneDetail(state.detail),
    bookmarks: Object.fromEntries(
      Object.entries(state.bookmarks).map(([id, bookmark]) => [id, cloneBookmark(bookmark)]),
    ),
    camera: state.camera ? cloneCamera(state.camera) : undefined,
    selection: dedupeSelection(state.selection),
    timeline: { ...state.timeline },
    evidence: Object.fromEntries(Object.entries(state.evidence).map(([id, evidence]) => [id, cloneEvidence(evidence)])),
    realtime: { ...state.realtime },
    history: state.history.map((entry) => ({ ...entry })),
  };
}

function cloneLayer(layer: SceneLayerState): SceneLayerState {
  return { ...layer };
}

function clonePrimitive(primitive: SceneRuntimePrimitive): SceneRuntimePrimitive {
  assertScenePrimitiveSerializable(primitive);
  return cloneValue(primitive);
}

function cloneDiagnostic(diagnostic: ScenePrimitiveDiagnostic): ScenePrimitiveDiagnostic {
  return cloneValue(diagnostic);
}

function cloneDetail(detail: SceneWorkspaceState["detail"]): SceneWorkspaceState["detail"] {
  return {
    ...detail,
    target: detail.target ? cloneSelectionTarget(detail.target) : undefined,
    attributes: detail.attributes ? cloneValue(detail.attributes) : undefined,
  };
}

function cloneCamera(camera: NonNullable<SceneWorkspaceState["camera"]>): NonNullable<SceneWorkspaceState["camera"]> {
  return { ...camera };
}

function cloneBookmark(
  bookmark: NonNullable<SceneWorkspaceState["bookmarks"][string]>,
): NonNullable<SceneWorkspaceState["bookmarks"][string]> {
  return {
    ...bookmark,
    camera: cloneCamera(bookmark.camera),
  };
}

function cloneEvidence(evidence: SceneEvidenceReference): SceneEvidenceReference {
  return {
    ...evidence,
    metadata: evidence.metadata ? cloneValue(evidence.metadata) : undefined,
  };
}

function dedupeSelection(selection: ReadonlyArray<SceneWorkspaceState["selection"][number]>) {
  const seen = new Set<string>();
  const out: SceneWorkspaceState["selection"][number][] = [];
  for (const target of selection) {
    const key = featureSelectionKey(target);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(cloneSelectionTarget(target));
  }
  return out;
}

function cloneSelectionTarget(
  target: SceneWorkspaceState["selection"][number],
): SceneWorkspaceState["selection"][number] {
  return typeof target === "object" && target !== null ? { ...target } : target;
}

function cloneValue<T>(value: T): T {
  if (typeof structuredClone === "function") return structuredClone(value);
  return JSON.parse(JSON.stringify(value)) as T;
}
