/**
 * `@honua/sdk-js/webmap` — WebMap JSON parse + symbol / renderer / popup converters.
 *
 * @example
 * ```ts
 * import { parseWebMap } from "@honua/sdk-js/webmap";
 *
 * const webmapJson = await (await fetch("/path/to/webmap.json")).json();
 * const { layers, warnings } = parseWebMap(webmapJson);
 * if (warnings.length > 0) console.warn("WebMap conversion warnings:", warnings);
 * ```
 *
 * @example Inspect the compatibility contract
 * ```ts
 * import { CONTRACT, getContractSummary } from "@honua/sdk-js/webmap";
 *
 * const summary = getContractSummary();
 * console.log(summary.supported);   // ["FeatureLayer", "MapImageLayer", ...]
 * console.log(summary.unsupported); // entries with `support: "unsupported"` + reason
 * ```
 *
 * @packageDocumentation
 */
export { parseWebMap } from "./parse.js";
export type { ParseWebMapOptions, ParseWebMapResult } from "./parse.js";
export { createWarningCollector } from "./warnings.js";
export type { WebMapWarning, WarningCollector } from "./warnings.js";
export { CONTRACT, getContractSummary } from "./contract.js";
export type { ContractEntry, ContractSupport, ContractSummary } from "./contract.js";
export { convertSymbol, esriColorToCss, esriLineStyleToDashArray } from "./convert-symbol.js";
export type { SymbolConversionResult } from "./convert-symbol.js";
export {
  classBreaksRendererFromWebMap,
  convertRenderer,
  uniqueValueRendererFromWebMap,
} from "./convert-renderer.js";
export type { RendererConversionResult } from "./convert-renderer.js";
export { convertPopupInfo } from "./convert-popup.js";
export type { HonuaPopupConfig, HonuaPopupFieldInfo, HonuaPopupMediaInfo } from "./convert-popup.js";
export { convertLabelingInfo } from "./convert-label.js";
export { convertBasemap } from "./convert-basemap.js";
export type { BasemapConversionResult } from "./convert-basemap.js";
export { convertExtent, convertInitialViewpoint } from "./convert-extent.js";
export type { ExtentConversionResult } from "./convert-extent.js";
export { convertOperationalLayer } from "./convert-layer.js";
export type { LayerConversionResult } from "./convert-layer.js";
export type {
  WebMapJson,
  WebMapOperationalLayer,
  WebMapRenderer,
  WebMapSimpleRenderer,
  WebMapUniqueValueRenderer,
  WebMapClassBreaksRenderer,
  WebMapSymbol,
  WebMapSimpleFillSymbol,
  WebMapSimpleLineSymbol,
  WebMapSimpleMarkerSymbol,
  WebMapPictureMarkerSymbol,
  WebMapTextSymbol,
  WebMapBaseMap,
  WebMapBaseMapLayer,
  WebMapPopupInfo,
  WebMapFieldInfo,
  WebMapExtent,
  WebMapPoint,
  WebMapViewpoint,
  WebMapViewpointTargetGeometry,
  WebMapInitialState,
  WebMapBookmark,
  WebMapSpatialReference,
  WebMapLabelClass,
  WebMapDrawingInfo,
  WebMapLayerDefinition,
  EsriColor,
} from "./types.js";
