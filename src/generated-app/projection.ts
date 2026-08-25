/**
 * Projection helpers from canonical builder/package artifacts into the
 * SDK generated-app manifest. These helpers are structural on purpose:
 * the canonical protobuf / server DTOs remain the source of truth, and this
 * subpath only extracts the browser-safe fields needed by the preview runtime.
 *
 * @module
 */

import type { HonuaMapPackage } from "../runtime/index.js";
import { HonuaGeneratedAppError } from "./errors.js";
import {
  HONUA_GENERATED_APP_MANIFEST_ARTIFACT_KIND,
  HONUA_GENERATED_APP_MANIFEST_ARTIFACT_VERSION,
  HONUA_GENERATED_APP_MANIFEST_FORMAT_V1,
  HONUA_GENERATED_APP_PROFILE_OPERATIONS_DASHBOARD_V1,
  type HonuaGeneratedAppBuildSpec,
  type HonuaGeneratedAppFieldBinding,
  type HonuaGeneratedAppManifest,
  type HonuaGeneratedAppManifestArtifact,
  type HonuaGeneratedAppPackage,
  type HonuaGeneratedAppWidget,
} from "./manifest.js";

export const HONUA_GENERATED_APP_DEFAULT_PREVIEW_LIMIT = 250;
export const HONUA_GENERATED_APP_MAX_PREVIEW_LIMIT = 1_000;
export const HONUA_GENERATED_APP_MAX_WIDGETS = 64;

export interface ProjectBuildSpecToGeneratedAppManifestOptions {
  readonly appId?: string;
  readonly version?: string;
  readonly sourceId?: string;
  readonly mapPackage?: HonuaMapPackage;
  readonly mapPackageId?: string;
  readonly bindings?: HonuaGeneratedAppFieldBinding;
  readonly widgets?: ReadonlyArray<HonuaGeneratedAppWidget>;
}

export interface ProjectMapPackageToGeneratedAppManifestOptions {
  readonly appId?: string;
  readonly title?: string;
  readonly version?: string;
  readonly sourceId?: string;
  readonly bindings?: HonuaGeneratedAppFieldBinding;
  readonly widgets?: ReadonlyArray<HonuaGeneratedAppWidget>;
}

export function createGeneratedAppManifestArtifact(
  manifest: HonuaGeneratedAppManifest,
  options: { readonly createdAt?: string; readonly source?: string } = {},
): HonuaGeneratedAppManifestArtifact {
  assertGeneratedAppManifest(manifest);
  return {
    artifactKind: HONUA_GENERATED_APP_MANIFEST_ARTIFACT_KIND,
    artifactVersion: HONUA_GENERATED_APP_MANIFEST_ARTIFACT_VERSION,
    manifest,
    ...(options.createdAt ? { createdAt: options.createdAt } : {}),
    ...(options.source ? { source: options.source } : {}),
  };
}

export function projectAppPackageToGeneratedAppManifest(
  pkg: HonuaGeneratedAppPackage,
  options: { readonly mapPackage?: HonuaMapPackage } = {},
): HonuaGeneratedAppManifest {
  const artifact = pkg.manifest_artifact ?? pkg.manifestArtifact;
  if (!artifact) {
    throw new HonuaGeneratedAppError(
      "missing-manifest-artifact",
      "AppPackage is missing manifest_artifact for generated-app preview",
      {
        stage: "projection",
        detail: { appId: pkg.id, path: "AppPackage.manifest_artifact" },
      },
    );
  }

  const manifest = extractManifestArtifact(artifact, pkg.id);
  assertGeneratedAppManifest(manifest);

  const mapPackage = manifest.mapPackage ?? options.mapPackage ?? pkg.mapPackage;
  return clampGeneratedAppManifest({
    ...manifest,
    appId: manifest.appId || pkg.id,
    version: manifest.version ?? pkg.version,
    ...(mapPackage ? { mapPackage, mapPackageId: manifest.mapPackageId ?? mapPackage.mapPackageId } : {}),
  });
}

export function projectBuildSpecToGeneratedAppManifest(
  buildSpec: HonuaGeneratedAppBuildSpec,
  options: ProjectBuildSpecToGeneratedAppManifestOptions = {},
): HonuaGeneratedAppManifest {
  const profile = buildSpec.profile ?? buildSpec.appProfile ?? HONUA_GENERATED_APP_PROFILE_OPERATIONS_DASHBOARD_V1;
  if (profile !== HONUA_GENERATED_APP_PROFILE_OPERATIONS_DASHBOARD_V1) {
    throw new HonuaGeneratedAppError("unsupported-profile", `unsupported generated app profile "${profile}"`, {
      stage: "projection",
      detail: {
        appId: buildSpec.appId ?? buildSpec.id ?? options.appId,
        expected: HONUA_GENERATED_APP_PROFILE_OPERATIONS_DASHBOARD_V1,
        received: profile,
      },
    });
  }

  const bindings = { ...(options.bindings ?? {}), ...(buildSpec.bindings ?? {}) };
  const sourceId = options.sourceId ?? buildSpec.sourceId ?? buildSpec.primarySourceId ?? bindings.sourceId;
  if (!sourceId) {
    throw new HonuaGeneratedAppError("missing-binding", "BuildSpec projection requires a sourceId", {
      stage: "projection",
      detail: { appId: buildSpec.appId ?? buildSpec.id ?? options.appId, path: "BuildSpec.sourceId" },
    });
  }

  const widgets = clampGeneratedAppWidgets(
    options.widgets ?? buildSpec.widgets ?? buildSpec.layout?.widgets ?? defaultOperationsWidgets(bindings),
  );
  const previewLimit = clampGeneratedAppPreviewLimit(
    (buildSpec as { data?: { previewLimit?: number } }).data?.previewLimit,
  );
  return clampGeneratedAppManifest({
    format: HONUA_GENERATED_APP_MANIFEST_FORMAT_V1,
    profile: HONUA_GENERATED_APP_PROFILE_OPERATIONS_DASHBOARD_V1,
    appId: options.appId ?? buildSpec.appId ?? buildSpec.id ?? "generated-app",
    ...(buildSpec.title ? { title: buildSpec.title } : {}),
    ...(buildSpec.description ? { description: buildSpec.description } : {}),
    ...(options.version ? { version: options.version } : {}),
    data: {
      sourceId,
      ...(previewLimit === undefined ? {} : { previewLimit }),
    },
    ...((options.mapPackageId ?? options.mapPackage?.mapPackageId)
      ? { mapPackageId: options.mapPackageId ?? options.mapPackage?.mapPackageId }
      : {}),
    ...(options.mapPackage ? { mapPackage: options.mapPackage } : {}),
    layout: {
      kind: "operations-dashboard",
      widgets,
    },
    ...(Object.keys(bindings).length > 0 ? { bindings } : {}),
    ...(buildSpec.initialState ? { initialState: buildSpec.initialState } : {}),
    ...(buildSpec.linkedViewPreset ? { linkedViewPreset: buildSpec.linkedViewPreset } : {}),
    metadata: {
      buildSpec,
    },
  });
}

export function projectMapPackageToGeneratedAppManifest(
  mapPackage: HonuaMapPackage,
  options: ProjectMapPackageToGeneratedAppManifestOptions = {},
): HonuaGeneratedAppManifest {
  const sourceId = options.sourceId ?? mapPackage.sourceBindings[0]?.sourceId;
  if (!sourceId) {
    throw new HonuaGeneratedAppError("missing-binding", "MapPackage projection requires at least one source binding", {
      stage: "projection",
      detail: { appId: options.appId, path: "MapPackage.sourceBindings" },
    });
  }

  const bindings = {
    sourceId,
    layerId: firstLayerIdForSource(mapPackage, sourceId),
    ...(options.bindings ?? {}),
  };
  return clampGeneratedAppManifest({
    format: HONUA_GENERATED_APP_MANIFEST_FORMAT_V1,
    profile: HONUA_GENERATED_APP_PROFILE_OPERATIONS_DASHBOARD_V1,
    // `previewArtifactId` is deliberately NOT a fallback here. It names a
    // rendered *preview* artifact — an ephemeral by-product of composing the
    // map — while `appId` is the manifest's stable identity, persisted inside
    // `HonuaGeneratedAppManifestArtifact` and carried into every app package
    // built from it. Preferring the preview id (as this once did) minted a
    // persisted identity out of something that was never persisted, and did it
    // in preference to the package's real server-assigned id. #1426: a preview
    // is never reported as persisted. The preview reference still travels, in
    // its own field, on `manifest.mapPackage.previewArtifactId`.
    appId: options.appId ?? mapPackage.mapPackageId,
    title: options.title ?? mapPackage.templateId ?? "Generated operations dashboard",
    ...(options.version ? { version: options.version } : {}),
    data: { sourceId },
    mapPackageId: mapPackage.mapPackageId,
    mapPackage,
    layout: {
      kind: "operations-dashboard",
      widgets: options.widgets ?? defaultOperationsWidgets(bindings),
    },
    bindings,
    metadata: {
      mapPackageId: mapPackage.mapPackageId,
    },
  });
}

export function assertGeneratedAppManifest(manifest: HonuaGeneratedAppManifest): void {
  if (manifest.format !== HONUA_GENERATED_APP_MANIFEST_FORMAT_V1) {
    throw new HonuaGeneratedAppError(
      "missing-manifest",
      `unsupported generated app manifest format "${String(manifest.format)}"`,
      {
        stage: "manifest",
        detail: {
          appId: manifest.appId,
          path: "GeneratedAppManifest.format",
          expected: HONUA_GENERATED_APP_MANIFEST_FORMAT_V1,
          received: manifest.format,
        },
      },
    );
  }
  if (manifest.profile !== HONUA_GENERATED_APP_PROFILE_OPERATIONS_DASHBOARD_V1) {
    throw new HonuaGeneratedAppError(
      "unsupported-profile",
      `unsupported generated app profile "${String(manifest.profile)}"`,
      {
        stage: "manifest",
        detail: {
          appId: manifest.appId,
          path: "GeneratedAppManifest.profile",
          expected: HONUA_GENERATED_APP_PROFILE_OPERATIONS_DASHBOARD_V1,
          received: manifest.profile,
        },
      },
    );
  }
  if (!manifest.data?.sourceId) {
    throw new HonuaGeneratedAppError("missing-binding", "GeneratedAppManifest.data.sourceId is required", {
      stage: "manifest",
      detail: { appId: manifest.appId, path: "GeneratedAppManifest.data.sourceId" },
    });
  }
  if (!manifest.layout || manifest.layout.kind !== "operations-dashboard" || !Array.isArray(manifest.layout.widgets)) {
    throw new HonuaGeneratedAppError("missing-binding", "GeneratedAppManifest.layout.widgets is required", {
      stage: "manifest",
      detail: { appId: manifest.appId, path: "GeneratedAppManifest.layout.widgets" },
    });
  }
}

function extractManifestArtifact(
  artifact: HonuaGeneratedAppManifestArtifact | HonuaGeneratedAppManifest,
  appId: string,
): HonuaGeneratedAppManifest {
  if ("artifactKind" in artifact || "artifactVersion" in artifact) {
    const manifestArtifact = artifact as HonuaGeneratedAppManifestArtifact;
    if (manifestArtifact.artifactKind !== HONUA_GENERATED_APP_MANIFEST_ARTIFACT_KIND) {
      throw new HonuaGeneratedAppError(
        "missing-manifest-artifact",
        "unsupported generated-app manifest artifact kind",
        {
          stage: "projection",
          detail: {
            appId,
            path: "AppPackage.manifest_artifact.artifactKind",
            expected: HONUA_GENERATED_APP_MANIFEST_ARTIFACT_KIND,
            received: manifestArtifact.artifactKind,
          },
        },
      );
    }
    if (manifestArtifact.artifactVersion !== HONUA_GENERATED_APP_MANIFEST_ARTIFACT_VERSION) {
      throw new HonuaGeneratedAppError(
        "missing-manifest-artifact",
        "unsupported generated-app manifest artifact version",
        {
          stage: "projection",
          detail: {
            appId,
            path: "AppPackage.manifest_artifact.artifactVersion",
            expected: HONUA_GENERATED_APP_MANIFEST_ARTIFACT_VERSION,
            received: manifestArtifact.artifactVersion,
          },
        },
      );
    }
    return manifestArtifact.manifest;
  }
  return artifact;
}

function defaultOperationsWidgets(bindings: HonuaGeneratedAppFieldBinding): ReadonlyArray<HonuaGeneratedAppWidget> {
  const sourceId = bindings.sourceId;
  const filterField = bindings.filterField ?? bindings.categoryField ?? "category";
  const categoryField = bindings.categoryField ?? bindings.filterField ?? "category";
  const tableFields = bindings.tableFields;
  const layerId = bindings.layerId;
  return [
    { id: "map", kind: "map", title: "Map", sourceId, layerId },
    { id: "table", kind: "table", title: "Results", sourceId, fields: tableFields },
    { id: "count", kind: "count", title: "Count", sourceId },
    { id: "chart", kind: "chart", title: "By category", sourceId, groupBy: categoryField },
    { id: "filter", kind: "filter", title: "Filter", sourceId, field: filterField },
  ];
}

function firstLayerIdForSource(mapPackage: HonuaMapPackage, sourceId: string): string | undefined {
  return mapPackage.mapSpec.layers.find((layer) => layer.source === sourceId)?.id;
}

export function clampGeneratedAppManifest(manifest: HonuaGeneratedAppManifest): HonuaGeneratedAppManifest {
  const widgets = clampGeneratedAppWidgets(manifest.layout.widgets);
  const previewLimit = clampGeneratedAppPreviewLimit(manifest.data.previewLimit);
  const data =
    previewLimit === manifest.data.previewLimit ? manifest.data : dataWithPreviewLimit(manifest, previewLimit);
  return {
    ...manifest,
    data,
    layout: {
      ...manifest.layout,
      widgets,
    },
  };
}

function dataWithPreviewLimit(
  manifest: HonuaGeneratedAppManifest,
  previewLimit: number | undefined,
): HonuaGeneratedAppManifest["data"] {
  const { previewLimit: _previewLimit, ...rest } = manifest.data;
  return {
    ...rest,
    ...(previewLimit === undefined ? {} : { previewLimit }),
  };
}

export function clampGeneratedAppPreviewLimit(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isFinite(value)) return undefined;
  return Math.max(1, Math.min(HONUA_GENERATED_APP_MAX_PREVIEW_LIMIT, Math.trunc(value)));
}

export function clampGeneratedAppWidgets(
  widgets: ReadonlyArray<HonuaGeneratedAppWidget>,
): ReadonlyArray<HonuaGeneratedAppWidget> {
  return widgets.length > HONUA_GENERATED_APP_MAX_WIDGETS ? widgets.slice(0, HONUA_GENERATED_APP_MAX_WIDGETS) : widgets;
}
