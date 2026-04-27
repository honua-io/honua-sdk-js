/**
 * `MapWorkspaceController` — orchestrates the `HonuaMapRuntime` and the
 * `ExplorationContext` for a single result `MapPackage`. The controller
 * owns no MapLibre source/style code of its own — every map mutation
 * delegates to the runtime from `src/runtime/`.
 *
 * @module
 */

import {
  type ExplorationContext,
  type LinkedViewPresetName,
  type ViewHandle,
  createExplorationContext,
} from "../../exploration/index.js";
import {
  type HonuaMapPackage,
  type HonuaMapPackagePopupBinding,
  type HonuaMapRuntime,
  type LegendEntry,
  type LoadMapPackageOptions,
  type MaplibreMap,
  type SetViewStateInput,
  loadMapPackage,
} from "../../runtime/index.js";
import type { OperatorClient } from "../client.js";
import { HonuaOperatorMapError } from "../errors.js";
import type { OperatorTelemetry } from "../telemetry.js";
import { ListenerBag, type Unsubscribe, withTelemetrySpan } from "./base.js";

export type MapWorkspaceEvent =
  | { kind: "package-loaded"; pkg: HonuaMapPackage }
  | { kind: "package-refined"; pkg: HonuaMapPackage }
  | { kind: "package-disposed" }
  | { kind: "error"; error: HonuaOperatorMapError };

/**
 * Caller-supplied factory that builds the host MapLibre map and returns
 * a teardown handle. The host owns the `MaplibreMap` lifecycle.
 */
export type MapFactory = () => MapFactoryResult | Promise<MapFactoryResult>;

export interface MapFactoryResult {
  map: MaplibreMap;
  dispose?: () => void;
}

export interface MapWorkspaceControllerOptions {
  client: OperatorClient;
  mapFactory: MapFactory;
  /** Linked-view preset for the embedded `ExplorationContext`. Default `"mapDriven"`. */
  explorationPreset?: LinkedViewPresetName;
  telemetry?: OperatorTelemetry;
  /**
   * Pass-through options handed to `loadMapPackage`. The controller
   * never instantiates a `HonuaClient` itself — the host wires the
   * runtime client through this hook.
   */
  loadOptions?: Omit<LoadMapPackageOptions, "telemetry">;
}

const MAP_VIEW_BINDING_ID = "map-primary";

export class MapWorkspaceController {
  readonly #client: OperatorClient;
  readonly #mapFactory: MapFactory;
  readonly #preset: LinkedViewPresetName;
  readonly #telemetry: OperatorTelemetry | undefined;
  readonly #loadOptions: Omit<LoadMapPackageOptions, "telemetry"> | undefined;
  readonly #bag = new ListenerBag<MapWorkspaceEvent>();

  #runtime: HonuaMapRuntime | undefined;
  #context: ExplorationContext | undefined;
  #viewHandle: ViewHandle | undefined;
  #disposeMap: (() => void) | undefined;
  #activeIntentId: string | undefined;
  // Bumped on every loadPackage() / refine() / dispose() entry. The
  // operation captures it before awaiting and only commits state when
  // the captured value still matches at resolution time. Parallel
  // loads or refinements thereby cannot let an older `MapPackage`
  // overwrite a newer one.
  #opGeneration = 0;

  public constructor(options: MapWorkspaceControllerOptions) {
    this.#client = options.client;
    this.#mapFactory = options.mapFactory;
    this.#preset = options.explorationPreset ?? "mapDriven";
    this.#telemetry = options.telemetry;
    this.#loadOptions = options.loadOptions;
  }

  public get runtime(): HonuaMapRuntime | undefined {
    return this.#runtime;
  }

  public get exploration(): ExplorationContext | undefined {
    return this.#context;
  }

  public on(listener: (event: MapWorkspaceEvent) => void): Unsubscribe {
    return this.#bag.on(listener);
  }

  /**
   * Bind the controller to an intent so that subsequent `refine()` calls
   * have an intent id to attach to the server request. Idempotent.
   */
  public bindIntent(intentId: string): void {
    this.#activeIntentId = intentId;
  }

  /**
   * Load a `MapPackage` into a fresh runtime + exploration context.
   * Tears down any previously loaded package; safe to call repeatedly.
   *
   * Concurrent loads supersede each other via `#opGeneration`: an
   * older load whose factory or `loadMapPackage` is still pending when
   * a newer load arrives discards its locally-built runtime/context
   * instead of overwriting the newer state.
   */
  public async loadPackage(pkg: HonuaMapPackage): Promise<HonuaMapRuntime> {
    if (!this.#loadOptions) {
      throw new HonuaOperatorMapError("loadPackage requires loadOptions on the controller", {
        detail: { mapPackageId: pkg.mapPackageId },
      });
    }

    this.#tearDown();
    const gen = ++this.#opGeneration;

    return withTelemetrySpan(
      this.#telemetry,
      "map-load",
      this.#activeIntentId,
      async () => {
        let factoryResult: MapFactoryResult | undefined;
        let runtime: HonuaMapRuntime | undefined;
        try {
          // The host-supplied factory can reject before any runtime
          // setup happens (e.g. WebGL unavailable). Keep its failure
          // inside the wrapper so embedders see a typed
          // HonuaOperatorMapError on the workspace event stream
          // instead of a raw factory rejection.
          factoryResult = await this.#mapFactory();
          if (gen !== this.#opGeneration) {
            disposeFactoryResult(factoryResult);
            throw new HonuaOperatorMapError("map load superseded by newer load", {
              detail: { mapPackageId: pkg.mapPackageId },
            });
          }
          runtime = await loadMapPackage(pkg, factoryResult.map, {
            ...this.#loadOptions!,
          });
          if (gen !== this.#opGeneration) {
            disposeRuntime(runtime);
            disposeFactoryResult(factoryResult);
            throw new HonuaOperatorMapError("map load superseded by newer load", {
              detail: { mapPackageId: pkg.mapPackageId },
            });
          }
          this.#disposeMap = factoryResult.dispose;
          this.#runtime = runtime;
          this.#context = createExplorationContext({
            datasetId: pkg.mapPackageId,
            sourceIds: pkg.sourceBindings.map((binding) => binding.sourceId),
            preset: this.#preset,
          });
          this.#viewHandle = this.#context.bind({ id: MAP_VIEW_BINDING_ID, role: "map" });
          this.#bag.emit({ kind: "package-loaded", pkg });
          return runtime;
        } catch (error) {
          if (gen !== this.#opGeneration) {
            // Superseded; the newer load owns teardown. Don't re-tear or emit.
            throw error;
          }
          // `#disposeMap` is only assigned after `loadMapPackage`
          // succeeds, so a factory that returned a host map followed
          // by a `loadMapPackage` failure leaves the map orphaned.
          // Dispose the locally-captured factoryResult / runtime here
          // before #tearDown runs (it will be a no-op for those).
          if (runtime !== undefined) disposeRuntime(runtime);
          if (factoryResult !== undefined && this.#disposeMap === undefined) {
            disposeFactoryResult(factoryResult);
          }
          this.#tearDown();
          const wrapped =
            error instanceof HonuaOperatorMapError
              ? error
              : new HonuaOperatorMapError("map package load failed", {
                  cause: error,
                  detail: { mapPackageId: pkg.mapPackageId },
                });
          this.#bag.emit({ kind: "error", error: wrapped });
          throw wrapped;
        }
      },
      { mapPackageId: pkg.mapPackageId },
    );
  }

  /**
   * Natural-language refinement. The server returns an updated
   * `MapPackage`; the runtime's diff path applies it incrementally.
   * Source-binding failures inside the runtime are forwarded via
   * `runtime.reportSourceError(...)` rather than thrown.
   */
  public async refine(prompt: string, signal?: AbortSignal): Promise<HonuaMapPackage> {
    if (!this.#runtime) {
      throw new HonuaOperatorMapError("refine called before loadPackage");
    }
    if (!this.#activeIntentId) {
      throw new HonuaOperatorMapError("refine requires bindIntent before invocation");
    }
    const intentId = this.#activeIntentId;
    const ownRuntime = this.#runtime;
    const gen = ++this.#opGeneration;
    return withTelemetrySpan(
      this.#telemetry,
      "map-refine",
      intentId,
      async () => {
        try {
          const next = await this.#client.operator.refineMap(intentId, prompt, signal);
          if (gen !== this.#opGeneration || this.#runtime !== ownRuntime) {
            // Superseded by a newer load/refine, or the runtime was
            // torn down while we awaited. Skip the apply so we never
            // mutate a stale or replaced runtime.
            return next;
          }
          await ownRuntime.updatePackage(next);
          if (gen !== this.#opGeneration || this.#runtime !== ownRuntime) {
            return next;
          }
          this.#syncExplorationContext(next);
          this.#bag.emit({ kind: "package-refined", pkg: next });
          return next;
        } catch (error) {
          if (gen !== this.#opGeneration || this.#runtime !== ownRuntime) {
            // Superseded; let the newer op own error reporting.
            throw error;
          }
          const wrapped = new HonuaOperatorMapError("map refine failed", {
            intentId,
            cause: error,
            detail: { prompt },
          });
          this.#bag.emit({ kind: "error", error: wrapped });
          // Forward any per-source recoveries to the runtime so
          // listeners on the runtime see the failure on the same
          // channel as native source events.
          ownRuntime.reportSourceError("__refine__", error);
          throw wrapped;
        }
      },
      { prompt },
    );
  }

  // ── Thin re-exports of HonuaMapRuntime ops ───────────────────

  public setLayerVisibility(layerId: string, visible: boolean): void {
    this.#assertRuntime().setLayerVisibility(layerId, visible);
  }

  public bindPopup(layerId: string, binding?: HonuaMapPackagePopupBinding): { remove(): void } {
    return this.#assertRuntime().bindPopup(layerId, binding);
  }

  public setViewState(view: SetViewStateInput): void {
    this.#assertRuntime().setViewState(view);
  }

  public getLegend(): LegendEntry[] {
    return this.#assertRuntime().getLegend();
  }

  public dispose(): void {
    this.#opGeneration += 1;
    this.#tearDown();
    this.#bag.clear();
  }

  #assertRuntime(): HonuaMapRuntime {
    if (!this.#runtime) {
      throw new HonuaOperatorMapError("operation requires a loaded MapPackage");
    }
    return this.#runtime;
  }

  /**
   * `ExplorationContext` exposes immutable `datasetId` / `sourceIds`,
   * so a refined package that changes either leaves linked views bound
   * to stale metadata. Rebuild the context (and the primary view
   * binding) on those transitions; otherwise leave it intact so
   * subscribers retain their current state.
   */
  #syncExplorationContext(pkg: HonuaMapPackage): void {
    const nextSourceIds = pkg.sourceBindings.map((binding) => binding.sourceId);
    if (
      this.#context &&
      this.#context.datasetId === pkg.mapPackageId &&
      sameSourceIds(this.#context.sourceIds, nextSourceIds)
    ) {
      return;
    }
    if (this.#viewHandle) {
      this.#viewHandle.unbind();
      this.#viewHandle = undefined;
    }
    if (this.#context) {
      this.#context.dispose();
      this.#context = undefined;
    }
    this.#context = createExplorationContext({
      datasetId: pkg.mapPackageId,
      sourceIds: nextSourceIds,
      preset: this.#preset,
    });
    this.#viewHandle = this.#context.bind({ id: MAP_VIEW_BINDING_ID, role: "map" });
  }

  #tearDown(): void {
    if (this.#viewHandle) {
      this.#viewHandle.unbind();
      this.#viewHandle = undefined;
    }
    if (this.#context) {
      this.#context.dispose();
      this.#context = undefined;
    }
    if (this.#runtime) {
      try {
        this.#runtime.dispose();
      } catch {
        // dispose is best-effort during teardown; map errors do not
        // re-surface here because the controller already returned.
      }
      this.#runtime = undefined;
      this.#bag.emit({ kind: "package-disposed" });
    }
    if (this.#disposeMap) {
      try {
        this.#disposeMap();
      } catch {
        // ignore — host-owned teardown.
      }
      this.#disposeMap = undefined;
    }
  }
}

function sameSourceIds(a: ReadonlyArray<string>, b: ReadonlyArray<string>): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function disposeFactoryResult(factoryResult: MapFactoryResult): void {
  try {
    factoryResult.dispose?.();
  } catch {
    // ignore — host-owned teardown.
  }
}

function disposeRuntime(runtime: HonuaMapRuntime): void {
  try {
    runtime.dispose();
  } catch {
    // dispose is best-effort during supersession cleanup.
  }
}
