import { parseWebMap } from "@honua/sdk-js/webmap";

const webmap = {
  operationalLayers: [
    {
      id: "incidents",
      title: "Incidents",
      layerType: "ArcGISFeatureLayer",
      url: "https://example.test/rest/services/EvalIncidents/FeatureServer/0",
      layerDefinition: {
        drawingInfo: {
          renderer: {
            type: "simple",
            symbol: { type: "esriSMS", style: "esriSMSCircle", color: [226, 119, 40, 255], size: 8 },
          },
        },
      },
    },
  ],
  baseMap: { title: "Basemap", baseMapLayers: [] },
  version: "2.27",
};

const { style } = parseWebMap(webmap);
process.stdout.write(
  `${JSON.stringify({
    styleVersion: style.version,
    layerCount: style.layers.length,
    sourceCount: Object.keys(style.sources ?? {}).length,
  })}\n`,
);
