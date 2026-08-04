/**
 * Columnar-plane telemetry (issue #1043).
 *
 * Epic #394 asks the SDK to integrate planner, GeoParquet, GeoArrow, deck.gl,
 * caching, and telemetry "around one batch identity". Everything the columnar
 * plane measured was previously a per-call return value — `ColumnarBatchMetrics`
 * on a transfer receipt, a cache diagnostic on one module's callback, nothing at
 * all for patch or conversion — so two observations of the same batch could not
 * be correlated. This module is the seam that correlates them.
 *
 * Three properties decide the shape:
 *
 * 1. **It is the SDK's telemetry shape, not a new one.** `ColumnarTelemetry`
 *    is the same before/after/error collector as `HonuaRuntimeTelemetry`
 *    (`src/runtime/runtime.ts`), mirrored exactly the way
 *    `src/operator/telemetry.ts` mirrors it, so one embedder-supplied observer
 *    satisfies every surface. The span's `identity` slot is this plane's
 *    correlation key, exactly as `packageId` is the runtime's and `intentId`
 *    the operator's — and it is `undefined` for a batch that declares no
 *    identity rather than being invented.
 * 2. **It is structural and dependency-light.** The declaration is an interface
 *    the caller satisfies; nothing here imports a telemetry implementation, and
 *    this module imports no module outside `src/columnar/`. That matters because
 *    `transfer.ts`, `result.ts`, and `geoarrow-patch.ts` are on the data plane's
 *    hot path and are reachable from the `/deckgl` and `/geoparquet` bundles.
 * 3. **A span never carries a raw authorization scope.** The identity is
 *    reported as source id, source version, schema version, plan id, and the
 *    *digest* of the authorization scope — the same digest rule the cache key
 *    uses, which lives here (see {@link columnarAuthorizationScopeDigest}) so
 *    the hot-path modules can bind identity without importing the cache.
 *
 * **Zero cost when absent.** Every emitter entry point is reached through a
 * caller-side `telemetry ? … : undefined` guard and every terminal call through
 * `span?.finish(…)`, both of which short-circuit argument evaluation. With no
 * sink configured the columnar path allocates nothing here, performs no digest,
 * and reads no clock.
 *
 * **A hostile sink cannot reach the operation.** Every hook invocation, every
 * read of a caller-supplied property, and the digest itself are contained: a
 * sink that throws, or an identity with a throwing getter, changes neither the
 * result nor the typed error of the operation being observed. Sink calls are
 * never awaited.
 *
 * **Delivery ordering.** Binding a span costs one SHA-256 of the authorization
 * scope, which Web Crypto only offers asynchronously. The digest is memoized per
 * scope, so the *first* span for a previously unseen scope is delivered once its
 * digest resolves and every later span for that scope is delivered
 * synchronously. Within one span `before` always precedes its terminal event,
 * and cold spans sharing a scope stay in order because they chain on the same
 * digest promise. The observed operation never waits for either.
 *
 * @module
 */

import { HonuaGeoArrowError } from "./geoarrow-types.js";
import type { ColumnarBatchIdentityV1 } from "./types.js";

/**
 * The columnar operations that emit spans. Each value names one measurable
 * unit of work, not one function: `columnar-transfer` covers the ownership
 * handoff whether an application or the worker session performs it.
 */
export type ColumnarTelemetryKind =
  | "columnar-transfer"
  | "columnar-worker-operation"
  | "columnar-cache-read"
  | "columnar-cache-write"
  | "columnar-patch-apply"
  | "columnar-result-conversion";

/**
 * The batch identity a span is bound to.
 *
 * This is {@link ColumnarBatchIdentityV1} with the authorization scope replaced
 * by its digest, which is the whole point: telemetry must never become a side
 * channel for the scope value the cache key deliberately excludes. Ordering and
 * freshness are omitted because a span reports what an operation cost, not what
 * the batch is; the four keyed identifiers plus the scope digest are what make
 * two observations of the same batch correlatable.
 */
export interface ColumnarTelemetryIdentityV1 {
  readonly sourceId: string;
  readonly sourceVersion: string;
  readonly schemaVersion: string;
  readonly planId: string;
  /** {@link columnarAuthorizationScopeDigest} of the identity's scope. */
  readonly authorizationScopeDigest: `sha256:${string}`;
}

export interface ColumnarTelemetrySpan {
  readonly kind: ColumnarTelemetryKind;
  /** `undefined` when the batch declares no identity, or when no digest is available. */
  readonly identity: ColumnarTelemetryIdentityV1 | undefined;
  readonly startedAt: number;
  readonly detail?: Record<string, unknown>;
}

export interface ColumnarTelemetrySpanResult extends ColumnarTelemetrySpan {
  readonly finishedAt: number;
  readonly durationMs: number;
  readonly error?: unknown;
}

/**
 * Before/after/error collector for columnar execution. Mirrors
 * {@link HonuaRuntimeTelemetry}; supply one object and wire it to every
 * columnar surface. Hooks must not be relied on to run synchronously (see the
 * module's delivery-ordering note) and are never awaited.
 */
export interface ColumnarTelemetry {
  before?: (span: ColumnarTelemetrySpan) => void;
  after?: (span: ColumnarTelemetrySpanResult) => void;
  error?: (span: ColumnarTelemetrySpanResult) => void;
}

/** Injection point shared by every columnar surface that can be observed. */
export interface ColumnarTelemetryOptions {
  /**
   * Optional observer. Off by default: no surface constructs one, and with no
   * sink the observed path costs exactly what it costs without this module.
   */
  readonly telemetry?: ColumnarTelemetry;
}

const SCOPE_DIGEST_PREFIX = "honua-columnar-batch-cache-scope:v1:";

/**
 * Opaque digest of an authorization scope.
 *
 * The scope is documented as a non-secret opaque fingerprint; digesting it is
 * what keeps that promise enforceable rather than assumed, and keeps the raw
 * value out of the persistent cache key (`columnarBatchCacheKey`) and out of
 * every telemetry span.
 *
 * It lives in this module rather than in `batch-cache.ts` so the hot-path
 * columnar modules can bind span identity without importing the cache — the
 * rule has exactly one implementation and it is this one.
 *
 * @throws HonuaGeoArrowError `missing-peer` when the host exposes no Web Crypto
 * SHA-256. The digest is never approximated and the raw scope is never
 * substituted for it.
 */
export async function columnarAuthorizationScopeDigest(scope: string): Promise<`sha256:${string}`> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new HonuaGeoArrowError("missing-peer", "Columnar authorization-scope digests require Web Crypto SHA-256.", {
      resource: "crypto.subtle",
    });
  }
  const digest = await subtle.digest("SHA-256", new TextEncoder().encode(`${SCOPE_DIGEST_PREFIX}${scope}`));
  let hex = "";
  for (const byte of new Uint8Array(digest)) hex += byte.toString(16).padStart(2, "0");
  return `sha256:${hex}`;
}

/**
 * Bounded scope→digest memo.
 *
 * Scopes are non-secret fingerprints and an application holds a handful of
 * them, so this is small by nature; it is bounded anyway (oldest-first) because
 * an unbounded module-level map keyed by caller data is a retention bug waiting
 * to happen. Spans are derived observations and nothing here is persisted.
 */
const MAX_MEMOIZED_SCOPES = 64;
const resolvedScopeDigests = new Map<string, `sha256:${string}`>();
const pendingScopeDigests = new Map<string, Promise<`sha256:${string}` | undefined>>();

function memoize(scope: string, digest: `sha256:${string}`): void {
  if (resolvedScopeDigests.size >= MAX_MEMOIZED_SCOPES) {
    const oldest = resolvedScopeDigests.keys().next();
    if (!oldest.done) resolvedScopeDigests.delete(oldest.value);
  }
  resolvedScopeDigests.set(scope, digest);
}

/** Resolve and memoize one scope digest. Never rejects: a failure is `undefined`. */
function scopeDigest(scope: string): Promise<`sha256:${string}` | undefined> {
  const pending = pendingScopeDigests.get(scope);
  if (pending) return pending;
  const resolving = columnarAuthorizationScopeDigest(scope).then(
    (digest) => {
      pendingScopeDigests.delete(scope);
      memoize(scope, digest);
      return digest;
    },
    () => {
      // Without a digest an identity cannot be reported at all, because the raw
      // scope is never an acceptable substitute for it.
      pendingScopeDigests.delete(scope);
      return undefined;
    },
  );
  pendingScopeDigests.set(scope, resolving);
  return resolving;
}

/**
 * Resolve once every span deferred behind a cold scope digest has been
 * delivered.
 *
 * Deliberately not part of the package surface: it exists so this repo's tests
 * can assert delivery deterministically instead of racing a digest that Node
 * completes on its thread pool. Nothing on a columnar path awaits it.
 */
export async function columnarTelemetryDelivered(): Promise<void> {
  for (let turn = 0; turn < 8; turn += 1) {
    if (pendingScopeDigests.size > 0) await Promise.allSettled([...pendingScopeDigests.values()]);
    // Each deferred span chains `before` and then its terminal event on that
    // digest, so the queue needs a turn per link.
    await Promise.resolve();
  }
}

/** Read the four keyed identifiers, tolerating a hostile or malformed identity. */
function keyedIdentity(
  identity: ColumnarBatchIdentityV1,
):
  | { readonly scope: string; readonly fields: Omit<ColumnarTelemetryIdentityV1, "authorizationScopeDigest"> }
  | undefined {
  try {
    const sourceId = identity.sourceId;
    const sourceVersion = identity.sourceVersion;
    const schemaVersion = identity.schemaVersion;
    const planId = identity.planId;
    const scope = identity.authorizationScope;
    if (
      typeof sourceId !== "string" ||
      typeof sourceVersion !== "string" ||
      typeof schemaVersion !== "string" ||
      typeof planId !== "string" ||
      typeof scope !== "string"
    ) {
      return undefined;
    }
    return { scope, fields: { sourceId, sourceVersion, schemaVersion, planId } };
  } catch {
    return undefined;
  }
}

/** One in-flight observation. Terminal calls are idempotent. */
export interface ColumnarSpanHandle {
  /** Record success. `detail` is merged over the detail the span started with. */
  finish(detail?: Record<string, unknown>): void;
  /** Record failure with the value the operation is about to throw or reject with. */
  fail(error: unknown, detail?: Record<string, unknown>): void;
}

class ColumnarSpan implements ColumnarSpanHandle {
  readonly #telemetry: ColumnarTelemetry;
  readonly #kind: ColumnarTelemetryKind;
  readonly #startedAt: number;
  readonly #detail: Record<string, unknown> | undefined;
  #identity: ColumnarTelemetryIdentityV1 | undefined;
  /** Set only while this span's scope digest is still cold. */
  #gate: Promise<void> | undefined;
  #settled = false;

  public constructor(
    telemetry: ColumnarTelemetry,
    kind: ColumnarTelemetryKind,
    identity: ColumnarBatchIdentityV1 | undefined,
    detail: Record<string, unknown> | undefined,
  ) {
    this.#telemetry = telemetry;
    this.#kind = kind;
    this.#startedAt = Date.now();
    this.#detail = detail;
    const keyed = identity === undefined || identity === null ? undefined : keyedIdentity(identity);
    if (keyed === undefined) {
      this.#emitBefore();
      return;
    }
    const memoized = resolvedScopeDigests.get(keyed.scope);
    if (memoized !== undefined) {
      this.#identity = Object.freeze({ ...keyed.fields, authorizationScopeDigest: memoized });
      this.#emitBefore();
      return;
    }
    this.#gate = scopeDigest(keyed.scope).then((digest) => {
      if (digest !== undefined) {
        this.#identity = Object.freeze({ ...keyed.fields, authorizationScopeDigest: digest });
      }
      this.#emitBefore();
    });
  }

  public finish(detail?: Record<string, unknown>): void {
    this.#settle(detail, undefined);
  }

  public fail(error: unknown, detail?: Record<string, unknown>): void {
    this.#settle(detail, { error });
  }

  #settle(detail: Record<string, unknown> | undefined, failure: { readonly error: unknown } | undefined): void {
    if (this.#settled) return;
    this.#settled = true;
    if (this.#gate === undefined) {
      this.#emitTerminal(detail, failure);
      return;
    }
    // Ordered, never awaited by the operation: the terminal event follows its
    // own `before` even when the digest was still resolving.
    void this.#gate.then(() => {
      this.#emitTerminal(detail, failure);
    });
  }

  #emitBefore(): void {
    const span: ColumnarTelemetrySpan = Object.freeze({
      kind: this.#kind,
      identity: this.#identity,
      startedAt: this.#startedAt,
      ...(this.#detail === undefined ? {} : { detail: this.#detail }),
    });
    deliver(this.#telemetry, "before", span);
  }

  #emitTerminal(detail: Record<string, unknown> | undefined, failure: { readonly error: unknown } | undefined): void {
    const finishedAt = Date.now();
    const merged =
      this.#detail === undefined ? detail : detail === undefined ? this.#detail : { ...this.#detail, ...detail };
    const result: ColumnarTelemetrySpanResult = Object.freeze({
      kind: this.#kind,
      identity: this.#identity,
      startedAt: this.#startedAt,
      ...(merged === undefined ? {} : { detail: merged }),
      finishedAt,
      durationMs: finishedAt - this.#startedAt,
      ...(failure === undefined ? {} : { error: failure.error }),
    });
    deliver(this.#telemetry, failure === undefined ? "after" : "error", result);
  }
}

/** Invoke one hook. A missing, unreadable, or throwing hook is inert. */
function deliver(
  telemetry: ColumnarTelemetry,
  hook: "before" | "after" | "error",
  span: ColumnarTelemetrySpanResult | ColumnarTelemetrySpan,
): void {
  try {
    const listener = telemetry[hook];
    if (typeof listener !== "function") return;
    listener(span as ColumnarTelemetrySpanResult);
  } catch {
    // An observer cannot fail, stall, or alter the operation it observes.
  }
}

/**
 * Begin one observation.
 *
 * Callers guard the call itself — `telemetry ? beginColumnarSpan(telemetry, …) : undefined` —
 * so that with no sink neither this function nor its `detail` argument is ever
 * evaluated. Returns `undefined` when a span could not be started, which the
 * `span?.finish(…)` call sites treat exactly like "no sink".
 */
export function beginColumnarSpan(
  telemetry: ColumnarTelemetry,
  kind: ColumnarTelemetryKind,
  identity: ColumnarBatchIdentityV1 | undefined,
  detail?: Record<string, unknown>,
): ColumnarSpanHandle | undefined {
  try {
    if (typeof telemetry !== "object" || telemetry === null) return undefined;
    return new ColumnarSpan(telemetry, kind, identity, detail);
  } catch {
    return undefined;
  }
}
