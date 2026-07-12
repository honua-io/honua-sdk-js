import { describe, expect, it } from "vitest";

import {
  HonuaFeatureLayer,
  HonuaMapService,
  HonuaWms,
  HonuaWmsLayer,
  HonuaWmts,
  HonuaWmtsTileset,
} from "@honua/sdk-js/honua";
import {
  createSources,
  isFeatureServiceSource,
  isHonuaSource,
  isMapServiceSource,
  isOgcFeaturesSource,
  parseOgcFeaturesUrl,
  validateHonuaStyle,
} from "@honua/sdk-js/style";
import type { HonuaStyleSpecification } from "@honua/sdk-js/style";
import { HonuaOgcFeatureCollection } from "../src/core/surfaces.js";
import { parseFeatureLayerUrl, parseMapServiceUrl } from "../src/esri-compat-entry.js";
import { HonuaClient } from "../src/index.js";

describe("Type guards", () => {
  it("isHonuaSource() identifies Honua sources by type prefix", () => {
    expect(isHonuaSource({ type: "honua-feature-service" })).toBe(true);
    expect(isHonuaSource({ type: "honua-map-service" })).toBe(true);
    expect(isHonuaSource({ type: "honua-ogc-features" })).toBe(true);
    expect(isHonuaSource({ type: "vector" })).toBe(false);
    expect(isHonuaSource({ type: "geojson" })).toBe(false);
  });

  it("isFeatureServiceSource() narrows to feature service", () => {
    const source = { type: "honua-feature-service" as const, url: "https://example.com" };
    expect(isFeatureServiceSource(source)).toBe(true);
    expect(isFeatureServiceSource({ type: "honua-map-service" })).toBe(false);
  });

  it("isMapServiceSource() narrows to map service", () => {
    expect(isMapServiceSource({ type: "honua-map-service" })).toBe(true);
    expect(isMapServiceSource({ type: "honua-feature-service" })).toBe(false);
  });

  it("isOgcFeaturesSource() narrows to OGC features", () => {
    expect(isOgcFeaturesSource({ type: "honua-ogc-features" })).toBe(true);
    expect(isOgcFeaturesSource({ type: "vector" })).toBe(false);
  });
});

describe("URL parsing", () => {
  describe("parseFeatureLayerUrl (re-exported from esri-compat)", () => {
    it("parses a standard Feature Service URL", () => {
      const result = parseFeatureLayerUrl("https://gis.example.com/rest/services/parcels/FeatureServer/0");
      expect(result).toEqual({
        baseUrl: "https://gis.example.com",
        serviceId: "parcels",
        layerId: 0,
      });
    });

    it("parses a URL with a path prefix (e.g. /arcgis)", () => {
      const result = parseFeatureLayerUrl("https://gis.example.com/arcgis/rest/services/parcels/FeatureServer/3");
      expect(result).toEqual({
        baseUrl: "https://gis.example.com/arcgis",
        serviceId: "parcels",
        layerId: 3,
      });
    });

    it("throws on invalid URL", () => {
      expect(() => parseFeatureLayerUrl("https://example.com/not-a-service")).toThrow("Invalid FeatureLayer URL");
    });
  });

  describe("parseMapServiceUrl (re-exported from esri-compat)", () => {
    it("parses a standard Map Service URL", () => {
      const result = parseMapServiceUrl("https://gis.example.com/rest/services/imagery/MapServer");
      expect(result).toEqual({
        baseUrl: "https://gis.example.com",
        serviceId: "imagery",
      });
    });

    it("throws on invalid URL", () => {
      expect(() => parseMapServiceUrl("https://example.com/not-a-service")).toThrow("Invalid MapServer URL");
    });
  });

  describe("parseOgcFeaturesUrl", () => {
    it("parses a URL with a collection path", () => {
      const result = parseOgcFeaturesUrl("https://gis.example.com/ogc/collections/admin-boundaries");
      expect(result).toEqual({
        baseUrl: "https://gis.example.com/ogc",
        collectionId: "admin-boundaries",
      });
    });

    it("parses a bare OGC root URL (no collection)", () => {
      const result = parseOgcFeaturesUrl("https://gis.example.com/ogc");
      expect(result).toEqual({
        baseUrl: "https://gis.example.com/ogc",
        collectionId: undefined,
      });
    });

    it("strips trailing slashes from bare URLs", () => {
      const result = parseOgcFeaturesUrl("https://gis.example.com/ogc/");
      expect(result).toEqual({
        baseUrl: "https://gis.example.com/ogc",
        collectionId: undefined,
      });
    });

    it("parses relative collection URLs", () => {
      const result = parseOgcFeaturesUrl("/ogc/features/collections/admin-boundaries");
      expect(result).toEqual({
        baseUrl: "/ogc/features",
        collectionId: "admin-boundaries",
      });
    });

    it("parses relative collection URLs with query/hash suffixes", () => {
      const result = parseOgcFeaturesUrl("/ogc/features/collections/admin-boundaries?limit=10#section");
      expect(result).toEqual({
        baseUrl: "/ogc/features",
        collectionId: "admin-boundaries",
      });
    });
  });
});

describe("validateHonuaStyle", () => {
  it("returns no errors for a valid style", () => {
    const style: HonuaStyleSpecification = {
      version: 8,
      sources: {
        parcels: {
          type: "honua-feature-service",
          url: "https://gis.example.com/rest/services/parcels/FeatureServer/0",
        },
      },
      layers: [{ id: "parcel-fill", type: "fill", source: "parcels" }],
    };
    expect(validateHonuaStyle(style)).toEqual([]);
  });

  it("reports missing version", () => {
    const errors = validateHonuaStyle({ sources: {}, layers: [] });
    expect(errors).toContainEqual({ path: "version", message: "Version must be 8" });
  });

  it("reports non-object sources", () => {
    const errors = validateHonuaStyle({ version: 8, sources: null, layers: [] });
    expect(errors).toContainEqual({
      path: "sources",
      message: "Sources must be a non-null object",
    });
  });

  it("reports missing url on Honua sources", () => {
    const errors = validateHonuaStyle({
      version: 8,
      sources: { bad: { type: "honua-feature-service" } },
      layers: [],
    });
    expect(errors).toContainEqual({
      path: "sources.bad.url",
      message: "Honua source must have a string url",
    });
  });

  it("reports missing layer id/type", () => {
    const errors = validateHonuaStyle({
      version: 8,
      sources: {},
      layers: [{}],
    });
    expect(errors.some((e) => e.path === "layers[0].id")).toBe(true);
    expect(errors.some((e) => e.path === "layers[0].type")).toBe(true);
  });

  it("reports non-object input", () => {
    expect(validateHonuaStyle(null)).toHaveLength(1);
    expect(validateHonuaStyle("string")).toHaveLength(1);
  });
});

describe("createSources", () => {
  const client = new HonuaClient({ baseUrl: "https://gis.example.com" });

  it("creates HonuaFeatureLayer for feature-service sources", () => {
    const style: HonuaStyleSpecification = {
      version: 8,
      sources: {
        parcels: {
          type: "honua-feature-service",
          url: "https://gis.example.com/rest/services/parcels/FeatureServer/0",
          definitionExpression: "status = 'active'",
        },
      },
      layers: [],
    };

    const sources = createSources(client, style);
    const parcels = sources.get("parcels");
    expect(parcels).toBeInstanceOf(HonuaFeatureLayer);
    expect((parcels as HonuaFeatureLayer).serviceId).toBe("parcels");
    expect((parcels as HonuaFeatureLayer).layerId).toBe(0);
  });

  it("creates HonuaMapService for map-service sources", () => {
    const style: HonuaStyleSpecification = {
      version: 8,
      sources: {
        imagery: {
          type: "honua-map-service",
          url: "https://gis.example.com/rest/services/imagery/MapServer",
        },
      },
      layers: [],
    };

    const sources = createSources(client, style);
    const imagery = sources.get("imagery");
    expect(imagery).toBeInstanceOf(HonuaMapService);
    expect((imagery as HonuaMapService).serviceId).toBe("imagery");
  });

  it("creates HonuaOgcFeatureCollection for ogc-features sources", () => {
    const style: HonuaStyleSpecification = {
      version: 8,
      sources: {
        boundaries: {
          type: "honua-ogc-features",
          url: "https://gis.example.com/ogc/collections/admin-boundaries",
        },
      },
      layers: [],
    };

    const sources = createSources(client, style);
    const boundaries = sources.get("boundaries");
    expect(boundaries).toBeInstanceOf(HonuaOgcFeatureCollection);
    expect((boundaries as HonuaOgcFeatureCollection).collectionId).toBe("admin-boundaries");
  });

  it("uses explicit collectionId over URL-parsed one", () => {
    const style: HonuaStyleSpecification = {
      version: 8,
      sources: {
        data: {
          type: "honua-ogc-features",
          url: "https://gis.example.com/ogc/collections/old-name",
          collectionId: "new-name",
        },
      },
      layers: [],
    };

    const sources = createSources(client, style);
    expect((sources.get("data") as HonuaOgcFeatureCollection).collectionId).toBe("new-name");
  });

  it("creates HonuaWms (service-level) for honua-wms sources without LAYERS", () => {
    const style: HonuaStyleSpecification = {
      version: 8,
      sources: {
        imagery: {
          type: "honua-wms",
          url: "https://gis.example.com/rest/services/imagery/MapServer/WMS",
        },
      },
      layers: [],
    };
    const sources = createSources(client, style);
    const handle = sources.get("imagery");
    expect(handle).toBeInstanceOf(HonuaWms);
    expect((handle as HonuaWms).serviceId).toBe("imagery");
  });

  it("creates HonuaWmsLayer when honua-wms binds a single LAYER (and STYLE)", () => {
    const style: HonuaStyleSpecification = {
      version: 8,
      sources: {
        parcels: {
          type: "honua-wms",
          url: "https://gis.example.com/rest/services/imagery/MapServer/WMS",
          layers: "parcels",
          styles: "default",
        },
      },
      layers: [],
    };
    const sources = createSources(client, style);
    const handle = sources.get("parcels");
    expect(handle).toBeInstanceOf(HonuaWmsLayer);
    expect((handle as HonuaWmsLayer).serviceId).toBe("imagery");
    expect((handle as HonuaWmsLayer).layerName).toBe("parcels");
    expect((handle as HonuaWmsLayer).defaultStyleId).toBe("default");
  });

  it("trims whitespace around a single LAYER token before binding HonuaWmsLayer", () => {
    const style: HonuaStyleSpecification = {
      version: 8,
      sources: {
        parcels: {
          type: "honua-wms",
          url: "https://gis.example.com/rest/services/imagery/MapServer/WMS",
          layers: "  parcels  ",
        },
      },
      layers: [],
    };
    const sources = createSources(client, style);
    const handle = sources.get("parcels");
    expect(handle).toBeInstanceOf(HonuaWmsLayer);
    expect((handle as HonuaWmsLayer).layerName).toBe("parcels");
  });

  it("returns service-level HonuaWms for multi-layer LAYERS=a,b composites", () => {
    // HonuaWmsLayer is a single-layer handle (its describe() resolves
    // exactly one <Layer>); registering it for a comma-separated
    // composite would silently mis-route describe() / stylesIn() /
    // legend() to a layer name that does not exist on the wire. The
    // service-level handle keeps map() / featureInfo() targeting the
    // composite verbatim.
    const style: HonuaStyleSpecification = {
      version: 8,
      sources: {
        composite: {
          type: "honua-wms",
          url: "https://gis.example.com/rest/services/imagery/MapServer/WMS",
          layers: "parcels, roads",
        },
      },
      layers: [],
    };
    const sources = createSources(client, style);
    const handle = sources.get("composite");
    expect(handle).toBeInstanceOf(HonuaWms);
    expect(handle).not.toBeInstanceOf(HonuaWmsLayer);
    expect((handle as HonuaWms).serviceId).toBe("imagery");
  });

  it("creates HonuaWmts (service-level) for honua-wmts sources without a layer", () => {
    const style: HonuaStyleSpecification = {
      version: 8,
      sources: {
        tiles: {
          type: "honua-wmts",
          url: "https://gis.example.com/rest/services/imagery/MapServer/WMTS",
        },
      },
      layers: [],
    };
    const sources = createSources(client, style);
    const handle = sources.get("tiles");
    expect(handle).toBeInstanceOf(HonuaWmts);
    expect((handle as HonuaWmts).serviceId).toBe("imagery");
  });

  it("creates HonuaWmtsTileset when honua-wmts pins a layer + style + TileMatrixSet", () => {
    const style: HonuaStyleSpecification = {
      version: 8,
      sources: {
        tiles: {
          type: "honua-wmts",
          url: "https://gis.example.com/rest/services/imagery/MapServer/WMTS",
          layer: "imagery",
          style: "default",
          tileMatrixSet: "WebMercatorQuad",
        },
      },
      layers: [],
    };
    const sources = createSources(client, style);
    const handle = sources.get("tiles");
    expect(handle).toBeInstanceOf(HonuaWmtsTileset);
    expect((handle as HonuaWmtsTileset).serviceId).toBe("imagery");
    expect((handle as HonuaWmtsTileset).layerName).toBe("imagery");
    expect((handle as HonuaWmtsTileset).styleId).toBe("default");
    expect((handle as HonuaWmtsTileset).tileMatrixSetId).toBe("WebMercatorQuad");
  });

  it("returns null for non-Honua sources", () => {
    const style: HonuaStyleSpecification = {
      version: 8,
      sources: {
        osm: { type: "vector", tiles: ["https://tiles.example.com/{z}/{x}/{y}.pbf"] },
      },
      layers: [],
    };

    const sources = createSources(client, style);
    expect(sources.get("osm")).toBeNull();
  });

  it("handles a mixed-source style", () => {
    const style: HonuaStyleSpecification = {
      version: 8,
      sources: {
        parcels: {
          type: "honua-feature-service",
          url: "https://gis.example.com/rest/services/parcels/FeatureServer/0",
        },
        basemap: {
          type: "vector",
          tiles: ["https://tiles.example.com/{z}/{x}/{y}.pbf"],
        },
        boundaries: {
          type: "honua-ogc-features",
          url: "https://gis.example.com/ogc/collections/admin",
        },
      },
      layers: [
        { id: "parcel-fill", type: "fill", source: "parcels" },
        { id: "basemap-fill", type: "fill", source: "basemap" },
      ],
    };

    const sources = createSources(client, style);
    expect(sources.get("parcels")).toBeInstanceOf(HonuaFeatureLayer);
    expect(sources.get("basemap")).toBeNull();
    expect(sources.get("boundaries")).toBeInstanceOf(HonuaOgcFeatureCollection);
    expect(sources.size).toBe(3);
  });
});

describe("HonuaStyleSpecification (design doc example)", () => {
  it("represents the parcel analysis style from the design doc", () => {
    const style: HonuaStyleSpecification = {
      version: 8,
      name: "Parcel Analysis",
      sources: {
        parcels: {
          type: "honua-feature-service",
          url: "https://gis.example.com/rest/services/parcels/FeatureServer/0",
          definitionExpression: "status = 'active'",
        },
        imagery: {
          type: "honua-map-service",
          url: "https://gis.example.com/rest/services/imagery/MapServer",
        },
        boundaries: {
          type: "honua-ogc-features",
          url: "https://gis.example.com/ogc/collections/admin-boundaries",
        },
      },
      layers: [
        {
          id: "parcel-fill",
          source: "parcels",
          type: "fill",
          paint: {
            "fill-color": ["step", ["get", "assessed_value"], "#f7fbff", 100000, "#6baed6", 500000, "#08306b"],
            "fill-opacity": 0.7,
          },
        },
      ],
    };

    expect(validateHonuaStyle(style)).toEqual([]);
    expect(style.sources.parcels.type).toBe("honua-feature-service");
    expect(style.sources.imagery.type).toBe("honua-map-service");
    expect(style.sources.boundaries.type).toBe("honua-ogc-features");
  });
});
