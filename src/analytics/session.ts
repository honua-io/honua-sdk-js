/**
 * One accepted artifact, many linked presentations, single data ownership.
 *
 * A session owns exactly one artifact reference at a time. Every presentation
 * it mounts — the default bars, an accessible table, a third-party chart —
 * receives that *same reference*, and the map and table read the same shared
 * exploration state that the presentations write to. Nothing is copied, so
 * there is no second version of the numbers to drift.
 *
 * The session also owns the interaction loop: an adapter emits an interaction,
 * the session commits it through the link binding, records the commit so it can
 * be undone deterministically, and pushes the resulting linked state back into
 * every mounted presentation.
 *
 * @experimental
 * @module
 */

import type { ExplorationViewController } from "../exploration/types.js";
import { resolveAnalyticsUpdateDisposition } from "./artifact.js";
import { bindAnalyticsToExploration } from "./linked-state.js";
import type { AnalyticsAdapterRegistry, ResolveAnalyticsPresentationOptions } from "./registry.js";
import { HonuaAnalyticsError } from "./types.js";
import type {
  AnalyticsArtifact,
  AnalyticsInteraction,
  AnalyticsLinkBindingOptions,
  AnalyticsLinkCommit,
  AnalyticsLinkedState,
  AnalyticsLinkedStateBinding,
  AnalyticsPresentationAdapter,
  AnalyticsPresentationHandle,
  AnalyticsUpdateDecision,
} from "./types.js";

/** A presentation mounted by a session. */
export interface AnalyticsSessionPresentation {
  readonly id: string;
  readonly adapter: AnalyticsPresentationAdapter;
  readonly handle: AnalyticsPresentationHandle;
  /** True when the session fell back to the accessible table. */
  readonly fallback: boolean;
  /** Unmount just this presentation. */
  remove(): void;
}

/** Options for {@link AnalyticsLinkedSession.present}. */
export interface AnalyticsPresentOptions extends ResolveAnalyticsPresentationOptions {
  /** Presentation id, unique within the session. @default the adapter id */
  readonly id?: string;
  /** Opaque render target handed to the adapter. */
  readonly target?: unknown;
  readonly locale?: string;
}

/** A linked-analytics session over one artifact lineage. */
export interface AnalyticsLinkedSession {
  /** The single accepted artifact every presentation shares by reference. */
  readonly artifact: AnalyticsArtifact;
  readonly binding: AnalyticsLinkedStateBinding;
  readonly linkedState: AnalyticsLinkedState;
  readonly presentations: readonly AnalyticsSessionPresentation[];
  /** Commits made through this session, oldest first. */
  readonly history: readonly AnalyticsLinkCommit[];
  readonly disposed: boolean;

  /** Mount a presentation of the current artifact. */
  present(options?: AnalyticsPresentOptions): Promise<AnalyticsSessionPresentation>;
  /**
   * Accept a new artifact for this lineage and fan the decision out to every
   * presentation. Returns the shared decision; `"ignore"` leaves the session's
   * artifact untouched so a late delta cannot rewind the numbers.
   */
  accept(artifact: AnalyticsArtifact): AnalyticsUpdateDecision;
  /** Commit one interaction (normally called by the session's own host). */
  apply(interaction: AnalyticsInteraction): AnalyticsLinkCommit;
  /**
   * Undo the most recent commit that changed shared state. Returns the undone
   * commit, or `undefined` when there is nothing to undo. Undo is exact: it
   * restores the previous values of only the slices that commit touched.
   */
  undo(): AnalyticsLinkCommit | undefined;
  /** Dispose every presentation and the binding. Idempotent. */
  dispose(): void;
}

/** Options for {@link createAnalyticsLinkedSession}. */
export interface CreateAnalyticsLinkedSessionOptions {
  readonly view: ExplorationViewController;
  readonly artifact: AnalyticsArtifact;
  readonly registry: AnalyticsAdapterRegistry;
  readonly binding?: AnalyticsLinkBindingOptions;
  /** Commits retained for undo. @default 50 */
  readonly historyLimit?: number;
  /** Observe every commit (for telemetry or an app-level undo stack). */
  readonly onCommit?: (commit: AnalyticsLinkCommit) => void;
  /** Observe adapter warnings. */
  readonly onWarning?: (message: string, detail?: Readonly<Record<string, unknown>>) => void;
}

/**
 * Create a linked-analytics session.
 *
 * @example
 * ```ts
 * const session = createAnalyticsLinkedSession({ view, artifact, registry });
 * await session.present({ target: panel });        // chart
 * await session.present({ headlessOnly: true });   // accessible table
 * session.apply({ kind: "mark-select", adapterId, artifactId, markKeys: ["s:OPEN"] });
 * session.undo();                                  // exact inverse
 * ```
 */
export function createAnalyticsLinkedSession(options: CreateAnalyticsLinkedSessionOptions): AnalyticsLinkedSession {
  const historyLimit = options.historyLimit ?? 50;
  let artifact = options.artifact;
  let disposed = false;

  const binding = bindAnalyticsToExploration(options.view, artifact, options.binding);
  const presentations = new Map<string, AnalyticsSessionPresentation>();
  const history: AnalyticsLinkCommit[] = [];

  function assertLive(operation: string): void {
    if (disposed) {
      throw new HonuaAnalyticsError("disposed", `Cannot ${operation} on a disposed analytics session.`, {
        artifactId: artifact.identity.artifactId,
      });
    }
  }

  function pushLinkedState(state: AnalyticsLinkedState): void {
    for (const presentation of presentations.values()) {
      if (presentation.handle.disposed) continue;
      presentation.handle.applyLinkedState(state);
    }
  }

  const unsubscribe = binding.subscribe(pushLinkedState);

  function record(commit: AnalyticsLinkCommit): AnalyticsLinkCommit {
    if (commit.changed) {
      history.push(commit);
      if (history.length > historyLimit) history.shift();
    }
    options.onCommit?.(commit);
    return commit;
  }

  function apply(interaction: AnalyticsInteraction): AnalyticsLinkCommit {
    assertLive("apply an interaction");
    const commit = record(binding.apply(interaction));
    pushLinkedState(commit.linkedState);
    return commit;
  }

  const session: AnalyticsLinkedSession = {
    get artifact(): AnalyticsArtifact {
      return artifact;
    },
    binding,
    get linkedState(): AnalyticsLinkedState {
      return binding.linkedState;
    },
    get presentations(): readonly AnalyticsSessionPresentation[] {
      return [...presentations.values()];
    },
    get history(): readonly AnalyticsLinkCommit[] {
      return [...history];
    },
    get disposed(): boolean {
      return disposed;
    },

    async present(presentOptions: AnalyticsPresentOptions = {}): Promise<AnalyticsSessionPresentation> {
      assertLive("mount a presentation");
      const resolution = options.registry.resolve(artifact, presentOptions);
      const id = presentOptions.id ?? resolution.adapter.id;
      if (presentations.has(id)) {
        throw new HonuaAnalyticsError("duplicate-adapter", `A presentation with id "${id}" is already mounted.`, {
          id,
        });
      }

      const handle = await resolution.adapter.mount({
        // The session's own reference — presentations never receive a copy.
        artifact,
        linkedState: binding.linkedState,
        ...(presentOptions.locale ? { locale: presentOptions.locale } : {}),
        ...(presentOptions.target !== undefined ? { target: presentOptions.target } : {}),
        host: {
          emit(interaction: AnalyticsInteraction): void {
            if (disposed) return;
            apply(interaction);
          },
          reportWarning(message, detail): void {
            options.onWarning?.(message, detail);
          },
        },
      });

      // `mount()` may await a dynamic peer import, so the session can be
      // disposed while it is in flight. Registering the handle now would leave
      // a live chart (and its listeners) inside a disposed session, so the
      // freshly built presentation is torn down instead.
      if (disposed) {
        handle.dispose();
        throw new HonuaAnalyticsError(
          "disposed",
          `The analytics session was disposed while "${id}" was mounting; the presentation was released.`,
          { id, adapterId: resolution.adapter.id },
        );
      }

      const presentation: AnalyticsSessionPresentation = {
        id,
        adapter: resolution.adapter,
        handle,
        fallback: resolution.fallback,
        remove(): void {
          presentations.delete(id);
          if (!handle.disposed) handle.dispose();
        },
      };
      presentations.set(id, presentation);
      handle.applyLinkedState(binding.linkedState);
      return presentation;
    },

    accept(next: AnalyticsArtifact): AnalyticsUpdateDecision {
      assertLive("accept an artifact");
      const decision = resolveAnalyticsUpdateDisposition(artifact, next);
      if (decision.disposition === "ignore") return decision;
      artifact = next;
      // Retarget before the presentations update: the binding resolves mark
      // keys, filter clauses, and feature targets against the artifact it
      // holds, so leaving it on the superseded one would make a click on a
      // newly added mark resolve to nothing and clear the filter.
      binding.retarget(next);
      for (const presentation of presentations.values()) {
        if (presentation.handle.disposed) continue;
        try {
          presentation.handle.update(next);
          presentation.handle.applyLinkedState(binding.linkedState);
        } catch (cause) {
          // A peer is an optional presentation, not part of the accepted
          // artifact's authority. Release a failed peer so one bad renderer
          // cannot leave the session with a half-updated live handle.
          presentations.delete(presentation.id);
          if (!presentation.handle.disposed) presentation.handle.dispose();
          options.onWarning?.(
            `The analytics presentation "${presentation.id}" was removed after it failed to accept a realtime artifact.`,
            {
              adapterId: presentation.adapter.id,
              presentationId: presentation.id,
              artifactId: next.identity.artifactId,
              error: cause instanceof Error ? cause.message : String(cause),
            },
          );
        }
      }
      return decision;
    },

    apply,

    undo(): AnalyticsLinkCommit | undefined {
      assertLive("undo");
      const commit = history.pop();
      if (!commit) return undefined;
      commit.undo();
      pushLinkedState(binding.linkedState);
      return commit;
    },

    dispose(): void {
      if (disposed) return;
      disposed = true;
      unsubscribe();
      for (const presentation of [...presentations.values()]) {
        if (!presentation.handle.disposed) presentation.handle.dispose();
      }
      presentations.clear();
      history.length = 0;
      binding.dispose();
    },
  };

  return session;
}
