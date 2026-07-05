/**
 * {@link HonuaPopup} — declaratively bind a runtime popup to a layer inside a
 * {@link HonuaMap}. The binding is removed on unmount (StrictMode-safe).
 *
 * Requires the enclosing `HonuaMap` to have a `popupFactory` — `HonuaMap`
 * defaults one from its maplibre module, so this works out of the box.
 *
 * @module
 */

import { type ReactNode, useEffect } from "react";

import type { HonuaMapPackagePopupBinding } from "../runtime/index.js";
import { useMapRuntime } from "./hooks.js";

/** Props for {@link HonuaPopup}. */
export interface HonuaPopupProps {
  /** The layer id whose feature clicks open the popup. */
  layer: string;
  /** Optional popup binding (source id, title, template, field). */
  binding?: HonuaMapPackagePopupBinding;
  /** Called if binding the popup throws (e.g. no `popupFactory` configured). */
  onError?: (error: unknown) => void;
}

/**
 * Bind a click-to-open popup to a layer in the enclosing `HonuaMap`. Must be
 * rendered inside a {@link HonuaMap}; renders nothing itself.
 */
export function HonuaPopup({ layer, binding, onError }: HonuaPopupProps): ReactNode {
  const runtime = useMapRuntime();

  useEffect(() => {
    if (!runtime) return;
    let handle: { remove(): void } | undefined;
    try {
      handle = runtime.bindPopup(layer, binding);
    } catch (error) {
      onError?.(error);
    }
    return () => {
      handle?.remove();
    };
    // biome-ignore lint/correctness/useExhaustiveDependencies: re-bind on runtime + layer + binding identity; onError is a stable-intent callback.
  }, [runtime, layer, binding]);

  return null;
}
