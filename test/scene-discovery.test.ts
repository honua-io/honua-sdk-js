import { describe, expect, it, vi } from "vitest";

import type { QueryMethod } from "../src/core/types.js";
import {
  type HonuaScene,
  type SceneDiscoveryRequestExecutor,
  getScene,
  listScenes,
  normalizeScene,
  resolveSceneTilesetUrl,
  sceneCameraPrimitive,
  sceneLayerStates,
  sceneTerrainPrimitive,
  sceneTilesetPrimitive,
  sceneToRuntimePrimitives,
  sceneViewpointBookmarks,
} from "../src/scene-workspace/index.js";

const CAMELCASE_SCENE = {
  sceneId: "downtown",
  title: "Downtown",
  description: "City core",
  tilesetUrl: "https://cdn.example/scenes/downtown/tileset.json",
  terrainUrl: "https://cdn.example/terrain",
  extent: { extent: { xmin: -158, ymin: 21, xmax: -157, ymax: 22 }, minHeight: 0, maxHeight: 400 },
  initialCamera: { longitude: -157.8, latitude: 21.3, height: 1200, heading: 30, pitch: -45 },
  viewpoints: [{ id: "harbor", title: "Harbor", camera: { longitude: -157.85, latitude: 21.31, height: 300 } }],
  style: { expression: "color('red')" },
  edition: "pro",
  capabilities: ["terrain", "styling"],
};

const SNAKECASE_SCENE = {
  scene_id: "valley",
  title: "Valley",
  tileset_url: "https://cdn.example/scenes/valley/tileset.json",
  terrain_url: "https://cdn.example/valley-terrain",
  initial_camera: { longitude: 10, latitude: 46, height: 5000 },
};

describe("scene discovery normalization", () => {
  it("normalizes a camelCase scene payload", () => {
    const scene = normalizeScene(CAMELCASE_SCENE);
    expect(scene.sceneId).toBe("downtown");
    expect(scene.tilesetUrl).toBe(CAMELCASE_SCENE.tilesetUrl);
    expect(scene.terrainUrl).toBe(CAMELCASE_SCENE.terrainUrl);
    expect(scene.initialCamera).toEqual({ longitude: -157.8, latitude: 21.3, height: 1200, heading: 30, pitch: -45 });
    expect(scene.extent).toEqual({ xmin: -158, ymin: 21, xmax: -157, ymax: 22, minHeight: 0, maxHeight: 400 });
    expect(scene.styleExpression).toBe("color('red')");
    expect(scene.edition).toBe("pro");
    expect(scene.capabilities).toEqual(["terrain", "styling"]);
    expect(scene.viewpoints).toEqual([
      { id: "harbor", title: "Harbor", camera: { longitude: -157.85, latitude: 21.31, height: 300 } },
    ]);
  });

  it("normalizes a proto-snake_case scene payload", () => {
    const scene = normalizeScene(SNAKECASE_SCENE);
    expect(scene.sceneId).toBe("valley");
    expect(scene.tilesetUrl).toBe(SNAKECASE_SCENE.tileset_url);
    expect(scene.terrainUrl).toBe(SNAKECASE_SCENE.terrain_url);
    expect(scene.initialCamera).toEqual({ longitude: 10, latitude: 46, height: 5000 });
    expect(scene.capabilities).toEqual([]);
    expect(scene.viewpoints).toEqual([]);
  });

  it("drops viewpoints without an id or camera", () => {
    const scene = normalizeScene({
      sceneId: "s",
      viewpoints: [
        { id: "ok", camera: { longitude: 1, latitude: 2 } },
        { title: "no-id", camera: { longitude: 1, latitude: 2 } },
        { id: "no-camera" },
      ],
    });
    expect(scene.viewpoints.map((v) => v.id)).toEqual(["ok"]);
  });
});

describe("scene → primitive mapping", () => {
  const scene = normalizeScene(CAMELCASE_SCENE);

  it("resolves the explicit tileset url and falls back to the discovery path", () => {
    expect(resolveSceneTilesetUrl(scene)).toBe(CAMELCASE_SCENE.tilesetUrl);
    const bare: HonuaScene = { sceneId: "bare", viewpoints: [], capabilities: [] };
    expect(resolveSceneTilesetUrl(bare, "https://h.example/")).toBe("https://h.example/scenes/bare/tileset.json");
    expect(resolveSceneTilesetUrl(bare)).toBeUndefined();
  });

  it("builds camera / tileset / terrain primitives", () => {
    expect(sceneCameraPrimitive(scene)).toMatchObject({ kind: "camera", id: "downtown:camera", mode: "global" });
    expect(sceneTilesetPrimitive(scene)).toMatchObject({
      kind: "model-layer",
      id: "downtown:tileset",
      format: "3d-tiles",
      uri: CAMELCASE_SCENE.tilesetUrl,
    });
    expect(sceneTerrainPrimitive(scene)).toMatchObject({
      kind: "elevation-source",
      id: "downtown:terrain",
      protocol: "quantized-mesh",
      url: CAMELCASE_SCENE.terrainUrl,
    });
  });

  it("maps a full scene to ordered runtime primitives (camera, terrain, tileset)", () => {
    const primitives = sceneToRuntimePrimitives(scene);
    expect(primitives.map((p) => p.kind)).toEqual(["camera", "elevation-source", "model-layer"]);
  });

  it("omits primitives the scene does not advertise", () => {
    const minimal = normalizeScene({ sceneId: "m" });
    expect(sceneToRuntimePrimitives(minimal)).toEqual([]);
    expect(sceneToRuntimePrimitives(minimal, "https://h.example")).toMatchObject([{ kind: "model-layer" }]);
  });

  it("builds layer states and viewpoint bookmarks", () => {
    expect(sceneLayerStates(scene).map((l) => l.id)).toEqual(["downtown:tileset", "downtown:terrain"]);
    expect(sceneViewpointBookmarks(scene)).toEqual([
      { id: "harbor", label: "Harbor", camera: { longitude: -157.85, latitude: 21.31, height: 300 } },
    ]);
  });
});

describe("scene discovery transport", () => {
  it("lists scenes via GET /api/scenes", async () => {
    const execute = vi.fn(async () => ({
      scenes: [CAMELCASE_SCENE, SNAKECASE_SCENE],
    })) as unknown as SceneDiscoveryRequestExecutor;
    const scenes = await listScenes(execute);
    expect(scenes.map((s) => s.sceneId)).toEqual(["downtown", "valley"]);
    expect(execute).toHaveBeenCalledWith("GET", "/api/scenes", undefined, undefined);
  });

  it("fetches a single scene via GET /api/scenes/{id} and unwraps the envelope", async () => {
    const calls: Array<[QueryMethod, string]> = [];
    const execute: SceneDiscoveryRequestExecutor = async (method, path) => {
      calls.push([method, path]);
      return { scene: CAMELCASE_SCENE } as never;
    };
    const scene = await getScene(execute, "downtown");
    expect(scene.sceneId).toBe("downtown");
    expect(calls).toEqual([["GET", "/api/scenes/downtown"]]);
  });

  it("rejects an empty sceneId", async () => {
    const execute = vi.fn() as unknown as SceneDiscoveryRequestExecutor;
    await expect(getScene(execute, "")).rejects.toThrow(/non-empty sceneId/);
    expect(execute).not.toHaveBeenCalled();
  });
});
