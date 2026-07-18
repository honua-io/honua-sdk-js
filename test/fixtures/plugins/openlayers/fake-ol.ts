/**
 * Lightweight, dependency-free stand-in for the OpenLayers (`ol`) runtime.
 *
 * The renderer-seam certification proof (issue #566) exercises a genuinely
 * non-MapLibre renderer shape (arbitrary view projections, `Map`/`View`
 * constructors, an `ol/proj`-style projection registry) without adding a real
 * `ol` dependency anywhere in the tree. A real OpenLayers integration would
 * inject the actual `ol` module surface through the same
 * {@link FakeOpenLayersPeer}-shaped seam; this fake mirrors just enough of
 * that surface (constructors, `getLayers`/`addLayer`/`removeLayer`,
 * `once`/`un` event lifecycle, and a `rendercomplete` readiness event) to
 * prove the adapter contract without pulling in the library or a DOM.
 */

/** One registered projection definition, structurally similar to `ol/proj`. */
export interface FakeOlProjectionDefinition {
  readonly code: string;
  /** Built into OpenLayers core (EPSG:4326 / EPSG:3857): no transform needed. */
  readonly native?: boolean;
  /** Registered with only a bounding-box/low-accuracy fit rather than an exact transform. */
  readonly approximate?: boolean;
  readonly accuracyMeters?: number;
}

const DEFAULT_PROJECTIONS: readonly FakeOlProjectionDefinition[] = Object.freeze([
  Object.freeze({ code: "EPSG:3857", native: true }),
  Object.freeze({ code: "EPSG:4326", native: true }),
]);

/** Structural stand-in for `ol/proj`'s projection registry. */
export class FakeOlProjectionRegistry {
  readonly #definitions = new Map<string, FakeOlProjectionDefinition>();

  public constructor(seed: readonly FakeOlProjectionDefinition[] = DEFAULT_PROJECTIONS) {
    for (const definition of seed) this.#definitions.set(definition.code, Object.freeze({ ...definition }));
  }

  public get(code: string): FakeOlProjectionDefinition | undefined {
    return this.#definitions.get(code);
  }

  /** Register a non-native projection, mirroring an application-supplied proj4 definition. */
  public register(definition: FakeOlProjectionDefinition): void {
    this.#definitions.set(definition.code, Object.freeze({ ...definition }));
  }
}

export interface FakeOlView {
  getProjection(): { getCode(): string };
  getCenter?(): readonly [number, number] | undefined;
  getZoom?(): number | undefined;
}

export interface FakeOlViewOptions {
  readonly projection: string;
  readonly center?: readonly [number, number];
  readonly zoom?: number;
}

/** Structural stand-in for `ol/View`. */
export class FakeOlViewImpl implements FakeOlView {
  readonly #projection: string;
  readonly #center: readonly [number, number] | undefined;
  readonly #zoom: number | undefined;

  public constructor(options: FakeOlViewOptions) {
    this.#projection = options.projection;
    this.#center = options.center;
    this.#zoom = options.zoom;
  }

  public getProjection(): { getCode(): string } {
    const code = this.#projection;
    return { getCode: () => code };
  }

  public getCenter(): readonly [number, number] | undefined {
    return this.#center;
  }

  public getZoom(): number | undefined {
    return this.#zoom;
  }
}

export type FakeOlLayerKind = "vector" | "tile";

export interface FakeOlLayer {
  readonly id: string;
  readonly kind: FakeOlLayerKind;
  /** True only for layers this adapter added; disposal must never remove others. */
  honuaOwned: boolean;
  data: unknown;
}

export interface FakeOlMapOptions {
  readonly view: FakeOlView;
  readonly target?: unknown;
}

/** Structural stand-in for `ol/Map`. */
export class FakeOlMap {
  readonly calls: string[] = [];
  #view: FakeOlView;
  #target: unknown;
  #layers: FakeOlLayer[] = [];
  readonly #listeners = new Map<string, Set<() => void>>();
  #disposed = false;
  removeCount = 0;
  /** Test hook: simulate a host that rejects the mutation after a layer/source has been retained. */
  failLayerAfterMutation = false;

  public constructor(options: FakeOlMapOptions) {
    this.#view = options.view;
    this.#target = options.target;
  }

  public getView(): FakeOlView {
    return this.#view;
  }

  public setView(view: FakeOlView): void {
    this.#view = view;
  }

  public getLayers(): readonly FakeOlLayer[] {
    return [...this.#layers];
  }

  public getLayerById(id: string): FakeOlLayer | undefined {
    return this.#layers.find((layer) => layer.id === id);
  }

  public addLayer(layer: FakeOlLayer): void {
    this.calls.push(`addLayer:${layer.id}`);
    this.#layers.push(layer);
    if (this.failLayerAfterMutation) throw new Error("fake OpenLayers host rejected the layer after retaining it");
  }

  public removeLayer(layer: FakeOlLayer): void {
    this.calls.push(`removeLayer:${layer.id}`);
    this.#layers = this.#layers.filter((existing) => existing !== layer);
  }

  public once(type: string, listener: () => void): void {
    const listeners = this.#listeners.get(type) ?? new Set<() => void>();
    listeners.add(listener);
    this.#listeners.set(type, listeners);
  }

  public un(type: string, listener: () => void): void {
    this.#listeners.get(type)?.delete(listener);
  }

  /** Fire a `once`-registered event, draining its listener set (mirrors ol/Observable semantics). */
  public emit(type: string): void {
    const listeners = [...(this.#listeners.get(type) ?? [])];
    this.#listeners.delete(type);
    for (const listener of listeners) listener();
  }

  /** Synchronously trigger the `rendercomplete` readiness event, as `Map#renderSync()` would. */
  public renderSync(): void {
    this.calls.push("renderSync");
    this.emit("rendercomplete");
  }

  public setTarget(target: unknown): void {
    this.#target = target;
  }

  public getTarget(): unknown {
    return this.#target;
  }

  public get disposed(): boolean {
    return this.#disposed;
  }

  /** Structural stand-in for `ol/Map#dispose()` / `setTarget(null)` teardown. */
  public dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.removeCount += 1;
    this.#target = undefined;
    this.calls.push("disposeMap");
  }
}

/** Caller-injected optional-peer shape a real `ol` integration would provide. */
export interface FakeOpenLayersPeer {
  readonly Map: new (options: FakeOlMapOptions) => FakeOlMap;
  readonly View: new (options: FakeOlViewOptions) => FakeOlView;
  readonly projections: FakeOlProjectionRegistry;
}

/** Build a fresh fake peer. Each call owns an independent projection registry. */
export function createFakeOpenLayersPeer(
  projections: FakeOlProjectionRegistry = new FakeOlProjectionRegistry(),
): FakeOpenLayersPeer {
  return {
    Map: FakeOlMap,
    View: FakeOlViewImpl,
    projections,
  };
}

export function isFakeOlMap(value: unknown): value is FakeOlMap {
  return value instanceof FakeOlMap;
}
