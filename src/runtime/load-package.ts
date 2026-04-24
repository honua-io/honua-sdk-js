/**
 * `loadMapPackage` — the first-class entry point that turns a server
 * `MapPackage` into a running MapLibre GL JS map. The caller owns the
 * `MaplibreMap` instance (peer dependency); the runtime composes the
 * style, resolves bindings through the shared contract, and hands the
 * composed style to `map.setStyle`.
 *
 * @module
 */

import { createDataset, type Dataset, type SourceResolver } from "../contract/index.js";
import type { HonuaClient } from "../core/client.js";
import { HonuaMap } from "../map/honua-map.js";
import type { HonuaStyleSpecification } from "../style/specification.js";
import { HonuaMapPackageError } from "./errors.js";
import { HONUA_MAP_PACKAGE_FORMAT_V1, type HonuaMapPackage } from "./map-package.js";
import {
  HonuaMapRuntime,
  type HonuaMapRuntimeReload,
  type HonuaRuntimeEventListener,
  type HonuaRuntimeTelemetry,
  type MaplibreMap,
} from "./runtime.js";
import type { PopupFactory, PopupRenderer } from "./popups.js";
import { projectSourceBindings, toHonuaSourceSpec } from "./source-bridge.js";
import { composeStyle, type StyleRefResolver, type ThemeResolver } from "./style-compose.js";

export interface LoadMapPackageOptions {
  /** Active `HonuaClient`; used for protocol adapter binding. */
  client: HonuaClient;
  /** Out-of-band style-ref body resolver. Only called when the ref has no inline body. */
  resolveStyleRef?: StyleRefResolver;
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
}

/**
 * Load a `MapPackage` onto a caller-provided `MaplibreMap`. Returns a
 * runtime handle that exposes the operational API. Throws
 * `HonuaMapPackageError` on binding failure; bubbles adapter errors
 * (`HonuaHttpError`, `HonuaCapabilityNotSupportedError`, ...) through
 * `source-error` events but does not swallow them.
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

  const compose = async (target: HonuaMapPackage): Promise<{ composed: HonuaStyleSpecification; dataset: Dataset; honuaMap: HonuaMap }> => {
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
    for (const descriptor of projection.descriptors) {
      const filter = projection.filtersBySourceId.get(descriptor.id);
      const honuaSpec = toHonuaSourceSpec(descriptor, filter);
      styleSources[descriptor.id] = honuaSpec;
      honuaMap.addSource(descriptor.id, honuaSpec);
    }
    for (const native of projection.nativeSources) {
      styleSources[native.sourceId] = native.spec;
      honuaMap.addSource(native.sourceId, native.spec);
    }

    const preComposed: HonuaStyleSpecification = {
      ...target.mapSpec,
      sources: styleSources,
    };

    for (const layer of preComposed.layers) {
      if (!honuaMap.hasLayer(layer.id)) honuaMap.addLayer(layer);
    }

    const composed = await composeStyle(target, preComposed, {
      resolveStyleRef: options.resolveStyleRef,
      resolveTheme: options.resolveTheme,
    });
    return { composed, dataset, honuaMap };
  };

  try {
    const { composed, dataset, honuaMap } = await compose(pkg);

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
      reload: async (next): Promise<HonuaMapRuntimeReload> => {
        const result = await compose(next);
        return { composed: result.composed, dataset: result.dataset, honuaMap: result.honuaMap };
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

    for (const sourceId of dataset.sourceIds()) {
      runtime._emit({ type: "source-ready", sourceId });
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
