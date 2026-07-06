import { HONUA_MAP_PACKAGE_FORMAT_V1, type HonuaMapPackage } from "./map-package.js";

export type HonuaMapPackageDiagnosticSeverity = "error" | "warning";

export type HonuaMapPackageDiagnosticCode =
  | "invalid-package"
  | "unsupported-format"
  | "missing-map-package-id"
  | "missing-source-bindings"
  | "missing-map-spec"
  | "invalid-map-spec"
  | "duplicate-source"
  | "missing-source-id"
  | "missing-source-locator"
  | "unsupported-protocol"
  | "missing-source"
  | "stale-package"
  | "expired-package"
  | "style-ref-missing-layer"
  | "style-ref-unresolved"
  | "style-ref-resolution-failed";

export interface HonuaMapPackageDiagnostic {
  readonly code: HonuaMapPackageDiagnosticCode;
  readonly severity: HonuaMapPackageDiagnosticSeverity;
  readonly message: string;
  readonly packageId?: string;
  readonly path?: string;
  readonly detail?: unknown;
}

export interface ValidateMapPackageOptions {
  /** Wall-clock used for stale / expired diagnostics. Defaults to `Date.now()`. */
  readonly now?: number | Date;
  /** Emit a `stale-package` warning when `updatedAt` / `createdAt` is older than this many ms. */
  readonly maxAgeMs?: number;
}

export interface ValidateMapPackageResult {
  readonly mapPackage: HonuaMapPackage | undefined;
  readonly diagnostics: readonly HonuaMapPackageDiagnostic[];
  readonly valid: boolean;
}

const SUPPORTED_SOURCE_PROTOCOLS = new Set([
  "geoservices_feature_service",
  "geoservices_map_service",
  "ogc_features",
  "ogc_maps",
  "ogc_tiles",
  "wfs",
  "wms",
  "wmts",
  "odata",
  "vector_tile",
  "raster_tile",
]);

/**
 * Validate the server-produced `MapPackage` wire shape and runtime binding
 * assumptions without throwing raw JSON/type errors. Diagnostics are
 * stable-enough for hosts to show or log directly.
 */
export function validateMapPackage(value: unknown, options: ValidateMapPackageOptions = {}): ValidateMapPackageResult {
  const diagnostics: HonuaMapPackageDiagnostic[] = [];
  if (!isRecord(value)) {
    diagnostics.push({
      code: "invalid-package",
      severity: "error",
      message: "MapPackage response must be a JSON object.",
    });
    return { mapPackage: undefined, diagnostics, valid: false };
  }

  const packageId = typeof value.mapPackageId === "string" ? value.mapPackageId : undefined;
  const add = (diagnostic: Omit<HonuaMapPackageDiagnostic, "packageId">): void => {
    diagnostics.push({ ...(packageId ? { packageId } : {}), ...diagnostic });
  };

  if (!packageId) {
    add({
      code: "missing-map-package-id",
      severity: "error",
      message: "MapPackage.mapPackageId must be a non-empty string.",
      path: "mapPackageId",
    });
  }

  if (value.format !== HONUA_MAP_PACKAGE_FORMAT_V1) {
    add({
      code: "unsupported-format",
      severity: "error",
      message: `MapPackage.format must be "${HONUA_MAP_PACKAGE_FORMAT_V1}".`,
      path: "format",
      detail: { expected: HONUA_MAP_PACKAGE_FORMAT_V1, received: value.format },
    });
  }

  const sourceIds = new Set<string>();
  const sourceBindings = value.sourceBindings;
  if (!Array.isArray(sourceBindings)) {
    add({
      code: "missing-source-bindings",
      severity: "error",
      message: "MapPackage.sourceBindings must be an array.",
      path: "sourceBindings",
    });
  } else {
    for (let i = 0; i < sourceBindings.length; i += 1) {
      const binding = sourceBindings[i];
      const path = `sourceBindings[${i}]`;
      if (!isRecord(binding)) {
        add({
          code: "invalid-package",
          severity: "error",
          message: "MapPackage.sourceBindings entries must be objects.",
          path,
        });
        continue;
      }

      const sourceId = typeof binding.sourceId === "string" && binding.sourceId.length > 0 ? binding.sourceId : "";
      if (!sourceId) {
        add({
          code: "missing-source-id",
          severity: "error",
          message: "SourceBinding.sourceId must be a non-empty string.",
          path: `${path}.sourceId`,
        });
      } else if (sourceIds.has(sourceId)) {
        add({
          code: "duplicate-source",
          severity: "error",
          message: `SourceBinding sourceId "${sourceId}" is duplicated.`,
          path: `${path}.sourceId`,
          detail: { sourceId },
        });
      } else {
        sourceIds.add(sourceId);
      }

      const protocol = typeof binding.protocol === "string" ? binding.protocol : undefined;
      if (!protocol || !SUPPORTED_SOURCE_PROTOCOLS.has(protocol)) {
        add({
          code: "unsupported-protocol",
          severity: "error",
          message: `SourceBinding "${sourceId || i}" uses unsupported protocol "${String(binding.protocol)}".`,
          path: `${path}.protocol`,
          detail: { sourceId, protocol: binding.protocol },
        });
      }

      const locator = binding.locator;
      if (!isRecord(locator) || typeof locator.url !== "string" || locator.url.length === 0) {
        add({
          code: "missing-source-locator",
          severity: "error",
          message: `SourceBinding "${sourceId || i}" must include locator.url.`,
          path: `${path}.locator.url`,
          detail: { sourceId, protocol },
        });
      }
    }
  }

  const mapSpec = value.mapSpec;
  if (!isRecord(mapSpec)) {
    add({
      code: "missing-map-spec",
      severity: "error",
      message: "MapPackage.mapSpec must be a MapLibre style object.",
      path: "mapSpec",
    });
  } else {
    validateMapSpecSources(add, mapSpec, sourceIds);
    validateStyleRefTargets(add, value, mapSpec);
  }

  validateLifecycle(add, value, options);

  const valid = !hasMapPackageDiagnosticErrors(diagnostics);
  return {
    mapPackage: value as HonuaMapPackage,
    diagnostics,
    valid,
  };
}

export function hasMapPackageDiagnosticErrors(diagnostics: readonly HonuaMapPackageDiagnostic[]): boolean {
  return diagnostics.some((diagnostic) => diagnostic.severity === "error");
}

function validateMapSpecSources(
  add: (diagnostic: Omit<HonuaMapPackageDiagnostic, "packageId">) => void,
  mapSpec: Record<string, unknown>,
  sourceIds: ReadonlySet<string>,
): void {
  const mapSpecSources = isRecord(mapSpec.sources) ? new Set(Object.keys(mapSpec.sources)) : new Set<string>();
  const layers = mapSpec.layers;
  if (!Array.isArray(layers)) {
    add({
      code: "invalid-map-spec",
      severity: "error",
      message: "MapPackage.mapSpec.layers must be an array.",
      path: "mapSpec.layers",
    });
    return;
  }

  for (let i = 0; i < layers.length; i += 1) {
    const layer = layers[i];
    if (!isRecord(layer)) {
      add({
        code: "invalid-map-spec",
        severity: "error",
        message: "MapPackage.mapSpec.layers entries must be objects.",
        path: `mapSpec.layers[${i}]`,
      });
      continue;
    }
    if (typeof layer.source !== "string") continue;
    if (!sourceIds.has(layer.source) && !mapSpecSources.has(layer.source)) {
      add({
        code: "missing-source",
        severity: "error",
        message: `Layer "${String(layer.id ?? i)}" references missing source "${layer.source}".`,
        path: `mapSpec.layers[${i}].source`,
        detail: { layerId: layer.id, sourceId: layer.source },
      });
    }
  }
}

function validateStyleRefTargets(
  add: (diagnostic: Omit<HonuaMapPackageDiagnostic, "packageId">) => void,
  pkg: Record<string, unknown>,
  mapSpec: Record<string, unknown>,
): void {
  if (!Array.isArray(pkg.styleRefs)) return;
  const layerIds = new Set<string>();
  if (Array.isArray(mapSpec.layers)) {
    for (const layer of mapSpec.layers) {
      if (isRecord(layer) && typeof layer.id === "string") layerIds.add(layer.id);
    }
  }

  for (let i = 0; i < pkg.styleRefs.length; i += 1) {
    const ref = pkg.styleRefs[i];
    if (!isRecord(ref) || !isRecord(ref.body)) continue;
    for (const layerId of Object.keys(ref.body)) {
      if (layerIds.has(layerId)) continue;
      add({
        code: "style-ref-missing-layer",
        severity: "warning",
        message: `StyleRef "${String(ref.styleId ?? i)}" targets missing layer "${layerId}".`,
        path: `styleRefs[${i}].body.${layerId}`,
        detail: { styleId: ref.styleId, layerId },
      });
    }
  }
}

function validateLifecycle(
  add: (diagnostic: Omit<HonuaMapPackageDiagnostic, "packageId">) => void,
  pkg: Record<string, unknown>,
  options: ValidateMapPackageOptions,
): void {
  const nowMs = normalizeNowMs(options.now);
  if (pkg.status === "Expired") {
    add({
      code: "expired-package",
      severity: "error",
      message: "MapPackage status is Expired.",
      path: "status",
      detail: { status: pkg.status },
    });
  }

  const expiresAt = parseTimestampMs(pkg.expiresAt);
  if (expiresAt !== undefined && expiresAt <= nowMs) {
    add({
      code: "expired-package",
      severity: "error",
      message: "MapPackage expiresAt is in the past.",
      path: "expiresAt",
      detail: { expiresAt: pkg.expiresAt },
    });
  }

  if (options.maxAgeMs === undefined) return;
  const updatedAt = parseTimestampMs(pkg.updatedAt) ?? parseTimestampMs(pkg.createdAt);
  if (updatedAt === undefined) return;
  if (nowMs - updatedAt > Math.max(0, Math.trunc(options.maxAgeMs))) {
    add({
      code: "stale-package",
      severity: "warning",
      message: "MapPackage is older than the configured freshness budget.",
      path: pkg.updatedAt ? "updatedAt" : "createdAt",
      detail: { ageMs: nowMs - updatedAt, maxAgeMs: options.maxAgeMs },
    });
  }
}

function normalizeNowMs(now: number | Date | undefined): number {
  if (now instanceof Date) return now.getTime();
  if (typeof now === "number" && Number.isFinite(now)) return now;
  return Date.now();
}

function parseTimestampMs(value: unknown): number | undefined {
  if (value instanceof Date) return value.getTime();
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const parsed = typeof value === "number" ? value : Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
