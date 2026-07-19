/**
 * OData v4 delta-link pull adapter for `@honua/sdk-js/realtime` (issue #558).
 *
 * OData delta links (`@odata.deltaLink`) are a *pull* change feed, not a
 * socket transport: a client requests a scoped delta-link URL and the
 * server returns only what changed since that link was minted, plus a fresh
 * delta link for the next request. This module maps that request/response
 * paging protocol onto the transport-neutral `RealtimeFeatureTransport`
 * surface (`types.ts`, #556) so it composes with `createRealtimeFeatureStore`
 * / `createResumableRealtimeSubscription` exactly like the SSE and WebSocket
 * adapters (`sse.ts`, `websocket.ts`, #557) — with one deliberate
 * difference dictated by REQ-004: this transport never claims to be live.
 * `capabilities.kind` is `"polling"`, it never emits a `"heartbeat"`, and
 * `onPoll` reports an explicit cadence/freshness snapshot on every request
 * cycle so a consumer can render "checked N seconds ago, next check in M"
 * rather than a live badge that misrepresents a poll as a stream.
 *
 * Ownership split from the SSE/WebSocket adapters: those open exactly one
 * connection per `subscribe()` and never reconnect on their own, deferring
 * reconnect entirely to `resumable-transport.ts`. This transport has no
 * connection to reconnect — every cycle is an independent request/response —
 * so it owns its own bounded poll loop, including the on-expiry resnapshot
 * recovery a socket transport cannot perform for itself: an expired or
 * rejected delta link (REQ per the User Workflow, "Expired/invalid delta
 * state requires an explicit resnapshot") is recovered by re-running a full
 * snapshot cycle and emitting a fresh `type: "snapshot", replace: true`
 * event, bounded by `maxConsecutiveResnapshots` so a server that keeps
 * rejecting the token cannot loop forever.
 *
 * Security posture (REQ-002): every `@odata.nextLink` / `@odata.deltaLink`
 * this transport follows, and any caller-supplied `resumeFrom.deltaToken`,
 * must resolve to the exact same origin and collection path as the
 * configured `url`. A link that does not is rejected rather than followed —
 * a delta token is an opaque, potentially attacker-influenced value once it
 * has round-tripped through a checkpoint store, and this transport never
 * trusts it to redirect a request elsewhere.
 *
 * @module
 */

import type { FeatureId } from "../contract/types.js";
import { HonuaRealtimeResumeError } from "./resumable.js";
import type {
  RealtimeDeletePatch,
  RealtimeFeatureEvent,
  RealtimeFeaturePatch,
  RealtimeFeatureTransport,
  RealtimeSubscriptionHandle,
} from "./types.js";
import { realtimeFailure } from "./wire.js";

/** Raw OData entity as delivered in a `value[]` array entry, annotations included. */
export interface OdataDeltaEntity {
  readonly [key: string]: unknown;
}

/** `$`-shaped query options applied only to the initial full-collection snapshot request. */
export interface OdataDeltaInitialQuery {
  readonly filter?: string;
  readonly select?: readonly string[];
  readonly orderBy?: readonly string[];
  readonly top?: number;
}

/** Honest pull-cadence/freshness telemetry emitted after every request cycle. Never implies push liveness. */
export interface OdataDeltaPollTelemetry {
  /** When this cycle's response was accepted, per `now()`. */
  readonly polledAt: number;
  /** When the next poll is scheduled, per `now()`. Absent while a resnapshot recovery is in progress. */
  readonly nextPollAt?: number;
  readonly intervalMs: number;
  readonly sequence: number;
  readonly changed: boolean;
  readonly upsertCount: number;
  readonly deleteCount: number;
}

export interface OdataDeltaTransportOptions<TFeature = unknown> {
  /**
   * Absolute OData entity-set collection URL, e.g.
   * `"https://host/odata/Incidents"`. Every `@odata.nextLink` /
   * `@odata.deltaLink` this transport follows, and any resumed
   * `resumeFrom.deltaToken`, must resolve to this exact origin and path
   * (REQ-002).
   */
  readonly url: string;
  /** Delay between the end of one accepted cycle and the start of the next. */
  readonly pollIntervalMs: number;
  /** Extract a stable entity id from a raw OData entity for `RealtimeFeaturePatch.id`. */
  readonly entityId: (entity: OdataDeltaEntity) => FeatureId;
  /** Project a raw OData entity into the feature payload. @default the entity with `@`-prefixed annotations stripped */
  readonly toFeature?: (entity: OdataDeltaEntity) => TFeature;
  /** `$filter` / `$select` / `$orderby` / `$top` applied only to the initial snapshot request. */
  readonly initialQuery?: OdataDeltaInitialQuery;
  /** Request headers, recomputed for every request (e.g. a fresh bearer token). */
  readonly headers?: () => Record<string, string>;
  /** Injectable fetch; defaults to `globalThis.fetch`. */
  readonly fetchImpl?: typeof fetch;
  /**
   * Classify a non-ok response as an expired/rejected delta link that should
   * trigger an explicit resnapshot rather than a generic transport failure.
   * @default status => status === 410
   */
  readonly isDeltaLinkExpiredResponse?: (status: number, body: unknown) => boolean;
  /**
   * Identify an OData delta-payload entry as an unsupported relationship
   * (link) change rather than an entity change, per REQ-003. Relationship
   * deltas fail explicitly instead of being silently dropped or
   * misinterpreted as an entity upsert.
   * @default entry with string `source`, `relationship`, and `target` properties
   */
  readonly isRelationshipDeltaEntry?: (entry: OdataDeltaEntity) => boolean;
  /** Safety bound on `@odata.nextLink` pages followed within one cycle. @default 500 */
  readonly maxPagesPerCycle?: number;
  /** Safety bound on rows collected by one snapshot cycle. @default 50_000 */
  readonly maxSnapshotRows?: number;
  /** Consecutive expired-delta-link resnapshots tolerated before failing closed. @default 3 */
  readonly maxConsecutiveResnapshots?: number;
  readonly onPoll?: (telemetry: OdataDeltaPollTelemetry) => void;
  readonly now?: () => number;
}

const DEFAULT_MAX_PAGES_PER_CYCLE = 500;
const DEFAULT_MAX_SNAPSHOT_ROWS = 50_000;
const DEFAULT_MAX_CONSECUTIVE_RESNAPSHOTS = 3;

/**
 * Build a {@link RealtimeFeatureTransport} that polls an OData v4 entity
 * set's delta link. See the module doc for the full recovery/security model.
 */
export function createOdataDeltaTransport<TFeature = unknown>(
  options: OdataDeltaTransportOptions<TFeature>,
): RealtimeFeatureTransport<TFeature> {
  if (typeof options.entityId !== "function") {
    throw new TypeError("createOdataDeltaTransport requires options.entityId.");
  }
  const pollIntervalMs = positiveInteger(options.pollIntervalMs, "pollIntervalMs");
  const maxPagesPerCycle = positiveInteger(options.maxPagesPerCycle ?? DEFAULT_MAX_PAGES_PER_CYCLE, "maxPagesPerCycle");
  const maxSnapshotRows = positiveInteger(options.maxSnapshotRows ?? DEFAULT_MAX_SNAPSHOT_ROWS, "maxSnapshotRows");
  const maxConsecutiveResnapshots = positiveInteger(
    options.maxConsecutiveResnapshots ?? DEFAULT_MAX_CONSECUTIVE_RESNAPSHOTS,
    "maxConsecutiveResnapshots",
  );
  const collectionUrl = parseAbsoluteUrl(
    options.url,
    `createOdataDeltaTransport requires an absolute options.url ("${options.url}").`,
  );

  return {
    capabilities: {
      kind: "polling",
      resumeModes: ["delta-token"],
      emitsHeartbeats: false,
      emitsWatermarks: false,
    },
    subscribe(request, observer): RealtimeSubscriptionHandle {
      if (request.signal?.aborted) {
        observer.complete();
        return { close: () => {} };
      }

      const resumeDeltaToken = request.deltaToken ?? request.resumeFrom?.deltaToken;
      let initialDeltaLink: string | undefined;
      if (resumeDeltaToken !== undefined) {
        const resumeUrl = parseRelativeOdataUrl(
          resumeDeltaToken,
          collectionUrl,
          `Realtime resumeFrom.deltaToken "${resumeDeltaToken}" is not a valid URL.`,
        );
        assertSameOdataCollection(collectionUrl, resumeUrl);
        initialDeltaLink = resumeUrl.toString();
      }

      const now = (): number => options.now?.() ?? Date.now();
      const controller = new AbortController();
      let closed = false;
      let sequence = 0;
      let resnapshotStreak = 0;
      let timer: ReturnType<typeof setTimeout> | undefined;

      const abortListener = () => teardown("Subscription signal was aborted.", true);
      request.signal?.addEventListener("abort", abortListener, { once: true });

      function teardown(reason: string, complete: boolean): void {
        if (closed) return;
        closed = true;
        if (timer !== undefined) clearTimeout(timer);
        request.signal?.removeEventListener("abort", abortListener);
        if (!controller.signal.aborted) controller.abort(reason);
        if (complete) observer.complete();
      }

      function fail(error: unknown): void {
        if (closed) return;
        closed = true;
        if (timer !== undefined) clearTimeout(timer);
        request.signal?.removeEventListener("abort", abortListener);
        if (!controller.signal.aborted) controller.abort("OData delta transport failed.");
        observer.error(error);
      }

      function emit(event: RealtimeFeatureEvent<TFeature>): boolean {
        if (closed) return false;
        try {
          observer.next(event);
          return true;
        } catch (cause) {
          fail(realtimeFailure("consumer-failed", "Realtime event observer rejected delivery.", cause));
          return false;
        }
      }

      function reportPoll(partial: {
        readonly changed: boolean;
        readonly upsertCount: number;
        readonly deleteCount: number;
        readonly scheduled: boolean;
      }): void {
        if (!options.onPoll) return;
        try {
          options.onPoll({
            polledAt: now(),
            intervalMs: pollIntervalMs,
            sequence,
            changed: partial.changed,
            upsertCount: partial.upsertCount,
            deleteCount: partial.deleteCount,
            ...(partial.scheduled ? { nextPollAt: now() + pollIntervalMs } : {}),
          });
        } catch {
          // Telemetry is diagnostic only; a throwing onPoll callback must
          // never affect delivery.
        }
      }

      function schedulePoll(link: string): void {
        if (closed) return;
        timer = setTimeout(() => {
          timer = undefined;
          void runDeltaCycle(link);
        }, pollIntervalMs);
      }

      async function fetchOdataDocument(target: string, trackChanges: boolean): Promise<OdataDeltaEnvelope> {
        const fetchImpl = resolveFetch(options.fetchImpl);
        const headers: Record<string, string> = { Accept: "application/json", ...(options.headers?.() ?? {}) };
        if (trackChanges) headers.Prefer = "odata.track-changes";
        let response: Response;
        try {
          response = await fetchImpl(target, { method: "GET", headers, signal: controller.signal });
        } catch (cause) {
          if (controller.signal.aborted) throw cause;
          throw realtimeFailure("transport-gap", "OData delta request failed.", cause);
        }
        if (!response.ok) {
          const body = await safeReadJson(response);
          const isExpired = (options.isDeltaLinkExpiredResponse ?? defaultIsDeltaLinkExpiredResponse)(
            response.status,
            body,
          );
          if (isExpired) {
            throw new HonuaRealtimeResumeError(
              "cursor-expired",
              `OData delta link expired or was rejected by the server (HTTP ${String(response.status)}).`,
            );
          }
          throw realtimeFailure(
            response.status >= 500 ? "transport-gap" : "invalid-event",
            `OData delta request failed with HTTP ${String(response.status)}${response.statusText ? ` ${response.statusText}` : ""}.`,
            body,
          );
        }
        const body = await safeReadJson(response);
        if (!isRecord(body) || !Array.isArray(body.value)) {
          throw realtimeFailure("invalid-event", "OData delta response is missing a JSON `value` array.", body);
        }
        return body as unknown as OdataDeltaEnvelope;
      }

      function parseEntry(raw: unknown): PageEntry<TFeature> {
        if (!isRecord(raw)) {
          throw realtimeFailure("invalid-event", "OData delta entry must be a JSON object.", raw);
        }
        const removed = raw["@removed"] ?? raw["@odata.removed"];
        if (removed !== undefined) {
          return { kind: "delete", patch: { id: removedEntryId(raw) } };
        }
        const isRelationshipDelta = options.isRelationshipDeltaEntry ?? defaultIsRelationshipDeltaEntry;
        if (isRelationshipDelta(raw)) {
          throw realtimeFailure(
            "invalid-event",
            "OData relationship (link) deltas are not supported by createOdataDeltaTransport; only entity upserts and removals are normalized (REQ-003).",
            raw,
          );
        }
        try {
          const id = options.entityId(raw);
          const feature = (options.toFeature ?? (defaultToFeature as (entity: OdataDeltaEntity) => TFeature))(raw);
          return { kind: "upsert", patch: { id, feature } };
        } catch (cause) {
          throw realtimeFailure("invalid-event", "OData delta entry projection (entityId/toFeature) failed.", cause);
        }
      }

      function removedEntryId(entry: Record<string, unknown>): FeatureId {
        const withoutAnnotations = Object.fromEntries(Object.entries(entry).filter(([key]) => !key.startsWith("@")));
        if (Object.keys(withoutAnnotations).length > 0) {
          try {
            return options.entityId(withoutAnnotations);
          } catch {
            // Fall through to @id parsing below.
          }
        }
        const idValue = entry["@id"] ?? entry["@odata.id"];
        if (typeof idValue !== "string") {
          throw realtimeFailure(
            "invalid-event",
            "OData removed delta entry has neither key properties nor an @id/@odata.id to derive an id from.",
            entry,
          );
        }
        const key = parseODataIdKey(idValue);
        if (key === undefined) {
          throw realtimeFailure(
            "invalid-event",
            `OData removed delta entry's id "${idValue}" uses a composite or unparseable key; the removed entry must retain key properties instead.`,
            entry,
          );
        }
        return key;
      }

      async function runCycle(startUrl: string, mode: "snapshot" | "delta"): Promise<CycleResult<TFeature>> {
        let target = startUrl;
        let pages = 0;
        const upserts: RealtimeFeaturePatch<TFeature>[] = [];
        const deletes: RealtimeDeletePatch[] = [];
        let deltaLink: string | undefined;
        while (true) {
          pages += 1;
          if (pages > maxPagesPerCycle) {
            throw realtimeFailure(
              "delivery-failed",
              `OData delta paging exceeded the configured ${String(maxPagesPerCycle)}-page bound.`,
              undefined,
            );
          }
          const envelope = await fetchOdataDocument(target, mode === "snapshot" && pages === 1);
          for (const raw of envelope.value) {
            const parsed = parseEntry(raw);
            if (parsed.kind === "delete") deletes.push(parsed.patch);
            else upserts.push(parsed.patch);
            if (mode === "snapshot" && upserts.length > maxSnapshotRows) {
              throw realtimeFailure(
                "delivery-failed",
                `OData snapshot exceeded the configured ${String(maxSnapshotRows)}-row bound.`,
                undefined,
              );
            }
          }
          const pageDeltaLink = envelope["@odata.deltaLink"];
          if (pageDeltaLink !== undefined) {
            const resolved = parseRelativeOdataUrl(
              pageDeltaLink,
              target,
              `OData response @odata.deltaLink "${pageDeltaLink}" is not a valid URL.`,
            );
            assertSameOdataCollection(collectionUrl, resolved);
            deltaLink = resolved.toString();
          }
          const nextLink = envelope["@odata.nextLink"];
          if (nextLink === undefined) break;
          const resolvedNext = parseRelativeOdataUrl(
            nextLink,
            target,
            `OData response @odata.nextLink "${nextLink}" is not a valid URL.`,
          );
          assertSameOdataCollection(collectionUrl, resolvedNext);
          target = resolvedNext.toString();
        }
        if (deltaLink === undefined) {
          throw realtimeFailure(
            "invalid-event",
            "OData response did not include a terminal @odata.deltaLink; the server may not support delta-link change tracking for this collection.",
            undefined,
          );
        }
        return { upserts, deletes, deltaLink };
      }

      function buildInitialUrl(): string {
        const url = new URL(collectionUrl.toString());
        const query = options.initialQuery;
        if (query?.filter) url.searchParams.set("$filter", query.filter);
        if (query?.select?.length) url.searchParams.set("$select", query.select.join(","));
        if (query?.orderBy?.length) url.searchParams.set("$orderby", query.orderBy.join(","));
        if (typeof query?.top === "number" && Number.isFinite(query.top)) {
          url.searchParams.set("$top", String(query.top));
        }
        return url.toString();
      }

      /**
       * Shared recovery path for a `cursor-expired` failure from *either*
       * cycle: a real server should only ever reject a `$deltatoken`, but a
       * caller-supplied `isDeltaLinkExpiredResponse` could in principle
       * classify any response that way, so both cycles route through the
       * same bounded streak counter (REQ-005) rather than the snapshot
       * cycle failing closed on its very first retry.
       */
      async function recoverFromExpiredDeltaLink(cause: HonuaRealtimeResumeError): Promise<void> {
        resnapshotStreak += 1;
        if (resnapshotStreak > maxConsecutiveResnapshots) {
          fail(
            realtimeFailure(
              "delivery-failed",
              `OData delta link expired ${String(resnapshotStreak)} times consecutively; giving up after the configured ${String(maxConsecutiveResnapshots)}-resnapshot bound.`,
              cause,
            ),
          );
          return;
        }
        reportPoll({ changed: false, upsertCount: 0, deleteCount: 0, scheduled: false });
        const delivered = emit({
          type: "status",
          status: "reconnecting",
          reason: "cursor-expired",
          receivedAt: now(),
        });
        if (!delivered) return;
        await runSnapshotCycle();
      }

      async function runSnapshotCycle(): Promise<void> {
        try {
          const cycle = await runCycle(buildInitialUrl(), "snapshot");
          if (closed) return;
          resnapshotStreak = 0;
          sequence += 1;
          const delivered = emit({
            type: "snapshot",
            sequence,
            deltaToken: cycle.deltaLink,
            receivedAt: now(),
            replace: true,
            features: cycle.upserts,
          });
          if (!delivered) return;
          reportPoll({
            changed: true,
            upsertCount: cycle.upserts.length,
            deleteCount: 0,
            scheduled: true,
          });
          schedulePoll(cycle.deltaLink);
        } catch (cause) {
          if (closed) return;
          if (cause instanceof HonuaRealtimeResumeError && cause.code === "cursor-expired") {
            await recoverFromExpiredDeltaLink(cause);
            return;
          }
          fail(cause);
        }
      }

      async function runDeltaCycle(link: string): Promise<void> {
        try {
          const cycle = await runCycle(link, "delta");
          if (closed) return;
          resnapshotStreak = 0;
          sequence += 1;
          const changed = cycle.upserts.length > 0 || cycle.deletes.length > 0;
          const delivered = emit(
            changed
              ? {
                  type: "delta",
                  sequence,
                  deltaToken: cycle.deltaLink,
                  receivedAt: now(),
                  ...(cycle.upserts.length ? { upserts: cycle.upserts } : {}),
                  ...(cycle.deletes.length ? { deletes: cycle.deletes } : {}),
                }
              : {
                  type: "status",
                  status: "live",
                  sequence,
                  deltaToken: cycle.deltaLink,
                  receivedAt: now(),
                  reason: "poll-unchanged",
                },
          );
          if (!delivered) return;
          reportPoll({
            changed,
            upsertCount: cycle.upserts.length,
            deleteCount: cycle.deletes.length,
            scheduled: true,
          });
          schedulePoll(cycle.deltaLink);
        } catch (cause) {
          if (closed) return;
          if (cause instanceof HonuaRealtimeResumeError && cause.code === "cursor-expired") {
            await recoverFromExpiredDeltaLink(cause);
            return;
          }
          fail(cause);
        }
      }

      void (initialDeltaLink !== undefined ? runDeltaCycle(initialDeltaLink) : runSnapshotCycle());

      return {
        close(): void {
          teardown("Subscription closed by caller.", true);
        },
      };
    },
  };
}

// ── Internal ────────────────────────────────────────────────────

type PageEntry<TFeature> =
  | { readonly kind: "upsert"; readonly patch: RealtimeFeaturePatch<TFeature> }
  | { readonly kind: "delete"; readonly patch: RealtimeDeletePatch };

interface CycleResult<TFeature> {
  readonly upserts: RealtimeFeaturePatch<TFeature>[];
  readonly deletes: RealtimeDeletePatch[];
  readonly deltaLink: string;
}

interface OdataDeltaEnvelope {
  readonly value: readonly unknown[];
  readonly "@odata.nextLink"?: string;
  readonly "@odata.deltaLink"?: string;
}

function defaultIsDeltaLinkExpiredResponse(status: number): boolean {
  return status === 410;
}

function defaultIsRelationshipDeltaEntry(entry: OdataDeltaEntity): boolean {
  return typeof entry.source === "string" && typeof entry.relationship === "string" && typeof entry.target === "string";
}

function defaultToFeature(entity: OdataDeltaEntity): OdataDeltaEntity {
  const clean: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(entity)) {
    if (!key.startsWith("@")) clean[key] = value;
  }
  return clean;
}

/**
 * Reject a next/delta link that does not resolve to the exact origin and
 * collection path this transport was configured for (REQ-002). Trailing
 * slashes are normalized so `.../Incidents` and `.../Incidents/` are treated
 * as the same collection.
 */
function assertSameOdataCollection(expected: URL, candidate: URL): void {
  if (candidate.origin !== expected.origin || normalizedPathname(candidate) !== normalizedPathname(expected)) {
    throw new HonuaRealtimeResumeError(
      "invalid-event",
      `OData delta/next link "${candidate.toString()}" does not resolve to the configured collection "${expected.toString()}"; refusing to follow a foreign link.`,
    );
  }
}

function normalizedPathname(url: URL): string {
  return url.pathname.length > 1 && url.pathname.endsWith("/") ? url.pathname.slice(0, -1) : url.pathname;
}

/**
 * Parse the single-value key predicate out of an OData `@id`/`@odata.id`
 * value like `Incidents('AB-12')` or `Incidents(42)`. Returns `undefined`
 * for composite keys (`Key1=1,Key2='a'`) or an unparseable shape — callers
 * treat that as unsupported rather than guessing.
 */
function parseODataIdKey(idValue: string): FeatureId | undefined {
  const open = idValue.lastIndexOf("(");
  if (open === -1 || !idValue.endsWith(")")) return undefined;
  const inner = idValue.slice(open + 1, -1);
  if (inner.includes("=") || hasTopLevelComma(inner)) return undefined;
  const unquoted = inner.startsWith("'") && inner.endsWith("'") ? inner.slice(1, -1).replace(/''/g, "'") : inner;
  if (unquoted.length === 0) return undefined;
  if (/^-?\d+$/.test(unquoted) && Number.isSafeInteger(Number(unquoted))) return Number(unquoted);
  return unquoted;
}

function hasTopLevelComma(inner: string): boolean {
  let quoted = false;
  for (const character of inner) {
    if (character === "'") quoted = !quoted;
    else if (character === "," && !quoted) return true;
  }
  return false;
}

function parseAbsoluteUrl(input: string, message: string): URL {
  try {
    return new URL(input);
  } catch (cause) {
    throw new TypeError(message, { cause });
  }
}

function parseRelativeOdataUrl(value: string, base: string | URL, message: string): URL {
  try {
    return new URL(value, base);
  } catch (cause) {
    throw new HonuaRealtimeResumeError("invalid-event", message, { cause });
  }
}

function resolveFetch(custom: typeof fetch | undefined): typeof fetch {
  if (custom) return custom;
  const globalFetch = (globalThis as unknown as { fetch?: typeof fetch }).fetch;
  if (!globalFetch) throw new Error("fetch is not available; provide fetchImpl for this runtime.");
  return globalFetch.bind(globalThis);
}

async function safeReadJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`createOdataDeltaTransport: ${name} must be a safe integer greater than zero.`);
  }
  return value;
}
