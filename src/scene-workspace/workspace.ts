import { featureSelectionKey } from "../exploration/index.js";
import type {
  SceneEvidenceReference,
  SceneLayerState,
  SceneWorkspace,
  SceneWorkspaceAdapterEvent,
  SceneWorkspaceChangeEvent,
  SceneWorkspaceIntent,
  SceneWorkspaceListener,
  SceneWorkspaceSlice,
  SceneWorkspaceSnapshot,
  SceneWorkspaceState,
  SceneWorkspaceUnsubscribe,
} from "./types.js";

export function emptySceneWorkspaceState(): SceneWorkspaceState {
  return {
    layers: {},
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
    case "selection-change":
      return { kind: "set-selection", selection: event.selection, source, historyLabel: "Scene selection changed" };
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
