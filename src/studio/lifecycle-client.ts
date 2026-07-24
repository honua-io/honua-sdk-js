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
import { HonuaHttpError } from "../core/errors.js";
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
  StudioPublicationRequest,
  StudioPublicationRequestInput,
  StudioReopenVersionRequest,
  StudioRollbackRequest,
  StudioRollbackRequestInput,
  StudioValidationSummary,
  StudioVersionComparison,
  StudioVersionComparisonRequest,
} from "./lifecycle-types.js";

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

/** `/content-items/{itemId}/versions/{versionId}/publish-requests`. */
export class HonuaStudioPublicationRequestsClient {
  readonly #lifecycle: HonuaStudioLifecycleClient;

  public constructor(lifecycle: HonuaStudioLifecycleClient) {
    this.#lifecycle = lifecycle;
  }

  /**
   * `POST /content-items/{itemId}/versions/{versionId}/publish-requests` —
   * persist a publication request and move the published pointer when
   * validation permits.
   */
  public create(
    itemId: string,
    versionId: string,
    request: StudioPublicationRequestInput = {},
    options: HonuaStudioRequestOptions = {},
  ): Promise<StudioPublicationRequest> {
    return this.#lifecycle.request(
      "POST",
      `/content-items/${encodeURIComponent(itemId)}/versions/${encodeURIComponent(versionId)}/publish-requests`,
      request,
      options,
    );
  }
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

/** Convert a thrown {@link HonuaHttpError} into a typed {@link HonuaStudioError}; pass through anything else. */
function toStudioError(error: unknown): unknown {
  if (!(error instanceof HonuaHttpError)) return error;
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
