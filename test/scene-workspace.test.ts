import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { sourceFeatureSelectionTarget } from "../src/exploration/index.js";
import {
  createSceneWorkspace,
  emptySceneWorkspaceState,
  sceneWorkspaceIntentFromAdapterEvent,
  selectSceneEvidenceForFeature,
  selectSceneVisibleLayers,
} from "../src/scene-workspace/index.js";

describe("scene workspace", () => {
  it("models scene layers, camera, timeline, evidence, realtime, and history without a renderer", () => {
    const workspace = createSceneWorkspace();
    const layerListener = vi.fn();
    const allListener = vi.fn();
    workspace.subscribe("layers", layerListener);
    workspace.subscribe("all", allListener);

    workspace.dispatch({
      kind: "set-scene",
      sceneId: "construction-yard",
      title: "Construction Yard",
      at: "2026-05-05T00:00:00.000Z",
    });
    workspace.dispatch({
      kind: "set-layers",
      layers: [
        { id: "world-model", title: "World model", visible: true, kind: "scene" },
        { id: "incidents", sourceId: "incidents", visible: false, kind: "feature" },
      ],
      at: "2026-05-05T00:00:01.000Z",
    });
    workspace.dispatch({
      kind: "set-camera",
      camera: { longitude: -157.8583, latitude: 21.3069, height: 700, heading: 45, pitch: -35 },
      at: "2026-05-05T00:00:02.000Z",
    });
    workspace.dispatch({
      kind: "set-timeline",
      timeline: {
        currentTime: "2026-05-05T00:05:00.000Z",
        startTime: "2026-05-05T00:00:00.000Z",
        endTime: "2026-05-05T00:10:00.000Z",
        progress: 0.5,
      },
      at: "2026-05-05T00:00:03.000Z",
    });
    workspace.dispatch({
      kind: "add-evidence",
      evidence: {
        id: "ev-1",
        label: "Crane inspection still",
        kind: "image",
        sourceId: "incidents",
        featureId: "INC-7",
      },
      at: "2026-05-05T00:00:04.000Z",
    });
    workspace.dispatch({
      kind: "set-realtime",
      realtime: { status: "stale", cursor: "c7", staleSince: 1_000 },
      at: "2026-05-05T00:00:05.000Z",
    });

    expect(workspace.state.sceneId).toBe("construction-yard");
    expect(selectSceneVisibleLayers(workspace.state).map((layer) => layer.id)).toEqual(["world-model"]);
    expect(workspace.state.camera?.height).toBe(700);
    expect(workspace.state.timeline.progress).toBe(0.5);
    expect(selectSceneEvidenceForFeature(workspace.state, "INC-7")).toHaveLength(1);
    expect(workspace.state.realtime.status).toBe("stale");
    expect(workspace.state.history.map((entry) => entry.intentKind)).toEqual([
      "set-scene",
      "set-layers",
      "set-camera",
      "set-timeline",
      "add-evidence",
      "set-realtime",
    ]);
    expect(layerListener).toHaveBeenCalledTimes(1);
    expect(allListener).toHaveBeenCalledTimes(6);
  });

  it("keeps scene, map, table, and detail selection targets source-qualified", () => {
    const workspace = createSceneWorkspace();
    const sceneTarget = sourceFeatureSelectionTarget("scene-assets", "asset-101");
    const mapTarget = sourceFeatureSelectionTarget("work-orders", "asset-101");

    workspace.dispatch({
      kind: "set-selection",
      selection: [sceneTarget, mapTarget, sceneTarget],
      source: "scene",
    });

    expect(workspace.state.selection).toEqual([sceneTarget, mapTarget]);
  });

  it("translates renderer adapter events into workspace intents", () => {
    const workspace = createSceneWorkspace();
    const intent = sceneWorkspaceIntentFromAdapterEvent(
      {
        type: "selection-change",
        selection: [sourceFeatureSelectionTarget("scene-assets", "asset-9")],
      },
      "map",
    );

    workspace.dispatch(intent);

    expect(intent).toMatchObject({ kind: "set-selection", source: "map" });
    expect(workspace.state.selection).toEqual([sourceFeatureSelectionTarget("scene-assets", "asset-9")]);
  });

  it("snapshots and restores serializable scene state", () => {
    const workspace = createSceneWorkspace({
      sceneId: "initial",
      layers: { initial: { id: "initial", visible: true } },
    });

    const snapshot = workspace.snapshot();
    workspace.dispatch({ kind: "set-scene", sceneId: "changed" });
    workspace.dispatch({ kind: "set-layer-visibility", layerId: "initial", visible: false });

    workspace.restore(snapshot);

    expect(workspace.state.sceneId).toBe("initial");
    expect(workspace.state.layers.initial?.visible).toBe(true);
    expect(snapshot.state).not.toBe(workspace.state);
  });

  it("detaches initial state and snapshots from caller-owned nested objects", () => {
    const selected = sourceFeatureSelectionTarget("scene-assets", "asset-1");
    const initial = {
      layers: { assets: { id: "assets", visible: true } },
      selection: [selected],
      evidence: {
        ev1: {
          id: "ev1",
          label: "Inspection packet",
          kind: "document" as const,
          featureId: "asset-1",
          metadata: { nested: { status: "original" } },
        },
      },
    };
    const workspace = createSceneWorkspace(initial);

    initial.layers.assets.visible = false;
    (selected as { id: string }).id = "mutated";
    (initial.evidence.ev1.metadata.nested as { status: string }).status = "mutated";

    expect(workspace.state.layers.assets?.visible).toBe(true);
    expect(workspace.state.selection).toEqual([sourceFeatureSelectionTarget("scene-assets", "asset-1")]);
    expect(workspace.state.evidence.ev1?.metadata).toEqual({ nested: { status: "original" } });

    const snapshot = workspace.snapshot();
    (snapshot.state.evidence.ev1?.metadata?.nested as { status: string }).status = "snapshot-mutated";
    (snapshot.state.selection[0] as { id: string }).id = "snapshot-mutated";

    expect(workspace.state.selection).toEqual([sourceFeatureSelectionTarget("scene-assets", "asset-1")]);
    expect(workspace.state.evidence.ev1?.metadata).toEqual({ nested: { status: "original" } });
  });

  it("timestamps history with dispatch time when callers do not supply at", () => {
    const workspace = createSceneWorkspace();
    const before = Date.now();

    workspace.dispatch({ kind: "set-scene", sceneId: "live-scene" });

    const timestamp = Date.parse(workspace.state.history[0]?.at ?? "");
    expect(timestamp).toBeGreaterThanOrEqual(before);
    expect(timestamp).toBeLessThanOrEqual(Date.now());
  });

  it("disposes subscriptions and rejects later dispatches", () => {
    const workspace = createSceneWorkspace();
    const listener = vi.fn();
    workspace.subscribe("scene", listener);
    workspace.dispose();

    expect(() => workspace.dispatch({ kind: "set-scene", sceneId: "late" })).toThrow(/disposed/);
    expect(listener).not.toHaveBeenCalled();
  });

  it("does not introduce a Cesium runtime dependency in the core scene workspace", () => {
    const sceneWorkspaceRoot = path.resolve(process.cwd(), "src", "scene-workspace");
    const files = fs.readdirSync(sceneWorkspaceRoot).filter((file) => file.endsWith(".ts"));
    const source = files.map((file) => fs.readFileSync(path.join(sceneWorkspaceRoot, file), "utf8")).join("\n");

    expect(source).not.toMatch(/from "cesium"|from 'cesium'|maplibre-gl/);
    expect(emptySceneWorkspaceState().realtime.status).toBe("idle");
  });
});
