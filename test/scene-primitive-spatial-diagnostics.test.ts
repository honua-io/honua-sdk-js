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

    it("rejects a two-dimensional CRS used as a vertical datum", () => {
      // EPSG:4326 and OGC:CRS84 are exact *horizontal* references but carry no
      // height component, so accepting either as a vertical datum would infer
      // an ellipsoidal height the author never declared. EPSG:4979 is the
      // three-dimensional spelling and is the one that passes.
      for (const verticalDatum of ["EPSG:4326", "OGC:CRS84"]) {
        expect(codes(diagnoseScenePrimitive(terrain({ verticalDatum }), CESIUM_SCENE_CAPABILITIES))).toEqual([
          "scene-primitive-vertical-datum-unsupported",
        ]);
      }
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

/** A renderer that does declare a floor, isolating the renderer-floor limit. */
const COARSE_FLOOR_CAPABILITIES: SceneRuntimeCapabilities = {
  ...CESIUM_SCENE_CAPABILITIES,
  spatial: { ...CESIUM_SCENE_CAPABILITIES.spatial, precision: { horizontalMeters: 2, verticalMeters: 5 } },
};

describe("scene primitive precision diagnostics (#1051)", () => {
  describe("DEM encoding height quantum", () => {
    it("reports exact fidelity when the claimed height detail survives the encoding", () => {
      const diagnostics = diagnoseScenePrimitive(
        terrain({ protocol: "raster-dem", encoding: "mapbox", precision: { verticalMeters: 0.5 } }),
        CESIUM_SCENE_CAPABILITIES,
      );

      expect(codes(diagnostics)).toEqual(["scene-primitive-precision-exact"]);
      expect(diagnostics[0]).toMatchObject({
        severity: "info",
        status: "supported",
        fidelity: "exact",
        primitiveId: "terrain",
        primitiveKind: "elevation-source",
        renderer: "cesium",
        context: { axis: "vertical", claimedMeters: 0.5, limitMeters: 0.1, limitSource: "dem-encoding" },
      });
      expect(summarizeDiagnosticStatus(diagnostics)).toBe("supported");
    });

    it("reports equivalent fidelity when the claim is finer than Terrain-RGB can encode", () => {
      const diagnostics = diagnoseScenePrimitive(
        terrain({ protocol: "terrain-rgb", encoding: "mapbox", precision: { verticalMeters: 0.01 } }),
        CESIUM_SCENE_CAPABILITIES,
      );

      expect(codes(diagnostics)).toEqual(["scene-primitive-precision-equivalent"]);
      expect(diagnostics[0]).toMatchObject({
        severity: "warning",
        status: "degraded",
        fidelity: "equivalent",
        context: {
          axis: "vertical",
          claimedMeters: 0.01,
          limitMeters: 0.1,
          limitSource: "dem-encoding",
          limitDetail: "mapbox",
        },
      });
      expect(diagnostics[0]?.fallback).toContain("encoding");
      expect(summarizeDiagnosticStatus(diagnostics)).toBe("degraded");
    });

    it("uses the terrarium quantum for a terrarium-encoded source", () => {
      const equivalent = diagnoseScenePrimitive(
        terrain({ protocol: "raster-dem", encoding: "terrarium", precision: { verticalMeters: 0.002 } }),
        CESIUM_SCENE_CAPABILITIES,
      );
      const exact = diagnoseScenePrimitive(
        terrain({ protocol: "raster-dem", encoding: "terrarium", precision: { verticalMeters: 0.01 } }),
        CESIUM_SCENE_CAPABILITIES,
      );

      expect(codes(equivalent)).toEqual(["scene-primitive-precision-equivalent"]);
      expect(equivalent[0]?.context).toMatchObject({ limitMeters: 1 / 256, limitDetail: "terrarium" });
      expect(codes(exact)).toEqual(["scene-primitive-precision-exact"]);
    });

    it("stays silent for an encoding whose quantum the plan does not publish", () => {
      const diagnostics = diagnoseScenePrimitive(
        terrain({ protocol: "raster-dem", encoding: "custom", precision: { verticalMeters: 0.001 } }),
        CESIUM_SCENE_CAPABILITIES,
      );

      expect(codes(diagnostics)).toEqual(["scene-primitive-supported"]);
    });

    it("never assumes an encoding that was not declared", () => {
      const diagnostics = diagnoseScenePrimitive(
        terrain({ protocol: "raster-dem", precision: { verticalMeters: 0.001 } }),
        CESIUM_SCENE_CAPABILITIES,
      );

      expect(codes(diagnostics)).toEqual(["scene-primitive-supported"]);
    });

    it("does not apply an RGB DEM quantum to a protocol that does not decode one", () => {
      const diagnostics = diagnoseScenePrimitive(
        terrain({ protocol: "quantized-mesh", encoding: "mapbox", precision: { verticalMeters: 0.001 } }),
        CESIUM_SCENE_CAPABILITIES,
      );

      expect(codes(diagnostics)).toEqual(["scene-primitive-supported"]);
    });
  });

  describe("geocentric float32 coordinate spacing", () => {
    it("reports the 0.5 m float32 spacing at the ellipsoid for an ECEF-stored asset", () => {
      const diagnostics = diagnoseScenePrimitive(
        model({
          precision: { horizontalMeters: 0.05, coordinateFrame: "geocentric", coordinateStorage: "float32" },
        }),
        CESIUM_SCENE_CAPABILITIES,
      );

      expect(codes(diagnostics)).toEqual(["scene-primitive-precision-equivalent"]);
      expect(diagnostics[0]).toMatchObject({
        fidelity: "equivalent",
        status: "degraded",
        context: {
          axis: "horizontal",
          claimedMeters: 0.05,
          limitMeters: 0.5,
          limitSource: "geocentric-float32-coordinates",
        },
      });
      expect(diagnostics[0]?.fallback).toContain("local frame");
    });

    it("classifies both axes when the asset claims detail on both", () => {
      const diagnostics = diagnoseScenePrimitive(
        model({
          precision: {
            horizontalMeters: 1,
            verticalMeters: 0.02,
            coordinateFrame: "geocentric",
            coordinateStorage: "float32",
          },
        }),
        CESIUM_SCENE_CAPABILITIES,
      );

      expect(codes(diagnostics)).toEqual(["scene-primitive-precision-exact", "scene-primitive-precision-equivalent"]);
      expect(diagnostics[0]?.context).toMatchObject({ axis: "horizontal" });
      expect(diagnostics[1]?.context).toMatchObject({ axis: "vertical", limitMeters: 0.5 });
    });

    it("stays silent for a locally anchored or float64 asset", () => {
      const local = diagnoseScenePrimitive(
        model({
          position: [-157.86, 21.31, 12],
          precision: { horizontalMeters: 0.001, coordinateFrame: "local", coordinateStorage: "float32" },
        }),
        CESIUM_SCENE_CAPABILITIES,
      );
      const wide = diagnoseScenePrimitive(
        model({ precision: { horizontalMeters: 0.001, coordinateFrame: "geocentric", coordinateStorage: "float64" } }),
        CESIUM_SCENE_CAPABILITIES,
      );

      expect(codes(local)).toEqual(["scene-primitive-supported"]);
      expect(codes(wide)).toEqual(["scene-primitive-supported"]);
    });
  });

  describe("renderer precision floor", () => {
    it("classifies a claim against a floor the renderer declares", () => {
      const equivalent = diagnoseScenePrimitive(
        imagery({ precision: { horizontalMeters: 0.5 } }),
        COARSE_FLOOR_CAPABILITIES,
      );
      const exact = diagnoseScenePrimitive(imagery({ precision: { horizontalMeters: 4 } }), COARSE_FLOOR_CAPABILITIES);

      expect(codes(equivalent)).toEqual(["scene-primitive-precision-equivalent"]);
      expect(equivalent[0]?.context).toMatchObject({ limitMeters: 2, limitSource: "renderer-floor" });
      expect(equivalent[0]?.context).not.toHaveProperty("limitDetail");
      expect(codes(exact)).toEqual(["scene-primitive-precision-exact"]);
    });

    it("keeps the coarsest limit when several apply", () => {
      const diagnostics = diagnoseScenePrimitive(
        terrain({
          protocol: "raster-dem",
          encoding: "mapbox",
          precision: { verticalMeters: 0.01, coordinateFrame: "geocentric", coordinateStorage: "float32" },
        }),
        COARSE_FLOOR_CAPABILITIES,
      );

      expect(codes(diagnostics)).toEqual(["scene-primitive-precision-equivalent"]);
      expect(diagnostics[0]?.context).toMatchObject({ limitMeters: 5, limitSource: "renderer-floor" });
    });

    it("declares no precision floor on either shipped adapter", () => {
      expect(CESIUM_SCENE_CAPABILITIES.spatial?.precision).toBeUndefined();
      expect(MAPLIBRE_SCENE_CAPABILITIES.spatial?.precision).toBeUndefined();
    });
  });

  describe("honest unknowns", () => {
    it("stays silent for a claim with no declared limit", () => {
      const diagnostics = diagnoseScenePrimitive(
        imagery({ precision: { horizontalMeters: 0.05, verticalMeters: 0.05 } }),
        CESIUM_SCENE_CAPABILITIES,
      );

      expect(codes(diagnostics)).toEqual(["scene-primitive-supported"]);
    });

    it("stays silent for a limit with no claim", () => {
      const diagnostics = diagnoseScenePrimitive(
        terrain({
          protocol: "raster-dem",
          encoding: "mapbox",
          precision: { coordinateFrame: "geocentric", coordinateStorage: "float32" },
        }),
        COARSE_FLOOR_CAPABILITIES,
      );

      expect(codes(diagnostics)).toEqual(["scene-primitive-supported"]);
    });

    it("never mints an unsupported precision fidelity, however coarse the limit", () => {
      const diagnostics = [
        ...diagnoseScenePrimitive(
          terrain({ protocol: "raster-dem", encoding: "mapbox", precision: { verticalMeters: 1e-9 } }),
          COARSE_FLOOR_CAPABILITIES,
        ),
        ...diagnoseScenePrimitive(
          model({
            precision: { horizontalMeters: 1e-9, coordinateFrame: "geocentric", coordinateStorage: "float32" },
          }),
          COARSE_FLOOR_CAPABILITIES,
        ),
      ];

      expect(diagnostics.every((entry) => entry.fidelity !== "unsupported")).toBe(true);
      expect(diagnostics.every((entry) => entry.status !== "unsupported")).toBe(true);
    });

    it("replaces the generic supported summary but keeps a renderability finding", () => {
      const diagnostics = diagnoseScenePrimitive(
        model({
          format: "i3s",
          precision: { horizontalMeters: 0.05, coordinateFrame: "geocentric", coordinateStorage: "float32" },
        }),
        CESIUM_SCENE_CAPABILITIES,
      );

      expect(codes(diagnostics)).toEqual([
        "scene-primitive-precision-equivalent",
        "scene-primitive-model-format-not-materialized",
      ]);
    });
  });
});

describe("scene primitive cache and source-version metadata (#1051)", () => {
  describe("cache status", () => {
    it("reports a stale cache as degraded without blocking the binding", () => {
      const diagnostics = diagnoseScenePrimitive(
        imagery({
          cache: { status: "stale", scope: "tiles", updatedAt: "2026-08-01T00:00:00.000Z", ttlMs: 600_000 },
        }),
        CESIUM_SCENE_CAPABILITIES,
      );

      expect(codes(diagnostics)).toEqual(["scene-primitive-supported", "scene-primitive-cache-stale"]);
      expect(diagnostics[1]).toMatchObject({
        severity: "warning",
        status: "degraded",
        primitiveId: "imagery",
        context: {
          cacheStatus: "stale",
          cacheScope: "tiles",
          cacheUpdatedAt: "2026-08-01T00:00:00.000Z",
          cacheTtlMs: 600_000,
        },
      });
      expect(diagnostics[1]?.message).toContain("tiles");
      expect(summarizeDiagnosticStatus(diagnostics)).toBe("degraded");
    });

    it("reports a bypassed cache as an informational, supported statement", () => {
      const diagnostics = diagnoseScenePrimitive(terrain({ cache: { status: "bypass" } }), CESIUM_SCENE_CAPABILITIES);

      expect(codes(diagnostics)).toEqual(["scene-primitive-supported", "scene-primitive-cache-bypass"]);
      expect(diagnostics[1]).toMatchObject({
        severity: "info",
        status: "supported",
        context: { cacheStatus: "bypass" },
      });
      expect(summarizeDiagnosticStatus(diagnostics)).toBe("supported");
    });

    it("stays silent for a ready or unknown cache", () => {
      const baseline = diagnoseScenePrimitive(terrain(), CESIUM_SCENE_CAPABILITIES);

      for (const status of ["ready", "unknown"] as const) {
        expect(diagnoseScenePrimitive(terrain({ cache: { status } }), CESIUM_SCENE_CAPABILITIES)).toEqual(baseline);
      }
    });

    it("keeps a fail-closed binding fail-closed", () => {
      const target = createMapLibreTarget();

      const result = applyMapLibreScenePrimitives(target, [
        terrain({ protocol: "raster-dem", url: "ftp://terrain.example.test/tiles", cache: { status: "stale" } }),
      ]);

      expect(result.status).toBe("unsupported");
      expect(codes(result.diagnostics)).toEqual([
        "scene-primitive-terrain-source-url-invalid",
        "scene-primitive-cache-stale",
      ]);
      expect(target.sources.size).toBe(0);
    });
  });

  describe("source version", () => {
    it("carries the declared version on every finding the primitive raises", () => {
      const diagnostics = diagnoseScenePrimitive(
        imagery({ sourceVersion: "2026-07-14.3", crs: "EPSG:3857", cache: { status: "stale" } }),
        CESIUM_SCENE_CAPABILITIES,
      );

      expect(codes(diagnostics)).toEqual(["scene-primitive-crs-equivalent", "scene-primitive-cache-stale"]);
      for (const entry of diagnostics) {
        expect(entry.context).toMatchObject({ sourceVersion: "2026-07-14.3" });
      }
    });

    it("carries it onto a plain supported summary too", () => {
      const diagnostics = diagnoseScenePrimitive(terrain({ sourceVersion: "v9" }), CESIUM_SCENE_CAPABILITIES);

      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0]).toMatchObject({
        code: "scene-primitive-supported",
        context: { sourceVersion: "v9" },
      });
    });

    it("round-trips through workspace serialization with precision and cache", () => {
      const workspace = createSceneWorkspace();
      const primitives: SceneRuntimePrimitive[] = [
        terrain({
          protocol: "raster-dem",
          encoding: "mapbox",
          sourceVersion: "dem-2026.2",
          cache: { status: "stale", scope: "tiles" },
          precision: { verticalMeters: 0.01 },
        }),
        model({
          sourceVersion: "tileset-17",
          precision: { horizontalMeters: 0.05, coordinateFrame: "geocentric", coordinateStorage: "float32" },
        }),
      ];

      workspace.dispatch({ kind: "set-primitives", primitives });
      const restored = JSON.parse(JSON.stringify(workspace.snapshot().state)) as {
        primitives: Record<string, SceneRuntimePrimitive>;
      };

      expect(restored.primitives.terrain).toMatchObject({
        sourceVersion: "dem-2026.2",
        cache: { status: "stale", scope: "tiles" },
        precision: { verticalMeters: 0.01 },
      });
      expect(restored.primitives.model).toMatchObject({
        sourceVersion: "tileset-17",
        precision: { horizontalMeters: 0.05, coordinateFrame: "geocentric", coordinateStorage: "float32" },
      });
      expect(diagnoseScenePrimitives(Object.values(restored.primitives), CESIUM_SCENE_CAPABILITIES)).toEqual(
        diagnoseScenePrimitives(primitives, CESIUM_SCENE_CAPABILITIES),
      );
    });
  });

  describe("metadata that cannot be read", () => {
    it("names an unknown precision key and classifies nothing from the record", () => {
      const diagnostics = diagnoseScenePrimitive(
        terrain({
          protocol: "raster-dem",
          encoding: "mapbox",
          precision: { verticalMeters: 0.01, verticalMetres: 0.01 } as never,
        }),
        CESIUM_SCENE_CAPABILITIES,
      );

      expect(codes(diagnostics)).toEqual(["scene-primitive-supported", "scene-primitive-asset-metadata-invalid"]);
      expect(diagnostics[1]).toMatchObject({
        severity: "warning",
        status: "degraded",
        context: { invalidFields: ["precision.verticalMetres"] },
      });
    });

    it("names non-positive magnitudes and unknown coordinate tokens", () => {
      const diagnostics = diagnoseScenePrimitive(
        model({
          precision: {
            horizontalMeters: -1,
            verticalMeters: Number.POSITIVE_INFINITY,
            coordinateFrame: "ecef" as never,
            coordinateStorage: "float16" as never,
          },
        }),
        CESIUM_SCENE_CAPABILITIES,
      );

      expect(diagnostics[1]?.context).toMatchObject({
        invalidFields: [
          "precision.horizontalMeters",
          "precision.verticalMeters",
          "precision.coordinateFrame",
          "precision.coordinateStorage",
        ],
      });
    });

    it("names a precision record that is not plain data, and a stray one on a kind that cannot carry it", () => {
      const nonRecord = diagnoseScenePrimitive(imagery({ precision: [0.5] as never }), CESIUM_SCENE_CAPABILITIES);
      const stray = diagnoseScenePrimitive(
        { kind: "ground", id: "ground", precision: { horizontalMeters: 0.5 } } as never,
        CESIUM_SCENE_CAPABILITIES,
      );

      expect(nonRecord[1]?.context).toMatchObject({ invalidFields: ["precision"] });
      expect(stray.map((entry) => entry.code)).toContain("scene-primitive-asset-metadata-invalid");
      expect(stray.at(-1)?.context).toMatchObject({ invalidFields: ["precision"] });
    });

    it("names unreadable cache fields and suppresses the cache finding", () => {
      const diagnostics = diagnoseScenePrimitive(
        imagery({
          cache: { status: "stalé", ttlMs: -1, updatedAt: "yesterday", validator: " " } as never,
        }),
        CESIUM_SCENE_CAPABILITIES,
      );

      expect(codes(diagnostics)).toEqual(["scene-primitive-supported", "scene-primitive-asset-metadata-invalid"]);
      expect(diagnostics[1]?.context).toMatchObject({
        invalidFields: ["cache.status", "cache.updatedAt", "cache.ttlMs", "cache.validator"],
      });
    });

    it("names a blank source version and never propagates it", () => {
      const diagnostics = diagnoseScenePrimitive(terrain({ sourceVersion: "   " }), CESIUM_SCENE_CAPABILITIES);

      expect(diagnostics[1]?.context).toMatchObject({ invalidFields: ["sourceVersion"] });
      for (const entry of diagnostics) {
        expect(entry.context ?? {}).not.toHaveProperty("sourceVersion");
      }
    });

    it("degrades the plan's claims rather than refusing a renderable binding", () => {
      const target = createMapLibreTarget();

      const result = applyMapLibreScenePrimitives(target, [
        terrain({ protocol: "raster-dem", precision: { horizontalMeters: 0 } }),
      ]);

      expect(result.status).toBe("degraded");
      expect(target.sources.has("terrain")).toBe(true);
      expect(target.terrains).toHaveLength(1);
    });
  });

  describe("backward compatibility", () => {
    it("diagnoses a primitive with no descriptive metadata exactly as before", () => {
      const primitives: SceneRuntimePrimitive[] = [
        terrain(),
        imagery(),
        model(),
        { kind: "camera", id: "camera", camera: { longitude: 0, latitude: 0, height: 1000 } },
      ];

      const diagnostics = diagnoseScenePrimitives(primitives, CESIUM_SCENE_CAPABILITIES);

      expect(codes(diagnostics)).toEqual([
        "scene-primitive-supported",
        "scene-primitive-supported",
        "scene-primitive-supported",
        "scene-primitive-supported",
      ]);
      expect(diagnostics.every((entry) => entry.context === undefined)).toBe(true);
      expect(diagnostics.every((entry) => entry.fidelity === undefined)).toBe(true);
    });
  });
});
