/**
 * Compatibility contract for WebMap JSON → HonuaStyleSpecification conversion.
 *
 * Documents every WebMap JSON property path and its support level,
 * enabling consumers to programmatically audit which features are
 * handled (or not) by the parser.
 *
 * @module
 */

export type ContractSupport = "full" | "partial" | "ignored" | "unsupported";

export interface ContractEntry {
  /** JSON path pattern (e.g. `"operationalLayers[].layerDefinition.drawingInfo.renderer"`). */
  path: string;
  /** Support level. */
  support: ContractSupport;
  /** Additional notes about limitations or behavior. */
  notes?: string;
}

export const CONTRACT: ContractEntry[] = [
  // ── Top-level ──
  { path: "version", support: "ignored", notes: "Informational only" },
  { path: "authoringApp", support: "ignored" },
  { path: "authoringAppVersion", support: "ignored" },
  { path: "spatialReference", support: "partial", notes: "Web Mercator (3857/102100) supported; others warn" },
  { path: "unknown top-level properties", support: "ignored", notes: "Ignored with warning" },

  // ── Initial viewpoint / extent ──
  {
    path: "initialViewpoint",
    support: "partial",
    notes: "targetGeometry point/extent supported; camera/3D unsupported",
  },
  { path: "initialViewpoint.targetGeometry", support: "partial", notes: "Point or extent in 3857/102100/4326" },
  { path: "initialViewpoint.scale", support: "full", notes: "Converted to approximate zoom" },
  { path: "initialExtent", support: "full", notes: "Converted to center/zoom for Web Mercator" },
  { path: "initialExtent.spatialReference", support: "partial", notes: "Web Mercator only" },

  // ── Bookmarks ──
  { path: "bookmarks", support: "full", notes: "Passed through as-is in result" },
  { path: "bookmarks[].name", support: "full" },
  { path: "bookmarks[].extent", support: "full" },

  // ── Basemap ──
  { path: "baseMap", support: "partial" },
  { path: "baseMap.title", support: "full" },
  { path: "baseMap.baseMapLayers[]", support: "partial" },
  { path: "baseMap.baseMapLayers[].url", support: "full" },
  {
    path: "baseMap.baseMapLayers[].layerType",
    support: "partial",
    notes: "ArcGISTiledMapServiceLayer supported; VectorTileLayer partial",
  },
  { path: "baseMap.baseMapLayers[].visibility", support: "full" },
  { path: "baseMap.baseMapLayers[].opacity", support: "full" },
  {
    path: "baseMap.baseMapLayers[].styleUrl",
    support: "partial",
    notes: "Noted in metadata; sprite/glyph resolution not performed",
  },

  // ── Operational layers ──
  { path: "operationalLayers[]", support: "partial" },
  { path: "operationalLayers[].id", support: "full" },
  { path: "operationalLayers[].title", support: "full", notes: "Used as layer metadata" },
  { path: "operationalLayers[].url", support: "full" },
  {
    path: "operationalLayers[].layerType",
    support: "partial",
    notes: "ArcGISFeatureLayer, ArcGISMapServiceLayer supported",
  },
  { path: "operationalLayers[].visibility", support: "full" },
  { path: "operationalLayers[].opacity", support: "full" },
  { path: "operationalLayers[].minScale", support: "full" },
  { path: "operationalLayers[].maxScale", support: "full" },

  // ── Layer definition ──
  { path: "operationalLayers[].layerDefinition", support: "partial" },
  { path: "operationalLayers[].layerDefinition.definitionExpression", support: "full" },
  { path: "operationalLayers[].layerDefinition.drawingInfo", support: "partial" },
  { path: "operationalLayers[].layerDefinition.drawingInfo.transparency", support: "full" },

  // ── Renderers ──
  { path: "operationalLayers[].layerDefinition.drawingInfo.renderer", support: "partial" },
  { path: "operationalLayers[].layerDefinition.drawingInfo.renderer (simple)", support: "full" },
  { path: "operationalLayers[].layerDefinition.drawingInfo.renderer (uniqueValue)", support: "full" },
  { path: "operationalLayers[].layerDefinition.drawingInfo.renderer (classBreaks)", support: "full" },
  {
    path: "operationalLayers[].layerDefinition.drawingInfo.renderer (heatmap)",
    support: "unsupported",
    notes: "Warning emitted",
  },
  {
    path: "operationalLayers[].layerDefinition.drawingInfo.renderer (dotDensity)",
    support: "unsupported",
    notes: "Warning emitted",
  },

  // ── Symbols ──
  { path: "symbol (esriSFS)", support: "full", notes: "Simple fill symbol → fill layer" },
  { path: "symbol (esriSLS)", support: "full", notes: "Simple line symbol → line layer" },
  { path: "symbol (esriSMS)", support: "full", notes: "Simple marker symbol → circle layer" },
  { path: "symbol (esriPMS)", support: "partial", notes: "Picture marker → symbol layer; requires sprite setup" },
  { path: "symbol (esriTS)", support: "partial", notes: "Text symbol → symbol layer with text" },

  // ── Labeling ──
  { path: "operationalLayers[].layerDefinition.drawingInfo.labelingInfo", support: "partial" },
  {
    path: "operationalLayers[].layerDefinition.drawingInfo.labelingInfo[].labelExpressionInfo.expression",
    support: "partial",
    notes: "Simple $feature.FIELD supported; complex Arcade skipped",
  },

  // ── Popups ──
  {
    path: "operationalLayers[].popupInfo",
    support: "full",
    notes: "Passed through as metadata (MapLibre has no popup spec)",
  },
  { path: "operationalLayers[].popupInfo.title", support: "full" },
  { path: "operationalLayers[].popupInfo.description", support: "full" },
  { path: "operationalLayers[].popupInfo.fieldInfos", support: "full" },
  { path: "operationalLayers[].popupInfo.mediaInfos", support: "full" },
  {
    path: "operationalLayers[].popupInfo.expressionInfos",
    support: "unsupported",
    notes: "Warning emitted; manual intervention",
  },

  // ── Feature collection (inline) ──
  {
    path: "operationalLayers[].featureCollection",
    support: "unsupported",
    notes: "Inline feature collections not yet supported",
  },

  // ── 3D ──
  {
    path: "ground / viewingMode / camera / elevationInfo",
    support: "unsupported",
    notes: "Warning emitted; manual intervention",
  },
];

export interface ContractSummary {
  total: number;
  full: number;
  partial: number;
  ignored: number;
  unsupported: number;
}

export function getContractSummary(): ContractSummary {
  const summary: ContractSummary = { total: 0, full: 0, partial: 0, ignored: 0, unsupported: 0 };
  for (const entry of CONTRACT) {
    summary.total++;
    summary[entry.support]++;
  }
  return summary;
}
