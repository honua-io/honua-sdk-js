/**
 * Browser-safe MapPackage / AppPackage projections for `honua-console`.
 *
 * A `MapPackage` (server: `honua_map_package.v1`) and a generated `AppPackage`
 * are **server-owned** artifacts already typed in `@honua/sdk-js/runtime`
 * ({@link HonuaMapPackage}) and `@honua/sdk-js/generated-app`
 * ({@link HonuaGeneratedAppPackage} / {@link HonuaGeneratedAppManifest}). This
 * module does not redefine those wire shapes; it projects them into the slim,
 * **SDK-projected** summaries a Console content browser renders without loading
 * the full runtime: identity, status, source/layer/chart inventory, sharing,
 * provenance, and a normalized title.
 *
 * Console flows that actually render a map or run a generated app continue to
 * use the runtime (`loadMapPackage`) and generated-app runtime
 * (`loadGeneratedAppRuntime`) directly — these projections are the lightweight
 * catalog/detail view, not a replacement for the runtimes.
 *
 * Ownership legend (shared across the Console contracts):
 * - **server-owned**: `HonuaMapPackage`, `HonuaGeneratedAppPackage`, and the
 *   manifest artifact embedded in an app package.
 * - **SDK-projected**: the `*Projection` summaries and projection helpers here.
 * - **Console-rendered**: UI state derived from these projections.
 *
 * @module
 */

import {
  HONUA_GENERATED_APP_MANIFEST_ARTIFACT_KIND,
  type HonuaGeneratedAppChartKind,
  type HonuaGeneratedAppManifest,
  type HonuaGeneratedAppPackage,
} from "../generated-app/index.js";
import { HONUA_MAP_PACKAGE_FORMAT_V1, type HonuaMapPackage } from "../runtime/index.js";
import type { HonuaConsoleMetadata, HonuaConsoleProvenance, HonuaConsoleSharing } from "./content.js";
import { HonuaConsoleError } from "./errors.js";

/**
 * SDK-projected summary of a single source binding on a MapPackage. Console
 * lists these in a package detail view without binding the runtime.
 */
export interface HonuaConsoleMapSourceSummary {
  readonly sourceId: string;
  readonly protocol: string;
  readonly url?: string;
  readonly attribution?: string;
}

/** SDK-projected catalog summary of a server MapPackage. */
export interface HonuaConsoleMapPackageProjection {
  readonly kind: "map-package";
  readonly id: string;
  readonly title?: string;
  readonly status?: string;
  readonly createdAt?: string;
  readonly updatedAt?: string;
  readonly expiresAt?: string;
  readonly previewArtifactId?: string;
  readonly sources: ReadonlyArray<HonuaConsoleMapSourceSummary>;
  readonly layerCount: number;
  readonly hasLegend: boolean;
  readonly initialView?: HonuaMapPackage["initialView"];
  readonly metadata?: HonuaConsoleMetadata;
  readonly sharing?: HonuaConsoleSharing;
  readonly provenance?: HonuaConsoleProvenance;
}

/** SDK-projected summary of one widget on a generated app. */
export interface HonuaConsoleAppWidgetSummary {
  readonly id: string;
  readonly kind: string;
  readonly title?: string;
  readonly chartKind?: HonuaConsoleAppChartKind;
}

/** Chart-kind vocabulary shared with the generated-app chart widget. */
export type HonuaConsoleAppChartKind = HonuaGeneratedAppChartKind;

/** SDK-projected catalog summary of a generated AppPackage. */
export interface HonuaConsoleAppPackageProjection {
  readonly kind: "app-package";
  readonly id: string;
  readonly version?: string;
  readonly title?: string;
  readonly description?: string;
  readonly profile?: string;
  readonly primarySourceId?: string;
  readonly mapPackageId?: string;
  readonly widgets: ReadonlyArray<HonuaConsoleAppWidgetSummary>;
  readonly chartKinds: ReadonlyArray<HonuaConsoleAppChartKind>;
  readonly metadata?: HonuaConsoleMetadata;
  readonly sharing?: HonuaConsoleSharing;
  readonly provenance?: HonuaConsoleProvenance;
}

/** Optional Console-side context attached to a projection. */
export interface HonuaConsolePackageProjectionContext {
  readonly metadata?: HonuaConsoleMetadata;
  readonly sharing?: HonuaConsoleSharing;
  readonly provenance?: HonuaConsoleProvenance;
}

function optional<K extends string, V>(key: K, value: V | undefined): Partial<Record<K, V>> {
  return value === undefined ? {} : ({ [key]: value } as Record<K, V>);
}

/**
 * Projects a server {@link HonuaMapPackage} into a slim Console catalog
 * summary. The package `format` is the version gate; an unexpected format
 * raises a typed `unsupported-package-format` error so Console can flag the
 * package instead of rendering a partial view.
 *
 * The full runtime (`loadMapPackage`) remains the way to actually render the
 * map; this projection only powers the catalog/detail surfaces.
 */
export function projectMapPackage(
  pkg: HonuaMapPackage,
  context: HonuaConsolePackageProjectionContext = {},
): HonuaConsoleMapPackageProjection {
  if (!pkg || typeof pkg !== "object") {
    throw new HonuaConsoleError("projection-failed", "MapPackage must be an object", {
      stage: "projection",
      detail: { path: "package", received: pkg },
    });
  }
  if (pkg.format !== HONUA_MAP_PACKAGE_FORMAT_V1) {
    throw new HonuaConsoleError("unsupported-package-format", `Unsupported MapPackage format "${String(pkg.format)}"`, {
      stage: "projection",
      detail: {
        packageId: pkg.mapPackageId,
        path: "format",
        received: pkg.format,
        expected: HONUA_MAP_PACKAGE_FORMAT_V1,
      },
    });
  }

  const sources: HonuaConsoleMapSourceSummary[] = (pkg.sourceBindings ?? []).map((binding) => ({
    sourceId: binding.sourceId,
    protocol: binding.protocol,
    ...optional("url", binding.locator?.url),
    ...optional("attribution", binding.attribution),
  }));

  const layers = Array.isArray(pkg.mapSpec?.layers) ? pkg.mapSpec.layers : [];
  const title = readStringField(pkg.metadata, "title") ?? context.metadata?.title;

  return {
    kind: "map-package",
    id: pkg.mapPackageId,
    ...optional("title", title),
    ...optional("status", pkg.status),
    ...optional("createdAt", pkg.createdAt),
    ...optional("updatedAt", pkg.updatedAt),
    ...optional("expiresAt", pkg.expiresAt),
    ...optional("previewArtifactId", pkg.previewArtifactId),
    sources,
    layerCount: layers.length,
    hasLegend: Array.isArray(pkg.legend) && pkg.legend.length > 0,
    ...optional("initialView", pkg.initialView),
    ...optional("metadata", context.metadata),
    ...optional("sharing", context.sharing),
    ...optional("provenance", context.provenance),
  };
}

function readStringField(value: unknown, key: string): string | undefined {
  if (value && typeof value === "object") {
    const field = (value as Record<string, unknown>)[key];
    if (typeof field === "string") return field;
  }
  return undefined;
}

function resolveManifest(pkg: HonuaGeneratedAppPackage): HonuaGeneratedAppManifest | undefined {
  // Match `projectAppPackageToGeneratedAppManifest` precedence: the canonical
  // server `manifest_artifact` wins over the camelCase compatibility alias so
  // the Console catalog summary and the launched runtime read the same manifest.
  const candidate = pkg.manifest_artifact ?? pkg.manifestArtifact;
  if (!candidate || typeof candidate !== "object") return undefined;
  // The artifact may be the manifest itself or a `{ artifactKind, manifest }` wrapper.
  const wrapper = candidate as { readonly artifactKind?: unknown; readonly manifest?: unknown };
  if (wrapper.artifactKind === HONUA_GENERATED_APP_MANIFEST_ARTIFACT_KIND && wrapper.manifest) {
    return wrapper.manifest as HonuaGeneratedAppManifest;
  }
  if ("layout" in candidate) {
    return candidate as HonuaGeneratedAppManifest;
  }
  return undefined;
}

/**
 * Projects a generated {@link HonuaGeneratedAppPackage} into a slim Console
 * catalog summary derived from its embedded manifest artifact. A package with
 * no resolvable manifest raises a typed `missing-binding` error so Console can
 * flag the broken package rather than show an empty app entry.
 *
 * The generated-app runtime (`loadGeneratedAppRuntime`) is still the way to
 * actually run the app; this projection only powers the catalog/detail surfaces
 * and reuses the shared `categories` / `histogram` / `time-series` chart-kind
 * vocabulary so Console and the runtime agree on chart inventory.
 */
export function projectAppPackage(
  pkg: HonuaGeneratedAppPackage,
  context: HonuaConsolePackageProjectionContext = {},
): HonuaConsoleAppPackageProjection {
  if (!pkg || typeof pkg !== "object") {
    throw new HonuaConsoleError("projection-failed", "AppPackage must be an object", {
      stage: "projection",
      detail: { path: "package", received: pkg },
    });
  }
  const manifest = resolveManifest(pkg);
  if (!manifest) {
    throw new HonuaConsoleError("missing-binding", `AppPackage "${pkg.id}" has no resolvable manifest artifact`, {
      stage: "projection",
      detail: { packageId: pkg.id, path: "manifestArtifact" },
    });
  }

  const widgets: HonuaConsoleAppWidgetSummary[] = (manifest.layout?.widgets ?? []).map((widget) => ({
    id: widget.id,
    kind: widget.kind,
    ...optional("title", widget.title),
    ...optional(
      "chartKind",
      widget.kind === "chart" ? (widget as { chartKind?: HonuaConsoleAppChartKind }).chartKind : undefined,
    ),
  }));

  const chartKinds = Array.from(
    new Set(
      widgets.map((widget) => widget.chartKind).filter((kind): kind is HonuaConsoleAppChartKind => kind !== undefined),
    ),
  );

  const title = manifest.title ?? context.metadata?.title;

  return {
    kind: "app-package",
    id: pkg.id,
    ...optional("version", pkg.version ?? manifest.version),
    ...optional("title", title),
    ...optional("description", manifest.description),
    ...optional("profile", manifest.profile),
    ...optional("primarySourceId", manifest.data?.sourceId),
    ...optional("mapPackageId", manifest.mapPackageId ?? manifest.mapPackage?.mapPackageId),
    widgets,
    chartKinds,
    ...optional("metadata", context.metadata),
    ...optional("sharing", context.sharing),
    ...optional("provenance", context.provenance),
  };
}
