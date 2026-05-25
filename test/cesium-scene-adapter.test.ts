import fs from "node:fs";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

// Cesium needs a WebGL context that is unavailable headless, and a real
// `Cartesian3` is opaque ECEF geometry. Mock only the tiny surface the adapter
// touches lazily (`Cartesian3.fromDegrees`) so `apply()` stays a fast, pure
// wiring test. The 2D bundle never loads this module — see the static-import
// guard test below.
vi.mock("cesium", () => ({
  Cartesian3: {
    fromDegrees: (longitude: number, latitude: number, height: number) => ({ longitude, latitude, height }),
  },
}));

import {
  CESIUM_SCENE_CAPABILITIES,
  type CesiumCameraLike,
  type SceneCameraState,
  type SceneRuntimePrimitive,
  applyCameraStateToCesiumCamera,
  cameraStateToCesiumView,
  cesiumCameraToSceneState,
  createCesiumSceneAdapter,
  createSceneWorkspace,
} from "../src/scene-workspace/index.js";

const DEG2RAD = Math.PI / 180;

/**
 * A pure-JS stand-in for Cesium's `Camera`. It mirrors the real getter contract
 * (`positionCartographic` + heading/pitch/roll in radians) so the adapter's
 * camera math can be exercised without a WebGL `Viewer`, which is unavailable
 * headless. `setView` mutates internal radian state exactly as Cesium would.
 */
function createMockCesiumCamera(): CesiumCameraLike & {
  setView: ReturnType<typeof vi.fn>;
} {
  const position = { longitude: 0, latitude: 0, height: 0 };
  const orientation = { heading: 0, pitch: -Math.PI / 2, roll: 0 };
  const setView = vi.fn(
    (options: {
      destination?: { longitude: number; latitude: number; height: number };
      orientation?: { heading?: number; pitch?: number; roll?: number };
    }) => {
      if (options.destination) {
        position.longitude = options.destination.longitude * DEG2RAD;
        position.latitude = options.destination.latitude * DEG2RAD;
        position.height = options.destination.height;
      }
      if (options.orientation) {
        if (options.orientation.heading !== undefined) orientation.heading = options.orientation.heading;
        if (options.orientation.pitch !== undefined) orientation.pitch = options.orientation.pitch;
        if (options.orientation.roll !== undefined) orientation.roll = options.orientation.roll;
      }
    },
  );
  return {
    get positionCartographic() {
      return { ...position };
    },
    get heading() {
      return orientation.heading;
    },
    get pitch() {
      return orientation.pitch;
    },
    get roll() {
      return orientation.roll;
    },
    setView,
  };
}

describe("cesium scene adapter", () => {
  it("declares true-3D capabilities distinct from the MapLibre 2.5D adapter", () => {
    expect(CESIUM_SCENE_CAPABILITIES.renderer).toBe("cesium");
    expect(CESIUM_SCENE_CAPABILITIES.camera).toBe(true);
    expect(CESIUM_SCENE_CAPABILITIES.terrain?.protocols).toContain("quantized-mesh");
    expect(CESIUM_SCENE_CAPABILITIES.terrain?.supportsExaggeration).toBe(true);
    expect(CESIUM_SCENE_CAPABILITIES.modelLayer?.formats).toEqual(
      expect.arrayContaining(["gltf", "glb", "3d-tiles", "i3s"]),
    );
    expect(CESIUM_SCENE_CAPABILITIES.sceneLayerMetadata).toBe(true);

    const adapter = createCesiumSceneAdapter();
    expect(adapter.id).toBe("cesium-scene");
    expect(adapter.capabilities).toBe(CESIUM_SCENE_CAPABILITIES);
  });

  it("maps a scene camera state to a Cesium setView description in radians", () => {
    const view = cameraStateToCesiumView({
      longitude: -157.8583,
      latitude: 21.3069,
      height: 700,
      heading: 45,
      pitch: -35,
      roll: 10,
    });

    expect(view.destination).toEqual({ longitude: -157.8583, latitude: 21.3069, height: 700 });
    expect(view.orientation.heading).toBeCloseTo(45 * DEG2RAD, 12);
    expect(view.orientation.pitch).toBeCloseTo(-35 * DEG2RAD, 12);
    expect(view.orientation.roll).toBeCloseTo(10 * DEG2RAD, 12);
  });

  it("defaults heading/pitch/roll to Cesium's top-down defaults when omitted", () => {
    const view = cameraStateToCesiumView({ longitude: 10, latitude: 20, height: 1000 });
    expect(view.orientation.heading).toBe(0);
    expect(view.orientation.pitch).toBeCloseTo(-90 * DEG2RAD, 12);
    expect(view.orientation.roll).toBe(0);
  });

  it("round-trips camera state set -> read back through a Cesium camera", () => {
    const camera = createMockCesiumCamera();
    const original: SceneCameraState = {
      longitude: -157.8583,
      latitude: 21.3069,
      height: 1234.5,
      heading: 312,
      pitch: -42.5,
      roll: 7.25,
    };

    applyCameraStateToCesiumCamera(camera, original);
    const readBack = cesiumCameraToSceneState(camera);

    expect(readBack.longitude).toBeCloseTo(-157.8583, 9);
    expect(readBack.latitude).toBeCloseTo(21.3069, 9);
    expect(readBack.height).toBeCloseTo(1234.5, 6);
    expect(readBack.heading).toBeCloseTo(312, 9);
    expect(readBack.pitch).toBeCloseTo(-42.5, 9);
    expect(readBack.roll).toBeCloseTo(7.25, 9);
  });

  it("normalizes a negative heading into the [0, 360) range on read back", () => {
    const camera = createMockCesiumCamera();
    camera.setView({ orientation: { heading: -90 * DEG2RAD, pitch: 0, roll: 0 } });
    expect(cesiumCameraToSceneState(camera).heading).toBeCloseTo(270, 9);
  });

  it("diagnoses 3D primitives (terrain, 3D-tiles model layer) as supported", () => {
    const adapter = createCesiumSceneAdapter();
    const primitives: SceneRuntimePrimitive[] = [
      {
        kind: "elevation-source",
        id: "world-terrain",
        sourceId: "world-terrain",
        protocol: "quantized-mesh",
        url: "https://example.test/terrain",
        exaggeration: 1.5,
      },
      {
        kind: "model-layer",
        id: "city-tiles",
        uri: "https://example.test/tileset.json",
        format: "3d-tiles",
      },
    ];

    const diagnostics = adapter.diagnose(primitives);
    expect(diagnostics.map((diagnostic) => diagnostic.status)).toEqual(["supported", "supported"]);
    expect(diagnostics.every((diagnostic) => diagnostic.renderer === "cesium")).toBe(true);
  });

  it("drives the adapter from a workspace camera dispatch via apply()", async () => {
    const camera = createMockCesiumCamera();
    const adapter = createCesiumSceneAdapter({ target: { camera } });
    const workspace = createSceneWorkspace();

    const cameraState: SceneCameraState = {
      longitude: 12.4924,
      latitude: 41.8902,
      height: 850,
      heading: 90,
      pitch: -25,
      roll: 0,
    };
    workspace.dispatch({ kind: "set-camera", camera: cameraState });

    expect(adapter.apply).toBeTypeOf("function");
    const result = await adapter.apply?.(
      [{ kind: "camera", id: "primary", camera: workspace.state.camera as SceneCameraState }],
      workspace.state,
    );

    expect(result?.status).toBe("supported");
    expect(camera.setView).toHaveBeenCalledTimes(1);
    // After apply, reading the live camera back reproduces the workspace state.
    const readBack = cesiumCameraToSceneState(camera);
    expect(readBack.longitude).toBeCloseTo(12.4924, 9);
    expect(readBack.heading).toBeCloseTo(90, 9);
    expect(readBack.pitch).toBeCloseTo(-25, 9);
  });

  it("omits apply() when no live Cesium target is provided", () => {
    const adapter = createCesiumSceneAdapter();
    expect(adapter.apply).toBeUndefined();
  });

  it("does not statically import Cesium from the scene-workspace sources", () => {
    const sceneWorkspaceRoot = path.resolve(process.cwd(), "src", "scene-workspace");
    const files = fs.readdirSync(sceneWorkspaceRoot).filter((file) => file.endsWith(".ts"));
    const source = files.map((file) => fs.readFileSync(path.join(sceneWorkspaceRoot, file), "utf8")).join("\n");

    // Static `import ... from "cesium"` would eagerly pull Cesium into the 2D
    // bundle. Only the lazy dynamic `import("cesium")` is allowed.
    expect(source).not.toMatch(/from\s+["']cesium["']/);
    expect(source).toMatch(/import\(["']cesium["']\)/);
  });
});
