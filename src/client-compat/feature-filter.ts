import { CompatEventBus, safeInvokeCompatListener } from "./event-bus.js";

export interface FeatureFilterGeometryCompat {
  type?: string;
  rings?: number[][][];
  paths?: number[][][];
  x?: number;
  y?: number;
  xmin?: number;
  ymin?: number;
  xmax?: number;
  ymax?: number;
  spatialReference?: { wkid?: number; latestWkid?: number };
}

export type FeatureFilterSpatialRelationshipCompat =
  | "intersects"
  | "contains"
  | "crosses"
  | "disjoint"
  | "envelope-intersects"
  | "index-intersects"
  | "overlaps"
  | "touches"
  | "within"
  | "relation";

export type FeatureFilterTimeExtentCompat =
  | { start?: Date | number | null; end?: Date | number | null }
  | null
  | undefined;

export interface FeatureFilterCompatOptions {
  where?: string | null;
  objectIds?: ReadonlyArray<number | string> | null;
  geometry?: FeatureFilterGeometryCompat | null;
  spatialRelationship?: FeatureFilterSpatialRelationshipCompat;
  distance?: number;
  units?: string;
  timeExtent?: FeatureFilterTimeExtentCompat;
  eventBus?: CompatEventBus;
}

export type FeatureFilterLoadStatusCompat = "loaded";

export interface FeatureFilterHandleCompat {
  remove(): void;
}

/**
 * Feature filter properties for passing a compatibility filter to an
 * application component that has not been migrated.
 *
 * `objectIds` is narrowed to `number[]` here, which is exactly the narrowing
 * {@link FeatureFilterCompat.toFeatureFilterProperties} has to prove.
 */
export interface FeatureFilterProperties {
  where?: string;
  objectIds?: number[];
  geometry?: FeatureFilterGeometryCompat;
  spatialRelationship: FeatureFilterSpatialRelationshipCompat;
  distance?: number;
  units?: string;
  timeExtent?: { start?: Date | number | null; end?: Date | number | null };
}

/**
 * Feature filter adapter.
 *
 * **Documented divergence — `objectIds` element type (#1013).** Some
 * GeoServices REST services use numeric identifiers, while OGC API Features,
 * GeoJSON, and STAC sources may use strings. The public filter therefore
 * accepts `Array<number | string>` so feature identifiers survive a
 * queryFeatures / queryObjectIds round trip. The array remains mutable, and
 * `filter.objectIds.push(id)` is honored because the stored array is evaluated.
 *
 * Use {@link FeatureFilterCompat.toFeatureFilterProperties} to project the
 * filter onto the legacy feature filter shape. It fails rather than silently
 * dropping an identifier that the target cannot represent.
 */
export class FeatureFilterCompat {
  public where: string | null;
  public objectIds: Array<number | string> | null;
  public geometry: FeatureFilterGeometryCompat | null;
  public spatialRelationship: FeatureFilterSpatialRelationshipCompat;
  public distance: number | undefined;
  public units: string | undefined;
  public timeExtent: FeatureFilterTimeExtentCompat;
  public readonly loaded: true;
  public readonly loadStatus: FeatureFilterLoadStatusCompat;
  public readonly eventBus: CompatEventBus;
  private readonly watchListeners: Map<string, Set<(value: unknown) => void>>;

  public constructor(options: FeatureFilterCompatOptions = {}) {
    this.where = options.where ?? null;
    this.objectIds = options.objectIds == null ? null : [...options.objectIds];
    this.geometry = options.geometry ?? null;
    this.spatialRelationship = options.spatialRelationship ?? "intersects";
    this.distance = options.distance;
    this.units = options.units;
    this.timeExtent = options.timeExtent ?? null;
    this.loaded = true;
    this.loadStatus = "loaded";
    this.eventBus = options.eventBus ?? new CompatEventBus();
    this.watchListeners = new Map();
  }

  public watch(propertyName: string, listener: (value: unknown) => void): FeatureFilterHandleCompat {
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

  public clone(): FeatureFilterCompat {
    return new FeatureFilterCompat({
      where: this.where ?? undefined,
      objectIds: this.objectIds ?? undefined,
      geometry: this.geometry ?? undefined,
      spatialRelationship: this.spatialRelationship,
      distance: this.distance,
      units: this.units,
      timeExtent: this.timeExtent ?? undefined,
      eventBus: this.eventBus,
    });
  }

  public update(patch: FeatureFilterCompatOptions): FeatureFilterCompat {
    if (patch.where !== undefined) {
      this.where = patch.where ?? null;
      this.notifyWatchers("where", this.where);
    }
    if (patch.objectIds !== undefined) {
      this.objectIds = patch.objectIds == null ? null : [...patch.objectIds];
      this.notifyWatchers("objectIds", this.objectIds);
    }
    if (patch.geometry !== undefined) {
      this.geometry = patch.geometry ?? null;
      this.notifyWatchers("geometry", this.geometry);
    }
    if (patch.spatialRelationship !== undefined) {
      this.spatialRelationship = patch.spatialRelationship;
      this.notifyWatchers("spatialRelationship", this.spatialRelationship);
    }
    if (patch.distance !== undefined) {
      this.distance = patch.distance;
      this.notifyWatchers("distance", this.distance);
    }
    if (patch.units !== undefined) {
      this.units = patch.units;
      this.notifyWatchers("units", this.units);
    }
    if (patch.timeExtent !== undefined) {
      this.timeExtent = patch.timeExtent ?? null;
      this.notifyWatchers("timeExtent", this.timeExtent);
    }
    this.eventBus.emit("feature-filter.updated", { filter: this.toJSON() }, this);
    return this;
  }

  /**
   * Project this filter onto the legacy `FeatureFilterProperties` shape so a
   * partially migrated app can hand it to an unmigrated component (#1013 REQ-003).
   *
   * Throws when `objectIds` holds an identifier the target shape cannot
   * represent. Quietly dropping or coercing it would return a filter that
   * selects a different set of features than the caller requested.
   */
  public toFeatureFilterProperties(): FeatureFilterProperties {
    const properties: FeatureFilterProperties = {
      spatialRelationship: this.spatialRelationship,
    };
    if (this.where != null) properties.where = this.where;
    if (this.objectIds != null) {
      const unrepresentable = this.objectIds.filter(
        (objectId) => typeof objectId !== "number" || !Number.isFinite(objectId),
      );
      if (unrepresentable.length > 0) {
        const rendered = unrepresentable.map((objectId) => JSON.stringify(objectId)).join(", ");
        throw new Error(
          `FeatureFilterCompat.toFeatureFilterProperties cannot represent non-numeric object ids: ${rendered}.`,
        );
      }
      properties.objectIds = this.objectIds as number[];
    }
    if (this.geometry != null) properties.geometry = this.geometry;
    if (this.distance !== undefined) properties.distance = this.distance;
    if (this.units !== undefined) properties.units = this.units;
    if (this.timeExtent != null) properties.timeExtent = this.timeExtent;
    return properties;
  }

  public toJSON(): Record<string, unknown> {
    const json: Record<string, unknown> = {};
    if (this.where != null) json.where = this.where;
    if (this.objectIds != null) json.objectIds = [...this.objectIds];
    if (this.geometry != null) json.geometry = this.geometry;
    json.spatialRelationship = this.spatialRelationship;
    if (this.distance !== undefined) json.distance = this.distance;
    if (this.units !== undefined) json.units = this.units;
    if (this.timeExtent != null) json.timeExtent = this.timeExtent;
    return json;
  }

  private notifyWatchers(propertyName: string, value: unknown): void {
    const listeners = this.watchListeners.get(propertyName);
    if (!listeners) return;
    for (const listener of listeners) {
      safeInvokeCompatListener(listener, value);
    }
  }
}
