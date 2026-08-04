import { isCredentialQueryName } from "../connect-url-safety.js";
import type { FeatureId, SourceId } from "../contract/types.js";
import type { FilterClause } from "../exploration/index.js";
import type { SceneStateSyncFidelity } from "./state-sync.js";
import type { SceneCameraState, SceneLayerState, SceneWorkspaceState } from "./types.js";

export type SceneRendererKind = "maplibre" | "cesium" | "three" | "custom";
export type ScenePrimitiveStatus = "supported" | "degraded" | "unsupported";
export type ScenePrimitiveDiagnosticSeverity = "info" | "warning" | "error";

/**
 * Spatial fidelity of a primitive against a renderer, using the same vocabulary
 * the scene state synchronizer already applies to slice mappings: `exact` when
 * the renderer honors the declaration as authored, `equivalent` when it honors
 * it through its own documented reprojection/resampling, and `unsupported` when
 * it cannot honor it at all.
 */
export type SceneSpatialFidelity = SceneStateSyncFidelity;

/**
 * Declared spatial reference for a scene binding.
 *
 * Both fields are descriptive plan data: the SDK performs no reprojection and
 * no vertical-datum transform. They exist so the adapter can say, before a
 * viewer is created, whether the renderer will place the binding's footprints
 * and heights where the author meant them. Identifiers are accepted in the
 * common spellings (`EPSG:3857`, `3857`, `urn:ogc:def:crs:EPSG::3857`,
 * `http://www.opengis.net/def/crs/EPSG/0/3857`, `OGC:CRS84`) and normalized
 * before classification.
 */
export interface SceneSpatialReference {
  /** Horizontal CRS the binding's coordinates are authored in. */
  readonly crs?: string;
  /**
   * Vertical datum the binding's heights are referenced to. Accepts the same
   * `ellipsoidal-wgs84` token the Cesium entity path uses, alongside EPSG
   * identifiers such as `EPSG:4979` (ellipsoidal) or `EPSG:5703` (NAVD88).
   */
  readonly verticalDatum?: string;
}

/**
 * The horizontal CRS and vertical datums a renderer adapter can honor.
 *
 * Omit the record entirely to keep the pre-#929 behavior: without a declared
 * renderer capability there is nothing to classify against, so declared
 * primitive metadata is reported as unclassified rather than guessed at.
 */
export interface SceneSpatialCapabilities {
  /** CRS identifiers the renderer addresses natively, with no resampling. */
  readonly exactHorizontalCrs?: readonly string[];
  /** CRS identifiers the renderer honors through its own reprojection/tiling. */
  readonly equivalentHorizontalCrs?: readonly string[];
  /** Vertical datums the renderer can interpret as scene heights. */
  readonly verticalDatums?: readonly string[];
}

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

export interface SceneElevationSourcePrimitive extends ScenePrimitiveBase, SceneSpatialReference {
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

const SCENE_ASSET_URL_BASE = "https://scene.honua.invalid/";
const WMS_RESERVED_PARAMETER_KEYS = new Set(["bbox", "crs", "height", "request", "service", "srs", "width"]);
const ARCGIS_IMAGE_SERVER_RESERVED_PARAMETER_KEYS = new Set([
  "bbox",
  "bboxsr",
  "f",
  "format",
  "imagesr",
  "size",
  "transparent",
]);
const WMTS_RESERVED_DIMENSION_KEYS = new Set([
  "format",
  "layer",
  "request",
  "service",
  "style",
  "tilecol",
  "tilematrix",
  "tilematrixset",
  "tilematrixsetid",
  "tilerow",
  "version",
]);
/**
 * A credential-free imagery binding for a scene renderer.
 *
 * Service-specific configuration stays explicit rather than hiding a failed
 * provider behind a generic URL: WMS requires `layer`; WMTS additionally
 * requires `style` and `tileMatrixSetId`. Authorization remains the host's
 * responsibility and must not be serialized into this primitive.
 */
export interface SceneImageryLayerPrimitive extends ScenePrimitiveBase, SceneSpatialReference {
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

/**
 * Bounded point-cloud rendering controls for a tiled point-cloud asset.
 *
 * Point clouds ride the same `3d-tiles` model-layer path as any other tileset,
 * but they need splat sizing and eye-dome lighting to be legible. These fields
 * are the renderer-neutral subset every 3D engine can honor; each is validated
 * before the renderer peer is loaded, so an out-of-range value fails closed
 * rather than silently reverting to a renderer default.
 */
const POINT_CLOUD_SHADING_BOOLEAN_KEYS = ["attenuation", "eyeDomeLighting"] as const;
const POINT_CLOUD_SHADING_MAGNITUDE_KEYS = [
  "maximumAttenuation",
  "geometricErrorScale",
  "eyeDomeLightingStrength",
  "eyeDomeLightingRadius",
] as const;
const POINT_CLOUD_SHADING_KEYS: ReadonlySet<string> = new Set<string>([
  ...POINT_CLOUD_SHADING_BOOLEAN_KEYS,
  ...POINT_CLOUD_SHADING_MAGNITUDE_KEYS,
]);

export interface ScenePointCloudShading {
  /** Scale point size with geometric error / eye distance. */
  readonly attenuation?: boolean;
  /** Upper bound on attenuated point size, in pixels. Must be finite and > 0. */
  readonly maximumAttenuation?: number;
  /** Multiplier applied to the tile geometric error when sizing points. Must be finite and > 0. */
  readonly geometricErrorScale?: number;
  /** Apply eye-dome lighting to emphasize point-cloud depth. */
  readonly eyeDomeLighting?: boolean;
  /** Eye-dome lighting contrast. Must be finite and > 0. */
  readonly eyeDomeLightingStrength?: number;
  /** Eye-dome lighting sampling radius, in pixels. Must be finite and > 0. */
  readonly eyeDomeLightingRadius?: number;
}

export interface SceneModelLayerPrimitive extends ScenePrimitiveBase, SceneSpatialReference {
  readonly kind: "model-layer";
  readonly sourceId?: SourceId;
  readonly uri: string;
  readonly format: SceneModelFormat;
  readonly position?: readonly [number, number, number?];
  readonly rotation?: readonly [number, number, number];
  readonly scale?: number | readonly [number, number, number];
  readonly featureId?: FeatureId;
  /** Point-cloud rendering controls. Only meaningful for tiled (`3d-tiles`) assets. */
  readonly pointCloudShading?: ScenePointCloudShading;
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
  /**
   * Spatial fidelity this finding reports. Present on spatial-reference
   * diagnostics; omitted where fidelity is not the subject of the finding.
   */
  readonly fidelity?: SceneSpatialFidelity;
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
    /** Formats the underlying renderer engine can consume. */
    readonly formats: readonly SceneModelFormat[];
    /**
     * The subset of {@link formats} this adapter actually materializes on a live
     * scene. Omit when the adapter renders everything it declares. When present,
     * a declared-but-unmaterialized format diagnoses as
     * `scene-primitive-model-format-not-materialized` instead of reporting
     * `supported` and then silently rendering nothing.
     */
    readonly materializedFormats?: readonly SceneModelFormat[];
  };
  readonly sceneLayerMetadata?: boolean;
  /** Horizontal CRS and vertical datums this renderer can honor. */
  readonly spatial?: SceneSpatialCapabilities;
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

/**
 * Both shipped adapters address the world in geographic WGS84 and consume the
 * Web Mercator family through their own tiling/reprojection, so they share one
 * spatial capability record. Nothing else is honorable here: this slice
 * performs no reprojection, so a projected or local CRS would render in the
 * wrong place, and a non-ellipsoidal datum would render at the wrong height.
 */
export const RENDERER_WGS84_SPATIAL_CAPABILITIES: SceneSpatialCapabilities = {
  exactHorizontalCrs: ["EPSG:4326", "OGC:CRS84"],
  equivalentHorizontalCrs: ["EPSG:3857"],
  verticalDatums: ["EPSG:4979"],
};

export const MAPLIBRE_SCENE_CAPABILITIES: SceneRuntimeCapabilities = {
  renderer: "maplibre",
  camera: true,
  ground: true,
  terrain: { protocols: ["terrain-rgb", "raster-dem"], supportsExaggeration: true },
  extrusion: true,
  modelLayer: { formats: [] },
  sceneLayerMetadata: true,
  spatial: RENDERER_WGS84_SPATIAL_CAPABILITIES,
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

/**
 * Diagnose one primitive against a renderer capability record.
 *
 * Two independent questions are answered: whether the renderer can *materialize*
 * the binding at all (structure), and whether it can place it where the author
 * meant (spatial reference). Both are pure — nothing here loads a renderer peer,
 * so a migration analysis can run before a viewer exists.
 *
 * A spatial finding replaces the generic `scene-primitive-supported` summary,
 * mirroring how a renderability finding already does: the caller should read the
 * fidelity, not a bare "supported". A primitive that declares no CRS or vertical
 * datum diagnoses exactly as it did before this contract existed.
 */
export function diagnoseScenePrimitive(
  primitive: SceneRuntimePrimitive,
  capabilities: SceneRuntimeCapabilities,
): ScenePrimitiveDiagnostic[] {
  const spatial = diagnoseSceneSpatialReference(primitive, capabilities);
  const structural = diagnoseScenePrimitiveStructure(primitive, capabilities);
  if (spatial.length === 0) return structural;
  return [...spatial, ...structural.filter((entry) => entry.code !== "scene-primitive-supported")];
}

function diagnoseScenePrimitiveStructure(
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
      const terrainDiagnostics = diagnoseRenderableTerrain(primitive, capabilities);
      if (terrainDiagnostics.length > 0) return terrainDiagnostics;
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
      const modelLayer = capabilities.modelLayer;
      const formats = modelLayer?.formats ?? [];
      if (!formats.includes(primitive.format)) {
        return [
          unsupported(
            primitive,
            capabilities,
            `Model format '${primitive.format}' is not supported by ${capabilities.renderer}.`,
            "Preserve model metadata and route to a 3D renderer adapter.",
          ),
        ];
      }
      const modelDiagnostics = diagnoseRenderableModelLayer(primitive, capabilities);
      const materializedFormats = modelLayer?.materializedFormats;
      if (materializedFormats !== undefined && !materializedFormats.includes(primitive.format)) {
        modelDiagnostics.push({
          ...diagnostic(
            "scene-primitive-model-format-not-materialized",
            "error",
            "unsupported",
            primitive,
            capabilities,
            `Model format '${primitive.format}' is consumable by ${capabilities.renderer} but this adapter does not materialize it.`,
            "Publish the asset as a 3D-Tiles or glTF/GLB model layer, or keep the binding for an adapter that renders it.",
          ),
          context: { format: primitive.format, materializedFormats: [...materializedFormats] },
        });
      }
      return modelDiagnostics.length > 0
        ? modelDiagnostics
        : [supported(primitive, capabilities, "Model layer format is supported.")];
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
      // A primitive can carry several findings (spatial reference *and*
      // renderability). Any one of them being fail-closed must skip the apply,
      // so this asks whether *any* is unsupported rather than reading whichever
      // diagnostic happens to come first.
      const blocked = diagnostics.some(
        (diagnostic) => diagnostic.primitiveId === primitive.id && diagnostic.status === "unsupported",
      );
      if (blocked) continue;
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

/**
 * Endpoint and range validation for an elevation source, applied to every
 * terrain protocol rather than `terrain-rgb` alone.
 *
 * `quantized-mesh`, `raster-dem`, `image-service`, `i3s`, and `custom` all reach
 * a renderer through the same door — `CesiumTerrainProvider.fromUrl(url)` or a
 * MapLibre `raster-dem` source — and every one of them fails opaquely on an
 * absent or malformed endpoint. Failing closed here keeps that failure legible
 * and keeps it off the live scene.
 */
function diagnoseRenderableTerrain(
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
        `${primitive.protocol} elevation source requires a renderable url or tile template.`,
        "Provide a non-empty url or at least one non-empty tiles entry before applying terrain.",
      ),
    );
  }

  const invalidEndpointFields = invalidTerrainEndpointFields(primitive);
  if (invalidEndpointFields.length > 0) {
    diagnostics.push({
      ...diagnostic(
        "scene-primitive-terrain-source-url-invalid",
        "error",
        "unsupported",
        primitive,
        capabilities,
        `${primitive.protocol} elevation source endpoint is invalid.`,
        "Use a relative, HTTP, or HTTPS endpoint for the url and every tiles entry.",
      ),
      context: { invalidFields: invalidEndpointFields },
    });
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
        `${primitive.protocol} elevation source has invalid numeric rendering ranges.`,
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
  let urlProblem: SceneAssetUrlProblem;
  if (!isNonEmptyString(primitive.url)) {
    diagnostics.push(
      diagnostic(
        "scene-primitive-imagery-source-missing-url",
        "error",
        "unsupported",
        primitive,
        capabilities,
        "Imagery requires a provider URL.",
        "Provide a credential-free URL.",
      ),
    );
  } else {
    urlProblem = sceneAssetUrlProblem(primitive.url);
    if (urlProblem === "invalid") {
      diagnostics.push(
        diagnostic(
          "scene-primitive-imagery-source-url-invalid",
          "error",
          "unsupported",
          primitive,
          capabilities,
          "Imagery provider URL is invalid.",
          "Use a relative, HTTP, or HTTPS URL.",
        ),
      );
    }
  }

  if (urlProblem === "credentials" || hasCredentialParameter(primitive.parameters)) {
    diagnostics.push(
      diagnostic(
        "scene-primitive-imagery-credentials-forbidden",
        "error",
        "unsupported",
        primitive,
        capabilities,
        "Imagery bindings cannot contain credentials or signed URLs.",
        "Resolve authorization at the host boundary.",
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
  if (
    (primitive.protocol === "single-tile" || primitive.protocol === "arcgis-imagery") &&
    typeof primitive.url === "string" &&
    primitive.url.includes("{s}") &&
    primitive.subdomains === undefined
  ) {
    missingServiceFields.push("subdomains");
  }
  if (missingServiceFields.length > 0) {
    diagnostics.push({
      ...diagnostic(
        "scene-primitive-imagery-service-config-missing",
        "error",
        "unsupported",
        primitive,
        capabilities,
        `Imagery configuration for '${primitive.protocol}' is incomplete.`,
        "Provide required service fields.",
      ),
      context: { missingFields: missingServiceFields },
    });
  }

  const invalidServiceFields: string[] = [];
  const isWebMapService = primitive.protocol === "wms" || primitive.protocol === "wmts";
  const arcGisEndpoint =
    primitive.protocol === "arcgis-imagery" && typeof primitive.url === "string"
      ? arcGisImageryEndpoint(primitive.url)
      : undefined;
  if (primitive.protocol === "arcgis-imagery" && isNonEmptyString(primitive.url) && !arcGisEndpoint) {
    invalidServiceFields.push("url");
  }
  if (primitive.layer !== undefined && !isWebMapService) invalidServiceFields.push("layer");
  if (
    primitive.style !== undefined &&
    (!isWebMapService || (primitive.protocol === "wms" && !isNonEmptyString(primitive.style)))
  ) {
    invalidServiceFields.push("style");
  }
  if (primitive.format !== undefined) {
    if (!isWebMapService || !isNonEmptyString(primitive.format)) invalidServiceFields.push("format");
  }
  if (primitive.tileMatrixSetId !== undefined && primitive.protocol !== "wmts") {
    invalidServiceFields.push("tileMatrixSetId");
  }
  if (primitive.parameters !== undefined && !isValidImageryParameters(primitive.parameters)) {
    invalidServiceFields.push("parameters");
  }
  if ((primitive.protocol === "single-tile" || arcGisEndpoint === "map") && primitive.minimumLevel !== undefined) {
    invalidServiceFields.push("minimumLevel");
  }
  if (primitive.protocol === "single-tile" && primitive.maximumLevel !== undefined) {
    invalidServiceFields.push("maximumLevel");
  }
  const invalidParameterKeys = invalidImageryParameterKeys(primitive);
  if (invalidParameterKeys.length > 0 && !invalidServiceFields.includes("parameters")) {
    invalidServiceFields.push("parameters");
  }
  if (invalidServiceFields.length > 0) {
    diagnostics.push({
      ...diagnostic(
        "scene-primitive-imagery-service-config-invalid",
        "error",
        "unsupported",
        primitive,
        capabilities,
        `Imagery configuration for '${primitive.protocol}' is invalid.`,
        "Omit unsupported fields.",
      ),
      context: {
        invalidFields: invalidServiceFields,
        ...(invalidParameterKeys.length > 0 ? { invalidParameterKeys } : {}),
      },
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
        "Imagery opacity must be finite and between 0 and 1.",
        "Use opacity in [0, 1].",
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
        "Use integer levels with minimumLevel <= maximumLevel.",
      ),
      context: invalidLevels,
    });
  }
  if (
    primitive.subdomains !== undefined &&
    (!isValidImagerySubdomains(primitive.subdomains) ||
      typeof primitive.url !== "string" ||
      !primitive.url.includes("{s}"))
  ) {
    diagnostics.push(
      diagnostic(
        "scene-primitive-imagery-subdomains-invalid",
        "error",
        "unsupported",
        primitive,
        capabilities,
        "Subdomains require DNS labels and a {s} URL.",
        "Omit subdomains or add {s}.",
      ),
    );
  }
  return diagnostics;
}

/**
 * Renderability checks for a model layer, mirroring the imagery contract: the
 * asset URI must be a credential-free relative/HTTP/HTTPS URL, the placement
 * must be expressible as a real position on the globe, and point-cloud shading
 * must be in range. Every failure is fail-closed (`unsupported`), so nothing is
 * handed to a renderer factory that would either throw opaquely or, worse,
 * produce a silently wrong model matrix.
 */
function diagnoseRenderableModelLayer(
  primitive: SceneModelLayerPrimitive,
  capabilities: SceneRuntimeCapabilities,
): ScenePrimitiveDiagnostic[] {
  const diagnostics: ScenePrimitiveDiagnostic[] = [];
  if (!isNonEmptyString(primitive.uri)) {
    diagnostics.push(
      diagnostic(
        "scene-primitive-model-source-missing-uri",
        "error",
        "unsupported",
        primitive,
        capabilities,
        "Model layer requires an asset URI.",
        "Provide a credential-free URI.",
      ),
    );
  } else {
    const uriProblem = sceneAssetUrlProblem(primitive.uri);
    if (uriProblem === "invalid") {
      diagnostics.push(
        diagnostic(
          "scene-primitive-model-source-uri-invalid",
          "error",
          "unsupported",
          primitive,
          capabilities,
          "Model layer asset URI is invalid.",
          "Use a relative, HTTP, or HTTPS URI.",
        ),
      );
    } else if (uriProblem === "credentials") {
      diagnostics.push(
        diagnostic(
          "scene-primitive-model-credentials-forbidden",
          "error",
          "unsupported",
          primitive,
          capabilities,
          "Model bindings cannot contain credentials or signed URIs.",
          "Resolve authorization at the host boundary.",
        ),
      );
    }
  }

  const invalidPlacementFields = invalidModelPlacementFields(primitive);
  if (invalidPlacementFields.length > 0) {
    diagnostics.push({
      ...diagnostic(
        "scene-primitive-model-placement-invalid",
        "error",
        "unsupported",
        primitive,
        capabilities,
        "Model placement must use finite longitude/latitude/height, rotation, and positive scale values.",
        "Correct the placement or omit it to place the asset at its authored origin.",
      ),
      context: { invalidFields: invalidPlacementFields },
    });
  }

  const invalidShadingFields = invalidPointCloudShadingFields(primitive);
  if (invalidShadingFields.length > 0) {
    diagnostics.push({
      ...diagnostic(
        "scene-primitive-model-point-cloud-shading-invalid",
        "error",
        "unsupported",
        primitive,
        capabilities,
        "Point-cloud shading requires boolean toggles and finite positive magnitudes on a tiled asset.",
        "Correct the shading values or omit pointCloudShading.",
      ),
      context: { invalidFields: invalidShadingFields },
    });
  }
  return diagnostics;
}

function invalidModelPlacementFields(primitive: SceneModelLayerPrimitive): string[] {
  const invalidFields: string[] = [];
  const { position, rotation, scale } = primitive;
  if (position !== undefined) {
    if (!Array.isArray(position) || position.length < 2 || position.length > 3) invalidFields.push("position");
    else {
      const [longitude, latitude, height] = position;
      const validLongitude = Number.isFinite(longitude) && longitude >= -180 && longitude <= 180;
      const validLatitude = Number.isFinite(latitude) && latitude >= -90 && latitude <= 90;
      const validHeight = height === undefined || Number.isFinite(height);
      if (!validLongitude || !validLatitude || !validHeight) invalidFields.push("position");
    }
  }
  if (rotation !== undefined) {
    if (!Array.isArray(rotation) || rotation.length !== 3 || !rotation.every((angle) => Number.isFinite(angle))) {
      invalidFields.push("rotation");
    }
  }
  if (scale !== undefined) {
    const validScale = Array.isArray(scale)
      ? scale.length === 3 && scale.every((axis) => typeof axis === "number" && isPositiveFiniteNumber(axis))
      : typeof scale === "number" && isPositiveFiniteNumber(scale);
    if (!validScale) invalidFields.push("scale");
  }
  return invalidFields;
}

/**
 * Point-cloud shading is validated as a closed record: an unknown or misspelled
 * own key (`maximumAttenutation`) is itself a failure, because
 * `normalizePointCloudShading` would otherwise drop it and the layer would
 * render with Cesium's defaults while still reporting `supported`. The `typeof`
 * guards are load-bearing at runtime even though the declared type narrows
 * them — deserialized plan JSON is not type-checked.
 */
function invalidPointCloudShadingFields(primitive: SceneModelLayerPrimitive): string[] {
  const shading = primitive.pointCloudShading;
  if (shading === undefined) return [];
  // Only a tiled asset has points to shade, and only a plain data record can be
  // checked key-by-key.
  if (primitive.format !== "3d-tiles" || !isPlainRecord(shading)) return ["pointCloudShading"];
  const invalidFields: string[] = [];
  for (const key of Object.keys(shading)) {
    if (!POINT_CLOUD_SHADING_KEYS.has(key)) invalidFields.push(key);
  }
  for (const field of POINT_CLOUD_SHADING_BOOLEAN_KEYS) {
    const value = shading[field];
    if (value !== undefined && typeof value !== "boolean") invalidFields.push(field);
  }
  for (const field of POINT_CLOUD_SHADING_MAGNITUDE_KEYS) {
    const value = shading[field];
    if (value !== undefined && (typeof value !== "number" || !isPositiveFiniteNumber(value))) invalidFields.push(field);
  }
  return invalidFields;
}

function hasRenderableTerrainUrl(primitive: SceneElevationSourcePrimitive): boolean {
  if (typeof primitive.url === "string" && primitive.url.trim() !== "") return true;
  return primitive.tiles?.some((tile) => typeof tile === "string" && tile.trim() !== "") === true;
}

/**
 * Name the declared terrain endpoints that cannot be resolved. A blank or absent
 * value is the *missing*-endpoint case and is reported separately, so only
 * present, non-blank material is judged here.
 */
function invalidTerrainEndpointFields(primitive: SceneElevationSourcePrimitive): string[] {
  const invalidFields: string[] = [];
  if (isNonEmptyString(primitive.url) && sceneAssetUrlProblem(primitive.url) === "invalid") invalidFields.push("url");
  if (primitive.tiles !== undefined) {
    if (!Array.isArray(primitive.tiles)) invalidFields.push("tiles");
    else {
      primitive.tiles.forEach((tile, index) => {
        if (isNonEmptyString(tile) && sceneAssetUrlProblem(tile) === "invalid") invalidFields.push(`tiles[${index}]`);
      });
    }
  }
  return invalidFields;
}

/**
 * Classify a primitive's declared spatial reference against the renderer.
 *
 * Pure and peer-free (NFR-001), and silent for a primitive that declares
 * nothing or a renderer that declares no spatial capability (NFR-002) — there is
 * no honest classification to make in either case, and inventing one would turn
 * an unannotated plan into a wall of warnings.
 */
function diagnoseSceneSpatialReference(
  primitive: SceneRuntimePrimitive,
  capabilities: SceneRuntimeCapabilities,
): ScenePrimitiveDiagnostic[] {
  if (!primitiveDeclaresSpatialReference(primitive)) return [];
  const { crs, verticalDatum } = primitive;
  if (crs === undefined && verticalDatum === undefined) return [];
  const spatial = capabilities.spatial;
  if (!spatial) return [];

  const diagnostics: ScenePrimitiveDiagnostic[] = [];
  if (crs !== undefined) {
    const exact = spatial.exactHorizontalCrs ?? [];
    const equivalent = spatial.equivalentHorizontalCrs ?? [];
    const normalized = normalizeSceneCrs(crs);
    const context = { crs, ...(normalized !== undefined ? { normalizedCrs: normalized } : {}) };
    if (normalized !== undefined && containsNormalizedCrs(exact, normalized)) {
      diagnostics.push({
        ...diagnostic(
          "scene-primitive-crs-exact",
          "info",
          "supported",
          primitive,
          capabilities,
          `Horizontal CRS '${crs}' is addressed natively by ${capabilities.renderer}.`,
        ),
        fidelity: "exact",
        context,
      });
    } else if (normalized !== undefined && containsNormalizedCrs(equivalent, normalized)) {
      diagnostics.push({
        ...diagnostic(
          "scene-primitive-crs-equivalent",
          "warning",
          "degraded",
          primitive,
          capabilities,
          `Horizontal CRS '${crs}' is honored by ${capabilities.renderer} through its own reprojection, not as authored.`,
          "Accept the renderer's resampling, or republish the binding in WGS84 to keep exact fidelity.",
        ),
        fidelity: "equivalent",
        context: { ...context, exactHorizontalCrs: [...exact] },
      });
    } else {
      diagnostics.push({
        ...diagnostic(
          "scene-primitive-crs-unsupported",
          "error",
          "unsupported",
          primitive,
          capabilities,
          `Horizontal CRS '${crs}' cannot be honored by ${capabilities.renderer}; coordinates are never reinterpreted.`,
          "Republish the binding in a supported CRS, or reproject it before it reaches the scene.",
        ),
        fidelity: "unsupported",
        context: { ...context, exactHorizontalCrs: [...exact], equivalentHorizontalCrs: [...equivalent] },
      });
    }
  }

  if (verticalDatum !== undefined) {
    const supportedDatums = spatial.verticalDatums ?? [];
    const normalized = normalizeSceneCrs(verticalDatum);
    if (normalized === undefined || !containsNormalizedCrs(supportedDatums, normalized)) {
      diagnostics.push({
        ...diagnostic(
          "scene-primitive-vertical-datum-unsupported",
          "error",
          "unsupported",
          primitive,
          capabilities,
          `Vertical datum '${verticalDatum}' cannot be honored by ${capabilities.renderer}; heights are never transformed.`,
          "Republish heights against an ellipsoidal WGS84 datum, or drop the height component.",
        ),
        fidelity: "unsupported",
        context: {
          verticalDatum,
          ...(normalized !== undefined ? { normalizedVerticalDatum: normalized } : {}),
          supportedVerticalDatums: [...supportedDatums],
        },
      });
    }
  }
  return diagnostics;
}

function primitiveDeclaresSpatialReference(
  primitive: SceneRuntimePrimitive,
): primitive is SceneElevationSourcePrimitive | SceneImageryLayerPrimitive | SceneModelLayerPrimitive {
  return (
    primitive.kind === "elevation-source" || primitive.kind === "imagery-layer" || primitive.kind === "model-layer"
  );
}

function containsNormalizedCrs(candidates: readonly string[], normalized: string): boolean {
  return candidates.some((candidate) => normalizeSceneCrs(candidate) === normalized);
}

/**
 * Aliases that cannot be derived from an authority/code pair. Keys are compared
 * lowercase against the trimmed identifier.
 */
const SCENE_CRS_ALIASES: ReadonlyMap<string, string> = new Map([
  ["crs84", "OGC:CRS84"],
  ["ogc:crs84", "OGC:CRS84"],
  ["wgs84", "EPSG:4326"],
  ["wgs 84", "EPSG:4326"],
  ["wgs-84", "EPSG:4326"],
  ["ellipsoidal-wgs84", "EPSG:4979"],
  ["wgs84-ellipsoidal", "EPSG:4979"],
  ["web mercator", "EPSG:3857"],
  ["web-mercator", "EPSG:3857"],
  ["esri:102100", "EPSG:3857"],
  ["esri:102113", "EPSG:3857"],
  ["epsg:102100", "EPSG:3857"],
  ["epsg:102113", "EPSG:3857"],
  ["epsg:900913", "EPSG:3857"],
  ["epsg:3785", "EPSG:3857"],
]);

const SCENE_CRS_AUTHORITIES: ReadonlySet<string> = new Set(["epsg", "esri", "ogc"]);

/**
 * Normalize a CRS or vertical-datum identifier to a canonical `AUTHORITY:CODE`
 * token, or `undefined` when it cannot be identified at all.
 *
 * Splitting is done with a single linear scan rather than a pattern so an
 * attacker-supplied plan value cannot drive backtracking.
 */
function normalizeSceneCrs(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed === "") return undefined;
  const lower = trimmed.toLowerCase();
  const alias = SCENE_CRS_ALIASES.get(lower);
  if (alias) return alias;

  const segments = splitSceneCrsSegments(lower);
  const code = segments[segments.length - 1];
  if (code === undefined) return undefined;
  if (code === "crs84") return "OGC:CRS84";
  if (!isDigitString(code)) return undefined;

  let authority: string | undefined;
  for (let index = segments.length - 2; index >= 0; index -= 1) {
    const segment = segments[index];
    if (segment !== undefined && SCENE_CRS_AUTHORITIES.has(segment)) {
      authority = segment;
      break;
    }
  }
  // A bare numeric identifier is an EPSG code by convention; an OGC authority
  // does not mint numeric CRS codes, so that pairing stays unidentified.
  if (authority === undefined) return segments.length === 1 ? resolveSceneCrsToken("epsg", code) : undefined;
  if (authority === "ogc") return undefined;
  return resolveSceneCrsToken(authority, code);
}

function resolveSceneCrsToken(authority: string, code: string): string {
  const canonical = `${authority.toUpperCase()}:${stripLeadingZeros(code)}`;
  return SCENE_CRS_ALIASES.get(canonical.toLowerCase()) ?? canonical;
}

function splitSceneCrsSegments(value: string): string[] {
  const segments: string[] = [];
  let current = "";
  for (const character of value) {
    if (character !== ":" && character !== "/") {
      current += character;
      continue;
    }
    if (current !== "") segments.push(current);
    current = "";
  }
  if (current !== "") segments.push(current);
  return segments;
}

function isDigitString(value: string): boolean {
  if (value === "") return false;
  for (const character of value) {
    if (character < "0" || character > "9") return false;
  }
  return true;
}

function stripLeadingZeros(value: string): string {
  let index = 0;
  while (index < value.length - 1 && value[index] === "0") index += 1;
  return value.slice(index);
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

type SceneAssetUrlProblem = "invalid" | "credentials" | undefined;

function sceneAssetUrlProblem(value: string): SceneAssetUrlProblem {
  let parsed: URL;
  try {
    parsed = new URL(value, SCENE_ASSET_URL_BASE);
  } catch {
    return "invalid";
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "invalid";
  if (parsed.username !== "" || parsed.password !== "") return "credentials";
  for (const key of parsed.searchParams.keys()) {
    if (isCredentialQueryName(key)) return "credentials";
  }
  if (parsed.hash !== "") {
    const fragmentParameters = new URLSearchParams(parsed.hash.slice(1).replaceAll("?", "&"));
    for (const key of fragmentParameters.keys()) {
      if (isCredentialQueryName(key)) return "credentials";
    }
  }
  return undefined;
}

function hasCredentialParameter(parameters: SceneImageryLayerPrimitive["parameters"]): boolean {
  if (!isValidImageryParameters(parameters)) return false;
  return Object.keys(parameters).some(isCredentialQueryName);
}

/**
 * A plain, inspectable data record: object literal (or null-prototype), not an
 * array, no symbol keys, and no accessors. Anything else cannot be validated
 * key-by-key without invoking foreign code, so it fails closed.
 */
function isPlainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return false;
    if (Object.getOwnPropertySymbols(value).length > 0) return false;
    return Object.values(Object.getOwnPropertyDescriptors(value)).every((descriptor) => "value" in descriptor);
  } catch {
    return false;
  }
}

function isValidImageryParameters(value: unknown): value is Readonly<Record<string, string | number | boolean>> {
  if (!isPlainRecord(value)) return false;
  return Object.values(value).every(
    (entry) =>
      typeof entry === "string" || typeof entry === "boolean" || (typeof entry === "number" && Number.isFinite(entry)),
  );
}

function isValidImagerySubdomains(value: unknown): value is readonly string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 32) return false;
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index) || !isSafeDnsLabel(value[index])) return false;
  }
  return true;
}

function invalidImageryParameterKeys(primitive: SceneImageryLayerPrimitive): string[] {
  if (
    primitive.protocol === "wms" &&
    primitive.parameters !== undefined &&
    isValidImageryParameters(primitive.parameters)
  ) {
    return invalidCaseInsensitiveParameterKeys(primitive.parameters, WMS_RESERVED_PARAMETER_KEYS);
  }
  if (
    primitive.protocol === "wmts" &&
    primitive.parameters !== undefined &&
    isValidImageryParameters(primitive.parameters)
  ) {
    return invalidCaseInsensitiveParameterKeys(primitive.parameters, WMTS_RESERVED_DIMENSION_KEYS);
  }
  if (
    primitive.protocol !== "arcgis-imagery" ||
    typeof primitive.url !== "string" ||
    primitive.parameters === undefined ||
    !isValidImageryParameters(primitive.parameters)
  ) {
    return [];
  }
  if (arcGisImageryEndpoint(primitive.url) === "image") {
    return invalidCaseInsensitiveParameterKeys(primitive.parameters, ARCGIS_IMAGE_SERVER_RESERVED_PARAMETER_KEYS);
  }
  const invalidKeys: string[] = [];
  const seenKeys = new Set<string>();
  for (const [key, value] of Object.entries(primitive.parameters)) {
    const canonical = canonicalParameterKey(key);
    if (seenKeys.has(canonical)) {
      invalidKeys.push(key);
      continue;
    }
    seenKeys.add(canonical);
    const valid =
      (canonical === "layers" && normalizeArcGisMapServerLayers(value) !== undefined) ||
      ((canonical === "enablepickfeatures" || canonical === "useprecachedtilesifavailable") &&
        typeof value === "boolean") ||
      ((canonical === "tilewidth" || canonical === "tileheight") &&
        typeof value === "number" &&
        Number.isInteger(value) &&
        value > 0 &&
        value <= 8192);
    if (!valid) invalidKeys.push(key);
  }
  return invalidKeys;
}

function invalidCaseInsensitiveParameterKeys(
  parameters: Readonly<Record<string, string | number | boolean>>,
  reservedKeys: ReadonlySet<string>,
): string[] {
  const invalidKeys: string[] = [];
  const seenKeys = new Set<string>();
  for (const key of Object.keys(parameters)) {
    const caseInsensitiveKey = key.toLowerCase();
    if (seenKeys.has(caseInsensitiveKey) || reservedKeys.has(canonicalParameterKey(key))) invalidKeys.push(key);
    seenKeys.add(caseInsensitiveKey);
  }
  return invalidKeys;
}

function normalizeArcGisMapServerLayers(value: unknown): string | undefined {
  if (!isNonEmptyString(value)) return undefined;
  const trimmed = value.trim();
  const layerList = trimmed.toLowerCase().startsWith("show:") ? trimmed.slice(5) : trimmed;
  const layerIds = layerList.split(",").map((layerId) => layerId.trim());
  if (layerIds.length === 0 || layerIds.some((layerId) => !/^\d+$/.test(layerId))) return undefined;
  return layerIds.join(",");
}

function arcGisImageryEndpoint(url: string): "image" | "map" | undefined {
  const endpoint = url.split(/[?#]/, 1)[0] ?? "";
  let end = endpoint.length;
  while (end > 0 && endpoint.charCodeAt(end - 1) === 47) end -= 1;
  const normalized = endpoint.slice(0, end).toLowerCase();
  if (normalized.endsWith("/imageserver")) return "image";
  return normalized.endsWith("/mapserver") ? "map" : undefined;
}

function isSafeDnsLabel(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 63) return false;
  if (value[0] === "-" || value.at(-1) === "-") return false;
  for (const character of value) {
    const lower = character.toLowerCase();
    const isLetter = lower >= "a" && lower <= "z";
    const isDigit = character >= "0" && character <= "9";
    if (!isLetter && !isDigit && character !== "-") return false;
  }
  return true;
}

function canonicalParameterKey(key: string): string {
  let canonical = "";
  for (const character of key.toLowerCase()) {
    if (character >= "a" && character <= "z") canonical += character;
    else if (character >= "0" && character <= "9") canonical += character;
  }
  return canonical;
}

/**
 * Enforces the credential-free serialization boundary used by workspace state.
 * Renderability diagnostics remain separate so incomplete-but-safe bindings can
 * still be inspected, while unsafe or malformed URL material is never retained.
 * @internal
 */
export function assertScenePrimitiveSerializable(primitive: SceneRuntimePrimitive): void {
  if (primitive.kind === "model-layer") {
    assertSceneModelPrimitiveSerializable(primitive);
    return;
  }
  if (primitive.kind !== "imagery-layer") return;
  if (typeof primitive.url !== "string") {
    throw new TypeError(`Scene imagery primitive '${primitive.id}' has an invalid provider URL.`);
  }
  const urlProblem = isNonEmptyString(primitive.url) ? sceneAssetUrlProblem(primitive.url) : undefined;
  if (urlProblem === "invalid") {
    throw new TypeError(`Scene imagery primitive '${primitive.id}' has an invalid provider URL.`);
  }
  if (urlProblem === "credentials" || hasCredentialParameter(primitive.parameters)) {
    throw new TypeError(`Scene imagery primitive '${primitive.id}' must be credential-free.`);
  }
  if (primitive.parameters !== undefined && !isValidImageryParameters(primitive.parameters)) {
    throw new TypeError(`Scene imagery primitive '${primitive.id}' has invalid service parameters.`);
  }
  if (primitive.subdomains !== undefined && !isValidImagerySubdomains(primitive.subdomains)) {
    throw new TypeError(`Scene imagery primitive '${primitive.id}' has invalid subdomains.`);
  }
}

/**
 * Model layers cross the same serialization boundary as imagery: a persisted
 * plan must never carry a signed tileset/model URI. Placement and shading stay
 * on the diagnostic path so an incomplete-but-safe binding is still inspectable.
 */
function assertSceneModelPrimitiveSerializable(primitive: SceneModelLayerPrimitive): void {
  if (typeof primitive.uri !== "string") {
    throw new TypeError(`Scene model primitive '${primitive.id}' has an invalid asset URI.`);
  }
  const uriProblem = isNonEmptyString(primitive.uri) ? sceneAssetUrlProblem(primitive.uri) : undefined;
  if (uriProblem === "invalid") {
    throw new TypeError(`Scene model primitive '${primitive.id}' has an invalid asset URI.`);
  }
  if (uriProblem === "credentials") {
    throw new TypeError(`Scene model primitive '${primitive.id}' must be credential-free.`);
  }
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
