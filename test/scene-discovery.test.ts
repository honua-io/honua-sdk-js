import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import type { QueryMethod } from "../src/core/types.js";
import {
  type HonuaScene,
  type SceneDiscoveryRequestExecutor,
  getScene,
  listScenes,
  normalizeScene,
  normalizeSceneMetadata,
  normalizeSceneResolution,
  normalizeSceneSummary,
  resolveScene,
  resolveSceneTilesetUrl,
  sceneCameraPrimitive,
  sceneLayerStates,
  sceneTerrainPrimitive,
  sceneTilesetPrimitive,
  sceneToRuntimePrimitives,
  sceneViewpointBookmarks,
} from "../src/scene-workspace/index.js";

/**
 * Checked-in JSON for the three public scene routes. Field names and null
 * omission follow honua-server `PublicSceneSummary`, `PublicSceneMetadata`,
 * and `PublicSceneResolution` (camelCase). Values are the downtown-honolulu
 * hosted fixture: id/name/description from appsettings, bounds from
 * `fixtures/scenes/downtown-honolulu/metadata/scene.json`, and center from the
 * discovery endpoint (bounds midpoint, height 1200). The protected files are
 * the same documents with the record auth projection (`Bearer`/`ApiKey` plus
 * the allowed-role policy).
 */
function loadServerFixture(name: string): unknown {
  return JSON.parse(
    readFileSync(new URL(`./fixtures/scenes/public-discovery/${name}.json`, import.meta.url), "utf8"),
  ) as unknown;
}

const LIST_RESPONSE = loadServerFixture("list") as { scenes: unknown[] };
const METADATA = loadServerFixture("metadata");
const RESOLUTION = loadServerFixture("resolve");
const PROTECTED_LIST = loadServerFixture("protected-list") as { scenes: unknown[] };
const PROTECTED_METADATA = loadServerFixture("protected-metadata");
const PROTECTED_RESOLUTION = loadServerFixture("protected-resolve");

const TILESET_URL = "https://scenes.example.test/scenes/downtown-honolulu/tileset.json";
const PUBLIC_AUTH = { requiresAuthentication: false, schemes: [] };
const PROTECTED_AUTH = { requiresAuthentication: true, schemes: ["Bearer", "ApiKey"], policy: "project-members" };
const BOUNDS_EXTENT = { xmin: -157.875, ymin: 21.29, xmax: -157.835, ymax: 21.325 };
const CENTER_CAMERA = { longitude: -157.855, latitude: 21.3075, height: 1200 };

describe("server scene list contract", () => {
  it("normalizes id, name, tilesetUrl, bounds, and auth", () => {
    const scene = normalizeSceneSummary(LIST_RESPONSE.scenes[0]);
    expect(scene.sceneId).toBe("downtown-honolulu");
    expect(scene.name).toBe("Downtown Honolulu");
    expect(scene.title).toBe("Downtown Honolulu");
    expect(scene.tilesetUrl).toBe(TILESET_URL);
    expect(scene.extent).toEqual(BOUNDS_EXTENT);
    expect(scene.auth).toEqual(PUBLIC_AUTH);
    expect(scene.attribution).toEqual([]);
    expect(scene.capabilities).toEqual(["3d-tiles"]);
    expect(scene.updatedAt).toBe("2026-05-01T00:00:00Z");
  });

  it("keeps protected list auth schemes and policy", () => {
    const scene = normalizeSceneSummary(PROTECTED_LIST.scenes[0]);
    expect(scene.auth).toEqual(PROTECTED_AUTH);
    expect(scene.tilesetUrl).toBe(TILESET_URL);
  });

  it("fails closed when a list item has no id", () => {
    expect(() => normalizeSceneSummary({ name: "Nameless" })).toThrow(/missing an id/);
    expect(() => normalizeSceneSummary({ id: "  ", tilesetUrl: "https://h.example/scenes//tileset.json" })).toThrow(
      /missing an id/,
    );
  });
});

describe("server scene metadata contract", () => {
  it("normalizes id, name, tileset, center, bounds, and auth", () => {
    const scene = normalizeSceneMetadata(METADATA);
    expect(scene.sceneId).toBe("downtown-honolulu");
    expect(scene.name).toBe("Downtown Honolulu");
    expect(scene.tilesetUrl).toBe(TILESET_URL);
    expect(scene.initialCamera).toEqual(CENTER_CAMERA);
    expect(scene.extent).toEqual(BOUNDS_EXTENT);
    expect(scene.auth).toEqual(PUBLIC_AUTH);
    expect(scene.links?.map((link) => link.rel)).toEqual(["self", "resolve"]);
  });

  it("keeps protected metadata auth on the nested tileset and the scene", () => {
    const scene = normalizeSceneMetadata(PROTECTED_METADATA);
    expect(scene.auth).toEqual(PROTECTED_AUTH);
    expect(scene.tilesetUrl).toBe(TILESET_URL);
    expect(scene.initialCamera).toEqual(CENTER_CAMERA);
  });

  it("fails closed when metadata has no id", () => {
    expect(() => normalizeSceneMetadata({ name: "Downtown Honolulu", tileset: { url: TILESET_URL } })).toThrow(
      /missing an id/,
    );
  });
});

describe("server scene resolve contract", () => {
  it("normalizes sceneId, endpoints, and auth", () => {
    const resolution = normalizeSceneResolution(RESOLUTION);
    expect(resolution.sceneId).toBe("downtown-honolulu");
    expect(resolution.tilesetUrl).toBe(TILESET_URL);
    expect(resolution.endpoints).toEqual([
      {
        kind: "3d-tiles",
        url: TILESET_URL,
        mediaType: "application/json",
        format: "3d-tiles",
        requiresAuthentication: false,
      },
    ]);
    expect(resolution.auth).toEqual(PUBLIC_AUTH);
    expect(resolution.capabilities).toEqual(["3d-tiles"]);
  });

  it("keeps protected resolve auth and does not invent a tileset url", () => {
    const resolution = normalizeSceneResolution(PROTECTED_RESOLUTION);
    expect(resolution.auth).toEqual(PROTECTED_AUTH);
    expect(resolution.tilesetUrl).toBe(TILESET_URL);
  });

  it("uses the 3d-tiles endpoint when the flat tileset url is absent", () => {
    const resolution = normalizeSceneResolution({
      sceneId: "downtown-honolulu",
      endpoints: [{ kind: "3d-tiles", url: TILESET_URL, requiresAuthentication: false }],
      auth: PUBLIC_AUTH,
    });
    expect(resolution.tilesetUrl).toBe(TILESET_URL);
  });

  it("drops a tileset url that targets /scenes//", () => {
    const resolution = normalizeSceneResolution({
      sceneId: "downtown-honolulu",
      tilesetUrl: "https://scenes.example.test/scenes//tileset.json",
      endpoints: [{ kind: "3d-tiles", url: "https://scenes.example.test/scenes//tileset.json" }],
      auth: PUBLIC_AUTH,
    });
    expect(resolution.tilesetUrl).toBeUndefined();
    expect(resolution.endpoints).toEqual([]);
  });

  it("fails closed when resolve has no scene id", () => {
    expect(() => normalizeSceneResolution({ endpoints: [], auth: PUBLIC_AUTH })).toThrow(/missing a sceneId/);
    expect(() => normalizeSceneResolution({ sceneId: "" })).toThrow(/missing a sceneId/);
  });
});

describe("scene discovery transport", () => {
  it("lists scenes from the checked-in list document", async () => {
    const execute = vi.fn(async () => LIST_RESPONSE) as unknown as SceneDiscoveryRequestExecutor;
    const scenes = await listScenes(execute);
    expect(scenes.map((scene) => scene.sceneId)).toEqual(["downtown-honolulu"]);
    expect(scenes[0]?.auth).toEqual(PUBLIC_AUTH);
    expect(execute).toHaveBeenCalledWith("GET", "/api/scenes", undefined, undefined);
  });

  it("fetches metadata from the checked-in metadata document", async () => {
    const calls: Array<[QueryMethod, string]> = [];
    const execute: SceneDiscoveryRequestExecutor = async (method, path) => {
      calls.push([method, path]);
      return METADATA as never;
    };
    const scene = await getScene(execute, "downtown-honolulu");
    expect(scene.sceneId).toBe("downtown-honolulu");
    expect(scene.tilesetUrl).toBe(TILESET_URL);
    expect(scene.initialCamera).toEqual(CENTER_CAMERA);
    expect(calls).toEqual([["GET", "/api/scenes/downtown-honolulu"]]);
  });

  it("resolves runtime endpoints from the checked-in resolve document", async () => {
    const calls: Array<[QueryMethod, string]> = [];
    const execute: SceneDiscoveryRequestExecutor = async (method, path) => {
      calls.push([method, path]);
      return RESOLUTION as never;
    };
    const resolution = await resolveScene(execute, "downtown-honolulu");
    expect(resolution.sceneId).toBe("downtown-honolulu");
    expect(resolution.tilesetUrl).toBe(TILESET_URL);
    expect(resolution.auth).toEqual(PUBLIC_AUTH);
    expect(calls).toEqual([["GET", "/api/scenes/downtown-honolulu/resolve"]]);
  });

  it("rejects an empty scene id before any request", async () => {
    const execute = vi.fn() as unknown as SceneDiscoveryRequestExecutor;
    await expect(getScene(execute, "")).rejects.toThrow(/non-empty sceneId/);
    await expect(getScene(execute, "  ")).rejects.toThrow(/non-empty sceneId/);
    await expect(resolveScene(execute, "")).rejects.toThrow(/non-empty sceneId/);
    await expect(resolveScene(execute, "  ")).rejects.toThrow(/non-empty sceneId/);
    expect(execute).not.toHaveBeenCalled();
  });

  it("does not request /scenes//tileset.json when a list item has no id", async () => {
    const execute = vi.fn(async () => ({
      scenes: [{ name: "Nameless", tilesetUrl: "https://scenes.example.test/scenes//tileset.json" }],
    })) as unknown as SceneDiscoveryRequestExecutor;
    await expect(listScenes(execute)).rejects.toThrow(/missing an id/);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith("GET", "/api/scenes", undefined, undefined);
  });
});

/**
 * Proto-shaped tolerance. The server does not send `sceneId` / `title` /
 * `tileset_url` / nested `extent`. These cases stay so older proto JSON still
 * normalizes; they are not the list, metadata, or resolve contract.
 */
describe("proto-shaped scene tolerance", () => {
  const camelCaseScene = {
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

  const snakeCaseScene = {
    scene_id: "valley",
    title: "Valley",
    tileset_url: "https://cdn.example/scenes/valley/tileset.json",
    terrain_url: "https://cdn.example/valley-terrain",
    initial_camera: { longitude: 10, latitude: 46, height: 5000 },
  };

  it("normalizes a camelCase proto payload", () => {
    const scene = normalizeScene(camelCaseScene);
    expect(scene.sceneId).toBe("downtown");
    expect(scene.tilesetUrl).toBe(camelCaseScene.tilesetUrl);
    expect(scene.terrainUrl).toBe(camelCaseScene.terrainUrl);
    expect(scene.initialCamera).toEqual({ longitude: -157.8, latitude: 21.3, height: 1200, heading: 30, pitch: -45 });
    expect(scene.extent).toEqual({ xmin: -158, ymin: 21, xmax: -157, ymax: 22, minHeight: 0, maxHeight: 400 });
    expect(scene.styleExpression).toBe("color('red')");
    expect(scene.edition).toBe("pro");
    expect(scene.capabilities).toEqual(["terrain", "styling"]);
    expect(scene.viewpoints).toEqual([
      { id: "harbor", title: "Harbor", camera: { longitude: -157.85, latitude: 21.31, height: 300 } },
    ]);
  });

  it("normalizes a proto snake_case payload", () => {
    const scene = normalizeScene(snakeCaseScene);
    expect(scene.sceneId).toBe("valley");
    expect(scene.tilesetUrl).toBe(snakeCaseScene.tileset_url);
    expect(scene.terrainUrl).toBe(snakeCaseScene.terrain_url);
    expect(scene.initialCamera).toEqual({ longitude: 10, latitude: 46, height: 5000 });
    expect(scene.capabilities).toEqual([]);
    expect(scene.viewpoints).toEqual([]);
  });

  it("unwraps a proto { scene } envelope that has no root id", async () => {
    const execute: SceneDiscoveryRequestExecutor = async () => ({ scene: camelCaseScene }) as never;
    const scene = await getScene(execute, "downtown");
    expect(scene.sceneId).toBe("downtown");
    expect(scene.title).toBe("Downtown");
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
    expect(scene.viewpoints.map((viewpoint) => viewpoint.id)).toEqual(["ok"]);
  });
});

describe("scene → primitive mapping", () => {
  const scene = normalizeSceneMetadata(METADATA);

  it("returns only an advertised tileset url", () => {
    expect(resolveSceneTilesetUrl(scene)).toBe(TILESET_URL);
    const bare: HonuaScene = { sceneId: "bare", viewpoints: [], capabilities: [] };
    expect(resolveSceneTilesetUrl(bare)).toBeUndefined();
    const emptyId: HonuaScene = {
      sceneId: "",
      viewpoints: [],
      capabilities: [],
      tilesetUrl: "https://scenes.example.test/scenes//tileset.json",
    };
    expect(resolveSceneTilesetUrl(emptyId)).toBeUndefined();
    expect(sceneTilesetPrimitive(emptyId)).toBeUndefined();
    expect(sceneToRuntimePrimitives(emptyId)).toEqual([]);
  });

  it("builds camera / tileset primitives and omits terrain the server did not send", () => {
    expect(sceneCameraPrimitive(scene)).toMatchObject({
      kind: "camera",
      id: "downtown-honolulu:camera",
      mode: "global",
    });
    expect(sceneTilesetPrimitive(scene)).toMatchObject({
      kind: "model-layer",
      id: "downtown-honolulu:tileset",
      format: "3d-tiles",
      uri: TILESET_URL,
    });
    expect(sceneTerrainPrimitive(scene)).toBeUndefined();
  });

  it("maps a metadata scene to camera then tileset", () => {
    const primitives = sceneToRuntimePrimitives(scene);
    expect(primitives.map((primitive) => primitive.kind)).toEqual(["camera", "model-layer"]);
  });

  it("omits a tileset when the scene does not advertise one", () => {
    const minimal = normalizeScene({ sceneId: "m" });
    expect(sceneToRuntimePrimitives(minimal)).toEqual([]);
    expect(sceneLayerStates(minimal)).toEqual([]);
  });

  it("builds layer states from the metadata scene", () => {
    expect(sceneLayerStates(scene).map((layer) => layer.id)).toEqual(["downtown-honolulu:tileset"]);
    expect(sceneViewpointBookmarks(scene)).toEqual([]);
  });
});
