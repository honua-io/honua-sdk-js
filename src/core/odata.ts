/**
 * OData v4 entity-set adapter. Wraps an OData entity set behind the shared
 * `Source<T>` contract surface in `src/contract/source.ts`.
 *
 * Library posture is recorded in
 * `docs/decisions/odata-library-selection.md`: the canonical surface is a
 * thin URL/JSON serializer over `HonuaClient.pipelineFetch` /
 * `pipelineRequestJson` (rather than the GeoServices-shaped
 * `request()` helper, which would inject `f=json` and trip Honua
 * Server's OData validators) so that the auth / retry / telemetry
 * pipeline stays centralized. The dialect-specific `$batch` / `$apply`
 * / `$search` / `$deltatoken` operations live behind the typed escape
 * hatch returned by `Source.protocol("odata")`.
 *
 * @module
 */

import {
  type HonuaCacheState,
  type HonuaCacheValidator,
  type HonuaMetadataRequestOptions,
  createHonuaCacheState,
  honuaCacheValidatorFromHeaders,
  honuaMetadataRequestHeaders,
  isHonuaCacheEntryFresh,
  normalizeHonuaMetadataRequestOptions,
  withHonuaCacheState,
  withoutHonuaCacheState,
} from "./cache-state.js";
import type { HonuaClient } from "./client.js";
import { trimTrailingSlashes } from "./path-utils.js";
import type { HonuaFieldInfo } from "./types.js";

const MAX_ODATA_METADATA_CHARACTERS = 4 * 1024 * 1024;

// ── Locator + options ─────────────────────────────────────────

/**
 * Construction options for {@link HonuaOdataEntitySet}.
 *
 * `basePath` defaults to `/odata` (Honua Server's route prefix). External
 * OData services pass the path their endpoint is mounted under and use a
 * `HonuaClient` bound to that origin.
 */
export interface HonuaOdataEntitySetOptions {
  client: HonuaClient;
  /** Entity-set token, e.g. `"Features"` or `"Layers(1)/Features"`. */
  entitySet: string;
  /** Path prefix for the OData service. Defaults to `"/odata"`. */
  basePath?: string;
}

// ── Canonical request envelopes (escape hatch) ───────────────

/**
 * Per-page response envelope for `query()`. Mirrors the canonical
 * `Result<T>` fields the contract adapter consumes; the fully-canonical
 * `Result<T>` shape is constructed in `src/contract/source.ts` from this
 * envelope (so `HonuaOdataEntitySet` does not import from `contract/`).
 */
export interface HonuaOdataPage<T> {
  rows: ReadonlyArray<T>;
  totalCount?: number;
  nextLink?: string;
  deltaLink?: string;
}

/** Parameters that translate onto an OData query string. */
export interface HonuaOdataQueryParams {
  filter?: string;
  select?: readonly string[];
  orderBy?: readonly string[];
  top?: number;
  skip?: number;
  expand?: readonly string[];
  /** OData v4 `$count=true` — request the matched-row count alongside the page. */
  count?: boolean;
  /** Server-driven pagination cursor returned in `@odata.nextLink`. */
  skiptoken?: string;
  /** `$search` full-text search expression. */
  search?: string;
  /** `$apply` transformation expression. */
  apply?: string;
  /** `$deltatoken` change-feed cursor. */
  deltatoken?: string;
  /** Free-form passthrough for parameters the adapter does not model directly. */
  extra?: Record<string, string | number | boolean>;
  signal?: AbortSignal;
}

/** Single batch operation, in canonical SDK terms. */
export interface HonuaOdataBatchOperation {
  /** Request id; the adapter assigns one when omitted. */
  id?: string;
  method: "GET" | "POST" | "PATCH" | "DELETE";
  /** Path relative to the OData service root (no leading slash). */
  url: string;
  /** JSON body for `POST` / `PATCH` requests. */
  body?: Record<string, unknown>;
  /** Optional headers to merge with the per-batch defaults. */
  headers?: Record<string, string>;
}

/** Per-operation outcome in a `$batch` response. */
export interface HonuaOdataBatchOutcome {
  id: string;
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

export interface HonuaOdataBatchResult {
  responses: ReadonlyArray<HonuaOdataBatchOutcome>;
}

/** Options for {@link HonuaOdataEntitySet.batch}. */
export interface HonuaOdataBatchOptions {
  /**
   * `"all"` wraps the requests in a single `atomicityGroup`, requesting
   * server-side rollback when any operation fails. `"none"` (default)
   * runs them as independent change-set operations.
   */
  atomicity?: "all" | "none";
  signal?: AbortSignal;
}

/** SDK-shaped projection of an OData CSDL `$metadata` document. */
export interface HonuaOdataMetadata {
  /** Entity-set name → declared entity type. */
  entitySets: Readonly<Record<string, string>>;
  /** Entity-type name → ordered key field names. */
  keys: Readonly<Record<string, readonly string[]>>;
  /** Entity-type name → field metadata, including spatial typing hints. */
  fields: Readonly<Record<string, readonly HonuaOdataFieldInfo[]>>;
  /** Complex-type name → nested property metadata. */
  complexTypes?: Readonly<Record<string, readonly HonuaOdataFieldInfo[]>>;
  /** Enum-type name → underlying scalar and declared members. */
  enumTypes?: Readonly<Record<string, HonuaOdataEnumTypeInfo>>;
  /** Entity types explicitly declared with CSDL `OpenType="true"`. */
  openTypes?: Readonly<Record<string, true>>;
  /** Entity-set name → coarse capability flags advertised by `Capabilities.*` annotations. */
  capabilities: Readonly<Record<string, HonuaOdataAdvertisedCapabilities>>;
  cache?: HonuaCacheState;
}

/** @internal Parser evidence used only by the opt-in SourceSchemaV2 projector. */
export interface HonuaOdataSourceSchemaProjectionSafety {
  readonly csdlVersion?: string;
  readonly ambiguousTypeNames: readonly string[];
  readonly inheritedTypeNames: readonly string[];
  readonly openComplexTypeNames: readonly string[];
  readonly unqualifiedTypeNames: readonly string[];
}

const ODATA_SOURCE_SCHEMA_PROJECTION_SAFETY = Symbol("honua.odata.source-schema-projection-safety");
const ODATA_SOURCE_SCHEMA_PROJECTION_DETAILS = Symbol("honua.odata.source-schema-projection-details");

interface HonuaOdataSourceSchemaProjectionDetails {
  readonly fields: Readonly<Record<string, readonly HonuaOdataFieldInfo[]>>;
  readonly complexTypes: Readonly<Record<string, readonly HonuaOdataFieldInfo[]>>;
  readonly enumTypes: Readonly<Record<string, HonuaOdataEnumTypeInfo>>;
  readonly openTypes: Readonly<Record<string, true>>;
}

/** @internal Read parser evidence without changing the legacy string-keyed metadata shape. */
export function getOdataSourceSchemaProjectionSafety(
  metadata: HonuaOdataMetadata,
): HonuaOdataSourceSchemaProjectionSafety | undefined {
  return odataProjectionEvidence<HonuaOdataSourceSchemaProjectionSafety>(
    metadata,
    ODATA_SOURCE_SCHEMA_PROJECTION_SAFETY,
  );
}

/** @internal Read rich CSDL state without changing the legacy string-keyed metadata shape. */
export function getOdataSourceSchemaProjectionDetails(
  metadata: HonuaOdataMetadata,
): HonuaOdataSourceSchemaProjectionDetails | undefined {
  return odataProjectionEvidence<HonuaOdataSourceSchemaProjectionDetails>(
    metadata,
    ODATA_SOURCE_SCHEMA_PROJECTION_DETAILS,
  );
}

function odataProjectionEvidence<T>(metadata: HonuaOdataMetadata, key: symbol): T | undefined {
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Object.getOwnPropertyDescriptor(metadata, key);
  } catch {
    throw new TypeError("OData metadata projection evidence is inaccessible");
  }
  if (!descriptor) return undefined;
  if (!("value" in descriptor)) {
    throw new TypeError("OData metadata projection evidence must be a data property");
  }
  return descriptor.value as T | undefined;
}

/** Per-field metadata carried by {@link HonuaOdataMetadata.fields}. */
export interface HonuaOdataFieldInfo {
  name: string;
  type: string;
  nullable?: boolean;
  maxLength?: number | "max";
  precision?: number;
  scale?: number | "variable" | "floating";
  /** True when the field is an `Edm.Geography` / `Edm.Geometry` column. */
  isSpatial?: boolean;
  /** Optional SRID hint declared in the type or annotation. */
  srid?: number | "variable";
}

export interface HonuaOdataEnumMemberInfo {
  readonly name: string;
  readonly value: string | number;
}

export type HonuaOdataEnumDeclaration =
  | { readonly state: "valid"; readonly valueMode: "explicit" | "implicit" | "mixed" }
  | {
      readonly state: "invalid";
      readonly reason:
        | "invalid-underlying-type"
        | "empty-declaration"
        | "flags-require-explicit-values"
        | "invalid-member-name"
        | "duplicate-member-name"
        | "invalid-member-value"
        | "out-of-range"
        | "negative-flags-value";
    };

export interface HonuaOdataEnumTypeInfo {
  readonly underlyingType: string;
  readonly isFlags: boolean;
  readonly members: readonly HonuaOdataEnumMemberInfo[];
  /** CSDL declaration validation; absent on metadata assembled by older callers. */
  readonly declaration?: HonuaOdataEnumDeclaration;
}

/**
 * Coarse capability flags derived from the OData `Capabilities.*`
 * annotation namespace. The intersection happens in the contract layer
 * (the adapter does not enforce capability restrictions itself).
 */
export interface HonuaOdataAdvertisedCapabilities {
  query?: boolean;
  insert?: boolean;
  update?: boolean;
  delete?: boolean;
  batch?: boolean;
  filter?: boolean;
  select?: boolean;
  expand?: boolean;
  apply?: boolean;
  search?: boolean;
  delta?: boolean;
  count?: boolean;
}

interface OdataMetadataCacheEntry {
  metadata: HonuaOdataMetadata;
  cachedAtMs: number;
  keyFingerprint: string;
  status: "miss" | "refreshed" | "bypass";
  validator?: HonuaCacheValidator;
  sourceUpdatedAt?: string;
}

/** Single page of an OData `$apply` aggregation response. */
export interface HonuaOdataAggregateResult {
  rows: ReadonlyArray<Record<string, unknown>>;
  totalCount?: number;
}

/** Cursor-driven change-feed page returned by `delta()`. */
export interface HonuaOdataDeltaPage<T> {
  rows: ReadonlyArray<T>;
  /** Cursor for the next batch; undefined when the feed is fully drained. */
  nextLink?: string;
  /** Final-page cursor that callers persist for the next `delta({ since })`. */
  deltaLink?: string;
}

// ── Runtime class ─────────────────────────────────────────────

/**
 * Runtime handle for one OData entity set. Returned by
 * `Source.protocol("odata")` so callers can reach the dialect-specific
 * surface (`$batch`, `$apply`, `$search`, `$deltatoken`) without leaking
 * OData-shaped types into the canonical `Source` API.
 */
export class HonuaOdataEntitySet {
  public readonly client: HonuaClient;
  public readonly entitySet: string;
  /**
   * Unqualified entity-set name used as the CSDL metadata-lookup key.
   * Equals `entitySet` for direct paths like `"Parcels"`. For
   * layer-scoped navigation paths like `"Layers(1)/Features"` it is the
   * navigation suffix `"Features"` so capability and schema lookups
   * still find the entry the server emits in `<EntitySet Name="…">`.
   */
  public readonly entitySetName: string;
  public readonly basePath: string;
  private cachedMetadata: OdataMetadataCacheEntry | undefined;
  private inflightMetadata: Promise<HonuaOdataMetadata> | undefined;

  public constructor(options: HonuaOdataEntitySetOptions) {
    this.client = options.client;
    this.entitySet = options.entitySet;
    this.entitySetName = extractEntitySetName(options.entitySet);
    this.basePath = normalizeBasePath(options.basePath);
  }

  /**
   * Fetch (and cache) the `$metadata` document. The cache is per
   * `HonuaOdataEntitySet` instance so callers can pin a metadata snapshot
   * to a long-lived `Source` without re-parsing on every request.
   */
  public async metadata(options: HonuaMetadataRequestOptions = {}): Promise<HonuaOdataMetadata> {
    const metadataOptions = normalizeHonuaMetadataRequestOptions(options);
    const bypass = metadataOptions.cache === "bypass";
    const now = Date.now();
    const freshCachedMetadata = this.cachedMetadata
      ? isHonuaCacheEntryFresh(this.cachedMetadata.cachedAtMs, now, metadataOptions.ttlMs)
      : false;
    if (!bypass && !metadataOptions.refresh && this.cachedMetadata && freshCachedMetadata) {
      return withOdataMetadataCacheState(this.cachedMetadata, "hit", {
        now,
        ttlMs: metadataOptions.ttlMs,
        staleIfErrorMs: metadataOptions.staleIfErrorMs,
      });
    }
    if (!bypass && !metadataOptions.refresh && this.inflightMetadata) return this.inflightMetadata;
    const previous = this.cachedMetadata;
    const promise = this.fetchMetadata(metadataOptions, previous).then((entry) => {
      if (!bypass) {
        this.cachedMetadata = entry;
      }
      const status = bypass ? "bypass" : entry.status;
      return withOdataMetadataCacheState(entry, status, {
        now: Date.now(),
        ttlMs: metadataOptions.ttlMs,
        staleIfErrorMs: metadataOptions.staleIfErrorMs,
        ...(status === "refreshed" ? { revalidatedAt: new Date().toISOString() } : {}),
      });
    });

    const staleFallback = (error: unknown): HonuaOdataMetadata => {
      if (!bypass && metadataOptions.staleIfError && previous) {
        return withOdataMetadataCacheState(previous, "stale", {
          now: Date.now(),
          ttlMs: metadataOptions.ttlMs,
          staleIfErrorMs: metadataOptions.staleIfErrorMs,
          refreshErrorId: odataMetadataRefreshErrorId(error),
        });
      }
      throw error;
    };

    if (!bypass && !metadataOptions.refresh) {
      const trackedPromise = promise.catch(staleFallback).finally(() => {
        if (this.inflightMetadata === trackedPromise) this.inflightMetadata = undefined;
      });
      this.inflightMetadata = trackedPromise;
      return trackedPromise;
    }

    try {
      return await promise;
    } catch (error) {
      return staleFallback(error);
    }
  }

  /** Fetch one page of the entity set. */
  public async query<T = Record<string, unknown>>(params: HonuaOdataQueryParams = {}): Promise<HonuaOdataPage<T>> {
    const path = this.entitySetPath();
    const query = serializeQueryParams(params);
    const body = await this.requestJson<OdataValueEnvelope<T>>("GET", path, query, params.signal);
    return {
      rows: body.value ?? [],
      ...(typeof body["@odata.count"] === "number" ? { totalCount: body["@odata.count"] } : {}),
      ...(typeof body["@odata.nextLink"] === "string" ? { nextLink: body["@odata.nextLink"] } : {}),
      ...(typeof body["@odata.deltaLink"] === "string" ? { deltaLink: body["@odata.deltaLink"] } : {}),
    };
  }

  /**
   * Drain server-driven `@odata.nextLink` pages. When `params.top` is
   * supplied it is treated as a hard cap on collected rows. Callers that
   * want a lookahead row to detect truncation must add it themselves; the
   * canonical `Source.queryAll` path does this with `top = limit + 1`,
   * while ids-only projections enforce their own result cap.
   * Returning `top + 1` here would double-count for callers that already
   * added the lookahead, so this helper respects `top` exactly.
   */
  public async queryAll<T = Record<string, unknown>>(
    params: HonuaOdataQueryParams = {},
  ): Promise<{
    rows: ReadonlyArray<T>;
    totalCount?: number;
  }> {
    const cap = typeof params.top === "number" && params.top >= 0 ? params.top : undefined;
    const collected: T[] = [];
    let totalCount: number | undefined;
    let next: string | undefined;
    let firstPageParams: HonuaOdataQueryParams | undefined = params;
    while (true) {
      const page: HonuaOdataPage<T> = next
        ? await this.followNextLink<T>(next, params.signal)
        : await this.query<T>(firstPageParams ?? {});
      firstPageParams = undefined;
      if (totalCount === undefined && typeof page.totalCount === "number") {
        totalCount = page.totalCount;
      }
      for (const row of page.rows) {
        if (cap !== undefined && collected.length >= cap) break;
        collected.push(row);
        if (cap !== undefined && collected.length >= cap) break;
      }
      if (cap !== undefined && collected.length >= cap) break;
      if (!page.nextLink) break;
      next = page.nextLink;
    }
    return totalCount === undefined ? { rows: collected } : { rows: collected, totalCount };
  }

  /** Yield one page per server response. Used by `Source.stream()`. */
  public async *queryStream<T = Record<string, unknown>>(
    params: HonuaOdataQueryParams = {},
  ): AsyncGenerator<HonuaOdataPage<T>, void, undefined> {
    let page: HonuaOdataPage<T> = await this.query<T>(params);
    yield page;
    while (page.nextLink) {
      page = await this.followNextLink<T>(page.nextLink, params.signal);
      yield page;
    }
  }

  /** Insert a row via `POST /<entitySet>`. */
  public async add<T = Record<string, unknown>>(
    body: Record<string, unknown>,
    options: { signal?: AbortSignal } = {},
  ): Promise<T> {
    const path = this.entitySetPath();
    return this.requestJson<T>("POST", path, undefined, options.signal, JSON.stringify(body), {
      "Content-Type": "application/json",
    });
  }

  /**
   * Update a row via `PATCH /<entitySet>(<key>)`. The OData server in
   * Honua Server intentionally does not implement `PUT`; the SDK issues
   * `PATCH` with the full canonical body to match a `PUT` replacement on
   * the canonical surface (documented in
   * `docs/protocol-capability-matrix.md` under the OData section).
   */
  public async update<T = Record<string, unknown>>(
    key: string,
    body: Record<string, unknown>,
    options: { signal?: AbortSignal } = {},
  ): Promise<T | undefined> {
    const path = `${this.entitySetPath()}(${encodeOdataKey(key)})`;
    return this.requestJson<T | undefined>("PATCH", path, undefined, options.signal, JSON.stringify(body), {
      "Content-Type": "application/json",
    });
  }

  /** Delete a row via `DELETE /<entitySet>(<key>)`. */
  public async delete(key: string, options: { signal?: AbortSignal } = {}): Promise<void> {
    const path = `${this.entitySetPath()}(${encodeOdataKey(key)})`;
    await this.requestJson<unknown>("DELETE", path, undefined, options.signal);
  }

  /**
   * Submit a `$batch` request using the OData JSON batch format.
   * Multipart/mixed fallback is intentionally not implemented; Honua
   * Server emits both formats but the JSON envelope is sufficient for
   * the canonical surface and avoids the multipart parser.
   *
   * `atomicity: "all"` stamps the same `atomicityGroup` token on every
   * request so the server runs them in one change-set with rollback on
   * any failure (per OData v4 §11.7.7.3 and Honua Server's
   * `ODataBatchHandler`, which groups by `request.AtomicityGroup`).
   * `atomicity: "none"` (default) leaves the field unset so each request
   * runs independently.
   */
  public async batch(
    operations: ReadonlyArray<HonuaOdataBatchOperation>,
    options: HonuaOdataBatchOptions = {},
  ): Promise<HonuaOdataBatchResult> {
    if (operations.length === 0) return { responses: [] };
    const groupId = options.atomicity === "all" ? "g1" : undefined;
    const requests = operations.map((op, index) => ({
      id: op.id ?? String(index + 1),
      method: op.method,
      url: stripLeadingSlash(op.url),
      ...(op.headers
        ? { headers: { "Content-Type": "application/json", ...op.headers } }
        : { headers: { "Content-Type": "application/json" } }),
      ...(op.body !== undefined ? { body: op.body } : {}),
      ...(groupId !== undefined ? { atomicityGroup: groupId } : {}),
    }));
    const response = await this.requestJson<{ responses?: HonuaOdataBatchOutcome[] }>(
      "POST",
      `${this.basePath}/$batch`,
      undefined,
      options.signal,
      JSON.stringify({ requests }),
      { "Content-Type": "application/json" },
    );
    return { responses: response.responses ?? [] };
  }

  /**
   * Run an `$apply` aggregation. The OData server applies the
   * transformation pipeline (`aggregate`, `groupby`, `filter`,
   * `compute`); the SDK returns the rows unchanged so callers can shape
   * them onto the canonical `Result.aggregateRows`.
   */
  public async apply(
    transformations: string,
    params: { filter?: string; signal?: AbortSignal } = {},
  ): Promise<HonuaOdataAggregateResult> {
    const path = this.entitySetPath();
    const query = serializeQueryParams({ apply: transformations, filter: params.filter });
    const body = await this.requestJson<OdataValueEnvelope<Record<string, unknown>>>("GET", path, query, params.signal);
    return {
      rows: body.value ?? [],
      ...(typeof body["@odata.count"] === "number" ? { totalCount: body["@odata.count"] } : {}),
    };
  }

  /**
   * Run a `$search` full-text query. Returns an `HonuaOdataPage` so the
   * canonical `Result<T>` projection is symmetric with `query()`.
   */
  public async search<T = Record<string, unknown>>(
    text: string,
    params: HonuaOdataQueryParams = {},
  ): Promise<HonuaOdataPage<T>> {
    return this.query<T>({ ...params, search: text });
  }

  /**
   * `$deltatoken`-driven change feed. Yields `HonuaOdataDeltaPage` per
   * server response. The final page carries `deltaLink`; callers persist
   * the encoded token for the next call to `delta({ since })`.
   */
  public async *delta<T = Record<string, unknown>>(
    options: { since?: string; signal?: AbortSignal } = {},
  ): AsyncGenerator<HonuaOdataDeltaPage<T>, void, undefined> {
    const params: HonuaOdataQueryParams = options.since ? { deltatoken: options.since } : {};
    if (options.signal) params.signal = options.signal;
    let page: HonuaOdataPage<T> = await this.query<T>(params);
    yield {
      rows: page.rows,
      ...(page.nextLink ? { nextLink: page.nextLink } : {}),
      ...(page.deltaLink ? { deltaLink: page.deltaLink } : {}),
    };
    while (page.nextLink) {
      page = await this.followNextLink<T>(page.nextLink, options.signal);
      yield {
        rows: page.rows,
        ...(page.nextLink ? { nextLink: page.nextLink } : {}),
        ...(page.deltaLink ? { deltaLink: page.deltaLink } : {}),
      };
    }
  }

  /**
   * Last-resort raw passthrough — flows through `HonuaClient.pipelineFetch`
   * so auth headers, retry, timeout, interceptors, telemetry, and
   * normalized error mapping all apply. The returned `Response` is
   * unconsumed; callers pick `.json()`, `.text()`, or `.arrayBuffer()`.
   */
  public async raw(method: string, path: string, init: RequestInit = {}): Promise<Response> {
    const normalized = method.toUpperCase() as "GET" | "POST" | "PATCH" | "DELETE" | "PUT";
    return this.client.pipelineFetch(normalized, ensureLeadingSlash(path), init);
  }

  // ── Internal ────────────────────────────────────────────────

  private entitySetPath(): string {
    return `${this.basePath}/${this.entitySet}`;
  }

  private async fetchMetadata(
    options: ReturnType<typeof normalizeHonuaMetadataRequestOptions>,
    cached: OdataMetadataCacheEntry | undefined,
  ): Promise<OdataMetadataCacheEntry> {
    // Route through pipelineFetch so auth headers, interceptors, retry,
    // timeout, and normalized error handling all apply. The default
    // pipeline does not impose an `Accept` header — we ask for XML
    // explicitly because the OData `$metadata` route emits CSDL.
    const response = await this.client.pipelineFetch(
      "GET",
      `${this.basePath}/$metadata`,
      {
        headers: honuaMetadataRequestHeaders({
          accept: "application/xml",
          refresh: options.refresh || Boolean(cached),
          bypass: options.cache === "bypass",
          validator: cached?.validator,
        }),
      },
      options.signal,
      { okStatuses: [304] },
    );
    if (response.status === 304 && cached) {
      const validator = honuaCacheValidatorFromHeaders(response.headers) ?? cached.validator;
      return {
        ...cached,
        cachedAtMs: Date.now(),
        ...(validator ? { validator } : {}),
        status: "refreshed",
      };
    }
    const xml = await response.text();
    const validator = honuaCacheValidatorFromHeaders(response.headers);
    const sourceUpdatedAt = response.headers.get("last-modified") ?? undefined;
    return {
      metadata: withoutHonuaCacheState(parseOdataMetadata(xml)),
      cachedAtMs: Date.now(),
      keyFingerprint: `metadata:odata:${this.basePath}:$metadata`,
      status: options.cache === "bypass" ? "bypass" : cached ? "refreshed" : "miss",
      ...(validator ? { validator } : {}),
      ...(sourceUpdatedAt ? { sourceUpdatedAt } : {}),
    };
  }

  private async followNextLink<T>(nextLink: string, signal?: AbortSignal): Promise<HonuaOdataPage<T>> {
    // OData servers may emit either an absolute URL or a relative one.
    // Normalize through the same fetch path used by `query()` so retry,
    // auth interceptors, and telemetry still apply.
    const { path, query } = parseNextLink(nextLink, this.client.serverBaseUrl, this.basePath);
    const body = await this.requestJson<OdataValueEnvelope<T>>("GET", path, query, signal);
    return {
      rows: body.value ?? [],
      ...(typeof body["@odata.count"] === "number" ? { totalCount: body["@odata.count"] } : {}),
      ...(typeof body["@odata.nextLink"] === "string" ? { nextLink: body["@odata.nextLink"] } : {}),
      ...(typeof body["@odata.deltaLink"] === "string" ? { deltaLink: body["@odata.deltaLink"] } : {}),
    };
  }

  /**
   * Wrap `HonuaClient.pipelineRequestJson` with OData-shaped query
   * serialization so callers can pass parsed query bags. Critically this
   * does **not** go through `HonuaClient.request` — that helper injects
   * `f=json`, which Honua Server's OData validators reject as
   * `InvalidQueryOption`. The OData server defaults to JSON when the
   * request advertises `Accept: application/json` (the pipeline default).
   */
  private async requestJson<T>(
    method: "GET" | "POST" | "PATCH" | "DELETE",
    path: string,
    query: Record<string, string | number | boolean> | undefined,
    signal?: AbortSignal,
    body?: string,
    headers?: Record<string, string>,
  ): Promise<T> {
    const params = new URLSearchParams();
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        params.set(key, String(value));
      }
    }
    const pathWithQuery = params.size > 0 ? `${path}?${params.toString()}` : path;
    return this.client.pipelineRequestJson<T>(
      method,
      pathWithQuery,
      {
        ...(headers ? { headers } : {}),
        ...(body !== undefined ? { body } : {}),
      },
      signal,
    );
  }
}

// ── Helpers ───────────────────────────────────────────────────

function withOdataMetadataCacheState(
  entry: OdataMetadataCacheEntry,
  status: "hit" | "miss" | "stale" | "refreshed" | "bypass",
  options: {
    now: number;
    ttlMs?: number;
    staleIfErrorMs?: number;
    revalidatedAt?: string;
    refreshErrorId?: string;
  },
): HonuaOdataMetadata {
  return withHonuaCacheState(
    entry.metadata,
    createHonuaCacheState({
      scope: "metadata",
      status,
      keyFingerprint: entry.keyFingerprint,
      ageMs: Math.max(0, options.now - entry.cachedAtMs),
      ...(options.ttlMs !== undefined ? { ttlMs: options.ttlMs } : {}),
      ...(options.staleIfErrorMs !== undefined ? { staleIfErrorMs: options.staleIfErrorMs } : {}),
      ...(options.revalidatedAt ? { revalidatedAt: options.revalidatedAt } : {}),
      ...(entry.sourceUpdatedAt ? { sourceUpdatedAt: entry.sourceUpdatedAt } : {}),
      ...(entry.validator ? { validator: entry.validator } : {}),
      ...(options.refreshErrorId ? { refreshErrorId: options.refreshErrorId } : {}),
    }),
  );
}

function odataMetadataRefreshErrorId(error: unknown): string {
  if (error instanceof Error && error.name) {
    return error.name;
  }
  return "unknown";
}

interface OdataValueEnvelope<T> {
  value?: T[];
  "@odata.count"?: number;
  "@odata.nextLink"?: string;
  "@odata.deltaLink"?: string;
}

function normalizeBasePath(path: string | undefined): string {
  if (path === undefined || path === "") return "/odata";
  return path.startsWith("/") ? trimTrailingSlashes(path) || "/" : `/${trimTrailingSlashes(path)}`;
}

/**
 * Extract the unqualified entity-set name from a path-shaped token.
 * Direct identifiers (`"Parcels"`) round-trip unchanged; navigation paths
 * (`"Layers(1)/Features"`) collapse to the trailing segment so CSDL
 * metadata lookups (which key by `<EntitySet Name="…">`) still hit.
 */
function extractEntitySetName(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? path : path.slice(slash + 1);
}

function ensureLeadingSlash(path: string): string {
  return path.startsWith("/") ? path : `/${path}`;
}

function stripLeadingSlash(path: string): string {
  return path.startsWith("/") ? path.slice(1) : path;
}

/**
 * Make an OData entity key safe to interpolate into the URL path segment
 * `<entitySet>(<key>)`. A raw key containing characters such as `&`, `?`,
 * `#`, `/`, space, or `'` would otherwise split or mis-target the path
 * (e.g. `Customers(A&B)`).
 *
 * The key is treated as an OData literal: single-quoted spans are kept as
 * quoted string literals (with embedded `'` doubled per OData v4 §5.1.1.6.1),
 * and structural characters that delimit composite keys (`,`, `=`) and
 * literal quotes are preserved. Everything else is percent-encoded so the
 * resulting segment is a single, correctly-targeted URL path component.
 */
function encodeOdataKey(key: string | number): string {
  const raw = String(key);
  let out = "";
  let inQuote = false;
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    if (ch === "'") {
      // Toggle quoted-literal state and keep the (URL-safe) quote verbatim.
      inQuote = !inQuote;
      out += "'";
      continue;
    }
    if (!inQuote && (ch === "," || ch === "=")) {
      // Composite-key delimiters stay structural outside quoted spans.
      out += ch;
      continue;
    }
    // Percent-encode anything that is unsafe in a path segment. Unreserved
    // characters (RFC 3986) pass through untouched.
    if (/[A-Za-z0-9\-._~]/.test(ch)) {
      out += ch;
    } else {
      out += encodeURIComponent(ch);
    }
  }
  return out;
}

/**
 * Translate canonical query params onto the OData `$`-prefixed query
 * string. Empty strings, undefined values, and zero-length lists are
 * dropped so the URL stays minimal.
 */
function serializeQueryParams(params: HonuaOdataQueryParams): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  if (params.filter !== undefined && params.filter !== "") out.$filter = params.filter;
  if (params.select && params.select.length > 0) out.$select = params.select.join(",");
  if (params.orderBy && params.orderBy.length > 0) out.$orderby = params.orderBy.join(",");
  if (typeof params.top === "number" && Number.isFinite(params.top)) out.$top = params.top;
  if (typeof params.skip === "number" && Number.isFinite(params.skip) && params.skip > 0) out.$skip = params.skip;
  if (params.expand && params.expand.length > 0) out.$expand = params.expand.join(",");
  if (params.count) out.$count = "true";
  if (params.skiptoken !== undefined && params.skiptoken !== "") out.$skiptoken = params.skiptoken;
  if (params.search !== undefined && params.search !== "") out.$search = params.search;
  if (params.apply !== undefined && params.apply !== "") out.$apply = params.apply;
  if (params.deltatoken !== undefined && params.deltatoken !== "") out.$deltatoken = params.deltatoken;
  if (params.extra) Object.assign(out, params.extra);
  return out;
}

/**
 * `@odata.nextLink` is either an absolute URL (preferred by spec) or a
 * service-relative URL. Reduce it to the path + query bag the same fetch
 * pipeline expects.
 */
function parseNextLink(
  link: string,
  serverBaseUrl: string,
  basePath: string,
): { path: string; query: Record<string, string | number | boolean> } {
  const absolute =
    link.startsWith("http://") || link.startsWith("https://")
      ? new URL(link)
      : new URL(link, `${ensureTrailingSlash(serverBaseUrl)}${stripLeadingSlash(basePath)}/`);
  const path = absolute.pathname;
  const query: Record<string, string | number | boolean> = {};
  for (const [key, value] of absolute.searchParams) query[key] = value;
  return { path, query };
}

function ensureTrailingSlash(url: string): string {
  return url.endsWith("/") ? url : `${url}/`;
}

// ── EDMX (CSDL) parsing ───────────────────────────────────────

/**
 * Parse the subset of CSDL we need to power capability negotiation and
 * key resolution: entity sets, entity-type keys, property names + types,
 * `Edm.Geography` / `Edm.Geometry` typing, and `Capabilities.*`
 * annotations. The XML is read via small regular expressions because we
 * intentionally do not pull a DOM dep — the surface we read is
 * well-defined by OData CSDL §6 and the Honua Server spec page.
 */
export function parseOdataMetadata(xml: string): HonuaOdataMetadata {
  if (xml.length > MAX_ODATA_METADATA_CHARACTERS) {
    throw new RangeError(`OData metadata exceeds ${MAX_ODATA_METADATA_CHARACTERS} characters`);
  }
  const entitySets = Object.create(null) as Record<string, string>;
  const keys = Object.create(null) as Record<string, string[]>;
  const fields = Object.create(null) as Record<string, HonuaOdataFieldInfo[]>;
  const projectionFields = Object.create(null) as Record<string, HonuaOdataFieldInfo[]>;
  const complexTypes = Object.create(null) as Record<string, HonuaOdataFieldInfo[]>;
  const enumTypes = Object.create(null) as Record<string, HonuaOdataEnumTypeInfo>;
  const openTypes = Object.create(null) as Record<string, true>;
  const capabilities = Object.create(null) as Record<string, HonuaOdataAdvertisedCapabilities>;

  // Sibling annotations: <Annotations Target="<schema>.<container>/<entitySet>">
  // …</Annotations>. Honua Server emits Capabilities.* this way (next to
  // the EntityContainer) rather than nesting them inside <EntitySet>, so
  // capability negotiation must merge both shapes.
  const siblingByEntitySet = new Map<string, string>();
  for (const element of xmlElements(xml, "Annotations")) {
    const attrs = element.attributes;
    const target = readAttr(attrs, "Target");
    if (!target) continue;
    const slash = target.lastIndexOf("/");
    if (slash === -1) continue;
    const setName = target.slice(slash + 1);
    if (!setName) continue;
    const body = element.body;
    const existing = siblingByEntitySet.get(setName);
    siblingByEntitySet.set(setName, existing === undefined ? body : `${existing}\n${body}`);
  }

  // Entity sets: <EntitySet Name="Foo" EntityType="ns.FooEntity"/>
  for (const element of xmlElements(xml, "EntitySet")) {
    const attrs = element.attributes;
    const name = readAttr(attrs, "Name");
    const type = readAttr(attrs, "EntityType");
    if (!name || !type) continue;
    entitySets[name] = stripNamespace(type);
    const inlineBody = element.body;
    const siblingBody = siblingByEntitySet.get(name) ?? "";
    capabilities[name] = parseEntitySetAnnotations(`${inlineBody}\n${siblingBody}`);
    siblingByEntitySet.delete(name);
  }
  // Capture annotations for entity sets that were not declared inline (e.g.
  // when a server emits only the sibling block). The simple-name suffix
  // from the Target still keys a capability entry so callers can find it.
  for (const [setName, body] of siblingByEntitySet) {
    capabilities[setName] = parseEntitySetAnnotations(body);
  }

  // Entity types: <EntityType Name="FooEntity">…<Key><PropertyRef Name="Id"/></Key><Property…/>…</EntityType>
  for (const element of xmlElements(xml, "EntityType")) {
    const attrs = element.attributes;
    const body = element.body;
    const name = readAttr(attrs, "Name");
    if (!name) continue;
    if (readAttr(attrs, "OpenType")?.toLowerCase() === "true") openTypes[name] = true;
    const keyNames: string[] = [];
    const keyBlock = xmlElements(body, "Key").next();
    if (!keyBlock.done) {
      for (const refAttrs of xmlStartTags(keyBlock.value.body, "PropertyRef")) {
        const refName = readAttr(refAttrs, "Name");
        if (refName) keyNames.push(refName);
      }
    }
    keys[name] = keyNames;
    const richFields = parseOdataProperties(body);
    projectionFields[name] = richFields;
    fields[name] = richFields.map(legacyOdataFieldInfo);
  }

  for (const element of xmlElements(xml, "ComplexType")) {
    const name = readAttr(element.attributes, "Name");
    if (name) complexTypes[name] = parseOdataProperties(element.body);
  }

  for (const element of xmlElements(xml, "EnumType")) {
    const attrs = element.attributes;
    const name = readAttr(attrs, "Name");
    if (!name) continue;
    const underlyingType = readAttr(attrs, "UnderlyingType") ?? "Edm.Int32";
    const isFlags = readAttr(attrs, "IsFlags")?.toLowerCase() === "true";
    const declarations = [...xmlStartTags(element.body, "Member")].map((memberAttrs) => ({
      name: readAttr(memberAttrs, "Name"),
      rawValue: readAttr(memberAttrs, "Value"),
    }));
    const hasExplicit = declarations.some((member) => member.rawValue !== undefined);
    const hasImplicit = declarations.some((member) => member.rawValue === undefined);
    const valueMode = hasExplicit ? (hasImplicit ? "mixed" : "explicit") : "implicit";
    let declarationReason: Extract<HonuaOdataEnumDeclaration, { state: "invalid" }>["reason"] | undefined;
    const invalidate = (reason: NonNullable<typeof declarationReason>): void => {
      declarationReason ??= reason;
    };
    const bounds = odataEnumBounds(underlyingType);
    if (declarations.length === 0) invalidate("empty-declaration");
    if (!bounds) invalidate("invalid-underlying-type");
    if (isFlags && hasImplicit) invalidate("flags-require-explicit-values");

    const members: HonuaOdataEnumMemberInfo[] = [];
    const names = new Set<string>();
    let previousValue: bigint | undefined;
    for (const [index, declaration] of declarations.entries()) {
      let parsed: bigint | undefined;
      if (declaration.rawValue === undefined) {
        if (!isFlags) {
          parsed = index === 0 ? 0n : previousValue === undefined ? undefined : previousValue + 1n;
        }
      } else if (declaration.rawValue.length <= 20 && /^[+-]?\d+$/.test(declaration.rawValue)) {
        try {
          parsed = BigInt(declaration.rawValue);
        } catch {
          parsed = undefined;
        }
      }
      if (parsed === undefined) invalidate("invalid-member-value");
      else if (isFlags && parsed < 0n) invalidate("negative-flags-value");
      else if (bounds && (parsed < bounds.minimum || parsed > bounds.maximum)) invalidate("out-of-range");
      previousValue = parsed;
      if (!declaration.name || !odataSimpleIdentifier(declaration.name)) {
        invalidate("invalid-member-name");
        continue;
      }
      if (names.has(declaration.name)) invalidate("duplicate-member-name");
      names.add(declaration.name);
      if (parsed === undefined) continue;
      const value =
        underlyingType === "Edm.Int64" || !Number.isSafeInteger(Number(parsed)) ? parsed.toString() : Number(parsed);
      members.push({ name: declaration.name, value });
    }
    enumTypes[name] = {
      underlyingType,
      isFlags,
      members,
      declaration: declarationReason ? { state: "invalid", reason: declarationReason } : { state: "valid", valueMode },
    };
  }

  const metadata: HonuaOdataMetadata = {
    entitySets,
    keys,
    fields,
    capabilities,
  };
  Object.defineProperty(metadata, ODATA_SOURCE_SCHEMA_PROJECTION_DETAILS, {
    value: { fields: projectionFields, complexTypes, enumTypes, openTypes },
    enumerable: true,
  });
  Object.defineProperty(metadata, ODATA_SOURCE_SCHEMA_PROJECTION_SAFETY, {
    value: inspectOdataSourceSchemaProjectionSafety(xml),
    enumerable: true,
  });
  return metadata;
}

function inspectOdataSourceSchemaProjectionSafety(xml: string): HonuaOdataSourceSchemaProjectionSafety {
  const edmxAttributes = firstXmlStartTagByLocalName(xml, "Edmx");
  const csdlVersion = edmxAttributes === undefined ? undefined : readAttr(edmxAttributes, "Version");
  const declarations = new Map<string, Map<string, number>>();
  const inheritedTypeNames = new Set<string>();
  const openComplexTypeNames = new Set<string>();
  const unqualifiedTypeNames = new Set<string>();
  for (const schema of xmlElements(xml, "Schema")) {
    const namespace = readAttr(schema.attributes, "Namespace");
    for (const kind of ["EntityType", "ComplexType", "EnumType"] as const) {
      for (const attributes of xmlStartTags(schema.body, kind)) {
        const name = readAttr(attributes, "Name");
        if (!name) continue;
        const qualifiedIdentity = `${kind}:${namespace ? `${namespace}.${name}` : name}`;
        const identities = declarations.get(name) ?? new Map<string, number>();
        identities.set(qualifiedIdentity, (identities.get(qualifiedIdentity) ?? 0) + 1);
        declarations.set(name, identities);
        if (!namespace) unqualifiedTypeNames.add(name);
        if (kind !== "EnumType" && readAttr(attributes, "BaseType")) inheritedTypeNames.add(name);
        if (kind === "ComplexType" && readAttr(attributes, "OpenType")?.toLowerCase() === "true") {
          openComplexTypeNames.add(name);
        }
      }
    }
  }
  const ambiguousTypeNames = [...declarations]
    .filter(([, identities]) => identities.size > 1 || [...identities.values()].some((count) => count > 1))
    .map(([name]) => name)
    .sort();
  return Object.freeze({
    ...(csdlVersion === undefined ? {} : { csdlVersion }),
    ambiguousTypeNames: Object.freeze(ambiguousTypeNames),
    inheritedTypeNames: Object.freeze([...inheritedTypeNames].sort()),
    openComplexTypeNames: Object.freeze([...openComplexTypeNames].sort()),
    unqualifiedTypeNames: Object.freeze([...unqualifiedTypeNames].sort()),
  });
}

function odataEnumBounds(underlyingType: string): { readonly minimum: bigint; readonly maximum: bigint } | undefined {
  switch (underlyingType) {
    case "Edm.Byte":
      return { minimum: 0n, maximum: 255n };
    case "Edm.SByte":
      return { minimum: -128n, maximum: 127n };
    case "Edm.Int16":
      return { minimum: -32_768n, maximum: 32_767n };
    case "Edm.Int32":
      return { minimum: -2_147_483_648n, maximum: 2_147_483_647n };
    case "Edm.Int64":
      return { minimum: -(1n << 63n), maximum: (1n << 63n) - 1n };
    default:
      return undefined;
  }
}

function odataSimpleIdentifier(value: string): boolean {
  if (value.length > 256) return false;
  let codePoints = 0;
  for (const _character of value) {
    codePoints += 1;
    if (codePoints > 128) return false;
  }
  return /^[\p{L}\p{Nl}_][\p{L}\p{Nl}\p{Nd}\p{Mn}\p{Mc}\p{Pc}\p{Cf}]*$/u.test(value);
}

function parseOdataProperties(body: string): HonuaOdataFieldInfo[] {
  const props: HonuaOdataFieldInfo[] = [];
  for (const propAttrs of xmlStartTags(body, "Property")) {
    const propName = readAttr(propAttrs, "Name");
    const propType = readAttr(propAttrs, "Type");
    if (!propName || !propType) continue;
    const nullable = readAttr(propAttrs, "Nullable");
    const maxLengthAttr = readAttr(propAttrs, "MaxLength");
    const precisionAttr = readAttr(propAttrs, "Precision");
    const scaleAttr = readAttr(propAttrs, "Scale");
    const sridAttr = readAttr(propAttrs, "SRID");
    const isSpatial = propType.startsWith("Edm.Geography") || propType.startsWith("Edm.Geometry");
    const info: HonuaOdataFieldInfo = { name: propName, type: propType };
    if (nullable !== undefined) info.nullable = nullable !== "false";
    if (maxLengthAttr?.toLowerCase() === "max") info.maxLength = "max";
    else if (maxLengthAttr !== undefined) {
      const maxLength = Number(maxLengthAttr);
      if (Number.isSafeInteger(maxLength) && maxLength >= 0) info.maxLength = maxLength;
    }
    if (precisionAttr !== undefined) {
      const precision = Number(precisionAttr);
      if (Number.isSafeInteger(precision) && precision >= 0) info.precision = precision;
    }
    if (scaleAttr?.toLowerCase() === "variable" || scaleAttr?.toLowerCase() === "floating") {
      info.scale = scaleAttr.toLowerCase() as "variable" | "floating";
    } else if (scaleAttr !== undefined) {
      const scale = Number(scaleAttr);
      if (Number.isSafeInteger(scale) && scale >= 0) info.scale = scale;
    }
    if (isSpatial) info.isSpatial = true;
    if (sridAttr?.toLowerCase() === "variable") info.srid = "variable";
    else if (sridAttr !== undefined) {
      const srid = Number(sridAttr);
      if (Number.isSafeInteger(srid) && srid >= 0) info.srid = srid;
    }
    props.push(info);
  }
  return props;
}

function legacyOdataFieldInfo(field: HonuaOdataFieldInfo): HonuaOdataFieldInfo {
  return {
    name: field.name,
    type: field.type,
    ...(field.nullable === undefined ? {} : { nullable: field.nullable }),
    ...(field.isSpatial === true ? { isSpatial: true } : {}),
    ...(typeof field.srid === "number" ? { srid: field.srid } : {}),
  };
}

/**
 * Convenience: project the field schema for one entity set into the
 * canonical `HonuaFieldInfo[]` shape reused by `Result.fields`.
 */
export function odataFieldSchema(metadata: HonuaOdataMetadata, entitySet: string): readonly HonuaFieldInfo[] {
  const typeName = metadata.entitySets[entitySet];
  if (!typeName) return [];
  const props = metadata.fields[typeName];
  if (!props) return [];
  return props.map((p) => ({ name: p.name, type: edmToHonuaFieldType(p.type) }));
}

function edmToHonuaFieldType(edm: string): HonuaFieldInfo["type"] {
  if (edm.startsWith("Edm.Geography") || edm.startsWith("Edm.Geometry")) return "esriFieldTypeGeometry";
  if (edm === "Edm.String") return "esriFieldTypeString";
  if (edm === "Edm.Int32") return "esriFieldTypeInteger";
  if (edm === "Edm.Int64") return "esriFieldTypeOID";
  if (edm === "Edm.Double") return "esriFieldTypeDouble";
  if (edm === "Edm.Single") return "esriFieldTypeSingle";
  if (edm === "Edm.Boolean") return "esriFieldTypeSmallInteger";
  if (edm === "Edm.DateTimeOffset" || edm === "Edm.Date") return "esriFieldTypeDate";
  return "esriFieldTypeString";
}

function parseEntitySetAnnotations(body: string): HonuaOdataAdvertisedCapabilities {
  const out: HonuaOdataAdvertisedCapabilities = {};
  for (const element of xmlElements(body, "Annotation")) {
    const attrs = element.attributes;
    const term = readAttr(attrs, "Term");
    if (!term || !term.includes("Capabilities.")) continue;
    const inner = element.body.trim();
    const boolValue =
      readAttr(attrs, "Bool") ??
      matchBool(inner) ??
      matchPropertyValueBool(inner, "Insertable") ??
      matchPropertyValueBool(inner, "Updatable") ??
      matchPropertyValueBool(inner, "Deletable") ??
      matchPropertyValueBool(inner, "Searchable") ??
      matchPropertyValueBool(inner, "Filterable") ??
      matchPropertyValueBool(inner, "Expandable") ??
      matchPropertyValueBool(inner, "Selectable") ??
      matchPropertyValueBool(inner, "Countable") ??
      // Honua Server uses `Supported` for ChangeTracking and other
      // capability records; without this fallback, `<PropertyValue
      // Property="Supported" Bool="false"/>` would be silently treated
      // as supported.
      matchPropertyValueBool(inner, "Supported");
    if (term.endsWith("InsertRestrictions")) {
      out.insert = matchPropertyValueBool(inner, "Insertable") !== "false";
    } else if (term.endsWith("UpdateRestrictions")) {
      out.update = matchPropertyValueBool(inner, "Updatable") !== "false";
    } else if (term.endsWith("DeleteRestrictions")) {
      out.delete = matchPropertyValueBool(inner, "Deletable") !== "false";
    } else if (term.endsWith("BatchSupported") || term.endsWith("BatchSupport")) {
      out.batch = boolValue !== "false";
    } else if (term.endsWith("FilterRestrictions") || term.endsWith("FilterFunctions")) {
      out.filter = boolValue !== "false";
    } else if (term.endsWith("ExpandRestrictions")) {
      out.expand = boolValue !== "false";
    } else if (term.endsWith("SelectSupport")) {
      out.select = boolValue !== "false";
    } else if (term.endsWith("SearchRestrictions")) {
      out.search = boolValue !== "false";
    } else if (term.endsWith("CountRestrictions")) {
      out.count = boolValue !== "false";
    } else if (term.endsWith("ChangeTracking")) {
      out.delta = boolValue !== "false";
    } else if (term.endsWith("ApplySupported") || term.endsWith("ApplyRestrictions")) {
      out.apply = boolValue !== "false";
    }
  }
  return out;
}

function readAttr(attrs: string, name: string): string | undefined {
  let cursor = 0;
  while (cursor < attrs.length) {
    while (cursor < attrs.length && xmlWhitespace(attrs.charCodeAt(cursor))) cursor += 1;
    if (cursor >= attrs.length || attrs.charCodeAt(cursor) === 47) return undefined;
    const nameStart = cursor;
    while (cursor < attrs.length) {
      const code = attrs.charCodeAt(cursor);
      if (xmlWhitespace(code) || code === 61 || code === 47 || code === 62) break;
      cursor += 1;
    }
    const attributeName = attrs.slice(nameStart, cursor);
    while (cursor < attrs.length && xmlWhitespace(attrs.charCodeAt(cursor))) cursor += 1;
    if (attrs.charCodeAt(cursor) !== 61) {
      cursor += 1;
      continue;
    }
    cursor += 1;
    while (cursor < attrs.length && xmlWhitespace(attrs.charCodeAt(cursor))) cursor += 1;
    const quote = attrs.charCodeAt(cursor);
    if (quote !== 34 && quote !== 39) {
      cursor += 1;
      continue;
    }
    const valueStart = ++cursor;
    while (cursor < attrs.length && attrs.charCodeAt(cursor) !== quote) cursor += 1;
    if (cursor >= attrs.length) return undefined;
    if (attributeName === name) return attrs.slice(valueStart, cursor);
    cursor += 1;
  }
  return undefined;
}

interface XmlElementSlice {
  readonly attributes: string;
  readonly body: string;
}

function* xmlElements(xml: string, tagName: string): Generator<XmlElementSlice> {
  const marker = `<${tagName}`;
  const closing = `</${tagName}>`;
  let cursor = 0;
  while (cursor < xml.length) {
    const start = findXmlTag(xml, marker, cursor);
    if (start === -1) return;
    const tagEnd = findXmlTagEnd(xml, start + marker.length);
    if (tagEnd === -1) return;
    const attributes = xml.slice(start + marker.length, tagEnd);
    if (xmlSelfClosing(attributes)) {
      yield { attributes, body: "" };
      cursor = tagEnd + 1;
      continue;
    }
    const closeStart = xml.indexOf(closing, tagEnd + 1);
    if (closeStart === -1) return;
    yield { attributes, body: xml.slice(tagEnd + 1, closeStart) };
    cursor = closeStart + closing.length;
  }
}

function* xmlStartTags(xml: string, tagName: string): Generator<string> {
  const marker = `<${tagName}`;
  let cursor = 0;
  while (cursor < xml.length) {
    const start = findXmlTag(xml, marker, cursor);
    if (start === -1) return;
    const tagEnd = findXmlTagEnd(xml, start + marker.length);
    if (tagEnd === -1) return;
    yield xml.slice(start + marker.length, tagEnd);
    cursor = tagEnd + 1;
  }
}

function firstXmlStartTagByLocalName(xml: string, localName: string): string | undefined {
  let cursor = 0;
  while (cursor < xml.length) {
    const start = xml.indexOf("<", cursor);
    if (start === -1) return undefined;
    const nameStart = start + 1;
    const first = xml.charCodeAt(nameStart);
    if (first === 33 || first === 47 || first === 63) {
      cursor = nameStart + 1;
      continue;
    }
    let nameEnd = nameStart;
    while (nameEnd < xml.length) {
      const code = xml.charCodeAt(nameEnd);
      if (xmlWhitespace(code) || code === 47 || code === 62) break;
      nameEnd += 1;
    }
    const qualifiedName = xml.slice(nameStart, nameEnd);
    const colon = qualifiedName.lastIndexOf(":");
    if (qualifiedName.slice(colon + 1) === localName) {
      const tagEnd = findXmlTagEnd(xml, nameEnd);
      return tagEnd === -1 ? undefined : xml.slice(nameEnd, tagEnd);
    }
    cursor = nameEnd > nameStart ? nameEnd : nameStart + 1;
  }
  return undefined;
}

function findXmlTag(xml: string, marker: string, from: number): number {
  let cursor = from;
  while (cursor < xml.length) {
    const start = xml.indexOf(marker, cursor);
    if (start === -1) return -1;
    const boundary = xml.charCodeAt(start + marker.length);
    if (xmlWhitespace(boundary) || boundary === 47 || boundary === 62) return start;
    cursor = start + marker.length;
  }
  return -1;
}

function findXmlTagEnd(xml: string, from: number): number {
  let quote = 0;
  for (let cursor = from; cursor < xml.length; cursor += 1) {
    const code = xml.charCodeAt(cursor);
    if (quote !== 0) {
      if (code === quote) quote = 0;
    } else if (code === 34 || code === 39) {
      quote = code;
    } else if (code === 62) {
      return cursor;
    }
  }
  return -1;
}

function xmlSelfClosing(attributes: string): boolean {
  let cursor = attributes.length - 1;
  while (cursor >= 0 && xmlWhitespace(attributes.charCodeAt(cursor))) cursor -= 1;
  return cursor >= 0 && attributes.charCodeAt(cursor) === 47;
}

function xmlWhitespace(code: number): boolean {
  return code === 9 || code === 10 || code === 13 || code === 32;
}

function stripNamespace(name: string): string {
  const idx = name.lastIndexOf(".");
  return idx === -1 ? name : name.slice(idx + 1);
}

function matchBool(inner: string): string | undefined {
  const element = xmlElements(inner, "Bool").next();
  if (element.done) return undefined;
  return element.value.body === "true" || element.value.body === "false" ? element.value.body : undefined;
}

function matchPropertyValueBool(inner: string, property: string): string | undefined {
  for (const attributes of xmlStartTags(inner, "PropertyValue")) {
    if (readAttr(attributes, "Property") !== property) continue;
    const value = readAttr(attributes, "Bool");
    if (value === "true" || value === "false") return value;
  }
  return undefined;
}

const UNSUPPORTED_OPERATOR_RES: ReadonlyArray<{ token: string; re: RegExp }> = [
  { token: "has", re: /\bhas\b/i },
  { token: "in", re: /\bin\s*\(/i },
  { token: "any", re: /\bany\s*\(/i },
  { token: "all", re: /\ball\s*\(/i },
  { token: "cast", re: /\bcast\s*\(/i },
  { token: "isof", re: /\bisof\s*\(/i },
];

// ── SQL → OData filter rewrite ────────────────────────────────

/**
 * `Query.where` is documented as SQL-92 / CQL2 on the canonical surface.
 * The OData `$filter` grammar is close to but not identical to SQL-92;
 * this minimal rewriter handles the cases that would otherwise produce a
 * server-side parse error rather than a translated query. Full SQL→OData
 * translation is tracked as follow-up work in
 * `docs/decisions/odata-library-selection.md`.
 *
 * Rewrites applied:
 *  - `IS NULL` / `IS NOT NULL` → `eq null` / `ne null`
 *  - `<col> = '...'`, `<col> = N` → `<col> eq '...'` / `<col> eq N`
 *  - SQL-style `<>` → `ne`
 *  - SQL comparison operators `>=` / `<=` / `>` / `<` → `ge` / `le` /
 *    `gt` / `lt` (Honua Server's OData lexer rejects bare punctuation
 *    comparisons as `InvalidQueryOption`).
 *
 * Predicates whose syntax already matches OData (e.g. `STATE eq 'CA'`)
 * pass through unchanged. Unsupported operators (`HAS`, `IN`, `ANY`,
 * `ALL`, `CAST`, `ISOF` from the parity matrix) are detected and
 * rejected with a typed error rather than left to the server.
 */
export function rewriteWhereToOdataFilter(where: string): string {
  if (where === "" || where === "1=1") return "";
  // Tokenize into alternating non-literal / literal spans so the rewriter
  // and unsupported-operator detector skip the contents of quoted string
  // literals. Without this split, a value like `NAME = 'A=B'` would have
  // its embedded `=` rewritten to ` eq `, corrupting the literal before it
  // reaches `$filter`. OData uses single-quoted strings with `''` for
  // embedded quotes (per OData v4 §5.1.1.6.1).
  const spans = splitOdataLiteralSpans(where);
  for (let idx = 0; idx < spans.length; idx += 2) {
    const segment = spans[idx];
    if (segment === "") continue;
    for (const banned of UNSUPPORTED_OPERATOR_RES) {
      if (banned.re.test(segment)) {
        throw new Error(
          `odata: $filter does not support "${banned.token}"; the parity matrix lists this operator as unsupported on Honua Server.`,
        );
      }
    }
    let out = segment;
    out = out.replace(/\bIS\s+NOT\s+NULL\b/gi, "ne null");
    out = out.replace(/\bIS\s+NULL\b/gi, "eq null");
    // `<>` must be rewritten before bare `<` / `>` so the not-equal
    // operator does not get split into `lt` / `gt`. Two-char operators
    // (`>=` / `<=`) likewise come before bare `>` / `<`.
    out = out.replace(/<>/g, "ne");
    out = out.replace(/(\b\w+\b)\s*>=\s*/g, (_match, lhs: string) => `${lhs} ge `);
    out = out.replace(/(\b\w+\b)\s*<=\s*/g, (_match, lhs: string) => `${lhs} le `);
    out = out.replace(/(\b\w+\b)\s*>\s*/g, (_match, lhs: string) => `${lhs} gt `);
    out = out.replace(/(\b\w+\b)\s*<\s*/g, (_match, lhs: string) => `${lhs} lt `);
    out = out.replace(/(\b\w+\b)\s*=\s*/g, (_match, lhs: string) => `${lhs} eq `);
    out = out.replace(/\bAND\b/gi, "and");
    out = out.replace(/\bOR\b/gi, "or");
    out = out.replace(/\bNOT\b/gi, "not");
    spans[idx] = out;
  }
  return spans.join("").trim();
}

/**
 * Split an OData `$filter`-style expression into alternating non-literal
 * and literal spans. Even indices contain code; odd indices contain
 * single-quoted string literals (with quotes preserved). Embedded `''`
 * escape sequences inside a literal are kept verbatim. An unterminated
 * literal is treated as if it ran to the end of the input.
 */
function splitOdataLiteralSpans(input: string): string[] {
  const spans: string[] = [];
  let buf = "";
  let i = 0;
  while (i < input.length) {
    const ch = input[i];
    if (ch !== "'") {
      buf += ch;
      i += 1;
      continue;
    }
    spans.push(buf);
    let literal = "'";
    i += 1;
    while (i < input.length) {
      const c = input[i];
      if (c === "'") {
        // OData string literals double the quote to embed it.
        if (input[i + 1] === "'") {
          literal += "''";
          i += 2;
          continue;
        }
        literal += "'";
        i += 1;
        break;
      }
      literal += c;
      i += 1;
    }
    spans.push(literal);
    buf = "";
  }
  spans.push(buf);
  return spans;
}

// ── Spatial filter → OData $filter expression ────────────────

/**
 * Build a spatial `$filter` predicate (`geo.intersects` / `geo.distance`)
 * from a canonical `SpatialFilter`. The geometry column is resolved from
 * the supplied schema (typed `Edm.Geography`); when no geometry column is
 * declared the function throws so the caller can either pass an explicit
 * column via `extra` or refuse the request before it reaches the server.
 *
 * Only the `spatialRel` values supported by Honua Server's parity matrix
 * are accepted: `esriSpatialRelIntersects` and
 * `esriSpatialRelEnvelopeIntersects` translate to `geo.intersects`;
 * `esriSpatialRelWithin` and `esriSpatialRelContains` are not supported
 * by `geo.intersects` semantics and throw.
 *
 * The WKT literal is stamped with the **input** geometry's SRID (i.e.
 * the coordinate system the literal coordinates are in), not an output
 * SR. The resolution order is `inputSrid` → the
 * `spatialFilter.geometry.spatialReference.{wkid|latestWkid}` carried by
 * the canonical `SpatialFilter` constructors → the metadata-declared
 * SRID on the **selected** geometry column (matched by name against
 * `geometryColumn` when supplied; falls back to the first `isSpatial`
 * field only when no column was pinned). Multi-geometry entity types
 * never borrow SRIDs across columns. When none of those resolves, the
 * literal is emitted without a `SRID=` prefix and the server falls
 * back to the column's declared SRID.
 */
export interface OdataSpatialFilterContext {
  geometryColumn?: string;
  geometryFields?: ReadonlyArray<HonuaOdataFieldInfo>;
  /** SRID of the input WKT literal. Optional — auto-derived when omitted. */
  inputSrid?: string | number;
}

export function buildOdataSpatialFilter(
  spatialFilter: {
    geometry: Record<string, unknown>;
    geometryType: string;
    spatialRel?: string;
    distance?: number;
  },
  context: OdataSpatialFilterContext = {},
): string {
  const rel = spatialFilter.spatialRel ?? "esriSpatialRelIntersects";
  if (
    rel !== "esriSpatialRelIntersects" &&
    rel !== "esriSpatialRelEnvelopeIntersects" &&
    rel !== "esriSpatialRelDistance"
  ) {
    throw new Error(
      `odata: spatialRel "${rel}" is not supported; OData parity matrix only implements geo.intersects (intersects/envelope-intersects) and geo.distance.`,
    );
  }
  const column = resolveGeometryColumn(context);
  const wkt = geometryToWkt(spatialFilter.geometry, spatialFilter.geometryType);
  const inputSrid = resolveInputSrid(spatialFilter.geometry, context);
  const literal = wktLiteral(wkt, inputSrid);
  if (rel === "esriSpatialRelDistance") {
    if (typeof spatialFilter.distance !== "number" || !Number.isFinite(spatialFilter.distance)) {
      throw new Error('odata: spatialRel "esriSpatialRelDistance" requires a numeric distance (meters for geography).');
    }
    return `geo.distance(${column},${literal}) le ${spatialFilter.distance}`;
  }
  return `geo.intersects(${column},${literal})`;
}

function resolveGeometryColumn(context: OdataSpatialFilterContext): string {
  if (context.geometryColumn) return context.geometryColumn;
  const spatial = context.geometryFields?.find((f) => f.isSpatial);
  if (!spatial) {
    throw new Error(
      "odata: cannot translate spatialFilter — no geometry column was supplied and metadata exposes no Edm.Geography field.",
    );
  }
  return spatial.name;
}

function resolveInputSrid(
  geometry: Record<string, unknown>,
  context: OdataSpatialFilterContext,
): string | number | undefined {
  if (context.inputSrid !== undefined && context.inputSrid !== null && context.inputSrid !== "") {
    return context.inputSrid;
  }
  const sr = geometry.spatialReference as { wkid?: number; latestWkid?: number } | undefined;
  if (sr?.wkid !== undefined && Number.isFinite(sr.wkid)) return sr.wkid;
  if (sr?.latestWkid !== undefined && Number.isFinite(sr.latestWkid)) return sr.latestWkid;
  // Prefer the SRID of the *selected* geometry column when a name was
  // pinned by the caller — entity types with multiple spatial fields
  // can declare different SRIDs per column, and the WKT must be stamped
  // with the SRID of the column the predicate is being evaluated
  // against. Falls back to the first spatial field only when no column
  // was pinned (or the pinned column is absent from the supplied
  // metadata fields).
  const selected =
    context.geometryColumn !== undefined
      ? context.geometryFields?.find((f) => f.name === context.geometryColumn)
      : undefined;
  if (selected?.srid !== undefined && Number.isFinite(selected.srid)) return selected.srid;
  if (context.geometryColumn !== undefined && selected) return undefined;
  const spatial = context.geometryFields?.find((f) => f.isSpatial);
  if (spatial?.srid !== undefined && Number.isFinite(spatial.srid)) return spatial.srid;
  return undefined;
}

function wktLiteral(wkt: string, srid: string | number | undefined): string {
  if (srid === undefined || srid === null || srid === "") {
    return `geography'${wkt}'`;
  }
  return `geography'SRID=${srid};${wkt}'`;
}

// Coordinates are interpolated verbatim into a WKT string that is wrapped in an
// OData `geography'...'` literal and passed straight into `$filter`. Any value
// that is not a finite number must be rejected here: a non-numeric string (e.g.
// one containing a single quote) would otherwise terminate the OData string
// literal and inject attacker-controlled tokens into the server-side filter, and
// NaN/Infinity/undefined would produce malformed WKT.
function wktCoordinate(value: unknown, context: string): number {
  const num = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(num)) {
    throw new Error(`odata: spatialFilter ${context} must be a finite number.`);
  }
  return num;
}

function wktPoint(pt: ArrayLike<unknown>, context: string): string {
  return `${wktCoordinate(pt[0], `${context}[0]`)} ${wktCoordinate(pt[1], `${context}[1]`)}`;
}

function geometryToWkt(geometry: Record<string, unknown>, geometryType: string): string {
  if (geometryType === "esriGeometryEnvelope") {
    const xmin = wktCoordinate(geometry.xmin, "envelope.xmin");
    const ymin = wktCoordinate(geometry.ymin, "envelope.ymin");
    const xmax = wktCoordinate(geometry.xmax, "envelope.xmax");
    const ymax = wktCoordinate(geometry.ymax, "envelope.ymax");
    return `POLYGON((${xmin} ${ymin}, ${xmax} ${ymin}, ${xmax} ${ymax}, ${xmin} ${ymax}, ${xmin} ${ymin}))`;
  }
  if (geometryType === "esriGeometryPoint") {
    const x = wktCoordinate(geometry.x, "point.x");
    const y = wktCoordinate(geometry.y, "point.y");
    return `POINT(${x} ${y})`;
  }
  if (geometryType === "esriGeometryPolygon") {
    const rings = geometry.rings as unknown[][][] | undefined;
    if (!Array.isArray(rings) || rings.length === 0) {
      throw new Error("odata: polygon spatialFilter has no rings");
    }
    const inner = rings
      .map((ring) => `(${ring.map((pt) => wktPoint(pt as ArrayLike<unknown>, "polygon.ring")).join(", ")})`)
      .join(", ");
    return `POLYGON(${inner})`;
  }
  if (geometryType === "esriGeometryPolyline") {
    const paths = geometry.paths as unknown[][][] | undefined;
    if (!Array.isArray(paths) || paths.length === 0) {
      throw new Error("odata: polyline spatialFilter has no paths");
    }
    const path = paths[0];
    return `LINESTRING(${path.map((pt) => wktPoint(pt as ArrayLike<unknown>, "polyline.path")).join(", ")})`;
  }
  throw new Error(`odata: spatialFilter.geometryType "${geometryType}" is not supported.`);
}
