import { describe, expect, it } from "vitest";
import { validateHonuaStyle, webmapJsonToMapLibreStyle } from "../src/index.js";
import type { WebMapJson } from "../src/webmap/types.js";

describe("webmapJsonToMapLibreStyle", () => {
  it("converts a simple WebMap (FeatureLayer + TileLayer basemap) with zero gaps", () => {
    const webmap: WebMapJson = {
      version: "2.27",
      baseMap: {
        title: "Streets",
        baseMapLayers: [
          {
            id: "streets",
            url: "https://services.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer",
            layerType: "ArcGISTiledMapServiceLayer",
          },
        ],
      },
      operationalLayers: [
        {
          id: "roads",
          title: "Roads",
          url: "https://services.example.com/arcgis/rest/services/Roads/FeatureServer/0",
          layerType: "ArcGISFeatureLayer",
          layerDefinition: {
            drawingInfo: {
              renderer: {
                type: "simple",
                symbol: {
                  type: "esriSLS",
                  style: "esriSLSSolid",
                  color: [0, 0, 0, 255],
                  width: 1,
                },
              },
            },
          },
        },
      ],
    };

    const { style, manualGaps } = webmapJsonToMapLibreStyle(webmap);

    expect(style.version).toBe(8);
    expect(Object.keys(style.sources)).toContain("roads");
    expect(style.layers.length).toBeGreaterThan(0);
    expect(validateHonuaStyle(style)).toEqual([]);
    expect(manualGaps).toEqual([]);
  });

  it("records a gap for an unsupported renderer type", () => {
    const webmap: WebMapJson = {
      operationalLayers: [
        {
          id: "heat",
          title: "Crime Heatmap",
          url: "https://services.example.com/arcgis/rest/services/Crime/FeatureServer/0",
          layerType: "ArcGISFeatureLayer",
          layerDefinition: {
            drawingInfo: {
              renderer: {
                type: "heatmap",
                blurRadius: 10,
              } as never,
            },
          },
        },
      ],
    };

    const { style, manualGaps } = webmapJsonToMapLibreStyle(webmap);
    expect(validateHonuaStyle(style)).toEqual([]);

    const rendererGaps = manualGaps.filter((g) => g.kind === "unsupported-renderer");
    expect(rendererGaps).toHaveLength(1);
    expect(rendererGaps[0].layerId).toBe("heat");
    expect(rendererGaps[0].context).toMatchObject({ type: "heatmap" });
    expect(rendererGaps[0].path).toContain("operationalLayers[0]");
  });

  it("records a gap for Arcade expressions in popupInfo.expressionInfos", () => {
    const webmap: WebMapJson = {
      operationalLayers: [
        {
          id: "facilities",
          url: "https://services.example.com/arcgis/rest/services/Facilities/FeatureServer/0",
          layerType: "ArcGISFeatureLayer",
          layerDefinition: {
            drawingInfo: {
              renderer: {
                type: "simple",
                symbol: {
                  type: "esriSFS",
                  style: "esriSFSSolid",
                  color: [180, 180, 200, 255],
                },
              },
            },
          },
          popupInfo: {
            title: "{NAME}",
            description: "Status: {STATUS}",
            expressionInfos: [
              {
                name: "statusText",
                expression: "IIF($feature.STATUS == 1, 'Open', 'Closed')",
              },
            ],
          } as never,
        },
      ],
    };

    const { manualGaps } = webmapJsonToMapLibreStyle(webmap);

    const arcadeGaps = manualGaps.filter((g) => g.kind === "arcade-expression");
    expect(arcadeGaps.length).toBeGreaterThanOrEqual(1);
    expect(arcadeGaps[0].layerId).toBe("facilities");
    expect(arcadeGaps[0].context).toMatchObject({ count: 1 });
    expect(arcadeGaps[0].path).toContain("popupInfo");
  });

  it("records a gap for a SceneLayer reference (3D)", () => {
    const webmap: WebMapJson = {
      operationalLayers: [
        {
          id: "scene-buildings",
          title: "Buildings Scene",
          layerType: "ArcGISSceneServiceLayer",
          url: "https://services.example.com/arcgis/rest/services/Buildings/SceneServer/layers/0",
        },
      ],
    };

    const { manualGaps } = webmapJsonToMapLibreStyle(webmap);

    const sceneGaps = manualGaps.filter((g) => g.kind === "scene-3d");
    expect(sceneGaps.length).toBeGreaterThanOrEqual(1);
    expect(sceneGaps[0].layerId).toBe("scene-buildings");
    expect(sceneGaps[0].context).toMatchObject({ layerType: "ArcGISSceneServiceLayer" });
  });

  it("records a gap for top-level 3D ground / camera properties", () => {
    const webmap: WebMapJson = {
      ground: { surfaceColor: [255, 255, 255, 255] },
      camera: { position: { x: 0, y: 0, z: 1000 } },
      operationalLayers: [],
    } as WebMapJson;

    const { manualGaps } = webmapJsonToMapLibreStyle(webmap);

    const sceneGaps = manualGaps.filter((g) => g.kind === "scene-3d");
    expect(sceneGaps.length).toBeGreaterThanOrEqual(2);
    const props = sceneGaps.map((g) => (g.context as { property?: string } | undefined)?.property);
    expect(props).toContain("ground");
    expect(props).toContain("camera");
  });

  it("records a gap for Dashboard-style application shells", () => {
    const webmap = {
      type: "Dashboard",
      operationalLayers: [],
    } as unknown as WebMapJson;

    const { manualGaps } = webmapJsonToMapLibreStyle(webmap);
    expect(manualGaps.some((g) => g.kind === "dashboard-reference")).toBe(true);
  });

  it("records a gap for Experience Builder shells and custom widgets", () => {
    const webmap = {
      type: "Web Experience",
      experience: { pages: [] },
      widgets: [{ name: "my-custom-widget" }],
      applicationProperties: {
        viewing: {
          widgetsOnScreen: { widgets: [{ key: "third-party-1" }] },
        },
      },
      operationalLayers: [],
    } as unknown as WebMapJson;

    const { manualGaps } = webmapJsonToMapLibreStyle(webmap);
    const kinds = manualGaps.map((g) => g.kind);

    expect(kinds).toContain("experience-builder-reference");
    expect(kinds).toContain("custom-widget-reference");
    // Both the top-level `widgets` array and the
    // applicationProperties.viewing.widgetsOnScreen branch produce
    // custom-widget gaps, so we should see at least two.
    expect(kinds.filter((k) => k === "custom-widget-reference").length).toBeGreaterThanOrEqual(2);
  });

  it("does not record a gap for sprite-required / unknown-property warnings", () => {
    const webmap: WebMapJson = {
      operationalLayers: [
        {
          id: "pins",
          url: "https://services.example.com/arcgis/rest/services/Pins/FeatureServer/0",
          layerType: "ArcGISFeatureLayer",
          layerDefinition: {
            drawingInfo: {
              renderer: {
                type: "simple",
                symbol: {
                  type: "esriPMS",
                  url: "https://example.com/pin.png",
                  width: 24,
                  height: 24,
                } as never,
              },
            },
          },
        },
      ],
    };

    const { manualGaps } = webmapJsonToMapLibreStyle(webmap);
    expect(manualGaps).toEqual([]);
  });
});
