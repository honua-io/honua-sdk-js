/**
 * `MapPackage` validation.
 *
 * The *structural* rules — which properties exist, which are required, which
 * scalar types and enum members are legal, how long a string may be — are not
 * written here. They live in `schemas/honua-map-package.v1.json`, the canonical
 * artifact schema (honua-sdk-js#1426), which `scripts/generate-map-package-validator.mjs`
 * compiles into `./generated/map-package-schema-validator.js`. This module runs
 * that generated validator and translates its errors into the SDK's stable
 * diagnostic codes. Restating the shape in TypeScript would recreate exactly
 * the parallel description the schema exists to eliminate.
 *
 * What stays here is everything a JSON Schema genuinely cannot express:
 * cross-field resolution (does every layer's `source` resolve to a binding or
 * an inline style source?), package-level uniqueness (`sourceId` collisions),
 * runtime capability (which of the schema's protocols the source bridge can
 * actually bind), and wall-clock lifecycle (expiry and staleness).
 *
 * @module
 */

import { HONUA_MAP_PACKAGE_SCHEMA_PROTOCOLS } from "./generated/map-package-schema-meta.js";
import validateAgainstSchema from "./generated/map-package-schema-validator.js";
import type { HonuaMapPackage } from "./map-package.js";

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

/**
 * Schema-legal protocols the MapLibre source bridge cannot bind to a
 * `Dataset`/`Source` today. The schema is the wire contract and admits these;
 * the runtime is narrower. Deriving the bindable set by subtraction — rather
 * than by writing a second list — means a protocol added to the schema is
 * bindable by default and a deliberate gap has to be named here, in one place,
 * with a reason.
 */
const UNBINDABLE_SOURCE_PROTOCOLS: readonly string[] = [
  // `pmtiles://` archives are attached through the pmtiles protocol handler
  // (`registerPmtilesProtocol`), not through `createDataset`.
  "pmtiles",
  // Workspace artifacts resolve through the workspace/app layer, which the
  // map runtime does not depend on.
  "workspace_artifact",
];

const SUPPORTED_SOURCE_PROTOCOLS: ReadonlySet<string> = new Set(
  HONUA_MAP_PACKAGE_SCHEMA_PROTOCOLS.filter((protocol) => !UNBINDABLE_SOURCE_PROTOCOLS.includes(protocol)),
);

/** Ajv's error shape, narrowed to the fields this module reads. */
interface SchemaValidationError {
  readonly instancePath?: string;
  readonly schemaPath?: string;
  readonly keyword?: string;
  readonly params?: { readonly missingProperty?: string; readonly additionalProperty?: string };
  readonly message?: string;
}

type SchemaValidator = typeof validateAgainstSchema & { errors?: readonly SchemaValidationError[] | null };

/**
 * Translates one Ajv error into the SDK's stable diagnostic vocabulary.
 *
 * The codes predate the schema and are part of the public surface, so the
 * mapping is explicit rather than derived: hosts switch on these strings.
 */
function schemaErrorToDiagnostic(error: SchemaValidationError): Omit<HonuaMapPackageDiagnostic, "packageId"> {
  const path = jsonPointerToPath(error.instancePath ?? "");
  const missing = error.params?.missingProperty;
  const fullPath = missing ? (path ? `${path}.${missing}` : missing) : path;
  const detail = { schemaPath: error.schemaPath, keyword: error.keyword, params: error.params };
  const message = `MapPackage does not satisfy honua-map-package.v1 at ${fullPath || "(root)"}${
    error.message ? `: ${error.message}` : ""
  }.`;
  return { code: schemaErrorCode(fullPath, missing), severity: "error", message, path: fullPath || undefined, detail };
}

function schemaErrorCode(fullPath: string, missing: string | undefined): HonuaMapPackageDiagnosticCode {
  if (fullPath === "mapPackageId") return "missing-map-package-id";
  if (fullPath === "format") return "unsupported-format";
  if (fullPath === "sourceBindings") return "missing-source-bindings";
  if (fullPath === "mapSpec") return "missing-map-spec";
  if (fullPath.startsWith("mapSpec")) return "invalid-map-spec";
  if (fullPath.startsWith("sourceBindings[")) {
    const field = fullPath.slice(fullPath.indexOf("]") + 1);
    if (field === ".sourceId") return "missing-source-id";
    if (field === ".protocol") return "unsupported-protocol";
    if (field.startsWith(".locator") || missing === "locator") return "missing-source-locator";
  }
  return "invalid-package";
}

/** `/sourceBindings/0/locator/url` → `sourceBindings[0].locator.url`. */
function jsonPointerToPath(pointer: string): string {
  if (pointer.length === 0) return "";
  let path = "";
  for (const rawSegment of pointer.split("/").slice(1)) {
    const segment = rawSegment.replace(/~1/g, "/").replace(/~0/g, "~");
    if (/^\d+$/.test(segment)) path += `[${segment}]`;
    else path += path.length === 0 ? segment : `.${segment}`;
  }
  return path;
}

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

  // Structural pass: every required/type/enum/bound rule comes from
  // `schemas/honua-map-package.v1.json` by way of the generated validator.
  const validator = validateAgainstSchema as SchemaValidator;
  const structurallyValid = validator(value);
  const schemaErrorPaths = new Set<string>();
  if (!structurallyValid) {
    for (const error of validator.errors ?? []) {
      const diagnostic = schemaErrorToDiagnostic(error);
      if (diagnostic.path) schemaErrorPaths.add(diagnostic.path);
      add(diagnostic);
    }
  }

  const sourceIds = new Set<string>();
  const sourceBindings = value.sourceBindings;
  if (Array.isArray(sourceBindings)) {
    for (let i = 0; i < sourceBindings.length; i += 1) {
      const binding = sourceBindings[i];
      const path = `sourceBindings[${i}]`;
      if (!isRecord(binding)) continue;

      const sourceId = typeof binding.sourceId === "string" && binding.sourceId.length > 0 ? binding.sourceId : "";
      if (sourceId) {
        // Uniqueness is a package-level invariant; JSON Schema has no way to
        // express "distinct by this property", so it stays here.
        if (sourceIds.has(sourceId)) {
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
      }

      // The schema already rejected values outside its protocol enum; this is
      // the narrower question of what the source bridge can actually bind.
      const protocol = typeof binding.protocol === "string" ? binding.protocol : undefined;
      if (protocol && !SUPPORTED_SOURCE_PROTOCOLS.has(protocol) && !schemaErrorPaths.has(`${path}.protocol`)) {
        add({
          code: "unsupported-protocol",
          severity: "error",
          message: `SourceBinding "${sourceId || i}" uses unsupported protocol "${protocol}".`,
          path: `${path}.protocol`,
          detail: { sourceId, protocol },
        });
      }

      // `locator.url` is optional in the schema — a locator addressed purely by
      // `serviceId` is a legal artifact — but the runtime cannot bind one, so
      // the requirement is enforced here rather than in the wire contract.
      const locator = binding.locator;
      if (isRecord(locator) && (typeof locator.url !== "string" || locator.url.length === 0)) {
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
  if (isRecord(mapSpec)) {
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
  // A non-array `layers`, or a non-object entry, is a structural failure the
  // schema has already reported; re-reporting it here would double up.
  if (!Array.isArray(layers)) return;

  for (let i = 0; i < layers.length; i += 1) {
    const layer = layers[i];
    if (!isRecord(layer)) continue;
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
