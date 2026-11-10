import type { Dataset, Source } from "../contract/types.js";
import type { HonuaClient } from "../core/client.js";
import type { HonuaOgcRecordResponse } from "../core/types.js";
import type { DataToMapLibreMap, MountSourceOptions, mountSource } from "../map/data-to-map-bridge.js";

/** A mounted selection shared by the map, table, and analytics consumers. */
export interface HonuaCatalogSelection {
  readonly record: HonuaOgcRecordResponse;
  readonly source: Source;
  readonly dataset: Dataset;
  readonly layer: { readonly sourceId: string; readonly layerIds: readonly string[]; remove(): void };
}

export type HonuaCatalogPickerStatus =
  | "idle"
  | "loading"
  | "ready"
  | "empty"
  | "selecting"
  | "selected"
  | "unsupported"
  | "error";

export interface HonuaCatalogPickerState {
  readonly status: HonuaCatalogPickerStatus;
  readonly records: readonly HonuaOgcRecordResponse[];
  readonly selection?: HonuaCatalogSelection;
}

export interface HonuaCatalogPickerOptions {
  readonly client: Pick<HonuaClient, "searchOgcRecords">;
  readonly collectionId: string;
  readonly basePath?: string;
  /** Resolve through the caller's approved discovery and source-to-map adapters. */
  readonly resolve: (record: HonuaOgcRecordResponse, signal: AbortSignal) => Promise<HonuaCatalogSelection | undefined>;
}

/** Inject the existing adapters so controls keep their SSR-safe, core-free runtime graph. */
export interface HonuaCatalogSelectionResolverOptions<ConnectionOptions extends object> {
  readonly connect: (
    options: ConnectionOptions & { signal: AbortSignal },
  ) => Promise<{ dataset: Dataset; source(): Source }>;
  readonly mountSource: typeof mountSource;
  readonly map: DataToMapLibreMap;
  /** Return connection options only for records/endpoints approved by the application. */
  readonly optionsFor: (record: HonuaOgcRecordResponse) => ConnectionOptions | undefined;
  readonly mountOptions?: Omit<MountSourceOptions, "signal">;
}

let nextCatalogMountId = 0;

/** Discover and mount the same source returned to the analysis table and charts. */
export function createCatalogSelectionResolver<ConnectionOptions extends object>(
  options: HonuaCatalogSelectionResolverOptions<ConnectionOptions>,
): HonuaCatalogPickerOptions["resolve"] {
  return async (record, signal) => {
    const connectionOptions = options.optionsFor(record);
    if (!connectionOptions) return undefined;
    signal.throwIfAborted();
    const connection = await options.connect({ ...connectionOptions, signal });
    signal.throwIfAborted();
    const source = connection.source();
    const mounted = await options.mountSource(options.map, source, {
      sourceId: `honua-catalog-selection-${++nextCatalogMountId}`,
      ...options.mountOptions,
      signal,
    });
    // Adapters can complete after cancellation; never leave their map layer behind.
    if (signal.aborted) {
      mounted.dispose();
      signal.throwIfAborted();
    }
    return {
      record,
      source,
      dataset: connection.dataset,
      layer: { sourceId: mounted.sourceId, layerIds: mounted.layerIds, remove: () => mounted.dispose() },
    };
  };
}

/** Bounded catalog search with explicit ownership of its selected map layer. */
export class HonuaCatalogPicker {
  readonly #options: HonuaCatalogPickerOptions;
  readonly #listeners = new Set<(state: HonuaCatalogPickerState) => void>();
  #state: HonuaCatalogPickerState = Object.freeze({ status: "idle", records: Object.freeze([]) });
  #request: AbortController | undefined;
  #disposed = false;
  readonly #ownedSelections = new Set<HonuaCatalogSelection>();

  public constructor(options: HonuaCatalogPickerOptions) {
    if (!options.collectionId.trim()) throw new TypeError("A catalog collection is required.");
    this.#options = { ...options };
  }

  public get state(): HonuaCatalogPickerState {
    return this.#state;
  }

  public subscribe(listener: (state: HonuaCatalogPickerState) => void): () => void {
    this.#assertActive();
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  public async search(query: string): Promise<void> {
    this.#assertActive();
    const q = query.trim();
    if (q.length > 256) throw new RangeError("Catalog searches allow at most 256 characters.");
    const request = this.#begin();
    this.#update({ status: "loading", records: Object.freeze([]) });
    try {
      const result = await this.#options.client.searchOgcRecords({
        collectionId: this.#options.collectionId,
        ...(this.#options.basePath !== undefined ? { basePath: this.#options.basePath } : {}),
        ...(q ? { q } : {}),
        limit: 25,
        signal: request.signal,
      });
      if (!this.#current(request)) return;
      if (!Array.isArray(result.features)) throw new TypeError("Invalid catalog response.");
      const records = Object.freeze(result.features.slice(0, 25));
      this.#update({ status: records.length ? "ready" : "empty", records });
    } catch {
      if (this.#current(request)) this.#update({ status: "error", records: Object.freeze([]) });
    }
  }

  public async select(index: number): Promise<HonuaCatalogSelection | undefined> {
    this.#assertActive();
    const record = this.#state.records[index];
    if (!Number.isInteger(index) || !record) throw new RangeError("Select a current catalog result.");
    const request = this.#begin();
    this.#update({ ...this.#state, status: "selecting" });
    try {
      const selection = await this.#options.resolve(record, request.signal);
      if (selection) this.#ownedSelections.add(selection);
      if (!this.#current(request)) {
        if (selection) this.#release(selection);
        return undefined;
      }
      if (!selection) {
        this.#update({ ...this.#state, status: "unsupported" });
        return undefined;
      }
      const previous = this.#state.selection;
      try {
        if (previous && previous !== selection) this.#release(previous);
      } catch (error) {
        if (selection !== previous) this.#release(selection);
        throw error;
      }
      // A completed mount keeps its signal alive while later searches run.
      this.#request = undefined;
      this.#update({ status: "selected", records: this.#state.records, selection });
      return selection;
    } catch {
      if (this.#current(request)) this.#update({ ...this.#state, status: "error" });
      return undefined;
    }
  }

  public dispose(): void {
    this.#disposed = true;
    this.#request?.abort();
    this.#state = Object.freeze({ status: "idle", records: Object.freeze([]) });
    this.#listeners.clear();
    let failure: unknown;
    for (const selection of this.#ownedSelections) {
      try {
        this.#release(selection);
      } catch (error) {
        failure ??= error;
      }
    }
    if (failure) throw failure;
  }

  #release(selection: HonuaCatalogSelection): void {
    selection.layer.remove();
    this.#ownedSelections.delete(selection);
  }

  #begin(): AbortController {
    this.#request?.abort();
    const request = new AbortController();
    this.#request = request;
    return request;
  }

  #current(request: AbortController): boolean {
    return !this.#disposed && this.#request === request && !request.signal.aborted;
  }

  #assertActive(): void {
    if (this.#disposed) throw new Error("Catalog picker is disposed.");
  }

  #update(state: HonuaCatalogPickerState): void {
    // Search retains the mounted analysis selection until a replacement succeeds.
    this.#state = Object.freeze({
      ...state,
      ...(this.#state.selection && !state.selection ? { selection: this.#state.selection } : {}),
    });
    for (const listener of this.#listeners) listener(this.#state);
  }
}
