import type { HonuaExtent } from "@honua/sdk-js/honua";
import type { MapExtentExplorationSource } from "@honua/sdk-js/interactions";

export interface BoundsLike {
  getWest(): number;
  getEast(): number;
  getSouth(): number;
  getNorth(): number;
}

export interface MoveEventMapLike {
  getBounds(): BoundsLike;
  on(type: "move" | "moveend", listener: () => void): void;
  off(type: "move" | "moveend", listener: () => void): void;
}

export interface DebouncedMapExtentSourceOptions {
  readonly debounceMs: number;
  readonly eventType?: "move" | "moveend";
}

export function boundsToHonuaExtent(bounds: BoundsLike): HonuaExtent {
  const west = bounds.getWest();
  const east = bounds.getEast();
  const south = bounds.getSouth();
  const north = bounds.getNorth();
  return {
    xmin: Math.min(west, east),
    ymin: Math.min(south, north),
    xmax: Math.max(west, east),
    ymax: Math.max(south, north),
    spatialReference: { wkid: 4326 },
  };
}

export function createDebouncedMapExtentSource(
  map: MoveEventMapLike,
  options: DebouncedMapExtentSourceOptions,
): MapExtentExplorationSource {
  const eventType = options.eventType ?? "move";
  return {
    current(): HonuaExtent {
      return boundsToHonuaExtent(map.getBounds());
    },
    subscribe(listener: (extent: HonuaExtent | undefined) => void): () => void {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const emit = () => {
        if (timeout) clearTimeout(timeout);
        timeout = setTimeout(() => {
          timeout = undefined;
          listener(boundsToHonuaExtent(map.getBounds()));
        }, options.debounceMs);
      };

      map.on(eventType, emit);
      return () => {
        if (timeout) clearTimeout(timeout);
        map.off(eventType, emit);
      };
    },
  };
}
