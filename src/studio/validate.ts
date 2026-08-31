/**
 * Family-agnostic validation for Studio packages produced outside Console —
 * by an MCP client, the QGIS plugin, or the SDK itself. It returns the same
 * unified {@link StudioPackageValidationResponse} envelope as the per-family
 * validators, so a package generated through any surface is validated against
 * one contract.
 *
 * For the `map` family this delegates to the established
 * {@link validateMapPackage} (no duplication). For every other family it runs
 * the shared base checks (`packageId`/`format`, lifecycle) and, when present,
 * the shared {@link HonuaPackageProvenance} checks. Provenance is optional, but
 * when a package carries it, MCP- and QGIS-origin packages must satisfy the
 * same provenance shape as Console.
 *
 * @experimental Not yet covered by the SDK's semver contract — these shapes
 *   may change in any minor release prior to `1.0.0`.
 * @module
 */

import { validateMapPackage } from "../runtime/map-package-validation.js";
import { HONUA_MAP_PACKAGE_FORMAT_V1 } from "../runtime/map-package.js";
import { HONUA_PACKAGE_PROVENANCE_FORMAT_V1, type HonuaPackageProvenance, getPackageProvenance } from "./provenance.js";
import { HONUA_DASHBOARD_PACKAGE_FORMAT_V1, STUDIO_PACKAGE_FAMILIES, isStudioPackageFamily } from "./types.js";
import { fromMapPackageValidation } from "./validation.js";
import type { StudioPackageDiagnostic, StudioPackageValidationResponse } from "./validation.js";

/**
 * Expected `format` string for each family whose projection carries a single
 * `format` discriminant. The `app` family is identified by `version` rather than `format`
 * and is therefore not in this table.
 */
const FAMILY_FORMAT: Partial<Record<string, string>> = {
  query: "honua_query_package.v1",
  analysis: "honua_analysis_package.v1",
  map: HONUA_MAP_PACKAGE_FORMAT_V1,
  dashboard: HONUA_DASHBOARD_PACKAGE_FORMAT_V1,
  report: "honua_report_package.v1",
  form: "honua_form_package.v1",
  workflow: "honua_workflow_package.v1",
  gp: "honua_gp_package.v1",
  etl: "honua_etl_package.v1",
};

/** The package-identity field each family uses. */
function packageIdOf(family: string, value: Record<string, unknown>): string | undefined {
  if (family === "map") return typeof value.mapPackageId === "string" ? value.mapPackageId : undefined;
  if (family === "app") return typeof value.id === "string" ? value.id : undefined;
  return typeof value.packageId === "string" ? value.packageId : undefined;
}

export interface ValidateStudioPackageOptions {
  /** Wall-clock for lifecycle (expired) diagnostics. Defaults to `Date.now()`. */
  readonly now?: number | Date;
  /** Require a {@link HonuaPackageProvenance} envelope to be present. */
  readonly requireProvenance?: boolean;
}

/**
 * Validate a package of any Studio family produced outside Console. Dispatches
 * to the map validator for the `map` family and applies shared base +
 * provenance checks for every family.
 *
 * @experimental
 */
export function validateStudioPackage<T = unknown>(
  family: string,
  value: unknown,
  options: ValidateStudioPackageOptions = {},
): StudioPackageValidationResponse<T> {
  const diagnostics: StudioPackageDiagnostic[] = [];

  if (!isStudioPackageFamily(family)) {
    diagnostics.push({
      code: "unknown-family",
      severity: "error",
      message: `Unknown Studio package family "${family}". Expected one of: ${STUDIO_PACKAGE_FAMILIES.join(", ")}.`,
      path: "packageFamily",
    });
    return { valid: false, diagnostics };
  }

  if (!isRecord(value)) {
    diagnostics.push({
      code: "invalid-package",
      severity: "error",
      message: `${family} package must be a JSON object.`,
    });
    return { valid: false, diagnostics };
  }

  // The map family has a full structural validator already — reuse it so MCP
  // and QGIS map packages validate identically to Console's.
  if (family === "map") {
    const mapResponse = fromMapPackageValidation(validateMapPackage(value, { now: options.now }));
    const merged: StudioPackageDiagnostic[] = [...mapResponse.diagnostics];
    appendProvenanceDiagnostics(merged, value, options);
    return {
      valid: mapResponse.valid && !hasErrors(merged),
      diagnostics: merged,
      ...(mapResponse.pkg === undefined ? {} : { pkg: mapResponse.pkg as unknown as T }),
    };
  }

  const packageId = packageIdOf(family, value);
  if (!packageId) {
    diagnostics.push({
      code: "missing-package-id",
      severity: "error",
      message: `${family} package must carry a non-empty identity field.`,
      path: family === "app" ? "id" : "packageId",
    });
  }

  const expectedFormat = FAMILY_FORMAT[family];
  if (expectedFormat !== undefined && family !== "app" && value.format !== expectedFormat) {
    diagnostics.push({
      code: "unsupported-format",
      severity: "error",
      message: `${family} package format must be "${expectedFormat}".`,
      path: "format",
      detail: { expected: expectedFormat, received: value.format },
    });
  }

  if (family === "dashboard") appendDashboardDiagnostics(diagnostics, value);

  appendLifecycleDiagnostics(diagnostics, value, options);
  appendProvenanceDiagnostics(diagnostics, value, options);

  return {
    valid: !hasErrors(diagnostics),
    diagnostics,
    pkg: value as unknown as T,
  };
}

const DASHBOARD_LIFECYCLE_FIELDS = [
  "status",
  "createdAt",
  "updatedAt",
  "expiresAt",
  "tenantId",
  "ownerId",
  "actorId",
  "proposalId",
  "operationInstanceId",
  "auditId",
  "correlationId",
  "generation",
] as const;

function appendDashboardDiagnostics(diagnostics: StudioPackageDiagnostic[], value: Record<string, unknown>): void {
  if (!isRecord(value.data)) {
    diagnostics.push({
      code: "missing-dashboard-data",
      severity: "error",
      message: "dashboard package data must be a JSON object.",
      path: "data",
    });
  }
  if (!isRecord(value.layout) || !Array.isArray(value.layout.widgets)) {
    diagnostics.push({
      code: "missing-dashboard-layout",
      severity: "error",
      message: "dashboard package layout.widgets must be an array.",
      path: "layout.widgets",
    });
  }
  for (const field of DASHBOARD_LIFECYCLE_FIELDS) {
    if (field in value) {
      diagnostics.push({
        code: "dashboard-lifecycle-field",
        severity: "error",
        message: `dashboard package must not carry server-owned lifecycle field "${field}".`,
        path: field,
      });
    }
  }
}

/**
 * Validate just the {@link HonuaPackageProvenance} envelope on a package value.
 * Useful when a host (MCP/QGIS) wants to confirm attribution without running
 * the full family validation.
 *
 * @experimental
 */
export function validatePackageProvenance(
  value: unknown,
  options: { readonly required?: boolean } = {},
): StudioPackageValidationResponse<HonuaPackageProvenance> {
  const diagnostics: StudioPackageDiagnostic[] = [];
  appendProvenanceDiagnostics(diagnostics, value, { requireProvenance: options.required });
  const provenance = getPackageProvenance(value);
  return {
    valid: !hasErrors(diagnostics),
    diagnostics,
    ...(provenance === undefined ? {} : { pkg: provenance }),
  };
}

const KNOWN_ORIGINS = new Set(["console", "studio", "mcp", "qgis", "sdk"]);

function appendProvenanceDiagnostics(
  diagnostics: StudioPackageDiagnostic[],
  value: unknown,
  options: ValidateStudioPackageOptions | { requireProvenance?: boolean },
): void {
  const raw = isRecord(value) ? (value as { provenance?: unknown }).provenance : undefined;
  if (raw === undefined) {
    if (options.requireProvenance) {
      diagnostics.push({
        code: "missing-provenance",
        severity: "error",
        message: "Package provenance is required but absent.",
        path: "provenance",
      });
    }
    return;
  }

  if (!isRecord(raw)) {
    diagnostics.push({
      code: "invalid-provenance",
      severity: "error",
      message: "Package provenance must be a JSON object.",
      path: "provenance",
    });
    return;
  }

  if (raw.format !== HONUA_PACKAGE_PROVENANCE_FORMAT_V1) {
    diagnostics.push({
      code: "unsupported-provenance-format",
      severity: "error",
      message: `Package provenance.format must be "${HONUA_PACKAGE_PROVENANCE_FORMAT_V1}".`,
      path: "provenance.format",
      detail: { expected: HONUA_PACKAGE_PROVENANCE_FORMAT_V1, received: raw.format },
    });
    return;
  }

  if (typeof raw.origin !== "string" || raw.origin.length === 0) {
    diagnostics.push({
      code: "missing-provenance-origin",
      severity: "error",
      message: "Package provenance.origin must be a non-empty string.",
      path: "provenance.origin",
    });
  } else if (!KNOWN_ORIGINS.has(raw.origin)) {
    diagnostics.push({
      code: "unknown-provenance-origin",
      severity: "warning",
      message: `Package provenance.origin "${raw.origin}" is not a known surface.`,
      path: "provenance.origin",
      detail: { origin: raw.origin, known: [...KNOWN_ORIGINS] },
    });
  }

  if (raw.dataBindings !== undefined && !Array.isArray(raw.dataBindings)) {
    diagnostics.push({
      code: "invalid-provenance-data-bindings",
      severity: "error",
      message: "Package provenance.dataBindings must be an array when present.",
      path: "provenance.dataBindings",
    });
  } else if (Array.isArray(raw.dataBindings)) {
    raw.dataBindings.forEach((binding, i) => {
      if (!isRecord(binding) || typeof binding.sourceId !== "string" || binding.sourceId.length === 0) {
        diagnostics.push({
          code: "invalid-provenance-data-binding",
          severity: "error",
          message: "Each provenance dataBinding must carry a non-empty sourceId.",
          path: `provenance.dataBindings[${i}].sourceId`,
        });
      }
    });
  }

  if (raw.permissions !== undefined && !Array.isArray(raw.permissions)) {
    diagnostics.push({
      code: "invalid-provenance-permissions",
      severity: "error",
      message: "Package provenance.permissions must be an array when present.",
      path: "provenance.permissions",
    });
  } else if (Array.isArray(raw.permissions)) {
    raw.permissions.forEach((permission, i) => {
      if (!isRecord(permission) || typeof permission.scope !== "string" || permission.scope.length === 0) {
        diagnostics.push({
          code: "invalid-provenance-permission",
          severity: "error",
          message: "Each provenance permission must carry a non-empty scope.",
          path: `provenance.permissions[${i}].scope`,
        });
      }
    });
  }
}

function appendLifecycleDiagnostics(
  diagnostics: StudioPackageDiagnostic[],
  value: Record<string, unknown>,
  options: ValidateStudioPackageOptions,
): void {
  const nowMs = options.now instanceof Date ? options.now.getTime() : (options.now ?? Date.now());
  if (value.status === "Expired") {
    diagnostics.push({
      code: "expired-package",
      severity: "error",
      message: "Package status is Expired.",
      path: "status",
    });
  }
  const expiresAt = parseTimestamp(value.expiresAt);
  if (expiresAt !== undefined && expiresAt <= nowMs) {
    diagnostics.push({
      code: "expired-package",
      severity: "error",
      message: "Package expiresAt is in the past.",
      path: "expiresAt",
    });
  }
}

function parseTimestamp(value: unknown): number | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const parsed = typeof value === "number" ? value : Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function hasErrors(diagnostics: readonly StudioPackageDiagnostic[]): boolean {
  return diagnostics.some((d) => d.severity === "error");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
