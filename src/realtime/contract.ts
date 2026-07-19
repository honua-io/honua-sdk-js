/**
 * Snapshot, delta, cursor, resume, and plan-identity contract surface for
 * `@honua/sdk-js/realtime` (issue #556).
 *
 * The resumable delivery gate in `resumable.ts` already implements the
 * durable-checkpoint state machine: versioned snapshot/delta/cursor
 * envelopes, monotonic-sequence ordering and deduplication, delete
 * tombstones (`reducer.ts`), and mandatory resnapshot on gap, expiry, or
 * scope change. This module closes the three remaining contract gaps that
 * keep that machinery a *design* rather than an ad hoc convention:
 *
 * 1. **Plan identity** — {@link RealtimeResumeContextV1.queryFingerprint} was
 *    previously any caller-supplied string. {@link realtimePlanFingerprint}
 *    and {@link assertRealtimePlanIdentity} bind it to the query planner's
 *    canonical, credential-free `QueryExecutionPlan.fingerprint` — the same
 *    content hash `hashQueryPlan`/`persistedPlanSnapshot` establish once,
 *    with full protocol-compiler re-verification, when a plan is first
 *    constructed (`explainQuery`) or reloaded (`parseQueryPlan`). That
 *    fingerprint already folds in `capabilityPolicy` and `fallback`, so
 *    binding to it also carries policy identity per REQ-003 without a
 *    second fingerprint field. This module reads the already-trusted field
 *    rather than importing `hashQueryPlan` itself: plan *integrity* is the
 *    query planner's trust boundary, established once at construction time,
 *    and re-deriving it here would pull every protocol compiler
 *    (DuckDB/gRPC/GeoServices/OGC/OData/WFS — several hundred KB) into the
 *    `@honua/sdk-js/realtime` bundle for a check that is already done.
 * 2. **Authority** — {@link deriveRealtimeContractAuthority} projects the
 *    resumable gate's `phase` into one explicit
 *    `replaying | live | stale | terminal` state plus an `authoritative`
 *    flag, so consumers stop inferring trust from reason codes.
 * 3. **Deterministic, redacted serialization** — {@link serializeRealtimeCheckpoint}
 *    and {@link redactRealtimeCheckpoint} give a canonical (sorted-key) JSON
 *    form for durable storage and a form safe for logs/telemetry that never
 *    carries a raw cursor, watermark, or delta-token value.
 *
 * @module
 */

import { canonicalStringify, sha256, toJsonValue } from "../query-planner/canonical.js";
import type { QueryExecutionPlan } from "../query-planner/types.js";
import {
  HonuaRealtimeResumeError,
  type RealtimeDurableCheckpointV1,
  type RealtimeResumeContextV1,
  type ResumableRealtimeState,
} from "./resumable.js";

/**
 * Canonical plan-identity fingerprint for
 * {@link RealtimeResumeContextV1.queryFingerprint}: the accepted plan's own
 * trusted `fingerprint` field (`hashQueryPlan(plan) === plan.fingerprint`
 * for every plan produced by `explainQuery`/`parseQueryPlan`). Named and
 * exported so call sites bind resume identity to the plan by construction
 * instead of by convention, without importing the query planner's
 * protocol-compiler graph into `@honua/sdk-js/realtime`. Only
 * `QueryExecutionPlan["fingerprint"]` is type-imported; nothing from
 * `query-planner/planner.js` is bundled here.
 */
export function realtimePlanFingerprint(plan: Pick<QueryExecutionPlan, "fingerprint">): `sha256:${string}` {
  return plan.fingerprint;
}

/**
 * Assert that a resume context's `queryFingerprint` matches the accepted
 * plan's fingerprint. Throws a `"query-changed"`
 * {@link HonuaRealtimeResumeError} — the same taxonomy
 * {@link evaluateRealtimeCheckpoint} uses for a checkpoint whose bound query
 * identity no longer matches — when they diverge, so a subscription can
 * never resume against a plan other than the one it was accepted for. This
 * checks identity, not plan authenticity: trust that `plan.fingerprint`
 * matches the plan's actual content is established once, by the query
 * planner, when the plan is constructed or parsed.
 */
export function assertRealtimePlanIdentity(
  context: RealtimeResumeContextV1,
  plan: Pick<QueryExecutionPlan, "fingerprint">,
): void {
  const expected = realtimePlanFingerprint(plan);
  if (context.queryFingerprint !== expected) {
    throw new HonuaRealtimeResumeError(
      "query-changed",
      `Realtime resume context queryFingerprint does not match the accepted plan fingerprint (expected "${expected}", received "${context.queryFingerprint}").`,
    );
  }
}

/**
 * Explicit realtime contract authority states.
 *
 * - `replaying`: no confirmed authoritative baseline yet — awaiting an
 *   initial or replacement snapshot, or resuming from a durable checkpoint
 *   whose continuity has not been reconfirmed by a live event.
 * - `live`: an accepted snapshot establishes ground truth and the most
 *   recent contiguous event arrived within the caller's staleness window
 *   (or no window was supplied).
 * - `stale`: the baseline is still authoritative but no event has arrived
 *   within `staleAfterMs`; render the last known state but surface
 *   liveness doubt.
 * - `terminal`: delivery stopped on an unrecoverable error or an explicit
 *   close. The last accepted checkpoint, if any, remains available for
 *   read-only rendering but will never advance.
 */
export type RealtimeContractAuthorityState = "replaying" | "live" | "stale" | "terminal";

export interface RealtimeContractAuthority {
  readonly state: RealtimeContractAuthorityState;
  /** True once an accepted snapshot has established ground truth for the current checkpoint identity. */
  readonly authoritative: boolean;
  /** Milliseconds since the checkpoint was accepted, when a checkpoint exists and `now` was supplied. */
  readonly ageMs?: number;
}

export interface DeriveRealtimeContractAuthorityOptions {
  /** No event within this window while `phase === "live"` demotes authority to `"stale"`. */
  readonly staleAfterMs?: number;
  readonly now?: number;
}

/**
 * Derive one explicit {@link RealtimeContractAuthority} from a resumable
 * gate's state. Pure and side-effect free: call it after every
 * `enqueue`/`requireResnapshot`/`close` transition to render connection
 * chrome without re-deriving trust from `phase`/`reason` combinations.
 */
export function deriveRealtimeContractAuthority(
  resumable: Pick<ResumableRealtimeState, "phase" | "checkpoint">,
  options: DeriveRealtimeContractAuthorityOptions = {},
): RealtimeContractAuthority {
  const ageMs = checkpointAgeMs(resumable.checkpoint, options.now);
  switch (resumable.phase) {
    case "awaiting-snapshot":
    case "resuming":
    case "resnapshot-required":
      return freeze({ state: "replaying", authoritative: false, ...(ageMs !== undefined ? { ageMs } : {}) });
    case "error":
    case "closed":
      return freeze({
        state: "terminal",
        authoritative: resumable.checkpoint !== undefined,
        ...(ageMs !== undefined ? { ageMs } : {}),
      });
    case "live": {
      const stale =
        ageMs !== undefined &&
        typeof options.staleAfterMs === "number" &&
        Number.isFinite(options.staleAfterMs) &&
        ageMs > options.staleAfterMs;
      return freeze({
        state: stale ? "stale" : "live",
        authoritative: true,
        ...(ageMs !== undefined ? { ageMs } : {}),
      });
    }
  }
}

function checkpointAgeMs(
  checkpoint: RealtimeDurableCheckpointV1 | undefined,
  now: number | undefined,
): number | undefined {
  if (!checkpoint || typeof now !== "number" || !Number.isFinite(now)) return undefined;
  const savedAt = Date.parse(checkpoint.savedAt);
  if (!Number.isFinite(savedAt)) return undefined;
  return Math.max(0, now - savedAt);
}

/** Opaque, deterministic digest of a raw resume-position value; never the raw value itself. */
export type RedactedResumePosition = `sha256:${string}`;

export interface RedactedRealtimeResumePosition {
  readonly sequence: number;
  readonly cursor?: RedactedResumePosition;
  readonly watermark?: RedactedResumePosition;
  readonly timestamp?: string;
  readonly deltaToken?: RedactedResumePosition;
}

/**
 * Log/telemetry-safe projection of a durable checkpoint. `context` is kept
 * as-is because every one of its fields is already an opaque identity or
 * fingerprint (never a credential). `resume.cursor`, `resume.watermark`, and
 * `resume.deltaToken` are replaced with a deterministic SHA-256 digest so
 * repeated observations of the same position stay correlatable without
 * exposing the raw, potentially sensitive token. `timestamp` is kept in the
 * clear because it is not an opaque credential. `recentEventIds` is
 * collapsed to a count: individual event ids are dedup identity, not
 * something a log line needs verbatim.
 */
export interface RedactedRealtimeCheckpointV1 {
  readonly kind: "honua.realtime-checkpoint";
  readonly version: RealtimeDurableCheckpointV1["version"];
  readonly context: RealtimeResumeContextV1;
  readonly resume: RedactedRealtimeResumePosition;
  readonly recentEventIdCount: number;
  readonly savedAt: string;
}

export function redactRealtimeCheckpoint(checkpoint: RealtimeDurableCheckpointV1): RedactedRealtimeCheckpointV1 {
  return freeze({
    kind: checkpoint.kind,
    version: checkpoint.version,
    context: checkpoint.context,
    resume: freeze({
      sequence: checkpoint.resume.sequence,
      ...(checkpoint.resume.cursor !== undefined ? { cursor: redactPosition("cursor", checkpoint.resume.cursor) } : {}),
      ...(checkpoint.resume.watermark !== undefined
        ? { watermark: redactPosition("watermark", checkpoint.resume.watermark) }
        : {}),
      ...(checkpoint.resume.timestamp !== undefined ? { timestamp: checkpoint.resume.timestamp } : {}),
      ...(checkpoint.resume.deltaToken !== undefined
        ? { deltaToken: redactPosition("deltaToken", checkpoint.resume.deltaToken) }
        : {}),
    }),
    recentEventIdCount: checkpoint.recentEventIds.length,
    savedAt: checkpoint.savedAt,
  });
}

function redactPosition(field: "cursor" | "watermark" | "deltaToken", value: string): RedactedResumePosition {
  return sha256(`honua-realtime-checkpoint-redaction:v1:${field}:${value}`);
}

/**
 * Canonical (sorted-key) JSON serialization of the full durable checkpoint,
 * for persistence where the caller owns access control. Two checkpoints
 * with the same accepted content always serialize identically, regardless
 * of property insertion order — required for content-addressed storage and
 * for stable diffing across processes.
 */
export function serializeRealtimeCheckpoint(checkpoint: RealtimeDurableCheckpointV1): string {
  return canonicalStringify(toJsonValue(checkpoint));
}

/**
 * Canonical, redacted JSON serialization safe for logs and telemetry
 * sinks — never a raw cursor, watermark, or delta-token value.
 */
export function serializeRedactedRealtimeCheckpoint(checkpoint: RealtimeDurableCheckpointV1): string {
  return canonicalStringify(toJsonValue(redactRealtimeCheckpoint(checkpoint)));
}

function freeze<T>(value: T): Readonly<T> {
  return Object.freeze(value);
}
