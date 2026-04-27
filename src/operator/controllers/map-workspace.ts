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
   */
  public async loadPackage(pkg: HonuaMapPackage): Promise<HonuaMapRuntime> {
    this.#tearDown();

    if (!this.#loadOptions) {
      throw new HonuaOperatorMapError("loadPackage requires loadOptions on the controller", {
        detail: { mapPackageId: pkg.mapPackageId },
      });
    }

    return withTelemetrySpan(
      this.#telemetry,
      "map-load",
      this.#activeIntentId,
      async () => {
        const factoryResult = await this.#mapFactory();
        this.#disposeMap = factoryResult.dispose;
        try {
          const runtime = await loadMapPackage(pkg, factoryResult.map, {
            ...this.#loadOptions!,
          });
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
    return withTelemetrySpan(
      this.#telemetry,
      "map-refine",
      intentId,
      async () => {
        try {
          const next = await this.#client.operator.refineMap(intentId, prompt, signal);
          await this.#runtime!.updatePackage(next);
          this.#bag.emit({ kind: "package-refined", pkg: next });
          return next;
        } catch (error) {
          const wrapped = new HonuaOperatorMapError("map refine failed", {
            intentId,
            cause: error,
            detail: { prompt },
          });
          this.#bag.emit({ kind: "error", error: wrapped });
          // Forward any per-source recoveries to the runtime so
          // listeners on the runtime see the failure on the same
          // channel as native source events.
          this.#runtime?.reportSourceError("__refine__", error);
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
    this.#tearDown();
    this.#bag.clear();
  }

  #assertRuntime(): HonuaMapRuntime {
    if (!this.#runtime) {
      throw new HonuaOperatorMapError("operation requires a loaded MapPackage");
    }
    return this.#runtime;
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
