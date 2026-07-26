/**
 * Shared lifecycle for {@link AnalyticsPresentationHandle} implementations.
 *
 * Every adapter — the DOM default, the accessible table, and third-party chart
 * adapters — gets the same update-disposition and disposal semantics from here,
 * so a leak test written against one handle holds for all of them:
 *
 * - `update()` consults `resolveAnalyticsUpdateDisposition` and only calls the
 *   adapter's `onPatch` / `onInvalidate` when the decision says to.
 * - `dispose()` runs the adapter's teardown once, then permanently rejects
 *   further `update()` / `applyLinkedState()` calls so a late realtime delta
 *   cannot resurrect a torn-down chart.
 *
 * @experimental
 * @module
 */

import { resolveAnalyticsUpdateDisposition } from "./artifact.js";
import { EMPTY_ANALYTICS_LINKED_STATE, HonuaAnalyticsError } from "./types.js";
import type {
  AnalyticsArtifact,
  AnalyticsLinkedState,
  AnalyticsPresentationHandle,
  AnalyticsUpdateDecision,
} from "./types.js";

/** Adapter-supplied behaviour for {@link createDisposableHandle}. */
export interface DisposableHandleSpec {
  readonly adapterId: string;
  readonly artifact: AnalyticsArtifact;
  /** Produce the current accessible description. Called lazily. */
  describe(artifact: AnalyticsArtifact, state: AnalyticsLinkedState): string;
  /** Called for both `patch` and `invalidate`, after the stored artifact swaps. */
  onUpdate?(artifact: AnalyticsArtifact, decision: AnalyticsUpdateDecision): void;
  /** Called only when the decision is `invalidate`. Runs before `onUpdate`. */
  onInvalidate?(artifact: AnalyticsArtifact): void;
  readonly onLinkedState?: (state: AnalyticsLinkedState, artifact: AnalyticsArtifact) => void;
  onDispose(): void;
  /** Extra own-properties merged onto the handle (adapter-specific accessors). */
  readonly extra?: Readonly<Record<string, unknown>>;
}

/**
 * Build a handle with the shared lifecycle. `describe` is invoked on demand so
 * an adapter never pays for description formatting it does not use.
 */
export function createDisposableHandle(spec: DisposableHandleSpec): AnalyticsPresentationHandle {
  let artifact = spec.artifact;
  let linkedState: AnalyticsLinkedState = EMPTY_ANALYTICS_LINKED_STATE;
  let disposed = false;

  function assertLive(operation: string): void {
    if (disposed) {
      throw new HonuaAnalyticsError("disposed", `Cannot ${operation} a disposed ${spec.adapterId} presentation.`, {
        adapterId: spec.adapterId,
        artifactId: artifact.identity.artifactId,
      });
    }
  }

  const handle: AnalyticsPresentationHandle = {
    adapterId: spec.adapterId,
    get artifact(): AnalyticsArtifact {
      return artifact;
    },
    get accessibleDescription(): string {
      return spec.describe(artifact, linkedState);
    },
    get disposed(): boolean {
      return disposed;
    },
    update(next: AnalyticsArtifact): AnalyticsUpdateDecision {
      assertLive("update");
      const decision = resolveAnalyticsUpdateDisposition(artifact, next);
      if (decision.disposition === "ignore") return decision;
      if (decision.disposition === "invalidate") spec.onInvalidate?.(next);
      artifact = next;
      spec.onUpdate?.(next, decision);
      return decision;
    },
    applyLinkedState(state: AnalyticsLinkedState): void {
      assertLive("apply linked state to");
      linkedState = state;
      spec.onLinkedState?.(state, artifact);
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      spec.onDispose();
    },
  };

  return spec.extra ? Object.defineProperties(handle, Object.getOwnPropertyDescriptors(spec.extra)) : handle;
}
