import type { SourceDescriptor } from "../contract/types.js";
import {
  type HonuaErrorOptions,
  HonuaSdkError,
  mergeHonuaErrorContext,
  ownHonuaErrorContext,
  withHonuaErrorClassification,
} from "../core/error-base.js";
import {
  type MapLibreRasterSourceSpec,
  buildWmsRasterSourceSpec,
  buildWmtsRasterSourceSpec,
} from "./raster-source-spec.js";

export type MapLibreRasterStrategy = "native-raster-tiles" | "wms-raster" | "wmts-raster";
export type MapLibreRasterWorkflowState = "ready" | "disposed";
export type MapLibreRasterDiagnosticCode = "strategy-selected" | "cleanup-failed";
export type MapLibreRasterStrategyErrorCode =
  | "unsupported-strategy"
  | "capability-mismatch"
  | "missing-metadata"
  | "invalid-option"
  | "source-conflict"
  | "layer-conflict"
  | "map-mutation-failed";

export interface MapLibreRasterDiagnostic {
  readonly code: MapLibreRasterDiagnosticCode;
  readonly severity: "info" | "warning";
  readonly stage: "project" | "dispose";
  readonly fidelity: "exact" | "unsupported";
  readonly sourceId: string;
  readonly strategy: MapLibreRasterStrategy;
  readonly message: string;
  readonly detail?: Readonly<Record<string, unknown>>;
}

export class HonuaMapLibreRasterStrategyError extends HonuaSdkError {
  public constructor(
    public readonly code: MapLibreRasterStrategyErrorCode,
    message: string,
    public readonly detail?: Readonly<Record<string, unknown>>,
    options: HonuaErrorOptions = {},
  ) {
    super(
      MAPLIBRE_RASTER_ERROR_CODES[code],
      message,
      withHonuaErrorClassification(
        options,
        "map",
        code === "unsupported-strategy" || code === "capability-mismatch"
          ? "capability"
          : code === "map-mutation-failed"
            ? "internal"
            : "validation",
        false,
        mergeHonuaErrorContext(detail, ownHonuaErrorContext(options)),
      ),
    );
    this.name = "HonuaMapLibreRasterStrategyError";
  }
}

const MAPLIBRE_RASTER_ERROR_CODES = {
  "unsupported-strategy": "map.raster-strategy.unsupported-strategy",
  "capability-mismatch": "map.raster-strategy.capability-mismatch",
  "missing-metadata": "map.raster-strategy.missing-metadata",
  "invalid-option": "map.raster-strategy.invalid-option",
  "source-conflict": "map.raster-strategy.source-conflict",
  "layer-conflict": "map.raster-strategy.layer-conflict",
  "map-mutation-failed": "map.raster-strategy.map-mutation-failed",
} as const satisfies Record<MapLibreRasterStrategyErrorCode, `map.raster-strategy.${string}`>;

export interface ProjectRasterSourceToMapLibreOptions {
  readonly sourceId?: string;
  readonly layerId?: string;
  readonly beforeId?: string;
  readonly tileSize?: number;
  readonly format?: string;
  readonly transparent?: boolean;
  readonly minzoom?: number;
  readonly maxzoom?: number;
  readonly paint?: Readonly<Record<string, unknown>>;
  readonly layout?: Readonly<Record<string, unknown>>;
}

export interface MapLibreRasterProjection {
  readonly strategy: MapLibreRasterStrategy;
  readonly sourceId: string;
  readonly layerId: string;
  readonly source: MapLibreRasterSourceSpec;
  readonly layer: Readonly<Record<string, unknown>>;
  readonly diagnostics: readonly MapLibreRasterDiagnostic[];
  readonly state: "ready";
}

/** Minimal peer-injected MapLibre surface used by the raster mount. */
export interface RasterSourceToMapLibreMap {
  getSource(id: string): unknown;
  addSource(id: string, source: unknown): void;
  removeSource(id: string): void;
  getLayer(id: string): unknown;
  addLayer(layer: unknown, beforeId?: string): void;
  removeLayer(id: string): void;
}

export interface MountedMapLibreRasterSource {
  readonly strategy: MapLibreRasterStrategy;
  readonly sourceId: string;
  readonly layerId: string;
  readonly state: MapLibreRasterWorkflowState;
  readonly diagnostics: readonly MapLibreRasterDiagnostic[];
  dispose(): void;
}

/** Select and project the exact raster strategy implied by source metadata. */
export function projectRasterSourceToMapLibre(
  descriptor: SourceDescriptor,
  options: ProjectRasterSourceToMapLibreOptions = {},
): MapLibreRasterProjection {
  validateOptions(options);
  const strategy = selectStrategy(descriptor);
  assertCapabilities(descriptor);
  assertMetadata(descriptor, strategy);
  const sourceId = options.sourceId ?? `honua-${safeId(descriptor.id)}`;
  const layerId = options.layerId ?? `${sourceId}-raster`;
  const source = buildSource(descriptor, strategy, options);
  const layer = Object.freeze({
    id: layerId,
    type: "raster",
    source: sourceId,
    ...(options.minzoom !== undefined ? { minzoom: options.minzoom } : {}),
    ...(options.maxzoom !== undefined ? { maxzoom: options.maxzoom } : {}),
    ...(options.paint ? { paint: { ...options.paint } } : {}),
    ...(options.layout ? { layout: { ...options.layout } } : {}),
    metadata: { "honua:strategy": strategy, "honua:protocol": descriptor.protocol },
  });
  const diagnostic = Object.freeze({
    code: "strategy-selected" as const,
    severity: "info" as const,
    stage: "project" as const,
    fidelity: "exact" as const,
    sourceId,
    strategy,
    message: `Selected exact ${strategy} strategy from source metadata.`,
    detail: Object.freeze({ protocol: descriptor.protocol }),
  });
  return Object.freeze({
    strategy,
    sourceId,
    layerId,
    source: Object.freeze(source),
    layer,
    diagnostics: Object.freeze([diagnostic]),
    state: "ready" as const,
  });
}

/** Project and transactionally mount a metadata-selected raster source/layer. */
export function mountRasterSourceToMapLibre(
  map: RasterSourceToMapLibreMap,
  descriptor: SourceDescriptor,
  options: ProjectRasterSourceToMapLibreOptions = {},
): MountedMapLibreRasterSource {
  const projection = projectRasterSourceToMapLibre(descriptor, options);
  if (map.getSource(projection.sourceId) !== undefined) {
    throw failure("source-conflict", `MapLibre source "${projection.sourceId}" already exists.`, projection);
  }
  if (map.getLayer(projection.layerId) !== undefined) {
    throw failure("layer-conflict", `MapLibre layer "${projection.layerId}" already exists.`, projection);
  }

  try {
    map.addSource(projection.sourceId, projection.source);
    map.addLayer(projection.layer, options.beforeId);
  } catch (cause) {
    const rollbackErrors = rollbackMount(map, projection);
    throw failure(
      "map-mutation-failed",
      `Failed to mount raster source "${projection.sourceId}" transactionally.`,
      projection,
      { rollbackErrors },
      cause,
    );
  }

  let state: MapLibreRasterWorkflowState = "ready";
  const diagnostics: MapLibreRasterDiagnostic[] = [...projection.diagnostics];
  return {
    strategy: projection.strategy,
    sourceId: projection.sourceId,
    layerId: projection.layerId,
    get state() {
      return state;
    },
    get diagnostics() {
      return Object.freeze([...diagnostics]);
    },
    dispose() {
      if (state === "disposed") return;
      const cleanupErrors: string[] = [];
      removeIfPresent(map, "layer", projection.layerId, cleanupErrors);
      removeIfPresent(map, "source", projection.sourceId, cleanupErrors);
      if (cleanupErrors.length > 0) {
        diagnostics.push(
          Object.freeze({
            code: "cleanup-failed",
            severity: "warning",
            stage: "dispose",
            fidelity: "unsupported",
            sourceId: projection.sourceId,
            strategy: projection.strategy,
            message: "Raster mount cleanup did not remove every renderer object.",
            detail: Object.freeze({ errors: cleanupErrors }),
          }),
        );
      }
      state = "disposed";
    },
  };
}

function selectStrategy(descriptor: SourceDescriptor): MapLibreRasterStrategy {
  switch (descriptor.protocol) {
    case "maplibre-raster":
      return "native-raster-tiles";
    case "wms":
      return "wms-raster";
    case "wmts":
      return "wmts-raster";
    default:
      throw new HonuaMapLibreRasterStrategyError(
        "unsupported-strategy",
        `Protocol "${descriptor.protocol}" has no automatic raster strategy.`,
        { sourceId: descriptor.id, protocol: descriptor.protocol },
      );
  }
}

function assertCapabilities(descriptor: SourceDescriptor): void {
  const missing = ["render", "tiles"].filter(
    (capability) => !descriptor.capabilities.has(capability as "render" | "tiles"),
  );
  if (missing.length > 0) {
    throw new HonuaMapLibreRasterStrategyError(
      "capability-mismatch",
      `Source "${descriptor.id}" cannot use a raster strategy because required capabilities are missing.`,
      { sourceId: descriptor.id, missingCapabilities: missing },
    );
  }
}

function assertMetadata(descriptor: SourceDescriptor, strategy: MapLibreRasterStrategy): void {
  const missing: string[] = [];
  if (!nonEmpty(descriptor.locator.url)) missing.push("locator.url");
  if (strategy === "native-raster-tiles" && !isXyzTemplate(descriptor.locator.url)) {
    missing.push("locator.url:{z}/{x}/{y}");
  }
  if ((strategy === "wms-raster" || strategy === "wmts-raster") && !nonEmpty(descriptor.locator.typeName)) {
    missing.push("locator.typeName");
  }
  if (strategy === "wmts-raster" && !nonEmpty(descriptor.locator.tileMatrixSetId)) {
    missing.push("locator.tileMatrixSetId");
  }
  if (missing.length > 0) {
    throw new HonuaMapLibreRasterStrategyError(
      "missing-metadata",
      `Source "${descriptor.id}" lacks metadata required by ${strategy}.`,
      { sourceId: descriptor.id, strategy, missing },
    );
  }
}

function buildSource(
  descriptor: SourceDescriptor,
  strategy: MapLibreRasterStrategy,
  options: ProjectRasterSourceToMapLibreOptions,
): MapLibreRasterSourceSpec {
  if (strategy === "wms-raster") return buildWmsRasterSourceSpec(descriptor, options);
  if (strategy === "wmts-raster") return buildWmtsRasterSourceSpec(descriptor, options);
  return {
    type: "raster",
    tiles: [descriptor.locator.url],
    tileSize: options.tileSize ?? 256,
    ...(options.minzoom !== undefined ? { minzoom: options.minzoom } : {}),
    ...(options.maxzoom !== undefined ? { maxzoom: options.maxzoom } : {}),
    ...(descriptor.attribution ? { attribution: descriptor.attribution } : {}),
  };
}

function validateOptions(options: ProjectRasterSourceToMapLibreOptions): void {
  for (const [name, value] of [
    ["tileSize", options.tileSize],
    ["minzoom", options.minzoom],
    ["maxzoom", options.maxzoom],
  ] as const) {
    if (value !== undefined && (!Number.isInteger(value) || value < 0)) {
      throw new HonuaMapLibreRasterStrategyError("invalid-option", `${name} must be a non-negative integer.`, {
        option: name,
        value,
      });
    }
  }
  if (options.tileSize === 0) {
    throw new HonuaMapLibreRasterStrategyError("invalid-option", "tileSize must be greater than zero.", {
      option: "tileSize",
      value: options.tileSize,
    });
  }
  if (options.minzoom !== undefined && options.maxzoom !== undefined && options.minzoom > options.maxzoom) {
    throw new HonuaMapLibreRasterStrategyError("invalid-option", "minzoom cannot exceed maxzoom.", {
      minzoom: options.minzoom,
      maxzoom: options.maxzoom,
    });
  }
}

function rollbackMount(map: RasterSourceToMapLibreMap, projection: MapLibreRasterProjection): string[] {
  const errors: string[] = [];
  removeIfPresent(map, "layer", projection.layerId, errors);
  removeIfPresent(map, "source", projection.sourceId, errors);
  return errors;
}

function removeIfPresent(map: RasterSourceToMapLibreMap, kind: "layer" | "source", id: string, errors: string[]): void {
  try {
    const present = kind === "layer" ? map.getLayer(id) : map.getSource(id);
    if (present !== undefined) {
      if (kind === "layer") map.removeLayer(id);
      else map.removeSource(id);
    }
  } catch (error) {
    errors.push(`${kind}:${id}:${errorMessage(error)}`);
  }
}

function failure(
  code: MapLibreRasterStrategyErrorCode,
  message: string,
  projection: MapLibreRasterProjection,
  extra: Readonly<Record<string, unknown>> = {},
  cause?: unknown,
): HonuaMapLibreRasterStrategyError {
  return new HonuaMapLibreRasterStrategyError(
    code,
    message,
    { sourceId: projection.sourceId, layerId: projection.layerId, strategy: projection.strategy, ...extra },
    cause === undefined ? undefined : { cause },
  );
}

function safeId(value: string): string {
  const normalized = value.trim().replace(/[^a-zA-Z0-9_-]+/g, "-");
  let start = 0;
  while (start < normalized.length && normalized[start] === "-") start += 1;
  let end = normalized.length;
  while (end > start && normalized[end - 1] === "-") end -= 1;
  return normalized.slice(start, end) || "source";
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isXyzTemplate(value: unknown): value is string {
  return nonEmpty(value) && value.includes("{z}") && value.includes("{x}") && value.includes("{y}");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
