/**
 * Typed client for the Studio package lifecycle API
 * (`/api/v{version}/studio` in `honua-server`): package-family capability
 * discovery, draft CRUD with optimistic-generation checking, validate,
 * preview-plan, immutable content versions, version comparisons, publication
 * requests, reopen, and rollback requests.
 *
 * Mirrors {@link HonuaControlPlaneClient}'s ergonomics
 * (`src/control-plane/client.ts`): construct with the SDK's standard
 * {@link HonuaClient} (transport, auth, retry, and timeout are inherited from
 * it), reach resource groups off the client instance
 * (`.drafts`, `.contentVersions`, `.publicationRequests`, `.rollbackRequests`,
 * `.packageFamilies`), and use `.raw()` for any endpoint that does not yet
 * have a dedicated method.
 *
 * Every method throws {@link HonuaStudioError} on a non-2xx response — see
 * `./lifecycle-errors.js` for the RFC 7807 problem-detail taxonomy and the
 * `generation-conflict` discriminant.
 *
 * ## Publication proposals
 *
 * {@link HonuaStudioPublicationRequestsClient} submits an already-saved
 * immutable version for publication, reads the resulting proposal, and walks
 * it to a final state with a bounded, cancellable
 * {@link HonuaStudioPublicationRequestsClient.poll}. Only `Active` yields a
 * final publication URL; `Rejected` and `Failed` are terminal without one,
 * and a status this release does not recognize is treated as neither.
 * Approval is deliberately **not** part of this surface — see that class's
 * doc comment.
 *
 * ## Enumeration gap
 *
 * The lifecycle API doc is explicit that **there is no endpoint to enumerate
 * drafts or content items** — only single-resource reads
 * (`GET /package-drafts/{draftId}`, `GET /content-items/{itemId}/versions`,
 * `GET /content-items/{itemId}/versions/{versionId}`) and the
 * family-discovery list (`GET /package-families`, which already returns every
 * family in one response and does need no list method of its own).
 * `honua-server#3003` tracks adding a draft/content-item enumeration
 * endpoint. Until it ships:
 *
 * - `contentVersions.list(itemId)` already covers version enumeration *for a
 *   known item* — the gap is discovering `itemId`/`draftId` values in the
 *   first place, not paging a known collection.
 * - `.raw()` reaches any endpoint honua-server adds before this client grows
 *   a dedicated method for it, without a breaking-change window.
 * - When the enumeration endpoint ships, it is additive: a new
 *   `drafts.list(options)` (or a new resource group) can be added without
 *   touching any existing method signature.
 *
 * @module
 */

import type { HonuaClient } from "../core/client.js";
import { HonuaTimeoutError, isHonuaError } from "../core/errors.js";
import type { QueryMethod } from "../core/types.js";
import { HonuaStudioError, type HonuaStudioProblemDetails, classifyStudioProblemStatus } from "./lifecycle-errors.js";
import type {
  StudioApiResponse,
  StudioContentVersion,
  StudioContentVersionListResponse,
  StudioPackageDraft,
  StudioPackageDraftCreateRequest,
  StudioPackageDraftReplaceRequest,
  StudioPackageFamilyCapabilities,
  StudioPreviewPlan,
  StudioPublicationLifecycleState,
  StudioPublicationRequest,
  StudioPublicationRequestInput,
  StudioReopenVersionRequest,
  StudioRollbackRequest,
  StudioRollbackRequestInput,
  StudioValidationSummary,
  StudioVersionComparison,
  StudioVersionComparisonRequest,
} from "./lifecycle-types.js";
import {
  isStudioPublicationActive,
  isStudioPublicationTerminal,
  normalizeStudioPublicationStatus,
  studioPublicationUrl,
} from "./publication-status.js";

/** Default base path for the Studio package lifecycle API. */
export const HONUA_STUDIO_LIFECYCLE_BASE_PATH = "/api/v1/studio" as const;

/** Constructor options for {@link HonuaStudioLifecycleClient}. */
export interface HonuaStudioLifecycleClientOptions {
  readonly client: HonuaClient;
  readonly basePath?: string;
}

/** Per-call options accepted by every {@link HonuaStudioLifecycleClient} method. */
export interface HonuaStudioRequestOptions {
  readonly signal?: AbortSignal;
  readonly headers?: HeadersInit;
}

/** Escape-hatch request for {@link HonuaStudioLifecycleClient.raw}. */
export interface HonuaStudioRawRequest extends HonuaStudioRequestOptions {
  readonly method?: QueryMethod;
  readonly path: string;
  readonly body?: unknown;
}

/** Construct a {@link HonuaStudioLifecycleClient} from an existing {@link HonuaClient}. */
export function createHonuaStudioLifecycleClient(
  options: HonuaStudioLifecycleClientOptions,
): HonuaStudioLifecycleClient {
  return new HonuaStudioLifecycleClient(options);
}

/**
 * Typed client for every endpoint in the Studio package lifecycle API.
 *
 * @experimental Not yet covered by the SDK's semver contract.
 */
export class HonuaStudioLifecycleClient {
  readonly #client: HonuaClient;
  readonly #basePath: string;

  public readonly packageFamilies: HonuaStudioPackageFamiliesClient;
  public readonly drafts: HonuaStudioDraftsClient;
  public readonly contentVersions: HonuaStudioContentVersionsClient;
  public readonly publicationRequests: HonuaStudioPublicationRequestsClient;
  public readonly rollbackRequests: HonuaStudioRollbackRequestsClient;

  public constructor(options: HonuaStudioLifecycleClientOptions) {
    this.#client = options.client;
    this.#basePath = normalizeBasePath(options.basePath ?? HONUA_STUDIO_LIFECYCLE_BASE_PATH);
    this.packageFamilies = new HonuaStudioPackageFamiliesClient(this);
    this.drafts = new HonuaStudioDraftsClient(this);
    this.contentVersions = new HonuaStudioContentVersionsClient(this);
    this.publicationRequests = new HonuaStudioPublicationRequestsClient(this);
    this.rollbackRequests = new HonuaStudioRollbackRequestsClient(this);
  }

  public get basePath(): string {
    return this.#basePath;
  }

  /** Escape hatch for endpoints without a dedicated method yet (see the module doc's "Enumeration gap"). */
  public raw<T = unknown>(request: HonuaStudioRawRequest): Promise<T> {
    return this.request<T>(request.method ?? "GET", request.path, request.body, {
      signal: request.signal,
      headers: request.headers,
    });
  }

  /** @internal */
  public async request<T>(
    method: QueryMethod,
    path: string,
    body: unknown,
    options: HonuaStudioRequestOptions = {},
  ): Promise<T> {
    try {
      const response = await this.#client.pipelineFetch(
        method,
        this.resolvePath(path),
        { headers: jsonHeaders(options.headers), body: body === undefined ? null : JSON.stringify(body) },
        options.signal,
      );
      if (response.status === 204) return undefined as T;
      return unwrapApiResponse<T>(await readJson(response));
    } catch (error) {
      throw toStudioError(error);
    }
  }

  /** @internal */
  public resolvePath(path: string): string {
    if (path.startsWith("http://") || path.startsWith("https://")) return path;
    const normalized = path.startsWith("/") ? path : `/${path}`;
    if (normalized === this.#basePath || normalized.startsWith(`${this.#basePath}/`)) return normalized;
    return `${this.#basePath}${normalized}`;
  }
}

/** `GET /package-families` — discover every package family's capabilities. */
export class HonuaStudioPackageFamiliesClient {
  readonly #lifecycle: HonuaStudioLifecycleClient;

  public constructor(lifecycle: HonuaStudioLifecycleClient) {
    this.#lifecycle = lifecycle;
  }

  /** Discover every package family, schema version, format, support level, and limitations. */
  public list(options: HonuaStudioRequestOptions = {}): Promise<StudioPackageFamilyCapabilities> {
    return this.#lifecycle.request("GET", "/package-families", undefined, options);
  }
}

/** `/package-drafts*` — mutable draft CRUD, validation, preview, and save-as-version. */
export class HonuaStudioDraftsClient {
  readonly #lifecycle: HonuaStudioLifecycleClient;

  public constructor(lifecycle: HonuaStudioLifecycleClient) {
    this.#lifecycle = lifecycle;
  }

  /** `POST /package-drafts` — create a mutable package draft. */
  public create(
    request: StudioPackageDraftCreateRequest,
    options: HonuaStudioRequestOptions = {},
  ): Promise<StudioPackageDraft> {
    return this.#lifecycle.request("POST", "/package-drafts", request, options);
  }

  /** `GET /package-drafts/{draftId}` — retrieve a mutable draft. */
  public get(draftId: string, options: HonuaStudioRequestOptions = {}): Promise<StudioPackageDraft> {
    return this.#lifecycle.request("GET", `/package-drafts/${encodeURIComponent(draftId)}`, undefined, options);
  }

  /**
   * `PUT /package-drafts/{draftId}` — replace a mutable draft with optional
   * optimistic `generation` checking. A stale `generation` throws
   * {@link HonuaStudioError} with `code: "generation-conflict"`.
   */
  public replace(
    draftId: string,
    request: StudioPackageDraftReplaceRequest,
    options: HonuaStudioRequestOptions = {},
  ): Promise<StudioPackageDraft> {
    return this.#lifecycle.request("PUT", `/package-drafts/${encodeURIComponent(draftId)}`, request, options);
  }

  /** `DELETE /package-drafts/{draftId}` — delete a draft. */
  public async delete(draftId: string, options: HonuaStudioRequestOptions = {}): Promise<void> {
    await this.#lifecycle.request<unknown>(
      "DELETE",
      `/package-drafts/${encodeURIComponent(draftId)}`,
      undefined,
      options,
    );
  }

  /** `POST /package-drafts/{draftId}/validate` — re-run validation, persisting the summary on the draft. */
  public validate(draftId: string, options: HonuaStudioRequestOptions = {}): Promise<StudioValidationSummary> {
    return this.#lifecycle.request(
      "POST",
      `/package-drafts/${encodeURIComponent(draftId)}/validate`,
      undefined,
      options,
    );
  }

  /**
   * `POST /package-drafts/{draftId}/preview-plan` — return a stable preview
   * plan. `gp`/`etl`/`workflow` drafts advertise job-backed previews.
   */
  public previewPlan(draftId: string, options: HonuaStudioRequestOptions = {}): Promise<StudioPreviewPlan> {
    return this.#lifecycle.request(
      "POST",
      `/package-drafts/${encodeURIComponent(draftId)}/preview-plan`,
      undefined,
      options,
    );
  }

  /**
   * `POST /package-drafts/{draftId}/content-versions` — save a draft as an
   * immutable content version and move the item's current pointer.
   */
  public createContentVersion(draftId: string, options: HonuaStudioRequestOptions = {}): Promise<StudioContentVersion> {
    return this.#lifecycle.request(
      "POST",
      `/package-drafts/${encodeURIComponent(draftId)}/content-versions`,
      undefined,
      options,
    );
  }
}

/** `/content-items/{itemId}/versions*` and `/version-comparisons` — immutable content versions. */
export class HonuaStudioContentVersionsClient {
  readonly #lifecycle: HonuaStudioLifecycleClient;

  public constructor(lifecycle: HonuaStudioLifecycleClient) {
    this.#lifecycle = lifecycle;
  }

  /** `GET /content-items/{itemId}/versions` — list immutable versions ordered by `versionNumber`. */
  public list(itemId: string, options: HonuaStudioRequestOptions = {}): Promise<StudioContentVersionListResponse> {
    return this.#lifecycle.request("GET", `/content-items/${encodeURIComponent(itemId)}/versions`, undefined, options);
  }

  /** `GET /content-items/{itemId}/versions/{versionId}` — retrieve one immutable version. */
  public get(
    itemId: string,
    versionId: string,
    options: HonuaStudioRequestOptions = {},
  ): Promise<StudioContentVersion> {
    return this.#lifecycle.request(
      "GET",
      `/content-items/${encodeURIComponent(itemId)}/versions/${encodeURIComponent(versionId)}`,
      undefined,
      options,
    );
  }

  /**
   * `POST /content-items/{itemId}/version-comparisons` — compare two
   * immutable versions by content hash, dependencies, validation, and
   * provenance.
   */
  public compare(
    itemId: string,
    request: StudioVersionComparisonRequest,
    options: HonuaStudioRequestOptions = {},
  ): Promise<StudioVersionComparison> {
    return this.#lifecycle.request(
      "POST",
      `/content-items/${encodeURIComponent(itemId)}/version-comparisons`,
      request,
      options,
    );
  }

  /**
   * `POST /content-items/{itemId}/versions/{versionId}/reopen` — copy an
   * immutable version into a new mutable draft with `baseVersionId` set.
   */
  public reopen(
    itemId: string,
    versionId: string,
    request: StudioReopenVersionRequest = {},
    options: HonuaStudioRequestOptions = {},
  ): Promise<StudioPackageDraft> {
    return this.#lifecycle.request(
      "POST",
      `/content-items/${encodeURIComponent(itemId)}/versions/${encodeURIComponent(versionId)}/reopen`,
      request,
      options,
    );
  }
}

/** Default delay between {@link HonuaStudioPublicationRequestsClient.poll} attempts. */
export const HONUA_STUDIO_PUBLICATION_POLL_INTERVAL_MS = 1_000;

/** Default attempt bound for {@link HonuaStudioPublicationRequestsClient.poll}. */
export const HONUA_STUDIO_PUBLICATION_POLL_MAX_ATTEMPTS = 30;

/**
 * Body keys a publication *submission* may never carry. Approval is a
 * separate principal acting through the canonical Admin API/CLI, so the SDK
 * refuses to serialize a submission that tries to assert its own decision,
 * override policy, or seed a terminal status — see
 * {@link HonuaStudioPublicationRequestsClient} for why this is enforced
 * client-side as well as server-side.
 *
 * Matching is on the exact key (case-insensitively); an additive server field
 * that merely *mentions* approval (`approvalPolicyId`, say) is unaffected.
 */
const REJECTED_SUBMISSION_KEYS: ReadonlySet<string> = new Set([
  "status",
  "state",
  "approve",
  "approved",
  "approval",
  "approvedat",
  "approvedby",
  "autoapprove",
  "selfapprove",
  "skipapproval",
  "bypassapproval",
  "bypasspolicy",
  "policyoverride",
  "overridepolicy",
  "force",
]);

/** Per-call options for {@link HonuaStudioPublicationRequestsClient.poll}. */
export interface HonuaStudioPublicationPollOptions extends HonuaStudioRequestOptions {
  /**
   * Delay between attempts, in milliseconds. Defaults to
   * {@link HONUA_STUDIO_PUBLICATION_POLL_INTERVAL_MS}. `0` polls back-to-back
   * with no wait, which is what tests want and production code does not.
   */
  readonly intervalMs?: number;
  /**
   * Hard upper bound on the number of `GET`s, defaulting to
   * {@link HONUA_STUDIO_PUBLICATION_POLL_MAX_ATTEMPTS}. The poll always stops:
   * there is no "wait forever" mode, and no option that produces one.
   */
  readonly maxAttempts?: number;
  /**
   * Optional wall-clock bound, in milliseconds, checked before each attempt
   * and before each wait. Whichever of `maxAttempts`/`timeoutMs` is reached
   * first ends the poll.
   */
  readonly timeoutMs?: number;
  /** Invoked with every observed proposal, including the last one. */
  readonly onStatus?: (request: StudioPublicationRequest, state: StudioPublicationLifecycleState | undefined) => void;
}

/**
 * The outcome of a bounded {@link HonuaStudioPublicationRequestsClient.poll}.
 *
 * `terminal: false` means the bound was reached before the proposal settled
 * (`exhausted` says which bound) — it is *not* a failure and the proposal may
 * still be progressing server-side; poll again with the same `requestId`.
 */
export interface StudioPublicationPollOutcome {
  /** The last proposal observed, verbatim — every joined identifier preserved. */
  readonly request: StudioPublicationRequest;
  /** The last status normalized, or `undefined` when this release does not recognize it. */
  readonly state: StudioPublicationLifecycleState | undefined;
  /** True only for `Active`, `Rejected` and `Failed`. An unrecognized state is never terminal. */
  readonly terminal: boolean;
  /** True only for `Active`. `Rejected`/`Failed` are terminal but not successful. */
  readonly active: boolean;
  /** The final publication URL — present **only** when `active` is true. */
  readonly publicationUrl: string | undefined;
  /** How many `GET`s were issued. */
  readonly attempts: number;
  /** Which bound ended a non-terminal poll, if any. */
  readonly exhausted: "max-attempts" | "timeout" | undefined;
}

/**
 * `/content-items/{itemId}/versions/{versionId}/publish-requests` — submit an
 * already-saved immutable version for publication and walk the resulting
 * proposal to a final state.
 *
 * ## Approval is a different principal
 *
 * This client can **create**, **get** and **poll** a publication proposal. It
 * deliberately exposes no approve, authorize, force, or policy-override
 * capability, and {@link create} refuses to serialize a submission body that
 * tries to smuggle one (see {@link REJECTED_SUBMISSION_KEYS}). A proposer
 * therefore cannot approve their own publication, or bypass policy, through
 * any method on this class — approval happens through the canonical Admin
 * API/CLI acting as a separate principal, and the server enforces the same
 * rule with a `403` (`code: "forbidden"`) if a proposer tries anyway.
 *
 * {@link HonuaStudioLifecycleClient.raw} is a generic HTTP escape hatch with
 * no Studio approval semantics of its own; it reaches whatever the server
 * exposes and is subject to exactly the same server-side authorization.
 */
export class HonuaStudioPublicationRequestsClient {
  readonly #lifecycle: HonuaStudioLifecycleClient;

  public constructor(lifecycle: HonuaStudioLifecycleClient) {
    this.#lifecycle = lifecycle;
  }

  /**
   * `POST /content-items/{itemId}/versions/{versionId}/publish-requests` —
   * submit an already-saved immutable version for publication.
   *
   * The submission carries only the identity of what is being published
   * (`itemId`, `versionId`, the optional `contentHash` pin), the requested
   * route/visibility `intent`, and an optional `idempotencyKey` so a replayed
   * submit resolves to the same proposal. It never carries a decision:
   * an approval, policy-override, or `status` key in `request` throws a
   * {@link HonuaStudioError} with `code: "validation"` **before** anything is
   * sent.
   *
   * The response carries the joined `operationInstanceId`, `proposalId`,
   * `proposalUri`, `auditId` and `correlationId` identifiers verbatim.
   */
  // `async` so the client-side approval guard below surfaces as a rejected
  // promise, exactly like every server-side failure on this client, rather
  // than as a synchronous throw callers would have to catch separately.
  public async create(
    itemId: string,
    versionId: string,
    request: StudioPublicationRequestInput = {},
    options: HonuaStudioRequestOptions = {},
  ): Promise<StudioPublicationRequest> {
    assertNoApprovalFields(request);
    return this.#lifecycle.request("POST", `${this.#path(itemId, versionId)}/publish-requests`, request, options);
  }

  /**
   * `GET /content-items/{itemId}/versions/{versionId}/publish-requests/{requestId}`
   * — read one publication proposal's current status and joined identifiers.
   *
   * A proposal that does not exist, or is not reachable from this
   * `itemId`/`versionId` pair, throws `code: "not-found"`; one outside the
   * caller's owner/tenant scope throws `code: "forbidden"`.
   */
  public get(
    itemId: string,
    versionId: string,
    requestId: string,
    options: HonuaStudioRequestOptions = {},
  ): Promise<StudioPublicationRequest> {
    return this.#lifecycle.request(
      "GET",
      `${this.#path(itemId, versionId)}/publish-requests/${encodeURIComponent(requestId)}`,
      undefined,
      options,
    );
  }

  /**
   * Poll one publication proposal until it reaches a terminal state or a
   * bound is reached, whichever comes first.
   *
   * - **Bounded by construction.** Every poll stops after at most
   *   `maxAttempts` `GET`s (and `timeoutMs`, when given). There is no
   *   unbounded mode.
   * - **A final publication URL only at `Active`.** `Rejected` and `Failed`
   *   end the poll with `terminal: true`, `active: false` and no URL.
   * - **An unrecognized status is never final.** A state this release does
   *   not know keeps the poll waiting until a bound is hit, and comes back as
   *   `state: undefined, terminal: false, active: false`.
   * - **Cancellable.** `options.signal` aborts the in-flight request and the
   *   wait between attempts; the returned promise rejects with the signal's
   *   abort reason — including when the abort lands mid-request, where the
   *   underlying `HonuaClient` would otherwise normalize the rejection to a
   *   generic SDK abort error.
   * - **`timeoutMs` is a real wall-clock bound.** It aborts an in-flight `GET`
   *   as well as being checked between attempts, and the inter-attempt wait is
   *   clamped to the time left, so a hung response cannot leave the poll
   *   pending past the deadline even when the underlying `HonuaClient` has no
   *   `timeoutMs` of its own. A deadline reached with at least one observation
   *   returns `exhausted: "timeout"`; a deadline that expires before the very
   *   first response arrives has nothing to report and throws
   *   {@link HonuaTimeoutError}.
   * - **Standard error handling.** Every non-2xx surfaces as
   *   {@link HonuaStudioError} with its RFC 7807 problem details, exactly as
   *   for every other method on this client.
   */
  public async poll(
    itemId: string,
    versionId: string,
    requestId: string,
    options: HonuaStudioPublicationPollOptions = {},
  ): Promise<StudioPublicationPollOutcome> {
    const maxAttempts = normalizePollBound(options.maxAttempts, HONUA_STUDIO_PUBLICATION_POLL_MAX_ATTEMPTS);
    const intervalMs = normalizeInterval(options.intervalMs);
    const timeoutMs = options.timeoutMs === undefined ? undefined : normalizeInterval(options.timeoutMs);
    // The wall-clock bound owns its own abort signal rather than being a
    // between-attempts `Date.now()` check alone: `HonuaClient` carries no
    // request timeout unless the consumer configured one, so a `GET` that is
    // accepted and never answered would otherwise hold the poll open forever
    // in spite of a finite `timeoutMs`.
    const deadline = createPollDeadline(timeoutMs, options.signal);
    const requestOptions: HonuaStudioRequestOptions = { signal: deadline.signal, headers: options.headers };
    let observed: { request: StudioPublicationRequest; state: StudioPublicationLifecycleState | undefined } | undefined;

    try {
      // Bounded by construction: the loop counter is the only thing that drives
      // it, `maxAttempts` is validated to be a finite integer >= 1, and every
      // path out of the body either returns or advances the counter.
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        throwIfAborted(options.signal);
        let request: StudioPublicationRequest;
        try {
          request = await this.get(itemId, versionId, requestId, requestOptions);
        } catch (error) {
          // The caller's cancellation is reported with the caller's own
          // `reason`. `HonuaClient.pipelineFetch` normalizes an in-flight fetch
          // abort into a generic SDK abort error, which would otherwise lose it.
          throwIfAborted(options.signal);
          if (deadline.expired()) return this.#timedOut(observed, attempt - 1, timeoutMs);
          throw error;
        }
        const state = normalizeStudioPublicationStatus(request.status);
        observed = { request, state };
        options.onStatus?.(request, state);
        if (isStudioPublicationTerminal(request.status)) {
          return toPollOutcome(request, state, attempt, undefined);
        }
        if (attempt >= maxAttempts) {
          return toPollOutcome(request, state, attempt, "max-attempts");
        }
        const remainingMs = deadline.remainingMs();
        if (remainingMs !== undefined && remainingMs <= 0) {
          return toPollOutcome(request, state, attempt, "timeout");
        }
        // Never sleep past the deadline: a `intervalMs` larger than the time
        // left would overshoot the documented bound by a whole interval.
        await delay(remainingMs === undefined ? intervalMs : Math.min(intervalMs, remainingMs), options.signal);
        const leftAfterWait = deadline.remainingMs();
        if (leftAfterWait !== undefined && leftAfterWait <= 0) {
          return toPollOutcome(request, state, attempt, "timeout");
        }
      }
    } finally {
      deadline.dispose();
    }

    // Unreachable while `maxAttempts >= 1`; kept so the bound is enforced by
    // the type system rather than by a comment.
    throw new TypeError(`maxAttempts must be an integer >= 1, received ${String(maxAttempts)}.`);
  }

  /**
   * The wall-clock bound fired. With at least one observation the poll reports
   * it the documented way (`exhausted: "timeout"`); with none there is no
   * proposal to report, so the deadline surfaces as the SDK's own
   * {@link HonuaTimeoutError} rather than an invented empty outcome.
   */
  #timedOut(
    observed: { request: StudioPublicationRequest; state: StudioPublicationLifecycleState | undefined } | undefined,
    attempts: number,
    timeoutMs: number | undefined,
  ): StudioPublicationPollOutcome {
    if (!observed) throw new HonuaTimeoutError(timeoutMs ?? 0);
    return toPollOutcome(observed.request, observed.state, attempts, "timeout");
  }

  #path(itemId: string, versionId: string): string {
    return `/content-items/${encodeURIComponent(itemId)}/versions/${encodeURIComponent(versionId)}`;
  }
}

/**
 * The poll's wall-clock bound as an abort signal the in-flight `GET` actually
 * receives, merged with the caller's own signal so one `signal` covers both.
 * `expired()` distinguishes "the deadline fired" from "the caller cancelled",
 * which decide different outcomes.
 */
interface PollDeadline {
  /** Passed to every `GET`; `undefined` only when there is neither a caller signal nor a timeout. */
  readonly signal: AbortSignal | undefined;
  /** True once the wall-clock bound fired (never for a caller abort). */
  readonly expired: () => boolean;
  /** Milliseconds left, or `undefined` when no `timeoutMs` was given. */
  readonly remainingMs: () => number | undefined;
  readonly dispose: () => void;
}

function createPollDeadline(timeoutMs: number | undefined, callerSignal: AbortSignal | undefined): PollDeadline {
  if (timeoutMs === undefined) {
    return {
      signal: callerSignal,
      expired: () => false,
      remainingMs: () => undefined,
      dispose: () => undefined,
    };
  }
  const controller = new AbortController();
  const expiresAt = Date.now() + timeoutMs;
  let expired = false;
  const timer = setTimeout(() => {
    expired = true;
    controller.abort();
  }, timeoutMs);
  const onCallerAbort = (): void => {
    controller.abort(callerSignal ? abortReason(callerSignal) : undefined);
  };
  if (callerSignal?.aborted) onCallerAbort();
  else callerSignal?.addEventListener("abort", onCallerAbort, { once: true });
  return {
    signal: controller.signal,
    expired: () => expired,
    remainingMs: () => expiresAt - Date.now(),
    dispose: () => {
      clearTimeout(timer);
      callerSignal?.removeEventListener("abort", onCallerAbort);
    },
  };
}

function toPollOutcome(
  request: StudioPublicationRequest,
  state: StudioPublicationLifecycleState | undefined,
  attempts: number,
  exhausted: "max-attempts" | "timeout" | undefined,
): StudioPublicationPollOutcome {
  return {
    request,
    state,
    terminal: isStudioPublicationTerminal(request.status),
    active: isStudioPublicationActive(request.status),
    publicationUrl: studioPublicationUrl(request),
    attempts,
    exhausted,
  };
}

/**
 * Throw a client-side `validation` {@link HonuaStudioError} — nothing is sent
 * — when a submission body carries an approval or policy-override key.
 */
function assertNoApprovalFields(request: StudioPublicationRequestInput): void {
  const offending = Object.keys(request).filter((key) => REJECTED_SUBMISSION_KEYS.has(key.toLowerCase()));
  if (offending.length === 0) return;
  const rule = [
    "the proposer cannot approve their own publication or override policy.",
    "Approval is a separate principal acting through the Admin API/CLI.",
  ].join(" ");
  throw new HonuaStudioError(
    "validation",
    400,
    `A publication submission must not carry ${offending.join(", ")}: ${rule}`,
  );
}

function normalizePollBound(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1) {
    throw new TypeError(`maxAttempts must be an integer >= 1, received ${String(value)}.`);
  }
  return value;
}

function normalizeInterval(value: number | undefined): number {
  if (value === undefined) return HONUA_STUDIO_PUBLICATION_POLL_INTERVAL_MS;
  if (!Number.isFinite(value) || value < 0) {
    throw new TypeError(`Poll interval and timeout must be finite and >= 0, received ${String(value)}.`);
  }
  return value;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortReason(signal);
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The operation was aborted.", "AbortError");
}

/** `setTimeout` that settles early — by rejecting with the abort reason — when `signal` aborts. */
function delay(ms: number, signal: AbortSignal | undefined): Promise<void> {
  if (ms <= 0) {
    throwIfAborted(signal);
    return Promise.resolve();
  }
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortReason(signal));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(abortReason(signal as AbortSignal));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** `/content-items/{itemId}/rollback-requests`. */
export class HonuaStudioRollbackRequestsClient {
  readonly #lifecycle: HonuaStudioLifecycleClient;

  public constructor(lifecycle: HonuaStudioLifecycleClient) {
    this.#lifecycle = lifecycle;
  }

  /**
   * `POST /content-items/{itemId}/rollback-requests` — persist a rollback
   * request and move the current, published, or both pointers to an earlier
   * immutable version.
   */
  public create(
    itemId: string,
    request: StudioRollbackRequestInput,
    options: HonuaStudioRequestOptions = {},
  ): Promise<StudioRollbackRequest> {
    return this.#lifecycle.request(
      "POST",
      `/content-items/${encodeURIComponent(itemId)}/rollback-requests`,
      request,
      options,
    );
  }
}

function normalizeBasePath(path: string): string {
  const normalized = path.startsWith("/") ? path : `/${path}`;
  let end = normalized.length;
  while (end > 1 && normalized[end - 1] === "/") end -= 1;
  return normalized.slice(0, end);
}

function jsonHeaders(headers: HeadersInit | undefined): HeadersInit {
  return { Accept: "application/json", "Content-Type": "application/json", ...headersToRecord(headers) };
}

function headersToRecord(headers: HeadersInit | undefined): Record<string, string> {
  if (!headers) return {};
  if (headers instanceof Headers) return Object.fromEntries(headers.entries());
  if (Array.isArray(headers)) return Object.fromEntries(headers);
  return { ...headers };
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return undefined;
  return JSON.parse(text);
}

/** Unwrap `ApiResponse<T>` (`{ success, data, timestamp }`) into `T`, tolerating an already-unwrapped body. */
function unwrapApiResponse<T>(body: unknown): T {
  if (isRecord(body) && "data" in body && "success" in body) {
    return (body as unknown as StudioApiResponse<T>).data;
  }
  return body as T;
}

/** The structural shape every `HonuaHttpError` (`src/core/errors.js`) carries. */
interface HonuaHttpErrorLike {
  readonly statusCode: number;
  readonly body: unknown;
  readonly message: string;
}

/**
 * True when `error` has the exact shape a `HonuaHttpError` carries —
 * deliberately **not** `error instanceof HonuaHttpError`.
 *
 * This module ships as part of the generated `@honua/app-platform/studio`
 * split package (see `src/studio/index.ts`'s module doc and
 * `scripts/prepare-split-packages.mjs`, which copies `core/` — including
 * `core/errors.js` — into every split package rather than importing it from
 * the `@honua/sdk` peer). A caller that wires this client to a `HonuaClient`
 * constructed from that peer's own copy of `@honua/sdk-js` therefore has
 * *two* separate `HonuaHttpError` classes in play — one per package copy of
 * the identical source file. `error instanceof HonuaHttpError` silently
 * returns `false` across that boundary even though `error` is exactly a
 * `HonuaHttpError`, a classic dual-package hazard.
 *
 * Detection instead follows the SDK's own established cross-realm error
 * guard, {@link isHonuaError} (`isHonuaSdkError`, `src/core/error-envelope.js`
 * — "Cross-realm type guard backed by the public tag and registered code"):
 * match on the frozen `sdkCode` tag every `HonuaHttpError` carries
 * (`"core.http.transient"` / `"core.http.rejected"` — byte-identical string
 * constants in every copy of the module, unlike the class's identity) plus a
 * direct, non-`instanceof` read of the HTTP-specific `statusCode` own
 * property. `HonuaStudioError` is built from these primitive values alone, so
 * its construction never depends on receiving a specific class instance
 * either.
 */
function isHonuaHttpErrorLike(error: unknown): error is HonuaHttpErrorLike {
  if (!isHonuaError(error)) return false;
  if (error.sdkCode !== "core.http.transient" && error.sdkCode !== "core.http.rejected") return false;
  return typeof (error as unknown as { statusCode?: unknown }).statusCode === "number";
}

/** Convert a thrown `HonuaHttpError`-shaped rejection into a typed {@link HonuaStudioError}; pass through anything else. */
function toStudioError(error: unknown): unknown {
  if (!isHonuaHttpErrorLike(error)) return error;
  const problem = toProblemDetails(error.body);
  const code = classifyStudioProblemStatus(error.statusCode);
  const message = problem?.detail ?? problem?.title ?? error.message;
  return new HonuaStudioError(code, error.statusCode, message, problem, { cause: error });
}

function toProblemDetails(body: unknown): HonuaStudioProblemDetails | undefined {
  return isRecord(body) ? (body as HonuaStudioProblemDetails) : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
