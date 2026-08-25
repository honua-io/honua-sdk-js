/**
 * The publication-proposal state machine shared by
 * {@link HonuaStudioPublicationRequestsClient} and any caller that renders
 * proposal status itself.
 *
 * A Studio publication proposal walks `AwaitingApproval → Approved →
 * Executing → Active`, and can leave the walk at `Rejected` (an approver
 * declined) or `Failed` (execution failed after approval). Only `Active`
 * means published.
 *
 * Two invariants are load-bearing and are asserted by the tests:
 *
 * 1. **A status this SDK release does not recognize is never terminal and
 *    never successful.** A future server state must stall a poll until its
 *    bound is reached, not be mistaken for a finished — let alone a
 *    successful — publication.
 * 2. **A final publication URL exists only at `Active`.** `Rejected` and
 *    `Failed` are terminal *without* a URL, and {@link studioPublicationUrl}
 *    refuses to surface a `publicationUrl` that a misbehaving server attaches
 *    to any non-`Active` state.
 *
 * @module
 */

import type {
  StudioPublicationLifecycleState,
  StudioPublicationRequest,
  StudioPublicationRequestStatus,
} from "./lifecycle-types.js";

/** Every canonical publication-proposal state, in lifecycle order. */
export const STUDIO_PUBLICATION_LIFECYCLE_STATES = [
  "AwaitingApproval",
  "Approved",
  "Executing",
  "Active",
  "Rejected",
  "Failed",
] as const satisfies readonly StudioPublicationLifecycleState[];

/** Terminal states — the proposal will not change again. Only `Active` is a success. */
const TERMINAL_STATES: ReadonlySet<StudioPublicationLifecycleState> = new Set([
  "Active",
  "Rejected",
  "Failed",
] satisfies readonly StudioPublicationLifecycleState[]);

function comparisonForm(value: string): string {
  return value.toLowerCase().replace(/[-_\s]/g, "");
}

/**
 * Canonical state keyed by its comparison form (lower-cased with `-`/`_`/
 * whitespace removed), so `AwaitingApproval`, `awaitingApproval`,
 * `awaiting-approval` and `awaiting_approval` all resolve identically.
 *
 * The three legacy synchronous values map onto the canonical walk:
 * `accepted` was emitted only once the published pointer had already moved
 * (so it is `Active`), `rejected` is `Rejected`, and `pending` — documented as
 * "reserved for later asynchronous publication execution" — is `Executing`.
 * Both `pending` and `Executing` are non-terminal, so a legacy deployment
 * polls to the same outcome either way.
 */
const STATE_BY_COMPARISON_FORM: ReadonlyMap<string, StudioPublicationLifecycleState> = new Map<
  string,
  StudioPublicationLifecycleState
>([
  ...STUDIO_PUBLICATION_LIFECYCLE_STATES.map(
    (state) => [comparisonForm(state), state] as [string, StudioPublicationLifecycleState],
  ),
  ["accepted", "Active"],
  ["pending", "Executing"],
]);

/**
 * Resolve a wire status to its canonical {@link StudioPublicationLifecycleState},
 * or `undefined` when this SDK release does not recognize it.
 *
 * Recognition is case- and separator-insensitive, and covers the legacy
 * synchronous `accepted`/`rejected`/`pending` values. `undefined` is the
 * deliberate signal for "unknown": callers must treat it as neither terminal
 * nor successful.
 */
export function normalizeStudioPublicationStatus(
  status: StudioPublicationRequestStatus | undefined,
): StudioPublicationLifecycleState | undefined {
  if (typeof status !== "string" || status.length === 0) return undefined;
  return STATE_BY_COMPARISON_FORM.get(comparisonForm(status));
}

/**
 * True only for `Active`, `Rejected` and `Failed`. An unrecognized status is
 * **not** terminal — a poll must keep waiting (up to its bound) rather than
 * declare a state it cannot interpret finished.
 */
export function isStudioPublicationTerminal(status: StudioPublicationRequestStatus | undefined): boolean {
  const state = normalizeStudioPublicationStatus(status);
  return state !== undefined && TERMINAL_STATES.has(state);
}

/**
 * True only for `Active` — the single successful terminal state. `Rejected`
 * and `Failed` are terminal but not successful, and an unrecognized status is
 * never successful.
 */
export function isStudioPublicationActive(status: StudioPublicationRequestStatus | undefined): boolean {
  return normalizeStudioPublicationStatus(status) === "Active";
}

/**
 * The proposal's final publication URL, and `undefined` from every state
 * other than `Active` — including a non-`Active` proposal that carries a
 * `publicationUrl` field anyway.
 */
export function studioPublicationUrl(request: StudioPublicationRequest | undefined): string | undefined {
  if (request === undefined) return undefined;
  if (!isStudioPublicationActive(request.status)) return undefined;
  return typeof request.publicationUrl === "string" && request.publicationUrl.length > 0
    ? request.publicationUrl
    : undefined;
}
