/**
 * Combine multiple deck.gl disposal handles — mounted projections
 * (`DeckGlProjection.mount(...)`), camera/view-state sync
 * (`bindDeckGlViewportToMap`), and any other `DeckGlDisposalHandle` — into
 * one idempotent lifecycle object, so a MapLibre-overlay + deck.gl
 * composition can be torn down with a single `dispose()` call.
 *
 * Also exposes `bindDeckGlContextLossRecovery`, a thin WebGL
 * `contextlost`/`contextrestored` binding. deck.gl/luma.gl surface context
 * loss to `Deck.props.onError` but do not themselves rebuild GPU resources or
 * remount layers; a host application observes loss/restoration through this
 * hook and re-projects/re-mounts using the same adapter/projection APIs.
 *
 * @experimental
 * @module
 */

import type { DeckGlDisposalHandle } from "./types.js";
import { HonuaDeckGlAdapterError } from "./types.js";

/**
 * Compose disposal handles into one. `dispose()` disposes every handle in
 * reverse bind order (last bound, first disposed — mirrors typical
 * teardown ordering), is idempotent after success, and never touches a
 * borrowed host beyond what each handle's own `dispose()` already does.
 *
 * If one or more handles fail to dispose, the rest still run; the combined
 * handle reports `disposed: false` and the failures are re-thrown together
 * so the caller can retry (retrying re-invokes every handle's `dispose()`,
 * which is safe because each is independently idempotent on success).
 */
export function combineDeckGlDisposal(...handles: readonly DeckGlDisposalHandle[]): DeckGlDisposalHandle {
  for (const handle of handles) {
    if (typeof handle !== "object" || handle === null || typeof handle.dispose !== "function") {
      throw new HonuaDeckGlAdapterError("invalid-data", "combineDeckGlDisposal requires DeckGlDisposalHandle values.");
    }
  }
  let disposed = false;

  return Object.freeze({
    get disposed() {
      return disposed;
    },
    dispose(): void {
      if (disposed) return;
      const errors: unknown[] = [];
      for (let index = handles.length - 1; index >= 0; index -= 1) {
        try {
          handles[index]!.dispose();
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length > 0) {
        throw new HonuaDeckGlAdapterError(
          "dispose-failed",
          `${errors.length} of ${handles.length} combined deck.gl disposal handle(s) failed and can be retried.`,
          { failures: errors.length, total: handles.length },
          { cause: new AggregateError(errors) },
        );
      }
      disposed = true;
    },
  });
}

/** The subset of `HTMLCanvasElement` this binding depends on. */
export interface DeckGlContextLossTarget {
  addEventListener(type: "webglcontextlost" | "webglcontextrestored", listener: (event: Event) => void): void;
  removeEventListener(type: "webglcontextlost" | "webglcontextrestored", listener: (event: Event) => void): void;
}

export interface DeckGlContextLossRecoveryOptions {
  /**
   * Called after the browser's `webglcontextlost` event fires and this
   * binding has already called `event.preventDefault()` (required by the
   * WebGL spec for the context to become restorable at all). The GPU device
   * and every layer's GPU resources are gone at this point; a host typically
   * stops issuing new render calls here.
   */
  readonly onLost?: (event: Event) => void;
  /**
   * Called after the browser's `webglcontextrestored` event fires. The
   * canvas has a new, empty WebGL context; deck.gl/luma.gl do not
   * automatically recreate the `Deck` instance or re-mount layers. A host
   * typically disposes the old adapter/projection/mount, creates a new
   * `Deck` bound to this canvas, and re-projects + re-mounts from its own
   * retained source data (the SDK never retains a copy on the host's behalf).
   */
  readonly onRestored?: (event: Event) => void;
}

/**
 * Bind `webglcontextlost`/`webglcontextrestored` handling for one canvas.
 * Returns an idempotent `DeckGlDisposalHandle` that removes both listeners.
 *
 * This is a thin recovery seam, not a recovery implementation: it only
 * cancels the loss event's default action (the browser otherwise treats the
 * context as permanently lost) and forwards both events. Rebuilding the
 * `Deck` instance, re-running `adapter.project(...)`, and re-mounting is the
 * host's responsibility, exactly as the initial mount was.
 */
export function bindDeckGlContextLossRecovery(
  canvas: DeckGlContextLossTarget,
  options: DeckGlContextLossRecoveryOptions = {},
): DeckGlDisposalHandle {
  if (
    typeof canvas !== "object" ||
    canvas === null ||
    typeof canvas.addEventListener !== "function" ||
    typeof canvas.removeEventListener !== "function"
  ) {
    throw new HonuaDeckGlAdapterError(
      "invalid-data",
      "bindDeckGlContextLossRecovery requires a canvas-like EventTarget with addEventListener/removeEventListener.",
    );
  }
  let disposed = false;
  const handleLost = (event: Event): void => {
    event.preventDefault();
    options.onLost?.(event);
  };
  const handleRestored = (event: Event): void => {
    options.onRestored?.(event);
  };
  canvas.addEventListener("webglcontextlost", handleLost);
  canvas.addEventListener("webglcontextrestored", handleRestored);

  return Object.freeze({
    get disposed() {
      return disposed;
    },
    dispose(): void {
      if (disposed) return;
      canvas.removeEventListener("webglcontextlost", handleLost);
      canvas.removeEventListener("webglcontextrestored", handleRestored);
      disposed = true;
    },
  });
}
