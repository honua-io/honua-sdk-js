import type { FeatureId, SourceId } from "../contract/types.js";
import type { FilterClause } from "../exploration/index.js";
import type { SceneCameraState, SceneLayerState, SceneWorkspaceState } from "./types.js";

export type SceneRendererKind = "maplibre" | "cesium" | "three" | "custom";
export type ScenePrimitiveStatus = "supported" | "degraded" | "unsupported";
export type ScenePrimitiveDiagnosticSeverity = "info" | "warning" | "error";

export interface SceneCacheMetadata {
  readonly status: "ready" | "stale" | "bypass" | "unknown";
  readonly scope?: "metadata" | "tiles" | "asset" | "interaction";
  readonly updatedAt?: string;
  readonly ttlMs?: number;
  readonly validator?: string;
}

export interface ScenePrimitiveBase {
  readonly id: string;
  readonly title?: string;
  readonly attribution?: string;
  readonly cache?: SceneCacheMetadata;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface SceneCameraPrimitive extends ScenePrimitiveBase {
  readonly kind: "camera";
  readonly camera: SceneCameraState;
  readonly mode?: "local" | "global" | "orbit";
}

export interface SceneGroundPrimitive extends ScenePrimitiveBase {
  readonly kind: "ground";
  readonly terrainId?: string;
  readonly surfaceColor?: string;
  readonly opacity?: number;
}

export type SceneElevationSourceProtocol =
  | "terrain-rgb"
  | "raster-dem"
  | "quantized-mesh"
  | "image-service"
  | "i3s"
  | "custom";

export interface SceneElevationSourcePrimitive extends ScenePrimitiveBase {
  readonly kind: "elevation-source";
  readonly sourceId: SourceId;
  readonly protocol: SceneElevationSourceProtocol;
  readonly tiles?: readonly string[];
  readonly url?: string;
  readonly encoding?: "mapbox" | "terrarium" | "custom";
  readonly tileSize?: number;
  readonly minzoom?: number;
  readonly maxzoom?: number;
  readonly exaggeration?: number;
}

export type SceneImagerySourceProtocol = "url-template" | "wms" | "wmts" | "single-tile" | "arcgis-imagery";

/**
 * A credential-free imagery binding for a scene renderer.
 *
 * Service-specific configuration stays explicit rather than hiding a failed
 * provider behind a generic URL: WMS requires `layer`; WMTS additionally
 * requires `style` and `tileMatrixSetId`. Authorization remains the host's
 * responsibility and must not be serialized into this primitive.
 */
export interface SceneImageryLayerPrimitive extends ScenePrimitiveBase {
  readonly kind: "imagery-layer";
  readonly sourceId: SourceId;
  readonly protocol: SceneImagerySourceProtocol;
  readonly url: string;
  readonly layer?: string;
  readonly style?: string;
  readonly format?: string;
  readonly tileMatrixSetId?: string;
  readonly parameters?: Readonly<Record<string, string | number | boolean>>;
  readonly subdomains?: readonly string[];
  readonly minimumLevel?: number;
  readonly maximumLevel?: number;
  readonly opacity?: number;
}

export type SceneExtrusionValue = number | readonly unknown[];

export interface SceneExtrusionPrimitive extends ScenePrimitiveBase {
  readonly kind: "extrusion";
  readonly sourceId: SourceId;
  readonly layerId?: string;
  readonly sourceLayer?: string;
  readonly height: SceneExtrusionValue;
  readonly base?: SceneExtrusionValue;
  readonly color?: string | readonly unknown[];
  readonly opacity?: number | readonly unknown[];
  readonly filters?: Readonly<Record<string, FilterClause>>;
}

export type SceneModelFormat = "gltf" | "glb" | "3d-tiles" | "i3s" | "obj" | "custom";

export interface SceneModelLayerPrimitive extends ScenePrimitiveBase {
  readonly kind: "model-layer";
  readonly sourceId?: SourceId;
  readonly uri: string;
  readonly format: SceneModelFormat;
  readonly position?: readonly [number, number, number?];
  readonly rotation?: readonly [number, number, number];
  readonly scale?: number | readonly [number, number, number];
  readonly featureId?: FeatureId;
}

export interface SceneLayerMetadataPrimitive extends ScenePrimitiveBase {
  readonly kind: "scene-layer-metadata";
  readonly layer: SceneLayerState;
  readonly serviceType?: "SceneServer" | "3DTiles" | "Model" | "Custom";
  readonly geometryType?: "mesh" | "point" | "point-cloud" | "building" | "integrated-mesh" | "custom";
  readonly sourceAsset?: string;
  readonly capabilities?: readonly string[];
}

export type SceneRuntimePrimitive =
  | SceneCameraPrimitive
  | SceneGroundPrimitive
  | SceneElevationSourcePrimitive
  | SceneImageryLayerPrimitive
  | SceneExtrusionPrimitive
  | SceneModelLayerPrimitive
  | SceneLayerMetadataPrimitive;

export type SceneRuntimePrimitiveKind = SceneRuntimePrimitive["kind"];

export interface ScenePrimitiveDiagnostic {
  readonly code: string;
  readonly severity: ScenePrimitiveDiagnosticSeverity;
  readonly status: ScenePrimitiveStatus;
  readonly primitiveId?: string;
  readonly primitiveKind?: SceneRuntimePrimitiveKind;
  readonly renderer?: SceneRendererKind | string;
  readonly message: string;
  readonly fallback?: string;
  readonly context?: Readonly<Record<string, unknown>>;
}

export interface SceneRuntimeCapabilities {
  readonly renderer: SceneRendererKind | string;
  readonly camera?: boolean;
  readonly ground?: boolean;
  readonly terrain?: {
    readonly protocols: readonly SceneElevationSourceProtocol[];
    readonly supportsExaggeration?: boolean;
  };
  readonly imagery?: {
    readonly protocols: readonly SceneImagerySourceProtocol[];
  };
  readonly extrusion?: boolean;
  readonly modelLayer?: {
    readonly formats: readonly SceneModelFormat[];
  };
  readonly sceneLayerMetadata?: boolean;
}

export interface ScenePrimitiveApplyResult {
  readonly status: ScenePrimitiveStatus;
  readonly diagnostics: readonly ScenePrimitiveDiagnostic[];
}

export interface SceneRuntimeAdapter {
  readonly id: string;
  readonly capabilities: SceneRuntimeCapabilities;
  diagnose(
    primitives: readonly SceneRuntimePrimitive[],
    state?: SceneWorkspaceState,
  ): readonly ScenePrimitiveDiagnostic[];
  apply?(
    primitives: readonly SceneRuntimePrimitive[],
    state?: SceneWorkspaceState,
  ): ScenePrimitiveApplyResult | Promise<ScenePrimitiveApplyResult>;
}

export interface MapLibreTerrainSourceSpecification {
  readonly type: "raster-dem";
  readonly tiles?: readonly string[];
  readonly url?: string;
  readonly tileSize?: number;
  readonly encoding?: "mapbox" | "terrarium" | "custom";
  readonly minzoom?: number;
  readonly maxzoom?: number;
  readonly attribution?: string;
}

export interface MapLibreTerrainOptions {
  readonly source: string;
  readonly exaggeration?: number;
}

export interface MapLibreExtrusionLayerSpecification {
  readonly id: string;
  readonly type: "fill-extrusion";
  readonly source: string;
  readonly "source-layer"?: string;
  readonly paint: Readonly<Record<string, unknown>>;
  readonly layout?: Readonly<Record<string, unknown>>;
  readonly filter?: unknown;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface MapLibreSceneRuntimeTarget {
  getSource(id: string): unknown;
  addSource(id: string, source: MapLibreTerrainSourceSpecification): void;
  getLayer(id: string): unknown;
  addLayer(layer: MapLibreExtrusionLayerSpecification): void;
  setTerrain(options: MapLibreTerrainOptions): void;
}

export interface MapLibreTerrainPatch {
  readonly sourceId: string;
  readonly source: MapLibreTerrainSourceSpecification;
  readonly terrain: MapLibreTerrainOptions;
}

export const MAPLIBRE_SCENE_CAPABILITIES: SceneRuntimeCapabilities = {
  renderer: "maplibre",
  camera: true,
  ground: true,
  terrain: { protocols: ["terrain-rgb", "raster-dem"], supportsExaggeration: true },
  extrusion: true,
  modelLayer: { formats: [] },
  sceneLayerMetadata: true,
};

export function createSceneRuntimeAdapter(options: {
  readonly id: string;
  readonly capabilities: SceneRuntimeCapabilities;
  readonly apply?: SceneRuntimeAdapter["apply"];
}): SceneRuntimeAdapter {
  return {
    id: options.id,
    capabilities: options.capabilities,
    diagnose(primitives) {
      return diagnoseScenePrimitives(primitives, options.capabilities);
    },
    ...(options.apply ? { apply: options.apply } : {}),
  };
}

export function createMapLibreSceneAdapter(id = "maplibre-scene"): SceneRuntimeAdapter {
  return createSceneRuntimeAdapter({
    id,
    capabilities: MAPLIBRE_SCENE_CAPABILITIES,
  });
}

export function diagnoseScenePrimitives(
  primitives: readonly SceneRuntimePrimitive[],
  capabilities: SceneRuntimeCapabilities,
): ScenePrimitiveDiagnostic[] {
  return primitives.flatMap((primitive) => diagnoseScenePrimitive(primitive, capabilities));
}

export function diagnoseScenePrimitive(
  primitive: SceneRuntimePrimitive,
  capabilities: SceneRuntimeCapabilities,
): ScenePrimitiveDiagnostic[] {
  switch (primitive.kind) {
    case "camera":
      return capabilities.camera
        ? [supported(primitive, capabilities, "Camera state can be synchronized.")]
        : [
            unsupported(
              primitive,
              capabilities,
              "Renderer adapter does not expose camera synchronization.",
              "Keep camera state in the workspace snapshot only.",
            ),
          ];
    case "ground":
      return capabilities.ground
        ? [supported(primitive, capabilities, "Ground styling can be represented.")]
        : [
            degraded(
              primitive,
              capabilities,
              "Renderer adapter does not expose explicit ground styling.",
              "Use the base map background or renderer default ground.",
            ),
          ];
    case "elevation-source": {
      const terrain = capabilities.terrain;
      if (!terrain)
        return [
          unsupported(
            primitive,
            capabilities,
            "Renderer adapter does not support terrain sources.",
            "Render without terrain and keep elevation metadata for a 3D adapter.",
          ),
        ];
      if (!terrain.protocols.includes(primitive.protocol)) {
        return [
          unsupported(
            primitive,
            capabilities,
            `Terrain protocol '${primitive.protocol}' is not supported by ${capabilities.renderer}.`,
            "Use terrain-rgb/raster-dem for MapLibre 2.5D or route to a Cesium-style adapter.",
          ),
        ];
      }
      if (primitive.exaggeration !== undefined && terrain.supportsExaggeration !== true) {
        return [
          degraded(
            primitive,
            capabilities,
            "Elevation source is supported but exaggeration will be ignored.",
            "Apply source at native scale.",
          ),
        ];
      }
      if (primitive.protocol === "terrain-rgb") {
        const terrainDiagnostics = diagnoseRenderableTerrainRgb(primitive, capabilities);
        if (terrainDiagnostics.length > 0) return terrainDiagnostics;
      }
      return [supported(primitive, capabilities, "Elevation source can be applied as terrain.")];
    }
    case "imagery-layer": {
      const imagery = capabilities.imagery;
      if (!imagery) {
        return [
          unsupported(
            primitive,
            capabilities,
            "Renderer adapter does not support imagery layers.",
            "Keep the imagery binding in workspace diagnostics or route it to an imagery-capable renderer.",
          ),
        ];
      }
      if (!imagery.protocols.includes(primitive.protocol)) {
        return [
          unsupported(
            primitive,
            capabilities,
            `Imagery protocol '${primitive.protocol}' is not supported by ${capabilities.renderer}.`,
            "Use a supported imagery protocol or keep the source binding for another renderer.",
          ),
        ];
      }
      const imageryDiagnostics = diagnoseRenderableImagery(primitive, capabilities);
      return imageryDiagnostics.length > 0
        ? imageryDiagnostics
        : [supported(primitive, capabilities, "Imagery layer can be materialized by the renderer.")];
    }
    case "extrusion":
      return capabilities.extrusion
        ? [supported(primitive, capabilities, "Extrusion can be applied as a fill-extrusion layer.")]
        : [
            degraded(
              primitive,
              capabilities,
              "Renderer adapter does not support extrusions.",
              "Render the source as a 2D fill/line layer.",
            ),
          ];
    case "model-layer": {
      const formats = capabilities.modelLayer?.formats ?? [];
      if (formats.includes(primitive.format))
        return [supported(primitive, capabilities, "Model layer format is supported.")];
      return [
        unsupported(
          primitive,
          capabilities,
          `Model format '${primitive.format}' is not supported by ${capabilities.renderer}.`,
          "Preserve model metadata and route to a 3D renderer adapter.",
        ),
      ];
    }
    case "scene-layer-metadata":
      return capabilities.sceneLayerMetadata
        ? [
            degraded(
              primitive,
              capabilities,
              "Scene-layer metadata can be preserved but not rendered directly.",
              "Bind a compatible terrain/model/tiles primitive when available.",
            ),
          ]
        : [
            unsupported(
              primitive,
              capabilities,
              "Renderer adapter does not expose scene-layer metadata.",
              "Keep source metadata in diagnostics for manual migration.",
            ),
          ];
  }
}

export function toMapLibreTerrainPatch(primitive: SceneElevationSourcePrimitive): MapLibreTerrainPatch {
  if (primitive.protocol !== "terrain-rgb" && primitive.protocol !== "raster-dem") {
    throw new Error(`MapLibre terrain requires terrain-rgb or raster-dem elevation, received '${primitive.protocol}'.`);
  }
  return {
    sourceId: primitive.sourceId,
    source: {
      type: "raster-dem",
      ...(primitive.tiles ? { tiles: primitive.tiles } : {}),
      ...(primitive.url ? { url: primitive.url } : {}),
      ...(primitive.tileSize ? { tileSize: primitive.tileSize } : {}),
      ...(primitive.encoding ? { encoding: primitive.encoding } : {}),
      ...(primitive.minzoom !== undefined ? { minzoom: primitive.minzoom } : {}),
      ...(primitive.maxzoom !== undefined ? { maxzoom: primitive.maxzoom } : {}),
      ...(primitive.attribution ? { attribution: primitive.attribution } : {}),
    },
    terrain: {
      source: primitive.sourceId,
      ...(primitive.exaggeration !== undefined ? { exaggeration: primitive.exaggeration } : {}),
    },
  };
}

export function toMapLibreExtrusionLayer(primitive: SceneExtrusionPrimitive): MapLibreExtrusionLayerSpecification {
  return {
    id: primitive.layerId ?? primitive.id,
    type: "fill-extrusion",
    source: primitive.sourceId,
    ...(primitive.sourceLayer ? { "source-layer": primitive.sourceLayer } : {}),
    paint: {
      "fill-extrusion-height": primitive.height,
      "fill-extrusion-base": primitive.base ?? 0,
      "fill-extrusion-color": primitive.color ?? "#4d8a87",
      "fill-extrusion-opacity": primitive.opacity ?? 0.82,
    },
    layout: {},
    ...(primitive.filters ? { filter: compileMapLibreFilters(primitive.filters, primitive.sourceId) } : {}),
    ...(primitive.metadata ? { metadata: primitive.metadata } : {}),
  };
}

export function applyMapLibreScenePrimitives(
  target: MapLibreSceneRuntimeTarget,
  primitives: readonly SceneRuntimePrimitive[],
): ScenePrimitiveApplyResult {
  const diagnostics = diagnoseScenePrimitives(primitives, MAPLIBRE_SCENE_CAPABILITIES);
  for (const primitive of primitives) {
    if (primitive.kind === "elevation-source") {
      const terrainDiagnostic = diagnostics.find((diagnostic) => diagnostic.primitiveId === primitive.id);
      if (terrainDiagnostic?.status === "unsupported") continue;
      const patch = toMapLibreTerrainPatch(primitive);
      if (!target.getSource(patch.sourceId)) target.addSource(patch.sourceId, patch.source);
      target.setTerrain(patch.terrain);
    }
    if (primitive.kind === "extrusion") {
      const layer = toMapLibreExtrusionLayer(primitive);
      if (!target.getLayer(layer.id)) target.addLayer(layer);
    }
  }
  return {
    status: summarizeDiagnosticStatus(diagnostics),
    diagnostics,
  };
}

export function summarizeDiagnosticStatus(diagnostics: readonly ScenePrimitiveDiagnostic[]): ScenePrimitiveStatus {
  if (diagnostics.some((diagnostic) => diagnostic.status === "unsupported")) return "unsupported";
  if (diagnostics.some((diagnostic) => diagnostic.status === "degraded")) return "degraded";
  return "supported";
}

function supported(
  primitive: SceneRuntimePrimitive,
  capabilities: SceneRuntimeCapabilities,
  message: string,
): ScenePrimitiveDiagnostic {
  return diagnostic("scene-primitive-supported", "info", "supported", primitive, capabilities, message);
}

function degraded(
  primitive: SceneRuntimePrimitive,
  capabilities: SceneRuntimeCapabilities,
  message: string,
  fallback: string,
): ScenePrimitiveDiagnostic {
  return diagnostic("scene-primitive-degraded", "warning", "degraded", primitive, capabilities, message, fallback);
}

function unsupported(
  primitive: SceneRuntimePrimitive,
  capabilities: SceneRuntimeCapabilities,
  message: string,
  fallback: string,
): ScenePrimitiveDiagnostic {
  return diagnostic(
    "scene-primitive-unsupported",
    "warning",
    "unsupported",
    primitive,
    capabilities,
    message,
    fallback,
  );
}

function diagnostic(
  code: string,
  severity: ScenePrimitiveDiagnosticSeverity,
  status: ScenePrimitiveStatus,
  primitive: SceneRuntimePrimitive,
  capabilities: SceneRuntimeCapabilities,
  message: string,
  fallback?: string,
): ScenePrimitiveDiagnostic {
  return {
    code,
    severity,
    status,
    primitiveId: primitive.id,
    primitiveKind: primitive.kind,
    renderer: capabilities.renderer,
    message,
    ...(fallback ? { fallback } : {}),
  };
}

function diagnoseRenderableTerrainRgb(
  primitive: SceneElevationSourcePrimitive,
  capabilities: SceneRuntimeCapabilities,
): ScenePrimitiveDiagnostic[] {
  const diagnostics: ScenePrimitiveDiagnostic[] = [];
  if (!hasRenderableTerrainUrl(primitive)) {
    diagnostics.push(
      diagnostic(
        "scene-primitive-terrain-source-missing-url",
        "error",
        "unsupported",
        primitive,
        capabilities,
        "terrain-rgb elevation source requires a renderable url or tile template.",
        "Provide a non-empty url or at least one non-empty tiles entry before applying terrain.",
      ),
    );
  }

  const invalidRanges: Record<string, unknown> = {};
  if (primitive.tileSize !== undefined && !isPositiveFiniteNumber(primitive.tileSize)) {
    invalidRanges.tileSize = primitive.tileSize;
  }
  if (primitive.minzoom !== undefined && !isZoom(primitive.minzoom)) invalidRanges.minzoom = primitive.minzoom;
  if (primitive.maxzoom !== undefined && !isZoom(primitive.maxzoom)) invalidRanges.maxzoom = primitive.maxzoom;
  if (
    primitive.minzoom !== undefined &&
    primitive.maxzoom !== undefined &&
    Number.isFinite(primitive.minzoom) &&
    Number.isFinite(primitive.maxzoom) &&
    primitive.minzoom > primitive.maxzoom
  ) {
    invalidRanges.zoomRange = [primitive.minzoom, primitive.maxzoom];
  }
  if (primitive.exaggeration !== undefined && !isPositiveFiniteNumber(primitive.exaggeration)) {
    invalidRanges.exaggeration = primitive.exaggeration;
  }

  if (Object.keys(invalidRanges).length > 0) {
    diagnostics.push({
      ...diagnostic(
        "scene-primitive-terrain-range-invalid",
        "error",
        "unsupported",
        primitive,
        capabilities,
        "terrain-rgb elevation source has invalid numeric rendering ranges.",
        "Use finite positive tileSize/exaggeration values and ordered zoom values between 0 and 24.",
      ),
      context: invalidRanges,
    });
  }
  return diagnostics;
}

function diagnoseRenderableImagery(
  primitive: SceneImageryLayerPrimitive,
  capabilities: SceneRuntimeCapabilities,
): ScenePrimitiveDiagnostic[] {
  const diagnostics: ScenePrimitiveDiagnostic[] = [];
  if (!isNonEmptyString(primitive.url)) {
    diagnostics.push(
      diagnostic(
        "scene-primitive-imagery-source-missing-url",
        "error",
        "unsupported",
        primitive,
        capabilities,
        "Imagery layer requires a non-empty provider URL.",
        "Provide the credential-free provider endpoint before applying imagery.",
      ),
    );
  }

  const missingServiceFields: string[] = [];
  if ((primitive.protocol === "wms" || primitive.protocol === "wmts") && !isNonEmptyString(primitive.layer)) {
    missingServiceFields.push("layer");
  }
  if (primitive.protocol === "wmts") {
    if (!isNonEmptyString(primitive.style)) missingServiceFields.push("style");
    if (!isNonEmptyString(primitive.tileMatrixSetId)) missingServiceFields.push("tileMatrixSetId");
  }
  if (missingServiceFields.length > 0) {
    diagnostics.push({
      ...diagnostic(
        "scene-primitive-imagery-service-config-missing",
        "error",
        "unsupported",
        primitive,
        capabilities,
        `Imagery protocol '${primitive.protocol}' is missing required service configuration.`,
        "Provide every protocol-required layer, style, and tile-matrix identifier.",
      ),
      context: { missingFields: missingServiceFields },
    });
  }

  const invalidServiceFields: string[] = [];
  if (
    (primitive.protocol === "wms" || primitive.protocol === "wmts") &&
    primitive.format !== undefined &&
    !isNonEmptyString(primitive.format)
  ) {
    invalidServiceFields.push("format");
  }
  if (invalidServiceFields.length > 0) {
    diagnostics.push({
      ...diagnostic(
        "scene-primitive-imagery-service-config-invalid",
        "error",
        "unsupported",
        primitive,
        capabilities,
        `Imagery protocol '${primitive.protocol}' has invalid service configuration.`,
        "Omit optional service fields or provide values in their documented form.",
      ),
      context: { invalidFields: invalidServiceFields },
    });
  }

  if (
    primitive.opacity !== undefined &&
    (!Number.isFinite(primitive.opacity) || primitive.opacity < 0 || primitive.opacity > 1)
  ) {
    diagnostics.push({
      ...diagnostic(
        "scene-primitive-imagery-opacity-invalid",
        "error",
        "unsupported",
        primitive,
        capabilities,
        "Imagery opacity must be a finite number between 0 and 1.",
        "Use an opacity in the inclusive [0, 1] range.",
      ),
      context: { opacity: primitive.opacity },
    });
  }

  const invalidLevels: Record<string, unknown> = {};
  if (primitive.minimumLevel !== undefined && !isNonNegativeInteger(primitive.minimumLevel)) {
    invalidLevels.minimumLevel = primitive.minimumLevel;
  }
  if (primitive.maximumLevel !== undefined && !isNonNegativeInteger(primitive.maximumLevel)) {
    invalidLevels.maximumLevel = primitive.maximumLevel;
  }
  if (
    primitive.minimumLevel !== undefined &&
    primitive.maximumLevel !== undefined &&
    Number.isFinite(primitive.minimumLevel) &&
    Number.isFinite(primitive.maximumLevel) &&
    primitive.minimumLevel > primitive.maximumLevel
  ) {
    invalidLevels.levelRange = [primitive.minimumLevel, primitive.maximumLevel];
  }
  if (Object.keys(invalidLevels).length > 0) {
    diagnostics.push({
      ...diagnostic(
        "scene-primitive-imagery-level-range-invalid",
        "error",
        "unsupported",
        primitive,
        capabilities,
        "Imagery level bounds must be ordered non-negative integers.",
        "Use non-negative integer levels with minimumLevel less than or equal to maximumLevel.",
      ),
      context: invalidLevels,
    });
  }
  if (
    primitive.subdomains !== undefined &&
    (!Array.isArray(primitive.subdomains) ||
      primitive.subdomains.length === 0 ||
      primitive.subdomains.some((subdomain) => !isNonEmptyString(subdomain)))
  ) {
    diagnostics.push(
      diagnostic(
        "scene-primitive-imagery-subdomains-invalid",
        "error",
        "unsupported",
        primitive,
        capabilities,
        "Imagery subdomains must be a non-empty list of non-empty strings when provided.",
        "Omit subdomains to use the provider default or provide at least one valid subdomain.",
      ),
    );
  }
  return diagnostics;
}

function hasRenderableTerrainUrl(primitive: SceneElevationSourcePrimitive): boolean {
  if (typeof primitive.url === "string" && primitive.url.trim() !== "") return true;
  return primitive.tiles?.some((tile) => typeof tile === "string" && tile.trim() !== "") === true;
}

function isPositiveFiniteNumber(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

function isZoom(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= 24;
}

function isNonNegativeInteger(value: number): boolean {
  return Number.isInteger(value) && value >= 0;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function compileMapLibreFilters(filters: Readonly<Record<string, FilterClause>>, sourceId: string): unknown[] {
  const compiled = Object.values(filters)
    .filter((clause) => !clause.appliesTo || clause.appliesTo.length === 0 || clause.appliesTo.includes(sourceId))
    .map(clauseToMapLibreFilter)
    .filter((entry): entry is unknown[] => Array.isArray(entry));
  return compiled.length === 0 ? ["all"] : ["all", ...compiled];
}

function clauseToMapLibreFilter(clause: FilterClause): unknown[] | undefined {
  switch (clause.operator) {
    case "=":
      return ["==", clause.field, clause.value];
    case "!=":
      return ["!=", clause.field, clause.value];
    case "<":
    case "<=":
    case ">":
    case ">=":
      return typeof clause.value === "number" ? [clause.operator, clause.field, clause.value] : undefined;
    case "in":
      return Array.isArray(clause.value) ? ["in", clause.field, ...clause.value] : undefined;
    case "not-in":
      return Array.isArray(clause.value) ? ["!in", clause.field, ...clause.value] : undefined;
    case "is-null":
      return ["==", clause.field, null];
    case "is-not-null":
      return ["!=", clause.field, null];
    case "between":
      return Array.isArray(clause.value) && typeof clause.value[0] === "number" && typeof clause.value[1] === "number"
        ? ["all", [">=", clause.field, clause.value[0]], ["<=", clause.field, clause.value[1]]]
        : undefined;
    case "like":
      return undefined;
  }
}
