import type { HonuaLayerSpecification, HonuaStyleSpecification } from "../style/specification.js";
import type { HonuaRuntimeDiagnostic, HonuaRuntimeDiagnosticSeverity } from "./style-interactions.js";

export type RuntimeStyleSpecValidationMode = "strict" | "warning-only" | "renderer-deferred";

export interface RuntimeStyleSpecValidationOptions {
  readonly mode?: RuntimeStyleSpecValidationMode;
  readonly style?: HonuaStyleSpecification;
  readonly path?: string;
  readonly sourceId?: string;
  readonly layerId?: string;
  readonly protocol?: string;
  readonly context?: Readonly<Record<string, unknown>>;
}

type RuntimeSourceLike = Record<string, unknown>;

interface MapLibreValidationErrorLike {
  readonly message?: unknown;
  readonly identifier?: unknown;
  readonly key?: unknown;
  readonly line?: unknown;
}

interface MapLibreExpressionResult {
  readonly result: "success" | "error";
  readonly value: unknown;
}

interface MapLibreStyleSpecModule {
  readonly validateStyleMin: (style: unknown) => readonly MapLibreValidationErrorLike[];
  readonly createExpression: (expression: unknown) => MapLibreExpressionResult;
}

let loadAttempted = false;
let loadedModule: MapLibreStyleSpecModule | undefined;
let loadFailure: unknown;
let loadPromise: Promise<MapLibreStyleSpecModule | undefined> | undefined;

export async function prepareRuntimeStyleSpecValidation(
  mode: RuntimeStyleSpecValidationMode = "strict",
): Promise<HonuaRuntimeDiagnostic[]> {
  if (mode === "renderer-deferred") return [];
  const mod = await loadMapLibreStyleSpecModule();
  if (mod) return [];
  return [validatorUnavailableDiagnostic({ mode })];
}

export async function validateRuntimeStyleSpec(
  style: HonuaStyleSpecification,
  options: RuntimeStyleSpecValidationOptions = {},
): Promise<HonuaRuntimeDiagnostic[]> {
  const mode = options.mode ?? "strict";
  if (mode === "renderer-deferred") return [];
  const mod = await loadMapLibreStyleSpecModule();
  if (!mod) return [validatorUnavailableDiagnostic({ ...options, mode })];
  return mapStyleSpecErrors(mod.validateStyleMin(sanitizeStyle(style)), { ...options, mode }, {});
}

export async function validateRuntimeSourceStyleSpec(
  sourceId: string,
  source: unknown,
  options: RuntimeStyleSpecValidationOptions = {},
): Promise<HonuaRuntimeDiagnostic[]> {
  const mode = options.mode ?? "strict";
  if (mode === "renderer-deferred" || isHonuaSourceLike(source)) return [];
  const mod = await loadMapLibreStyleSpecModule();
  if (!mod)
    return [
      validatorUnavailableDiagnostic({ ...options, mode, sourceId, path: options.path ?? `sources.${sourceId}` }),
    ];
  return mapStyleSpecErrors(
    mod.validateStyleMin({
      version: 8,
      sources: { [sourceId]: source },
      layers: [],
    }),
    { ...options, mode, sourceId, path: options.path ?? `sources.${sourceId}` },
    {},
  );
}

export async function validateRuntimeLayerStyleSpec(
  layer: HonuaLayerSpecification,
  options: RuntimeStyleSpecValidationOptions = {},
): Promise<HonuaRuntimeDiagnostic[]> {
  const mode = options.mode ?? "strict";
  if (mode === "renderer-deferred") return [];
  const mod = await loadMapLibreStyleSpecModule();
  if (!mod) {
    return [
      validatorUnavailableDiagnostic({
        ...options,
        mode,
        layerId: options.layerId ?? layer.id,
        sourceId: options.sourceId ?? layer.source,
        path: options.path ?? layerPath(layer),
      }),
    ];
  }
  return mapStyleSpecErrors(
    mod.validateStyleMin(styleForLayerValidation(layer, options)),
    {
      ...options,
      mode,
      layerId: options.layerId ?? layer.id,
      sourceId: options.sourceId ?? layer.source,
      path: options.path ?? layerPath(layer),
    },
    { layerId: layer.id },
  );
}

export async function validateRuntimeStyleExpressionStyleSpec(
  value: unknown,
  options: RuntimeStyleSpecValidationOptions = {},
): Promise<HonuaRuntimeDiagnostic[]> {
  const mode = options.mode ?? "strict";
  if (mode === "renderer-deferred") return [];
  const mod = await loadMapLibreStyleSpecModule();
  if (!mod) return [validatorUnavailableDiagnostic({ ...options, mode })];
  return validateExpressionWithModule(mod, value, { ...options, mode });
}

export async function validateRuntimeFilterStyleSpec(
  filter: unknown,
  options: RuntimeStyleSpecValidationOptions = {},
): Promise<HonuaRuntimeDiagnostic[]> {
  const mode = options.mode ?? "strict";
  if (mode === "renderer-deferred") return [];
  const mod = await loadMapLibreStyleSpecModule();
  if (!mod) return [validatorUnavailableDiagnostic({ ...options, mode })];
  return mapStyleSpecErrors(
    mod.validateStyleMin(styleForFilterValidation(filter, options.layerId)),
    { ...options, mode, path: options.path ?? filterPath(options.layerId) },
    { layerId: options.layerId ?? "__honua_filter_validation__" },
  );
}

export function validateRuntimeSourceStyleSpecSync(
  sourceId: string,
  source: unknown,
  options: RuntimeStyleSpecValidationOptions = {},
): HonuaRuntimeDiagnostic[] {
  if (!shouldRunSyncStyleSpecValidation(options.mode) || isHonuaSourceLike(source)) return [];
  const mod = loadedStyleSpecModule();
  if (!mod)
    return [validatorUnavailableDiagnostic({ ...options, sourceId, path: options.path ?? `sources.${sourceId}` })];
  return mapStyleSpecErrors(
    mod.validateStyleMin({
      version: 8,
      sources: { [sourceId]: source },
      layers: [],
    }),
    { ...options, sourceId, path: options.path ?? `sources.${sourceId}` },
    {},
  );
}

export function validateRuntimeLayerStyleSpecSync(
  layer: HonuaLayerSpecification,
  options: RuntimeStyleSpecValidationOptions = {},
): HonuaRuntimeDiagnostic[] {
  if (!shouldRunSyncStyleSpecValidation(options.mode)) return [];
  const mod = loadedStyleSpecModule();
  if (!mod) {
    return [
      validatorUnavailableDiagnostic({
        ...options,
        layerId: options.layerId ?? layer.id,
        sourceId: options.sourceId ?? layer.source,
        path: options.path ?? layerPath(layer),
      }),
    ];
  }
  return mapStyleSpecErrors(
    mod.validateStyleMin(styleForLayerValidation(layer, options)),
    {
      ...options,
      layerId: options.layerId ?? layer.id,
      sourceId: options.sourceId ?? layer.source,
      path: options.path ?? layerPath(layer),
    },
    { layerId: layer.id },
  );
}

export function validateRuntimeStyleExpressionStyleSpecSync(
  value: unknown,
  options: RuntimeStyleSpecValidationOptions = {},
): HonuaRuntimeDiagnostic[] {
  if (!shouldRunSyncStyleSpecValidation(options.mode)) return [];
  const mod = loadedStyleSpecModule();
  if (!mod) return [validatorUnavailableDiagnostic(options)];
  return validateExpressionWithModule(mod, value, options);
}

export function validateRuntimeFilterStyleSpecSync(
  filter: unknown,
  options: RuntimeStyleSpecValidationOptions = {},
): HonuaRuntimeDiagnostic[] {
  if (!shouldRunSyncStyleSpecValidation(options.mode)) return [];
  const mod = loadedStyleSpecModule();
  if (!mod) return [validatorUnavailableDiagnostic(options)];
  return mapStyleSpecErrors(
    mod.validateStyleMin(styleForFilterValidation(filter, options.layerId)),
    { ...options, path: options.path ?? filterPath(options.layerId) },
    { layerId: options.layerId ?? "__honua_filter_validation__" },
  );
}

function validateExpressionWithModule(
  mod: MapLibreStyleSpecModule,
  value: unknown,
  options: RuntimeStyleSpecValidationOptions,
): HonuaRuntimeDiagnostic[] {
  const result = mod.createExpression(value);
  if (result.result !== "error" || !Array.isArray(result.value)) return [];
  return result.value.map((error) => {
    const mapLibrePath = pathWithExpressionKey(options.path, stringProperty(error, "key"));
    return mapLibreDiagnostic(error, stringProperty(error, "message") ?? "Invalid MapLibre style expression.", {
      ...options,
      path: mapLibrePath,
      mapLibrePath,
    });
  });
}

async function loadMapLibreStyleSpecModule(): Promise<MapLibreStyleSpecModule | undefined> {
  if (loadedModule) return loadedModule;
  loadAttempted = true;
  loadPromise ??= import("@maplibre/maplibre-gl-style-spec")
    .then((mod) => {
      const candidate = mod as Partial<MapLibreStyleSpecModule>;
      if (typeof candidate.validateStyleMin !== "function" || typeof candidate.createExpression !== "function") {
        throw new Error("@maplibre/maplibre-gl-style-spec does not expose the expected validator API.");
      }
      loadedModule = {
        validateStyleMin: candidate.validateStyleMin,
        createExpression: candidate.createExpression,
      };
      loadFailure = undefined;
      return loadedModule;
    })
    .catch((error: unknown) => {
      loadFailure = error;
      loadedModule = undefined;
      return undefined;
    });
  return loadPromise;
}

function loadedStyleSpecModule(): MapLibreStyleSpecModule | undefined {
  return loadedModule;
}

function shouldRunSyncStyleSpecValidation(mode: RuntimeStyleSpecValidationMode | undefined): boolean {
  return mode !== undefined && mode !== "renderer-deferred";
}

function mapStyleSpecErrors(
  errors: readonly MapLibreValidationErrorLike[],
  options: RuntimeStyleSpecValidationOptions,
  remap: { readonly layerId?: string },
): HonuaRuntimeDiagnostic[] {
  return errors.map((error) => {
    const parsed = parseMapLibreMessage(stringProperty(error, "message") ?? "Invalid MapLibre style specification.");
    const path = parsed.path ? normalizeStylePath(parsed.path, remap) : options.path;
    return mapLibreDiagnostic(error, parsed.message, {
      ...options,
      path: path ?? options.path,
      mapLibrePath: parsed.path,
    });
  });
}

function mapLibreDiagnostic(
  error: MapLibreValidationErrorLike,
  message: string,
  options: RuntimeStyleSpecValidationOptions & { readonly mapLibrePath?: string },
): HonuaRuntimeDiagnostic {
  const mapLibreCode = stringProperty(error, "identifier") ?? "validation-error";
  const line = numberProperty(error, "line");
  return {
    code: "style-spec-invalid",
    severity: severityForMode(options.mode),
    message,
    ...(options.path ? { path: options.path } : {}),
    ...(options.sourceId ? { sourceId: options.sourceId } : {}),
    ...(options.layerId ? { layerId: options.layerId } : {}),
    ...(options.protocol ? { protocol: options.protocol } : {}),
    context: {
      ...(options.context ?? {}),
      mapLibreCode,
      ...(options.mapLibrePath ? { mapLibrePath: options.mapLibrePath } : {}),
      ...(line !== undefined ? { mapLibreLine: line } : {}),
    },
  };
}

function validatorUnavailableDiagnostic(options: RuntimeStyleSpecValidationOptions): HonuaRuntimeDiagnostic {
  const cause = loadAttempted
    ? errorMessage(loadFailure) || "unknown import failure"
    : "validator has not been prepared";
  return {
    code: "style-spec-validator-unavailable",
    severity: severityForMode(options.mode),
    message:
      "MapLibre style-spec validation is unavailable. Install @maplibre/maplibre-gl-style-spec or use renderer-deferred validation.",
    ...(options.path ? { path: options.path } : {}),
    ...(options.sourceId ? { sourceId: options.sourceId } : {}),
    ...(options.layerId ? { layerId: options.layerId } : {}),
    ...(options.protocol ? { protocol: options.protocol } : {}),
    context: {
      ...(options.context ?? {}),
      mapLibreCode: "validator-unavailable",
      cause,
    },
  };
}

function sanitizeStyle(style: HonuaStyleSpecification): unknown {
  const sources: Record<string, unknown> = {};
  for (const [sourceId, source] of Object.entries(style.sources)) {
    sources[sourceId] = isHonuaSourceLike(source)
      ? placeholderSourceForLayer(firstLayerForSource(style.layers, sourceId), source)
      : source;
  }
  return {
    ...style,
    sources,
  };
}

function styleForLayerValidation(layer: HonuaLayerSpecification, options: RuntimeStyleSpecValidationOptions): unknown {
  const sources: Record<string, unknown> = {};
  const sourceId = typeof layer.source === "string" ? layer.source : undefined;
  if (sourceId) {
    const existing = options.style?.sources[sourceId];
    if (existing) {
      sources[sourceId] = isHonuaSourceLike(existing) ? placeholderSourceForLayer(layer, existing) : existing;
    } else if (!options.style) {
      sources[sourceId] = placeholderSourceForLayer(layer);
    }
  }
  return {
    version: 8,
    sources,
    layers: [layer],
  };
}

function styleForFilterValidation(filter: unknown, layerId: string | undefined): unknown {
  const sourceId = "__honua_filter_source__";
  return {
    version: 8,
    sources: {
      [sourceId]: geoJsonPlaceholderSource(),
    },
    layers: [
      {
        id: layerId ?? "__honua_filter_validation__",
        type: "circle",
        source: sourceId,
        filter,
      },
    ],
  };
}

function placeholderSourceForLayer(layer: HonuaLayerSpecification | undefined, source?: unknown): RuntimeSourceLike {
  const sourceType = isPlainObject(source) && typeof source.type === "string" ? source.type : undefined;
  if (sourceType === "honua-wms" || sourceType === "honua-wmts" || sourceType === "honua-map-service") {
    return rasterPlaceholderSource();
  }

  if (layer?.type === "raster") return rasterPlaceholderSource();
  if (layer?.type === "hillshade") return rasterDemPlaceholderSource();
  return geoJsonPlaceholderSource();
}

function geoJsonPlaceholderSource(): RuntimeSourceLike {
  return {
    type: "geojson",
    data: { type: "FeatureCollection", features: [] },
  };
}

function rasterPlaceholderSource(): RuntimeSourceLike {
  return {
    type: "raster",
    tiles: ["https://example.invalid/{z}/{x}/{y}.png"],
    tileSize: 256,
  };
}

function rasterDemPlaceholderSource(): RuntimeSourceLike {
  return {
    type: "raster-dem",
    tiles: ["https://example.invalid/{z}/{x}/{y}.png"],
    tileSize: 256,
  };
}

function firstLayerForSource(
  layers: readonly HonuaLayerSpecification[],
  sourceId: string,
): HonuaLayerSpecification | undefined {
  return layers.find((layer) => layer.source === sourceId);
}

function isHonuaSourceLike(value: unknown): boolean {
  return isPlainObject(value) && typeof value.type === "string" && value.type.startsWith("honua-");
}

function parseMapLibreMessage(message: string): { path: string | undefined; message: string } {
  const separator = message.indexOf(": ");
  if (separator <= 0) return { path: undefined, message };
  const path = message.slice(0, separator);
  if (!looksLikeMapLibrePath(path)) return { path: undefined, message };
  return { path, message: message.slice(separator + 2) };
}

function looksLikeMapLibrePath(path: string): boolean {
  return /^(version|name|metadata|center|zoom|bearing|pitch|sources|layers|sprite|glyphs|transition|light|terrain|projection|sky)(?:$|[.[\]])/.test(
    path,
  );
}

function normalizeStylePath(path: string, remap: { readonly layerId?: string }): string {
  if (remap.layerId) {
    return path.replace(/^layers\[\d+\]/, `layers.${remap.layerId}`);
  }
  return path;
}

function pathWithExpressionKey(path: string | undefined, key: string | undefined): string | undefined {
  if (!key) return path;
  if (!path) return key.startsWith(".") ? key.slice(1) : key;
  return key.startsWith("[") || key.startsWith(".") ? `${path}${key}` : `${path}.${key}`;
}

function filterPath(layerId: string | undefined): string {
  return layerId ? `layers.${layerId}.filter` : "filter";
}

function layerPath(layer: HonuaLayerSpecification): string {
  return layer.id ? `layers.${layer.id}` : "layers[]";
}

function severityForMode(mode: RuntimeStyleSpecValidationMode | undefined): HonuaRuntimeDiagnosticSeverity {
  return mode === "warning-only" ? "warning" : "error";
}

function stringProperty(value: unknown, property: keyof MapLibreValidationErrorLike): string | undefined {
  if (!isPlainObject(value)) return undefined;
  const candidate = value[property];
  return typeof candidate === "string" ? candidate : undefined;
}

function numberProperty(value: unknown, property: keyof MapLibreValidationErrorLike): number | undefined {
  if (!isPlainObject(value)) return undefined;
  const candidate = value[property];
  return typeof candidate === "number" ? candidate : undefined;
}

function errorMessage(error: unknown): string | undefined {
  if (error instanceof Error) return error.message;
  return typeof error === "string" ? error : undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
