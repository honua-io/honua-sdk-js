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
 * ## Enumeration
 *
 * `contentItems.list()` (`GET /content-items`) and `drafts.list()`
 * (`GET /package-drafts`) are the content-browser entry points added by
 * `honua-server#3003`: filters (`family`, `workspaceId`, `ownerId`, `search`, plus
 * `state` for content items), opaque keyset-cursor pagination ordered by
 * `updatedAt` then row id descending, and — for content items — a joined
 * Content Publication Registry lifecycle badge per row, so a lifecycle badge
 * costs no extra request. Both resource groups also expose a bounded
 * `listAll()` async generator and a `collect()` convenience that walk the
 * cursor for you; neither can loop forever (see
 * {@link HONUA_STUDIO_LIST_MAX_PAGES}).
 *
 * Cursors are **opaque**. Pass a `nextCursor` back verbatim; never build,
 * parse, or persist-and-mutate one.
 *
 * @module
 */

import type { HonuaClient } from "../core/client.js";
import { HonuaTimeoutError, isHonuaError } from "../core/errors.js";
import type { QueryMethod } from "../core/types.js";
import { HonuaStudioError, type HonuaStudioProblemDetails, classifyStudioProblemStatus } from "./lifecycle-errors.js";
import type {
  StudioApiResponse,
  StudioContentItemListOptions,
  StudioContentItemListResponse,
  StudioContentItemListRow,
  StudioContentVersion,
  StudioContentVersionListResponse,
  StudioListFilterOptions,
  StudioListPage,
  StudioPackageDraft,
  StudioPackageDraftCreateRequest,
  StudioPackageDraftListOptions,
  StudioPackageDraftListResponse,
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
  public readonly contentItems: HonuaStudioContentItemsClient;
  public readonly contentVersions: HonuaStudioContentVersionsClient;
  public readonly publicationRequests: HonuaStudioPublicationRequestsClient;
  public readonly rollbackRequests: HonuaStudioRollbackRequestsClient;

  public constructor(options: HonuaStudioLifecycleClientOptions) {
    this.#client = options.client;
    this.#basePath = normalizeBasePath(options.basePath ?? HONUA_STUDIO_LIFECYCLE_BASE_PATH);
    this.packageFamilies = new HonuaStudioPackageFamiliesClient(this);
    this.drafts = new HonuaStudioDraftsClient(this);
    this.contentItems = new HonuaStudioContentItemsClient(this);
    this.contentVersions = new HonuaStudioContentVersionsClient(this);
    this.publicationRequests = new HonuaStudioPublicationRequestsClient(this);
    this.rollbackRequests = new HonuaStudioRollbackRequestsClient(this);
  }

  public get basePath(): string {
    return this.#basePath;
  }

  /** Escape hatch for any endpoint that does not have a dedicated method on this client yet. */
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

  /**
   * `GET /package-drafts` — one page of mutable drafts matching `filters`
   * (`family`, `workspaceId`, `ownerId`, `search`), ordered by `updatedAt` then
   * `draftId` descending.
   *
   * Rows are full {@link StudioPackageDraft} objects. Pass the response's
   * `nextCursor` back as `filters.cursor` for the next page; its absence (or
   * `null`) means this was the last one. Prefer {@link listAll} or
   * {@link collect} over hand-rolling that loop.
   */
  // `async` so the client-side `limit` guard in `withStudioListQuery` surfaces
  // as a rejected promise, exactly like every server-side failure on this
  // client, rather than as a synchronous throw callers would have to catch
  // separately.
  public async list(
    filters: StudioPackageDraftListOptions = {},
    options: HonuaStudioRequestOptions = {},
  ): Promise<StudioPackageDraftListResponse> {
    return await this.#lifecycle.request("GET", withStudioListQuery("/package-drafts", filters), undefined, options);
  }

  /**
   * Walk `GET /package-drafts` to completion, yielding each page verbatim.
   * Bounded by `options.maxPages` — see {@link HonuaStudioContentItemsClient.listAll}
   * for the shared pagination rules.
   */
  public listAll(
    filters: StudioPackageDraftListOptions = {},
    options: HonuaStudioPaginationOptions = {},
  ): AsyncGenerator<StudioPackageDraftListResponse, void, undefined> {
    return paginateStudioList<StudioPackageDraft>(
      (pageFilters, pageOptions) => this.list(pageFilters, pageOptions),
      filters,
      options,
    );
  }

  /** Accumulate every draft page into one {@link StudioListCollection}. */
  public collect(
    filters: StudioPackageDraftListOptions = {},
    options: HonuaStudioPaginationOptions = {},
  ): Promise<StudioListCollection<StudioPackageDraft>> {
    return collectStudioList(this.listAll(filters, options));
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

/** Page size `GET /content-items` and `GET /package-drafts` use when `limit` is omitted. */
export const HONUA_STUDIO_LIST_DEFAULT_LIMIT = 25;

/**
 * Largest `limit` the Studio list endpoints accept. The server clamps anything
 * larger down to this value rather than erroring, which would silently hand a
 * caller fewer rows than they asked for, so this client rejects an oversized
 * `limit` up front instead.
 */
export const HONUA_STUDIO_LIST_MAX_LIMIT = 1_000;

/**
 * Default hard bound on how many pages {@link HonuaStudioContentItemsClient.listAll}
 * / {@link HonuaStudioDraftsClient.listAll} will fetch. There is no
 * "walk forever" mode, and no option that produces one.
 */
export const HONUA_STUDIO_LIST_MAX_PAGES = 1_000;

/** Per-call options for the bounded `listAll` / `collect` cursor walks. */
export interface HonuaStudioPaginationOptions extends HonuaStudioRequestOptions {
  /**
   * Hard upper bound on the number of pages fetched, defaulting to
   * {@link HONUA_STUDIO_LIST_MAX_PAGES}. Reaching it stops the walk; the last
   * page yielded still carries the `nextCursor` to resume from, so nothing is
   * lost — and {@link StudioListCollection.truncated} says it happened.
   */
  readonly maxPages?: number;
}

/**
 * The result of accumulating a bounded cursor walk.
 *
 * `truncated: true` means the page cap was reached while the server was still
 * advertising more rows — it is *not* an error and not a complete answer:
 * resume from {@link StudioListCollection.nextCursor}.
 */
export interface StudioListCollection<TItem> {
  /** Every row from every page fetched, in server order. */
  readonly items: readonly TItem[];
  /** How many pages were fetched. */
  readonly pages: number;
  /** The last page's `total` — every row matching the query server-side. */
  readonly total: number;
  /** The cursor to resume from; present only when `truncated` is true. */
  readonly nextCursor: string | undefined;
  /** True only when the page cap stopped a walk the server had not finished. */
  readonly truncated: boolean;
}

/**
 * True when a page is the last one — the server sends `nextCursor: null` on
 * the final page, and its source-generated JSON context omits `null`
 * properties, so "absent" and "null" mean the same thing. An empty-string
 * cursor is treated as exhausted too rather than replayed as a filter value.
 */
export function isStudioListExhausted(page: StudioListPage<unknown>): boolean {
  return typeof page.nextCursor !== "string" || page.nextCursor.length === 0;
}

/** `/content-items` — enumerate Studio content items with joined publication badges. */
export class HonuaStudioContentItemsClient {
  readonly #lifecycle: HonuaStudioLifecycleClient;

  public constructor(lifecycle: HonuaStudioLifecycleClient) {
    this.#lifecycle = lifecycle;
  }

  /**
   * `GET /content-items` — one page of content items matching `filters`
   * (`family`, `workspaceId`, `ownerId`, `state`, `search`), ordered by `updatedAt`
   * then `itemId` descending so pages stay stable while other rows are
   * concurrently created or updated.
   *
   * Each row is a summary projection — no envelope — carrying the derived
   * `state` (`draft`/`current`/`published`) and, when the Content Publication
   * Registry has a publication whose `sourceContentId` is this `itemId`, a
   * joined `publication` badge with the route's *own* lifecycle. That join is
   * batched server-side, so a badge costs no extra request.
   *
   * A non-admin caller under `Studio:EndUserAuthorization:Enabled` always gets
   * their own content regardless of the `owner` filter they pass, and a caller
   * whose id cannot be resolved at all is refused with `403` rather than shown
   * an unscoped list. An unknown `family` or `state` value is `400`.
   */
  // `async` so the client-side `limit` guard in `withStudioListQuery` surfaces
  // as a rejected promise, exactly like every server-side failure on this
  // client, rather than as a synchronous throw callers would have to catch
  // separately.
  public async list(
    filters: StudioContentItemListOptions = {},
    options: HonuaStudioRequestOptions = {},
  ): Promise<StudioContentItemListResponse> {
    return await this.#lifecycle.request("GET", withStudioListQuery("/content-items", filters), undefined, options);
  }

  /**
   * Walk `GET /content-items` to completion, yielding each page verbatim.
   *
   * - **Bounded by construction.** At most `options.maxPages` pages
   *   ({@link HONUA_STUDIO_LIST_MAX_PAGES} by default) are fetched. Reaching
   *   the cap ends the walk; the last yielded page still carries the
   *   `nextCursor` to resume from.
   * - **Cursors stay opaque.** Each request replays the previous page's
   *   `nextCursor` verbatim; `filters.cursor` seeds the walk, so a walk can be
   *   resumed exactly where a previous one stopped.
   * - **Cancellable.** `options.signal` aborts the in-flight page request and
   *   ends the iteration.
   * - **A stuck server is not an infinite loop.** A page that repeats the
   *   cursor it was fetched with throws {@link HonuaStudioError} rather than
   *   paging forever.
   * - **Standard error handling.** Every non-2xx surfaces as
   *   {@link HonuaStudioError} with its RFC 7807 problem details.
   */
  public listAll(
    filters: StudioContentItemListOptions = {},
    options: HonuaStudioPaginationOptions = {},
  ): AsyncGenerator<StudioContentItemListResponse, void, undefined> {
    return paginateStudioList<StudioContentItemListRow>(
      (pageFilters, pageOptions) => this.list(pageFilters, pageOptions),
      filters,
      options,
    );
  }

  /** Accumulate every content-item page into one {@link StudioListCollection}. */
  public collect(
    filters: StudioContentItemListOptions = {},
    options: HonuaStudioPaginationOptions = {},
  ): Promise<StudioListCollection<StudioContentItemListRow>> {
    return collectStudioList(this.listAll(filters, options));
  }
}

/**
 * The shared bounded cursor walk behind every `listAll`. Generic over the row
 * type so content items and drafts get identical pagination semantics from one
 * implementation.
 */
async function* paginateStudioList<TItem>(
  fetchPage: (filters: StudioListFilterOptions, options: HonuaStudioRequestOptions) => Promise<StudioListPage<TItem>>,
  filters: StudioListFilterOptions,
  options: HonuaStudioPaginationOptions,
): AsyncGenerator<StudioListPage<TItem>, void, undefined> {
  const maxPages = normalizePageBound(options.maxPages);
  const requestOptions: HonuaStudioRequestOptions = { signal: options.signal, headers: options.headers };
  let cursor = filters.cursor;

  for (let page = 0; page < maxPages; page += 1) {
    throwIfAborted(options.signal);
    const current: StudioListPage<TItem> = await fetchPage(
      cursor === undefined ? filters : { ...filters, cursor },
      requestOptions,
    );
    yield current;
    if (isStudioListExhausted(current)) return;
    const next = current.nextCursor as string;
    // A server that hands back the cursor it was just given would otherwise
    // spin until `maxPages`, re-fetching the same page every time.
    if (next === cursor) {
      throw new HonuaStudioError(
        "internal",
        500,
        `Studio list pagination stalled: the server returned the same cursor it was queried with (${next}).`,
      );
    }
    cursor = next;
  }
}

/** Drain a bounded page walk into one {@link StudioListCollection}. */
async function collectStudioList<TItem>(
  pages: AsyncGenerator<StudioListPage<TItem>, void, undefined>,
): Promise<StudioListCollection<TItem>> {
  const items: TItem[] = [];
  let pageCount = 0;
  let total = 0;
  let last: StudioListPage<TItem> | undefined;

  for await (const page of pages) {
    pageCount += 1;
    total = page.total;
    last = page;
    items.push(...page.items);
  }

  // The generator stops either because the server said "no more" or because
  // the page cap fired; only the second leaves a usable resume cursor behind.
  const truncated = last !== undefined && !isStudioListExhausted(last);
  return {
    items,
    pages: pageCount,
    total,
    nextCursor: truncated ? (last?.nextCursor ?? undefined) : undefined,
    truncated,
  };
}

function normalizePageBound(value: number | undefined): number {
  if (value === undefined) return HONUA_STUDIO_LIST_MAX_PAGES;
  if (!Number.isInteger(value) || value < 1) {
    throw new TypeError(`maxPages must be an integer >= 1, received ${String(value)}.`);
  }
  return value;
}

/**
 * Serialize the shared Studio list filters onto `path`.
 *
 * Blank strings are dropped rather than sent as an empty filter the server
 * would trim to `null` anyway.
 */
function withStudioListQuery(path: string, filters: StudioContentItemListOptions): string {
  const params = new URLSearchParams();
  if (filters.family?.trim()) params.set("family", filters.family);
  if (filters.state?.trim()) params.set("state", filters.state);
  if (filters.workspaceId?.trim()) params.set("workspaceId", filters.workspaceId);
  if (filters.ownerId?.trim()) params.set("ownerId", filters.ownerId);
  if (filters.search?.trim()) params.set("search", filters.search);
  if (filters.cursor) params.set("cursor", filters.cursor);
  if (filters.limit !== undefined) params.set("limit", String(normalizeListLimit(filters.limit)));
  const query = params.toString();
  return query ? `${path}?${query}` : path;
}

/**
 * Reject a `limit` the server would not honor as asked. Below `1` it would be
 * replaced with the default and above {@link HONUA_STUDIO_LIST_MAX_LIMIT} it
 * would be silently clamped — both hand back a page size the caller did not
 * request, which is worse than a thrown programming error.
 */
function normalizeListLimit(limit: number): number {
  if (!Number.isInteger(limit) || limit < 1 || limit > HONUA_STUDIO_LIST_MAX_LIMIT) {
    throw new TypeError(
      `limit must be an integer between 1 and ${HONUA_STUDIO_LIST_MAX_LIMIT}, received ${String(limit)}.`,
    );
  }
  return limit;
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
        const waitMs = remainingMs === undefined ? intervalMs : Math.min(intervalMs, remainingMs);
        // When the wait is the whole remaining time, waking from it *is* the
        // deadline being reached, and the loop must stop without consulting the
        // clock again. Re-deriving `expiresAt - Date.now()` here made that a
        // race: a timer may fire a tick before `Date.now()` passes its target,
        // so the remainder read back as 1 rather than 0, the `<= 0` guard did
        // not fire, and the loop issued one more GET *after* the documented
        // bound -- the exact overshoot this clamp exists to prevent.
        const waitsOutDeadline = remainingMs !== undefined && waitMs >= remainingMs;
        await delay(waitMs, options.signal);
        if (waitsOutDeadline) {
          return toPollOutcome(request, state, attempt, "timeout");
        }
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
