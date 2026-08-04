import { describe, expect, it } from "vitest";

import {
  CESIUM_SCENE_CAPABILITIES,
  MAPLIBRE_SCENE_CAPABILITIES,
  type MapLibreExtrusionLayerSpecification,
  type MapLibreSceneRuntimeTarget,
  type MapLibreTerrainOptions,
  type MapLibreTerrainSourceSpecification,
  type SceneElevationSourcePrimitive,
  type SceneElevationSourceProtocol,
  type SceneImageryLayerPrimitive,
  type SceneModelLayerPrimitive,
  type SceneRuntimeCapabilities,
  type SceneRuntimePrimitive,
  applyMapLibreScenePrimitives,
  createSceneWorkspace,
  diagnoseScenePrimitive,
  diagnoseScenePrimitives,
  summarizeDiagnosticStatus,
} from "../src/scene-workspace/index.js";

const TERRAIN_PROTOCOLS: SceneElevationSourceProtocol[] = [
  "terrain-rgb",
  "raster-dem",
  "quantized-mesh",
  "image-service",
  "i3s",
  "custom",
];

/** Capabilities that accept every terrain protocol, isolating endpoint checks. */
const ALL_PROTOCOL_CAPABILITIES: SceneRuntimeCapabilities = {
  ...CESIUM_SCENE_CAPABILITIES,
  terrain: { protocols: TERRAIN_PROTOCOLS, supportsExaggeration: true },
};

function terrain(overrides: Partial<SceneElevationSourcePrimitive> = {}): SceneElevationSourcePrimitive {
  return {
    kind: "elevation-source",
    id: "terrain",
    sourceId: "terrain",
    protocol: "quantized-mesh",
    url: "https://terrain.example.test/tiles",
    ...overrides,
  };
}

function imagery(overrides: Partial<SceneImageryLayerPrimitive> = {}): SceneImageryLayerPrimitive {
  return {
    kind: "imagery-layer",
    id: "imagery",
    sourceId: "imagery",
    protocol: "url-template",
    url: "https://tiles.example.test/{z}/{x}/{y}.png",
    ...overrides,
  };
}

function model(overrides: Partial<SceneModelLayerPrimitive> = {}): SceneModelLayerPrimitive {
  return {
    kind: "model-layer",
    id: "model",
    uri: "https://assets.example.test/tileset.json",
    format: "3d-tiles",
    ...overrides,
  };
}

function codes(diagnostics: readonly { code: string }[]): string[] {
  return diagnostics.map((diagnostic) => diagnostic.code);
}

function createMapLibreTarget(): MapLibreSceneRuntimeTarget & {
  sources: Map<string, MapLibreTerrainSourceSpecification>;
  terrains: MapLibreTerrainOptions[];
} {
  const sources = new Map<string, MapLibreTerrainSourceSpecification>();
  const layers = new Map<string, MapLibreExtrusionLayerSpecification>();
  const terrains: MapLibreTerrainOptions[] = [];
  return {
    sources,
    terrains,
    getSource: (id) => sources.get(id),
    addSource: (id, source) => {
      sources.set(id, source);
    },
    getLayer: (id) => layers.get(id),
    addLayer: (layer) => {
      layers.set(layer.id, layer);
    },
    setTerrain: (options) => {
      terrains.push(options);
    },
  };
}

describe("scene primitive spatial-reference diagnostics (#929)", () => {
  describe("horizontal CRS fidelity", () => {
    it("reports exact fidelity for a CRS the renderer addresses natively", () => {
      const diagnostics = diagnoseScenePrimitive(terrain({ crs: "EPSG:4326" }), CESIUM_SCENE_CAPABILITIES);

      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0]).toMatchObject({
        code: "scene-primitive-crs-exact",
        severity: "info",
        status: "supported",
        fidelity: "exact",
        primitiveId: "terrain",
        primitiveKind: "elevation-source",
        renderer: "cesium",
        context: { crs: "EPSG:4326", normalizedCrs: "EPSG:4326" },
      });
      expect(summarizeDiagnosticStatus(diagnostics)).toBe("supported");
    });

    it("reports equivalent fidelity for a Web Mercator binding the renderer reprojects", () => {
      const diagnostics = diagnoseScenePrimitive(imagery({ crs: "EPSG:3857" }), CESIUM_SCENE_CAPABILITIES);

      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0]).toMatchObject({
        code: "scene-primitive-crs-equivalent",
        severity: "warning",
        status: "degraded",
        fidelity: "equivalent",
        primitiveKind: "imagery-layer",
        context: { crs: "EPSG:3857", normalizedCrs: "EPSG:3857" },
      });
      expect(diagnostics[0]?.fallback).toBeTypeOf("string");
      expect(summarizeDiagnosticStatus(diagnostics)).toBe("degraded");
    });

    it("fails closed on a projected CRS the renderer cannot honor", () => {
      const diagnostics = diagnoseScenePrimitive(model({ crs: "EPSG:27700" }), CESIUM_SCENE_CAPABILITIES);

      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0]).toMatchObject({
        code: "scene-primitive-crs-unsupported",
        severity: "error",
        status: "unsupported",
        fidelity: "unsupported",
        primitiveKind: "model-layer",
        context: {
          crs: "EPSG:27700",
          normalizedCrs: "EPSG:27700",
          exactHorizontalCrs: ["EPSG:4326", "OGC:CRS84"],
          equivalentHorizontalCrs: ["EPSG:3857"],
        },
      });
      expect(summarizeDiagnosticStatus(diagnostics)).toBe("unsupported");
    });

    it("fails closed on a CRS identifier it cannot even resolve", () => {
      const diagnostics = diagnoseScenePrimitive(terrain({ crs: "local-site-grid" }), CESIUM_SCENE_CAPABILITIES);

      expect(codes(diagnostics)).toEqual(["scene-primitive-crs-unsupported"]);
      expect(diagnostics[0]?.context).toMatchObject({ crs: "local-site-grid" });
      expect(diagnostics[0]?.context).not.toHaveProperty("normalizedCrs");
    });

    it.each([
      ["EPSG:4326", "exact"],
      ["epsg:4326", "exact"],
      ["4326", "exact"],
      ["urn:ogc:def:crs:EPSG::4326", "exact"],
      ["http://www.opengis.net/def/crs/EPSG/0/4326", "exact"],
      ["OGC:CRS84", "exact"],
      ["CRS84", "exact"],
      ["urn:ogc:def:crs:OGC:1.3:CRS84", "exact"],
      ["WGS84", "exact"],
      ["EPSG:3857", "equivalent"],
      ["EPSG:900913", "equivalent"],
      ["ESRI:102100", "equivalent"],
      ["urn:ogc:def:crs:EPSG::3857", "equivalent"],
      ["EPSG:2193", "unsupported"],
      ["", "unsupported"],
      ["   ", "unsupported"],
    ])("classifies %s as %s fidelity", (crs, fidelity) => {
      const diagnostics = diagnoseScenePrimitive(terrain({ crs }), CESIUM_SCENE_CAPABILITIES);
      const spatial = diagnostics.find((diagnostic) => diagnostic.code.startsWith("scene-primitive-crs-"));

      expect(spatial?.fidelity).toBe(fidelity);
    });

    it("classifies against the renderer capability record rather than a hard-coded globe", () => {
      const britishGrid: SceneRuntimeCapabilities = {
        ...CESIUM_SCENE_CAPABILITIES,
        renderer: "custom",
        spatial: { exactHorizontalCrs: ["EPSG:27700"], verticalDatums: ["EPSG:5701"] },
      };

      expect(codes(diagnoseScenePrimitive(terrain({ crs: "EPSG:27700" }), britishGrid))).toEqual([
        "scene-primitive-crs-exact",
      ]);
      expect(codes(diagnoseScenePrimitive(terrain({ crs: "EPSG:4326" }), britishGrid))).toEqual([
        "scene-primitive-crs-unsupported",
      ]);
    });
  });

  describe("vertical datum", () => {
    it("stays silent for an ellipsoidal datum the renderer honors", () => {
      for (const verticalDatum of ["EPSG:4979", "ellipsoidal-wgs84"]) {
        const diagnostics = diagnoseScenePrimitive(terrain({ verticalDatum }), CESIUM_SCENE_CAPABILITIES);
        expect(codes(diagnostics)).toEqual(["scene-primitive-supported"]);
      }
    });

    it("fails closed on an orthometric datum the renderer cannot transform", () => {
      const diagnostics = diagnoseScenePrimitive(terrain({ verticalDatum: "EPSG:5703" }), CESIUM_SCENE_CAPABILITIES);

      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0]).toMatchObject({
        code: "scene-primitive-vertical-datum-unsupported",
        severity: "error",
        status: "unsupported",
        fidelity: "unsupported",
        context: {
          verticalDatum: "EPSG:5703",
          normalizedVerticalDatum: "EPSG:5703",
          supportedVerticalDatums: ["EPSG:4979"],
        },
      });
    });

    it("aligns its code vocabulary with the entity path's vertical-datum-unsupported", () => {
      const diagnostics = diagnoseScenePrimitive(model({ verticalDatum: "EPSG:3855" }), CESIUM_SCENE_CAPABILITIES);

      expect(diagnostics[0]?.code).toContain("vertical-datum-unsupported");
    });

    it("reports CRS and vertical-datum findings independently", () => {
      const diagnostics = diagnoseScenePrimitive(
        imagery({ crs: "EPSG:3857", verticalDatum: "EPSG:5773" }),
        CESIUM_SCENE_CAPABILITIES,
      );

      expect(codes(diagnostics)).toEqual([
        "scene-primitive-crs-equivalent",
        "scene-primitive-vertical-datum-unsupported",
      ]);
      expect(summarizeDiagnosticStatus(diagnostics)).toBe("unsupported");
    });
  });

  describe("backward compatibility", () => {
    it("diagnoses primitives without spatial metadata exactly as before", () => {
      const primitives: SceneRuntimePrimitive[] = [
        terrain(),
        imagery(),
        model(),
        { kind: "camera", id: "camera", camera: { longitude: 0, latitude: 0, height: 10 } },
        { kind: "ground", id: "ground" },
        { kind: "extrusion", id: "extrusion", sourceId: "buildings", height: 12 },
      ];

      expect(codes(diagnoseScenePrimitives(primitives, CESIUM_SCENE_CAPABILITIES))).toEqual([
        "scene-primitive-supported",
        "scene-primitive-supported",
        "scene-primitive-supported",
        "scene-primitive-supported",
        "scene-primitive-supported",
        "scene-primitive-supported",
      ]);
    });

    it("stays silent when the renderer declares no spatial capability", () => {
      const unaware: SceneRuntimeCapabilities = { ...CESIUM_SCENE_CAPABILITIES, spatial: undefined };

      expect(codes(diagnoseScenePrimitive(terrain({ crs: "EPSG:27700" }), unaware))).toEqual([
        "scene-primitive-supported",
      ]);
    });

    it("keeps a renderability finding alongside a spatial finding", () => {
      const diagnostics = diagnoseScenePrimitive(model({ crs: "EPSG:3857", uri: "  " }), CESIUM_SCENE_CAPABILITIES);

      expect(codes(diagnostics)).toEqual([
        "scene-primitive-crs-equivalent",
        "scene-primitive-model-source-missing-uri",
      ]);
    });
  });

  describe("serialization round-trip", () => {
    it("round-trips CRS and vertical-datum metadata through workspace state", () => {
      const workspace = createSceneWorkspace();
      const primitives: SceneRuntimePrimitive[] = [
        terrain({ crs: "EPSG:4326", verticalDatum: "ellipsoidal-wgs84" }),
        imagery({ crs: "OGC:CRS84", verticalDatum: "EPSG:4979" }),
        model({ crs: "EPSG:4326", verticalDatum: "EPSG:4979" }),
      ];

      workspace.dispatch({ kind: "set-primitives", primitives });
      const restored = JSON.parse(JSON.stringify(workspace.snapshot().state)) as {
        primitives: Record<string, SceneRuntimePrimitive>;
      };

      expect(restored.primitives.terrain).toMatchObject({ crs: "EPSG:4326", verticalDatum: "ellipsoidal-wgs84" });
      expect(restored.primitives.imagery).toMatchObject({ crs: "OGC:CRS84", verticalDatum: "EPSG:4979" });
      expect(restored.primitives.model).toMatchObject({ crs: "EPSG:4326", verticalDatum: "EPSG:4979" });
      expect(diagnoseScenePrimitives(Object.values(restored.primitives), CESIUM_SCENE_CAPABILITIES)).toEqual(
        diagnoseScenePrimitives(primitives, CESIUM_SCENE_CAPABILITIES),
      );
    });
  });

  describe("MapLibre fail-closed application", () => {
    it("never touches the map when the elevation source declares an unhonorable datum", () => {
      const target = createMapLibreTarget();

      const result = applyMapLibreScenePrimitives(target, [
        terrain({ protocol: "raster-dem", verticalDatum: "EPSG:5703" }),
      ]);

      expect(result.status).toBe("unsupported");
      expect(codes(result.diagnostics)).toContain("scene-primitive-vertical-datum-unsupported");
      expect(target.sources.size).toBe(0);
      expect(target.terrains).toEqual([]);
    });

    it("still applies terrain whose CRS is honored exactly", () => {
      const target = createMapLibreTarget();

      const result = applyMapLibreScenePrimitives(target, [
        terrain({ protocol: "raster-dem", crs: "EPSG:4326", verticalDatum: "ellipsoidal-wgs84" }),
      ]);

      expect(result.status).toBe("supported");
      expect(target.sources.has("terrain")).toBe(true);
      expect(target.terrains).toHaveLength(1);
    });

    it("declares the same spatial capability for both shipped adapters", () => {
      expect(MAPLIBRE_SCENE_CAPABILITIES.spatial).toEqual(CESIUM_SCENE_CAPABILITIES.spatial);
    });
  });
});

describe("terrain endpoint validation across protocols (#929)", () => {
  it.each(TERRAIN_PROTOCOLS)("fails closed when %s declares no endpoint", (protocol) => {
    const diagnostics = diagnoseScenePrimitive(
      { kind: "elevation-source", id: "t", sourceId: "t", protocol },
      ALL_PROTOCOL_CAPABILITIES,
    );

    expect(codes(diagnostics)).toEqual(["scene-primitive-terrain-source-missing-url"]);
    expect(diagnostics[0]).toMatchObject({ severity: "error", status: "unsupported" });
    expect(diagnostics[0]?.message).toContain(protocol);
  });

  it.each(TERRAIN_PROTOCOLS)("fails closed when %s declares a blank endpoint", (protocol) => {
    const diagnostics = diagnoseScenePrimitive(
      { kind: "elevation-source", id: "t", sourceId: "t", protocol, url: "   ", tiles: [] },
      ALL_PROTOCOL_CAPABILITIES,
    );

    expect(codes(diagnostics)).toEqual(["scene-primitive-terrain-source-missing-url"]);
  });

  it.each(TERRAIN_PROTOCOLS)("fails closed when %s declares an unusable endpoint scheme", (protocol) => {
    const diagnostics = diagnoseScenePrimitive(
      { kind: "elevation-source", id: "t", sourceId: "t", protocol, url: "ftp://terrain.example.test/tiles" },
      ALL_PROTOCOL_CAPABILITIES,
    );

    expect(codes(diagnostics)).toEqual(["scene-primitive-terrain-source-url-invalid"]);
    expect(diagnostics[0]).toMatchObject({
      severity: "error",
      status: "unsupported",
      context: { invalidFields: ["url"] },
    });
  });

  it.each(TERRAIN_PROTOCOLS)("fails closed when %s declares an unusable tile template", (protocol) => {
    const diagnostics = diagnoseScenePrimitive(
      {
        kind: "elevation-source",
        id: "t",
        sourceId: "t",
        protocol,
        tiles: ["https://terrain.example.test/{z}/{x}/{y}.png", "javascript:alert(1)"],
      },
      ALL_PROTOCOL_CAPABILITIES,
    );

    expect(codes(diagnostics)).toEqual(["scene-primitive-terrain-source-url-invalid"]);
    expect(diagnostics[0]?.context).toMatchObject({ invalidFields: ["tiles[1]"] });
  });

  it.each(TERRAIN_PROTOCOLS)("accepts %s with a renderable endpoint", (protocol) => {
    const diagnostics = diagnoseScenePrimitive(
      { kind: "elevation-source", id: "t", sourceId: "t", protocol, url: "https://terrain.example.test/tiles" },
      ALL_PROTOCOL_CAPABILITIES,
    );

    expect(codes(diagnostics)).toEqual(["scene-primitive-supported"]);
  });

  it("reports invalid numeric ranges for a non terrain-rgb protocol too", () => {
    const diagnostics = diagnoseScenePrimitive(
      terrain({ protocol: "raster-dem", tileSize: 0, minzoom: 12, maxzoom: 4 }),
      ALL_PROTOCOL_CAPABILITIES,
    );

    expect(codes(diagnostics)).toEqual(["scene-primitive-terrain-range-invalid"]);
    expect(diagnostics[0]?.context).toMatchObject({ tileSize: 0, zoomRange: [12, 4] });
  });

  it("still rejects an unsupported protocol before endpoint validation", () => {
    const diagnostics = diagnoseScenePrimitive(terrain({ protocol: "i3s" }), MAPLIBRE_SCENE_CAPABILITIES);

    expect(codes(diagnostics)).toEqual(["scene-primitive-unsupported"]);
  });
});
