/**
 * `BuilderWorkspaceController` — mirrors `MapWorkspaceController` for an
 * `AppPackage`. The controller does not execute the app; it surfaces a
 * `PreviewHandle` carrying the bundle URL the embedder mounts inside an
 * `<iframe sandbox>`.
 *
 * @module
 */

import type { HonuaMapPackage } from "../../runtime/index.js";
import type { OperatorClient } from "../client.js";
import { HonuaOperatorAppError } from "../errors.js";
import type { OperatorTelemetry } from "../telemetry.js";
import type { AppPackage, ArtifactRef } from "../workspace/types.js";
import { ListenerBag, type Unsubscribe, withTelemetrySpan } from "./base.js";

export interface PreviewHandle {
  readonly url: string | undefined;
  readonly assets: ReadonlyArray<ArtifactRef>;
  readonly mapPackage: HonuaMapPackage | undefined;
}

export type BuilderWorkspaceEvent =
  | { kind: "package-loaded"; pkg: AppPackage }
  | { kind: "package-refined"; pkg: AppPackage }
  | { kind: "map-bound"; pkg: HonuaMapPackage }
  | { kind: "error"; error: HonuaOperatorAppError };

export interface BuilderWorkspaceControllerOptions {
  client: OperatorClient;
  telemetry?: OperatorTelemetry;
  /**
   * Optional adapter that picks the entry-point URL out of an
   * `AppPackage`. Defaults to the first asset whose `kind === "app-package"`,
   * falling back to the first asset with a `url`.
   */
  resolveEntryUrl?: (pkg: AppPackage) => string | undefined;
}

const defaultEntryUrl = (pkg: AppPackage): string | undefined => {
  const appAsset = pkg.assets.find((asset) => asset.kind === "app-package" && asset.url);
  if (appAsset?.url) return appAsset.url;
  return pkg.assets.find((asset) => asset.url)?.url;
};

export class BuilderWorkspaceController {
  readonly #client: OperatorClient;
  readonly #telemetry: OperatorTelemetry | undefined;
  readonly #resolveEntryUrl: (pkg: AppPackage) => string | undefined;
  readonly #bag = new ListenerBag<BuilderWorkspaceEvent>();
  #pkg: AppPackage | undefined;
  #boundMap: HonuaMapPackage | undefined;
  #activeIntentId: string | undefined;
  // Same generation pattern as the other controllers: bumped on
  // every loadPackage()/refine()/dispose(), captured by each
  // operation, and consulted at resolution time so an older
  // refineApp() cannot overwrite a newer package.
  #opGeneration = 0;

  public constructor(options: BuilderWorkspaceControllerOptions) {
    this.#client = options.client;
    this.#telemetry = options.telemetry;
    this.#resolveEntryUrl = options.resolveEntryUrl ?? defaultEntryUrl;
  }

  public get appPackage(): AppPackage | undefined {
    return this.#pkg;
  }

  public on(listener: (event: BuilderWorkspaceEvent) => void): Unsubscribe {
    return this.#bag.on(listener);
  }

  public bindIntent(intentId: string): void {
    this.#activeIntentId = intentId;
  }

  public async loadPackage(pkg: AppPackage): Promise<void> {
    const gen = ++this.#opGeneration;
    return withTelemetrySpan(
      this.#telemetry,
      "app-load",
      this.#activeIntentId,
      async () => {
        if (gen !== this.#opGeneration) return;
        this.#pkg = pkg;
        this.#bag.emit({ kind: "package-loaded", pkg });
      },
      { appPackageId: pkg.id },
    );
  }

  public bindMapPackage(pkg: HonuaMapPackage): void {
    this.#boundMap = pkg;
    this.#bag.emit({ kind: "map-bound", pkg });
  }

  public preview(): PreviewHandle {
    if (!this.#pkg) {
      throw new HonuaOperatorAppError("preview called before loadPackage");
    }
    return {
      url: this.#resolveEntryUrl(this.#pkg),
      assets: this.#pkg.assets,
      mapPackage: this.#boundMap,
    };
  }

  public async refine(prompt: string, signal?: AbortSignal): Promise<AppPackage> {
    if (!this.#activeIntentId) {
      throw new HonuaOperatorAppError("refine requires bindIntent before invocation");
    }
    const intentId = this.#activeIntentId;
    const gen = ++this.#opGeneration;
    return withTelemetrySpan(
      this.#telemetry,
      "app-refine",
      intentId,
      async () => {
        try {
          const next = await this.#client.operator.refineApp(intentId, prompt, signal);
          if (gen !== this.#opGeneration) return next;
          this.#pkg = next;
          this.#bag.emit({ kind: "package-refined", pkg: next });
          return next;
        } catch (error) {
          const wrapped = new HonuaOperatorAppError("app refine failed", {
            intentId,
            cause: error,
            detail: { prompt },
          });
          if (gen === this.#opGeneration) {
            this.#bag.emit({ kind: "error", error: wrapped });
          }
          throw wrapped;
        }
      },
      { prompt },
    );
  }

  public dispose(): void {
    this.#opGeneration += 1;
    this.#pkg = undefined;
    this.#boundMap = undefined;
    this.#activeIntentId = undefined;
    this.#bag.clear();
  }
}
