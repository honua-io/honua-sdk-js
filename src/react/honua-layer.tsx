/**
 * {@link HonuaLayer} — declaratively add a runtime source + layer to the
 * {@link HonuaMap} it is nested under. Mounting adds the layer (and its source,
 * if provided); unmounting removes them. StrictMode-safe: the add/remove pair
 * is balanced across the double-invoked mount.
 *
 * @module
 */

import { type ReactNode, useEffect } from "react";

import type { RuntimeLayerOrder, RuntimeLayerSpecification, RuntimeSourceSpecification } from "../runtime/index.js";
import { useMapRuntime } from "./hooks.js";

/** A source to register alongside a {@link HonuaLayer}. */
export interface HonuaLayerSource {
  id: string;
  spec: RuntimeSourceSpecification;
}

/** Props for {@link HonuaLayer}. */
export interface HonuaLayerProps {
  /** The MapLibre-shaped runtime layer specification. Its `id` must be stable. */
  layer: RuntimeLayerSpecification;
  /**
   * Optional source to add before the layer. Removed on unmount only if this
   * component added it (i.e. it was not already present on the runtime).
   */
  source?: HonuaLayerSource;
  /** Insertion order (e.g. `{ beforeId }`). */
  order?: RuntimeLayerOrder;
  /** Called if adding/removing the layer or source throws. */
  onError?: (error: unknown) => void;
}

/**
 * Add a layer (and optionally its source) to the enclosing `HonuaMap` runtime.
 * Must be rendered inside a {@link HonuaMap}; renders nothing itself.
 */
export function HonuaLayer({ layer, source, order, onError }: HonuaLayerProps): ReactNode {
  const runtime = useMapRuntime();
  const layerId = layer.id;
  const sourceId = source?.id;

  useEffect(() => {
    if (!runtime) return;
    let addedSource = false;
    try {
      if (source && !runtime.map.getSource?.(source.id)) {
        runtime.addSource(source.id, source.spec);
        addedSource = true;
      }
      runtime.addLayer(layer, order);
    } catch (error) {
      onError?.(error);
    }

    return () => {
      try {
        runtime.removeLayer(layerId);
        if (addedSource && sourceId) {
          runtime.removeSource(sourceId);
        }
      } catch (error) {
        onError?.(error);
      }
    };
    // biome-ignore lint/correctness/useExhaustiveDependencies: re-run on runtime + identity of layer/source/order; onError is a stable-intent callback.
  }, [runtime, layer, source, order, layerId, sourceId]);

  return null;
}
