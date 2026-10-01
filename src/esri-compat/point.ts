import { safeInvokeCompatListener } from "./event-bus.js";
export interface PointCompatOptions {
  x?: number;
  y?: number;
  z?: number;
  m?: number;
  longitude?: number;
  latitude?: number;
  spatialReference?: unknown;
}

export type PointLoadStatusCompat = "not-loaded" | "loading" | "loaded";

export interface PointHandleCompat {
  remove(): void;
}

export class PointCompat {
  public loaded: boolean;
  public loadStatus: PointLoadStatusCompat;
  public x: number | undefined;
  public y: number | undefined;
  public z: number | undefined;
  public m: number | undefined;
  public spatialReference: unknown;
  private readonly watchListeners: Map<string, Set<(value: unknown) => void>>;

  /** Geographic longitude. Present when the spatial reference is geographic. */
  public get longitude(): number | undefined {
    return this.isGeographic() ? this.x : undefined;
  }

  /** Geographic latitude. Present when the spatial reference is geographic. */
  public get latitude(): number | undefined {
    return this.isGeographic() ? this.y : undefined;
  }

  public constructor(options: PointCompatOptions = {}) {
    this.loaded = false;
    this.loadStatus = "not-loaded";
    const longitude = normalizeFiniteNumber(options.longitude);
    const latitude = normalizeFiniteNumber(options.latitude);
    this.x = normalizeFiniteNumber(options.x) ?? longitude;
    this.y = normalizeFiniteNumber(options.y) ?? latitude;
    this.z = normalizeFiniteNumber(options.z);
    this.m = normalizeFiniteNumber(options.m);
    this.spatialReference =
      options.spatialReference ?? (longitude !== undefined || latitude !== undefined ? { wkid: 4326 } : undefined);
    this.watchListeners = new Map();
  }

  public async load(): Promise<PointCompat> {
    if (this.loaded) {
      return this;
    }

    this.loadStatus = "loading";
    this.notifyWatchers("loadStatus", this.loadStatus);
    this.loaded = true;
    this.notifyWatchers("loaded", this.loaded);
    this.loadStatus = "loaded";
    this.notifyWatchers("loadStatus", this.loadStatus);
    return this;
  }

  public async when(callback?: (point: PointCompat) => void): Promise<PointCompat> {
    const point = await this.load();
    if (callback) {
      callback(point);
    }
    return point;
  }

  public watch(propertyName: string, listener: (value: unknown) => void): PointHandleCompat {
    let listeners = this.watchListeners.get(propertyName);
    if (!listeners) {
      listeners = new Set();
      this.watchListeners.set(propertyName, listeners);
    }
    listeners.add(listener);

    return {
      remove: () => {
        listeners?.delete(listener);
      },
    };
  }

  public update(options: PointCompatOptions): void {
    if (options.x !== undefined) {
      this.x = normalizeFiniteNumber(options.x);
      this.notifyWatchers("x", this.x);
    }
    if (options.y !== undefined) {
      this.y = normalizeFiniteNumber(options.y);
      this.notifyWatchers("y", this.y);
    }
    if (options.z !== undefined) {
      this.z = normalizeFiniteNumber(options.z);
      this.notifyWatchers("z", this.z);
    }
    if (options.m !== undefined) {
      this.m = normalizeFiniteNumber(options.m);
      this.notifyWatchers("m", this.m);
    }
    if (options.longitude !== undefined && options.x === undefined) {
      this.x = normalizeFiniteNumber(options.longitude);
      this.notifyWatchers("x", this.x);
      this.notifyWatchers("longitude", this.longitude);
    }
    if (options.latitude !== undefined && options.y === undefined) {
      this.y = normalizeFiniteNumber(options.latitude);
      this.notifyWatchers("y", this.y);
      this.notifyWatchers("latitude", this.latitude);
    }
    if (options.spatialReference !== undefined) {
      this.spatialReference = options.spatialReference;
      this.notifyWatchers("spatialReference", this.spatialReference);
    } else if ((options.longitude !== undefined || options.latitude !== undefined) && !this.isGeographic()) {
      this.spatialReference = { wkid: 4326 };
      this.notifyWatchers("spatialReference", this.spatialReference);
    }
  }

  public clone(): PointCompat {
    return new PointCompat(this.toJSON());
  }

  public toJSON(): PointCompatOptions {
    return {
      x: this.x,
      y: this.y,
      z: this.z,
      m: this.m,
      spatialReference: this.spatialReference,
    };
  }

  public destroy(): void {
    this.watchListeners.clear();
  }

  private isGeographic(): boolean {
    const reference = this.spatialReference as { wkid?: unknown; latestWkid?: unknown } | undefined;
    const wkid = reference?.latestWkid ?? reference?.wkid;
    return wkid === 4326 || wkid === 4269;
  }

  private notifyWatchers(propertyName: string, value: unknown): void {
    const listeners = this.watchListeners.get(propertyName);
    if (!listeners) {
      return;
    }

    for (const listener of listeners) {
      safeInvokeCompatListener(listener, value);
    }
  }
}

function normalizeFiniteNumber(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
