/**
 * `loadMapPackage` — the first-class entry point that turns a server
 * `MapPackage` into a running MapLibre GL JS map. The caller owns the
 * `MaplibreMap` instance (peer dependency); the runtime composes the
 * style, resolves bindings through the shared contract, and hands the
 * composed style to `map.setStyle`.
 *
 * @module
 */

import { type Dataset, type SourceDescriptor, type SourceResolver, createDataset } from "../contract/index.js";
import type { HonuaClient } from "../core/client.js";
import { HonuaMap } from "../map/honua-map.js";
import type { HonuaLayerSpecification, HonuaStyleSpecification } from "../style/specification.js";
import { HonuaMapPackageError } from "./errors.js";
import { HONUA_MAP_PACKAGE_FORMAT_V1, type HonuaMapPackage } from "./map-package.js";
import {
  OFFLINE_REGION_PROTOCOL_SCHEME,
  type OfflineRegionTileHandler,
  ensureOfflineRegionProtocol,
  styleUsesOfflineRegion,
} from "./offline-region-protocol.js";
import { rewriteStyleTilesForOfflineRegion } from "./offline-region-style.js";
import { createOgcStyleRefResolver } from "./ogc-styles.js";
import { type MaplibreProtocolRegistrar, ensurePmtilesProtocol, styleUsesPmtiles } from "./pmtiles-protocol.js";
import type { PopupFactory, PopupRenderer } from "./popups.js";
import {
  HonuaMapRuntime,
  type HonuaMapRuntimeReload,
  type HonuaRuntimeEventListener,
  type HonuaRuntimeTelemetry,
  type MaplibreMap,
} from "./runtime.js";
import { projectSourceBindings, toHonuaSourceSpec } from "./source-bridge.js";
import { type StyleRefResolver, type ThemeResolver, composeStyle } from "./style-compose.js";
import { throwRuntimeDiagnostics } from "./style-interactions.js";
import { prepareRuntimeStyleSpecValidation } from "./style-spec-validation.js";
import type { RuntimeStyleSpecValidationMode } from "./style-spec-validation.js";

/**
 * How `loadMapPackage` reacts when a single protocol-backed source
 * binding fails to project / build a Honua source spec. Defaults to
 * `"tolerant"` because the entire point of mixed-protocol composition is
 * that one bad source should not break the rest of the map.
 *
 * Per-source binding failures still surface loudly under `"tolerant"`:
 *
 *  - the runtime emits a `{ type: "source-error", sourceId, error }`
 *    event,
 *  - {@link HonuaRuntimeTelemetry.error} receives a `source-bind` span,
 *  - layers whose `source` references a failed source are dropped from
 *    the composed style so MapLibre does not throw on a missing source.
 *
 * `"fail-fast"` preserves the historical single-source behaviour: any
 * per-source binding failure rejects the load with
 * `HonuaMapPackageError({ stage: "source-bind" })`. Configuration-level
 * binding errors (unknown protocol, missing locator, duplicate id,
 * deferred `workspace_artifact`) raised by `projectSourceBindings`
 * always fail-fast under either policy — those are operator errors that
 * must be fixed.
 */
export type SourceErrorPolicy = "tolerant" | "fail-fast";

export interface LoadMapPackageOptions {
  /** Active `HonuaClient`; used for protocol adapter binding. */
  client: HonuaClient;
  /**
   * Out-of-band style-ref body resolver. Only called when the ref has no
   * inline body. When omitted, the runtime defaults to resolving
   * `styleRefs.styleId` against the server's OGC API – Styles surface
   * (`GET /ogc/styles/{styleId}`, content-negotiated MapLibre) via
   * {@link createOgcStyleRefResolver}, so the JS identifier matches the
   * server's canonical styleId. Pass a callback to override that path
   * (back-compat), or set {@link disableDefaultStyleRefResolver} to skip it.
   */
  resolveStyleRef?: StyleRefResolver;
  /**
   * Disable the default `/ogc/styles` StyleRef resolver. When true and no
   * {@link resolveStyleRef} callback is supplied, style refs without an
   * inline body are left unresolved (composition then errors on them).
   */
  disableDefaultStyleRefResolver?: boolean;
  /** Out-of-band theme resolver. Only called when `pkg.theme` is absent and `pkg.themeId` is set. */
  resolveTheme?: ThemeResolver;
  /**
   * Resolver passed to `createDataset` for adapters the built-in set
   * (`geoservices-*`, `ogc-features`) does not cover — typically the
   * WFS/WMS/OData/tile-layer adapters contributed by `#24`–`#28`.
   */
  resolveSource?: SourceResolver;
  /** Skip `client.checkCompatibility()` — useful in tests and conformance fixtures. */
  skipCompatibilityCheck?: boolean;
  /** Telemetry collector; wired through the `HonuaClient` interceptor chain. */
  telemetry?: HonuaRuntimeTelemetry;
  /** Optional popup factory; required only if the caller calls `runtime.bindPopup`. */
  popupFactory?: PopupFactory;
  /** Optional popup renderer; defaults to an unstyled `<dl>` of feature properties. */
  popupRenderer?: PopupRenderer;
  /**
   * When true, apply `pkg.initialView` to the map immediately after load.
   * Defaults to `true`.
   */
  applyInitialView?: boolean;
  /**
   * Listener registered on the runtime **before** the first
   * `source-ready` / `package-loaded` emissions so callers can observe
   * the initial lifecycle without race-binding through
   * `runtime.on(...)`. Equivalent to calling `runtime.on(listener)`
   * immediately after construction. Subsequent events (updatePackage,
   * disposed, …) also flow through this listener.
   */
  onEvent?: HonuaRuntimeEventListener;
  /**
   * Per-source binding error policy. Defaults to `"tolerant"`: a single
   * source failing to bind (resolver throws, `toHonuaSourceSpec` throws,
   * `dataset.source(id)` throws) does not abort the whole package load.
   * Failed sources surface via `source-error` events and the
   * {@link HonuaRuntimeTelemetry.error} hook; remaining sources continue
   * to render. Pass `"fail-fast"` to reject the load on any per-source
   * binding failure (the historical single-source behaviour).
   */
  sourceErrorPolicy?: SourceErrorPolicy;
  /**
   * MapLibre style-spec validation mode used by runtime source/layer
   * mutation helpers. Defaults to `"strict"`; pass `"warning-only"` to
   * keep diagnostics non-fatal, or `"renderer-deferred"` to skip SDK
   * style-spec checks and let the renderer report invalid style values.
   */
  styleSpecValidationMode?: RuntimeStyleSpecValidationMode;
  /**
   * Serve the named style sources from a persisted offline region.
   *
   * The handler comes from `@honua/sdk-js/offline` because it is bound to one
   * region manifest, one store, and one authorization scope — none of which the
   * runtime can invent. When `sourceIds` are given the composed style's tile
   * templates are rewritten onto `offline-region://` before `map.setStyle`, and
   * a source that cannot be rewritten exactly fails the load rather than
   * quietly continuing to render live tiles.
   */
  offlineRegion?: LoadMapPackageOfflineRegion;
}

/** Binding between a composed style and one persisted offline region. */
export interface LoadMapPackageOfflineRegion {
  /** Handler from `createOfflineRegionTileProtocol()` in `@honua/sdk-js/offline`. */
  readonly tileHandler: OfflineRegionTileHandler;
  /** Style source ids to rewrite onto the region. Omit to bind an already-rewritten style. */
  readonly sourceIds?: readonly string[];
  /** Tile-matrix-set segment of the rewritten URLs. Defaults to `"default"`. */
  readonly tileMatrixSetId?: string;
  /** Injected MapLibre registrar; defaults to the lazily imported peer. */
  readonly maplibre?: MaplibreProtocolRegistrar;
}

/**
 * Point the named sources at the region, or fail the load.
 *
 * A refusal is fatal here on purpose: the caller named these sources precisely
 * because they must come from storage, so leaving one on its network template
 * would render live tiles while the application believed it was offline-backed.
 */
function bindOfflineRegionStyle(
  style: HonuaStyleSpecification,
  packageId: string | undefined,
  region: LoadMapPackageOfflineRegion | undefined,
): HonuaStyleSpecification {
  if (!region?.sourceIds || region.sourceIds.length === 0) return style;
  const rewrite = rewriteStyleTilesForOfflineRegion(style, {
    sourceIds: region.sourceIds,
    ...(region.tileMatrixSetId !== undefined ? { tileMatrixSetId: region.tileMatrixSetId } : {}),
  });
  if (rewrite.refusals.length > 0) {
    throw new HonuaMapPackageError("offline-region style binding refused a source it cannot rewrite exactly", {
      ...(packageId === undefined ? {} : { packageId }),
      stage: "style-compose",
      detail: { refusals: rewrite.refusals },
    });
  }
  return rewrite.style;
}

/**
 * Load a `MapPackage` onto a caller-provided `MaplibreMap`. Returns a
 * runtime handle that exposes the operational API. Throws
 * `HonuaMapPackageError` on binding failure. Query-time adapter errors
 * (`HonuaHttpError`, `HonuaCapabilityNotSupportedError`, ...) continue
 * to flow through the returned `Source` promises on `runtime.dataset`
 * and through the shared `HonuaClient` interceptor chain.
 *
 * Per-source binding tolerance is governed by
 * {@link LoadMapPackageOptions.sourceErrorPolicy} — the default
 * `"tolerant"` policy lets a heterogeneous (mixed-protocol) composition
 * keep rendering when one source fails by skipping the failing source
 * (and any layers that reference it) and emitting a `source-error`
 * runtime event plus a `source-bind` telemetry error span. Pass
 * `"fail-fast"` to restore the historical reject-on-any-binding-failure
 * behaviour.
 */
export async function loadMapPackage(
  pkg: HonuaMapPackage,
  map: MaplibreMap,
  options: LoadMapPackageOptions,
): Promise<HonuaMapRuntime> {
  assertPackageFormat(pkg);

  const startedAt = Date.now();
  options.telemetry?.before?.({
    kind: "load",
    packageId: pkg.mapPackageId,
    startedAt,
  });

  const sourceErrorPolicy: SourceErrorPolicy = options.sourceErrorPolicy ?? "tolerant";
  const styleSpecValidationMode: RuntimeStyleSpecValidationMode = options.styleSpecValidationMode ?? "strict";
  // Default StyleRef resolution to the server's OGC API – Styles surface so
  // `styleRefs.styleId` aligns with the server's canonical styleId. A
  // caller-supplied callback overrides this for back-compat.
  const styleRefResolver: StyleRefResolver | undefined =
    options.resolveStyleRef ??
    (options.disableDefaultStyleRefResolver ? undefined : createOgcStyleRefResolver({ client: options.client }));
  throwRuntimeDiagnostics(
    await prepareRuntimeStyleSpecValidation(styleSpecValidationMode),
    "Cannot initialize MapLibre style-spec validation.",
  );

  const compose = async (
    target: HonuaMapPackage,
  ): Promise<{
    composed: HonuaStyleSpecification;
    dataset: Dataset;
    honuaMap: HonuaMap;
    failedSources: ReadonlyArray<{ sourceId: string; error: unknown }>;
  }> => {
    const projection = projectSourceBindings(target.mapPackageId, target.sourceBindings);

    const dataset = createDataset({
      id: target.mapPackageId,
      client: options.client,
      sources: projection.descriptors,
      resolveSource: options.resolveSource,
      skipCompatibilityCheck: options.skipCompatibilityCheck,
    });

    const honuaMap = new HonuaMap({ client: options.client });

    const styleSources: HonuaStyleSpecification["sources"] = { ...target.mapSpec.sources };
    const failedSources: Array<{ sourceId: string; error: unknown }> = [];
    const failedSourceIds = new Set<string>();

    const recordSourceFailure = (descriptor: SourceDescriptor, cause: unknown): void => {
      if (sourceErrorPolicy === "fail-fast") {
        if (cause instanceof HonuaMapPackageError) throw cause;
        throw new HonuaMapPackageError(`binding source "${descriptor.id}" failed`, {
          packageId: target.mapPackageId,
          stage: "source-bind",
          detail: { sourceId: descriptor.id, protocol: descriptor.protocol },
          cause,
        });
      }
      failedSourceIds.add(descriptor.id);
      failedSources.push({ sourceId: descriptor.id, error: cause });
      // The tolerant contract is "failed sources are dropped from
      // composedStyle.sources". Inline `mapSpec.sources` entries that
      // collide with a failing binding id must go too — otherwise the
      // composed style still advertises the failed source through the
      // predeclared spec, which contradicts the documented behaviour.
      delete styleSources[descriptor.id];
    };

    for (const descriptor of projection.descriptors) {
      try {
        const filter = projection.filtersBySourceId.get(descriptor.id);
        const honuaSpec = toHonuaSourceSpec(descriptor, filter);
        // Eagerly materialize so a `resolveSource` rejection (or missing
        // built-in resolver) surfaces at bind time rather than the first
        // query-time call. The built-in adapter constructors are
        // side-effect free (no HTTP), so eager resolution is cheap.
        dataset.source(descriptor.id);
        // Commit to honuaMap before exposing the spec on styleSources so
        // a thrown addSource cannot leave the failed source in
        // composedStyle.sources after the catch records the failure.
        honuaMap.addSource(descriptor.id, honuaSpec);
        styleSources[descriptor.id] = honuaSpec;
      } catch (cause) {
        recordSourceFailure(descriptor, cause);
      }
    }
    for (const native of projection.nativeSources) {
      styleSources[native.sourceId] = native.spec;
      honuaMap.addSource(native.sourceId, native.spec);
    }
    for (const [sourceId, source] of Object.entries(styleSources)) {
      if (!honuaMap.hasSource(sourceId)) honuaMap.addSource(sourceId, source);
    }

    const layers = filterLayersByAvailableSource(target.mapSpec.layers, failedSourceIds);

    const preComposed: HonuaStyleSpecification = {
      ...target.mapSpec,
      sources: styleSources,
      layers,
    };

    for (const layer of preComposed.layers) {
      if (!honuaMap.hasLayer(layer.id)) honuaMap.addLayer(layer);
    }

    const styled = await composeStyle(target, preComposed, {
      resolveStyleRef: styleRefResolver,
      resolveTheme: options.resolveTheme,
    });
    const composed = bindOfflineRegionStyle(styled, target.mapPackageId, options.offlineRegion);
    // Auto-register the MapLibre `pmtiles://` protocol before the caller (or
    // `runtime.reload`) hands this style to `map.setStyle`, so PMTiles-backed
    // sources render with no manual `addProtocol` wiring. Idempotent across
    // maps and no-ops (zero import cost) when no source uses PMTiles.
    if (styleUsesPmtiles(composed)) {
      await ensurePmtilesProtocol();
    }
    // Same contract for a persisted offline region: register on the evidence of
    // the composed style, and refuse to hand MapLibre a style that addresses a
    // region without the handler that can answer it — a missing handler renders
    // blank tiles instead of failing.
    if (styleUsesOfflineRegion(composed)) {
      const region = options.offlineRegion;
      if (!region) {
        throw new HonuaMapPackageError(
          "the composed style addresses an offline region but no offlineRegion tile handler was supplied",
          {
            packageId: target.mapPackageId,
            stage: "style-compose",
            detail: { scheme: OFFLINE_REGION_PROTOCOL_SCHEME },
          },
        );
      }
      await ensureOfflineRegionProtocol({
        tileHandler: region.tileHandler,
        ...(region.maplibre ? { maplibre: region.maplibre } : {}),
      });
    }
    return { composed, dataset, honuaMap, failedSources };
  };

  try {
    const { composed, dataset, honuaMap, failedSources } = await compose(pkg);

    map.setStyle(composed);

    const packageRef = { current: pkg };
    const runtime = new HonuaMapRuntime({
      map,
      honuaMap,
      dataset,
      composedStyle: composed,
      packageRef,
      telemetry: options.telemetry,
      popupFactory: options.popupFactory,
      popupRenderer: options.popupRenderer,
      styleSpecValidationMode,
      reload: async (next): Promise<HonuaMapRuntimeReload> => {
        const result = await compose(next);
        for (const failed of result.failedSources) {
          emitSourceBindFailure(options.telemetry, next.mapPackageId, failed);
        }
        return {
          composed: result.composed,
          dataset: result.dataset,
          honuaMap: result.honuaMap,
          failedSources: result.failedSources,
        };
      },
    });

    // Register the caller's listener before emitting initial lifecycle
    // events so callers can observe source-ready / package-loaded once
    // per load instead of losing them to a race before runtime.on(...).
    if (options.onEvent) {
      runtime.on(options.onEvent);
    }

    if (options.applyInitialView !== false && pkg.initialView) {
      try {
        runtime.setViewState({
          ...(pkg.initialView.bbox ? { bbox: pkg.initialView.bbox } : {}),
          ...(pkg.initialView.center ? { center: pkg.initialView.center } : {}),
          ...(pkg.initialView.zoom !== undefined ? { zoom: pkg.initialView.zoom } : {}),
          ...(pkg.initialView.pitch !== undefined ? { pitch: pkg.initialView.pitch } : {}),
          ...(pkg.initialView.bearing !== undefined ? { bearing: pkg.initialView.bearing } : {}),
        });
      } catch (cause) {
        throw new HonuaMapPackageError("applying initialView failed", {
          packageId: pkg.mapPackageId,
          stage: "view",
          cause,
        });
      }
    }

    const failedIds = new Set(failedSources.map((entry) => entry.sourceId));
    for (const sourceId of dataset.sourceIds()) {
      if (failedIds.has(sourceId)) continue;
      runtime._emit({ type: "source-ready", sourceId });
    }
    for (const failed of failedSources) {
      emitSourceBindFailure(options.telemetry, pkg.mapPackageId, failed);
      runtime._emit({ type: "source-error", sourceId: failed.sourceId, error: failed.error });
    }
    runtime._emit({ type: "package-loaded", packageId: pkg.mapPackageId });

    const finishedAt = Date.now();
    options.telemetry?.after?.({
      kind: "load",
      packageId: pkg.mapPackageId,
      startedAt,
      finishedAt,
      durationMs: finishedAt - startedAt,
    });

    return runtime;
  } catch (error) {
    const finishedAt = Date.now();
    options.telemetry?.error?.({
      kind: "load",
      packageId: pkg.mapPackageId,
      startedAt,
      finishedAt,
      durationMs: finishedAt - startedAt,
      error,
    });
    if (error instanceof HonuaMapPackageError) throw error;
    throw new HonuaMapPackageError("loadMapPackage failed", {
      packageId: pkg.mapPackageId,
      stage: "load",
      cause: error,
    });
  }
}

function filterLayersByAvailableSource(
  layers: ReadonlyArray<HonuaLayerSpecification>,
  failedSourceIds: ReadonlySet<string>,
): HonuaLayerSpecification[] {
  if (failedSourceIds.size === 0) return [...layers];
  return layers.filter((layer) => {
    const sourceId = typeof layer.source === "string" ? layer.source : undefined;
    if (sourceId === undefined) return true;
    return !failedSourceIds.has(sourceId);
  });
}

function emitSourceBindFailure(
  telemetry: HonuaRuntimeTelemetry | undefined,
  packageId: string | undefined,
  failed: { sourceId: string; error: unknown },
): void {
  if (!telemetry?.error) return;
  const startedAt = Date.now();
  telemetry.error({
    kind: "source-bind",
    packageId,
    startedAt,
    finishedAt: startedAt,
    durationMs: 0,
    detail: { sourceId: failed.sourceId },
    error: failed.error,
  });
}

function assertPackageFormat(pkg: HonuaMapPackage): void {
  if (pkg.format !== HONUA_MAP_PACKAGE_FORMAT_V1) {
    throw new HonuaMapPackageError(
      `unsupported MapPackage format "${String(pkg.format)}"; runtime supports "${HONUA_MAP_PACKAGE_FORMAT_V1}"`,
      {
        packageId: pkg.mapPackageId,
        stage: "load",
        detail: { received: pkg.format, expected: HONUA_MAP_PACKAGE_FORMAT_V1 },
      },
    );
  }
  if (!Array.isArray(pkg.sourceBindings)) {
    throw new HonuaMapPackageError("MapPackage.sourceBindings must be an array", {
      packageId: pkg.mapPackageId,
      stage: "load",
    });
  }
  if (!pkg.mapSpec || typeof pkg.mapSpec !== "object") {
    throw new HonuaMapPackageError("MapPackage.mapSpec is required", {
      packageId: pkg.mapPackageId,
      stage: "load",
    });
  }
}
