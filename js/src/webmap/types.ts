/**
 * TypeScript interfaces for Esri WebMap JSON documents.
 *
 * These types represent the input format accepted by `parseWebMap()`.
 * They cover the subset of the ArcGIS WebMap specification that is
 * relevant to converting into a `HonuaStyleSpecification`.
 *
 * Index signatures (`[key: string]: unknown`) provide forward-compatibility
 * so that unknown properties pass through without compile errors.
 *
 * @module
 */

// ── Top-level WebMap document ───────────────────────────────

export interface WebMapJson {
  version?: string;
  authoringApp?: string;
  authoringAppVersion?: string;
  operationalLayers?: WebMapOperationalLayer[];
  baseMap?: WebMapBaseMap;
  initialExtent?: WebMapExtent;
  initialViewpoint?: WebMapViewpoint;
  initialState?: WebMapInitialState;
  bookmarks?: WebMapBookmark[];
  spatialReference?: WebMapSpatialReference;
  tables?: unknown[];
  [key: string]: unknown;
}

// ── Operational layers ──────────────────────────────────────

export interface WebMapOperationalLayer {
  id?: string;
  title?: string;
  url?: string;
  layerType?: string;
  itemId?: string;
  visibility?: boolean;
  opacity?: number;
  minScale?: number;
  maxScale?: number;
  layerDefinition?: WebMapLayerDefinition;
  popupInfo?: WebMapPopupInfo;
  featureCollection?: WebMapFeatureCollection;
  [key: string]: unknown;
}

export interface WebMapLayerDefinition {
  drawingInfo?: WebMapDrawingInfo;
  definitionExpression?: string;
  minScale?: number;
  maxScale?: number;
  [key: string]: unknown;
}

export interface WebMapDrawingInfo {
  renderer?: WebMapRenderer;
  labelingInfo?: WebMapLabelClass[];
  transparency?: number;
  [key: string]: unknown;
}

// ── Renderers ───────────────────────────────────────────────

export type WebMapRenderer =
  | WebMapSimpleRenderer
  | WebMapUniqueValueRenderer
  | WebMapClassBreaksRenderer
  | WebMapGenericRenderer;

export interface WebMapSimpleRenderer {
  type: "simple";
  symbol?: WebMapSymbol;
  label?: string;
  description?: string;
  [key: string]: unknown;
}

export interface WebMapUniqueValueRenderer {
  type: "uniqueValue";
  field1?: string;
  field2?: string;
  field3?: string;
  fieldDelimiter?: string;
  defaultSymbol?: WebMapSymbol;
  defaultLabel?: string;
  uniqueValueInfos?: WebMapUniqueValueInfo[];
  [key: string]: unknown;
}

export interface WebMapUniqueValueInfo {
  value: string;
  symbol?: WebMapSymbol;
  label?: string;
  description?: string;
  [key: string]: unknown;
}

export interface WebMapClassBreaksRenderer {
  type: "classBreaks";
  field?: string;
  classificationMethod?: string;
  defaultSymbol?: WebMapSymbol;
  defaultLabel?: string;
  minValue?: number;
  classBreakInfos?: WebMapClassBreakInfo[];
  [key: string]: unknown;
}

export interface WebMapClassBreakInfo {
  classMinValue?: number;
  classMaxValue: number;
  symbol?: WebMapSymbol;
  label?: string;
  description?: string;
  [key: string]: unknown;
}

export interface WebMapGenericRenderer {
  type: string;
  [key: string]: unknown;
}

// ── Symbols ─────────────────────────────────────────────────

export type WebMapSymbol =
  | WebMapSimpleFillSymbol
  | WebMapSimpleLineSymbol
  | WebMapSimpleMarkerSymbol
  | WebMapPictureMarkerSymbol
  | WebMapTextSymbol
  | WebMapGenericSymbol;

export interface WebMapSimpleFillSymbol {
  type: "esriSFS";
  style?: string;
  color?: EsriColor;
  outline?: WebMapSimpleLineSymbol;
  [key: string]: unknown;
}

export interface WebMapSimpleLineSymbol {
  type: "esriSLS";
  style?: string;
  color?: EsriColor;
  width?: number;
  [key: string]: unknown;
}

export interface WebMapSimpleMarkerSymbol {
  type: "esriSMS";
  style?: string;
  color?: EsriColor;
  size?: number;
  outline?: WebMapSimpleLineSymbol;
  [key: string]: unknown;
}

export interface WebMapPictureMarkerSymbol {
  type: "esriPMS";
  url?: string;
  imageData?: string;
  contentType?: string;
  width?: number;
  height?: number;
  [key: string]: unknown;
}

export interface WebMapTextSymbol {
  type: "esriTS";
  color?: EsriColor;
  font?: WebMapFont;
  text?: string;
  [key: string]: unknown;
}

export interface WebMapGenericSymbol {
  type: string;
  [key: string]: unknown;
}

export interface WebMapFont {
  family?: string;
  size?: number;
  style?: string;
  weight?: string;
  [key: string]: unknown;
}

/** Esri RGBA color as `[r, g, b, a]` where a is 0–255. */
export type EsriColor = [number, number, number, number];

// ── Popups ──────────────────────────────────────────────────

export interface WebMapPopupInfo {
  title?: string;
  description?: string;
  fieldInfos?: WebMapFieldInfo[];
  mediaInfos?: WebMapMediaInfo[];
  showAttachments?: boolean;
  [key: string]: unknown;
}

export interface WebMapFieldInfo {
  fieldName?: string;
  label?: string;
  tooltip?: string;
  visible?: boolean;
  isEditable?: boolean;
  format?: WebMapFieldFormat;
  [key: string]: unknown;
}

export interface WebMapFieldFormat {
  places?: number;
  digitSeparator?: boolean;
  dateFormat?: string;
  [key: string]: unknown;
}

export interface WebMapMediaInfo {
  type?: string;
  title?: string;
  caption?: string;
  value?: Record<string, unknown>;
  [key: string]: unknown;
}

// ── Labels ──────────────────────────────────────────────────

export interface WebMapLabelClass {
  labelExpression?: string;
  labelExpressionInfo?: WebMapLabelExpressionInfo;
  useCodedValues?: boolean;
  symbol?: WebMapTextSymbol;
  minScale?: number;
  maxScale?: number;
  where?: string;
  [key: string]: unknown;
}

export interface WebMapLabelExpressionInfo {
  expression?: string;
  value?: string;
  [key: string]: unknown;
}

// ── Basemap ─────────────────────────────────────────────────

export interface WebMapBaseMap {
  title?: string;
  baseMapLayers?: WebMapBaseMapLayer[];
  [key: string]: unknown;
}

export interface WebMapBaseMapLayer {
  id?: string;
  title?: string;
  url?: string;
  layerType?: string;
  visibility?: boolean;
  opacity?: number;
  styleUrl?: string;
  [key: string]: unknown;
}

// ── Extent & spatial reference ──────────────────────────────

export interface WebMapExtent {
  xmin: number;
  ymin: number;
  xmax: number;
  ymax: number;
  spatialReference?: WebMapSpatialReference;
  [key: string]: unknown;
}

export interface WebMapPoint {
  x: number;
  y: number;
  spatialReference?: WebMapSpatialReference;
  [key: string]: unknown;
}

export type WebMapViewpointTargetGeometry = WebMapExtent | WebMapPoint;

export interface WebMapViewpoint {
  targetGeometry?: WebMapViewpointTargetGeometry;
  scale?: number;
  rotation?: number;
  [key: string]: unknown;
}

export interface WebMapInitialState {
  viewpoint?: WebMapViewpoint;
  [key: string]: unknown;
}

export interface WebMapSpatialReference {
  wkid?: number;
  latestWkid?: number;
  [key: string]: unknown;
}

// ── Bookmarks ───────────────────────────────────────────────

export interface WebMapBookmark {
  name?: string;
  extent?: WebMapExtent;
  [key: string]: unknown;
}

// ── Feature collection (inline GeoJSON-like data) ───────────

export interface WebMapFeatureCollection {
  layers?: WebMapFeatureCollectionLayer[];
  [key: string]: unknown;
}

export interface WebMapFeatureCollectionLayer {
  layerDefinition?: WebMapLayerDefinition;
  featureSet?: WebMapFeatureSet;
  [key: string]: unknown;
}

export interface WebMapFeatureSet {
  geometryType?: string;
  features?: Record<string, unknown>[];
  [key: string]: unknown;
}
