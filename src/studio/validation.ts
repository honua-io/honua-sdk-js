/**
 * Unified validation and preview response envelopes shared across every
 * Studio package family and across the SDK, Console, MCP, and QGIS clients.
 *
 * The existing {@link ValidateMapPackageResult} (map family) stays unchanged;
 * {@link toStudioValidationResponse} and {@link fromMapPackageValidation}
 * adapt it into the generic {@link StudioPackageValidationResponse} envelope
 * without renaming or restructuring it. {@link HonuaMapPackageDiagnostic} is
 * already a structural subtype of {@link StudioPackageDiagnostic}.
 *
 * @experimental Not yet covered by the SDK's semver contract — these shapes
 *   may change in any minor release prior to `1.0.0`.
 * @module
 */

import type { ValidateMapPackageResult } from "../runtime/map-package-validation.js";
import type { HonuaMapPackage } from "../runtime/map-package.js";
import type { HonuaStudioPackageFamily } from "./types.js";

/**
 * Severity of a single {@link StudioPackageDiagnostic}. Matches the frozen
 * server / honua-sdk-dotnet `StudioPackageDiagnosticSeverity` enum members
 * (`info`, `warning`, `error`, `blocker`); the map-package validator emits only
 * `error`/`warning`, which remain assignable.
 */
export type StudioPackageDiagnosticSeverity = "info" | "warning" | "error" | "blocker";

/**
 * One diagnostic emitted while validating a Studio package. The shape is a
 * superset-compatible mirror of `HonuaMapPackageDiagnostic` so the map
 * validator's output adapts without conversion.
 *
 * @experimental
 */
export interface StudioPackageDiagnostic {
  readonly code: string;
  readonly severity: StudioPackageDiagnosticSeverity;
  readonly message: string;
  readonly path?: string;
  readonly detail?: unknown;
}

/**
 * Generic validation response envelope. Every package family returns the
 * same `{ valid, diagnostics, pkg? }` shape, so SDK, Console, MCP, and QGIS
 * clients consume one contract.
 *
 * @experimental
 */
export interface StudioPackageValidationResponse<T> {
  readonly valid: boolean;
  readonly diagnostics: readonly StudioPackageDiagnostic[];
  readonly pkg?: T;
}

/** Reference to a server-rendered preview artifact for a package. */
export interface StudioPreviewArtifactRef {
  readonly id?: string;
  readonly kind?: string;
  readonly url?: string;
  readonly mediaType?: string;
  readonly [extra: string]: unknown;
}

/**
 * Generic preview response envelope returned when a package is previewed
 * (composed without publishing). Diagnostics reuse the validation shape.
 *
 * @experimental
 */
export interface StudioPackagePreviewResponse<T> {
  readonly packageId?: string;
  readonly packageFamily?: HonuaStudioPackageFamily | (string & {});
  readonly pkg?: T;
  readonly diagnostics?: readonly StudioPackageDiagnostic[];
  readonly artifacts?: readonly StudioPreviewArtifactRef[];
  readonly expiresAt?: string;
  readonly [extra: string]: unknown;
}

/**
 * Loose shape a family-specific validation result must satisfy to be adapted
 * by {@link toStudioValidationResponse}. Diagnostics carry no index signature
 * so that results with extra diagnostic fields (e.g. `packageId` on
 * {@link HonuaMapPackageDiagnostic}) — and results that carry a named package
 * field alongside `valid`/`diagnostics` — assign without a structural index
 * signature on the caller's type.
 */
interface StudioValidationResultLike {
  readonly valid: boolean;
  readonly diagnostics: readonly {
    readonly code: string;
    readonly severity: StudioPackageDiagnosticSeverity;
    readonly message: string;
    readonly path?: string;
    readonly detail?: unknown;
  }[];
}

/**
 * Adapt any family validation result — an object with `valid`, `diagnostics`,
 * and a named package field — into the unified
 * {@link StudioPackageValidationResponse}. `pkgKey` names the field holding
 * the package (e.g. `"mapPackage"`). The package field is loosely typed; for
 * the map family prefer the fully-typed {@link fromMapPackageValidation}.
 *
 * @experimental
 */
export function toStudioValidationResponse<T>(
  result: StudioValidationResultLike,
  pkgKey: string,
): StudioPackageValidationResponse<T> {
  const pkg = (result as unknown as Record<string, unknown>)[pkgKey];
  return {
    valid: result.valid,
    diagnostics: [...result.diagnostics],
    ...(pkg === undefined ? {} : { pkg: pkg as T }),
  };
}

/**
 * Fully-typed convenience adapter from the map family's
 * {@link ValidateMapPackageResult} to a
 * {@link StudioPackageValidationResponse}. Equivalent to
 * `toStudioValidationResponse<HonuaMapPackage>(result, "mapPackage")`.
 *
 * @experimental
 */
export function fromMapPackageValidation(
  result: ValidateMapPackageResult,
): StudioPackageValidationResponse<HonuaMapPackage> {
  return toStudioValidationResponse<HonuaMapPackage>(result, "mapPackage");
}
