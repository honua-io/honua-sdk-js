/**
 * Runtime classes for the WFS 2.0 adapter. Three layers:
 *
 *   - `HonuaWfs` — root handle bound to a WFS endpoint URL. Owns the
 *     capabilities cache and exposes feature-type / stored-query factories.
 *   - `HonuaWfsFeatureType` — bound to a single namespace-qualified type
 *     name. Implements GetFeature / GetPropertyValue / Transaction; routed
 *     from `Source.protocol("wfs")`.
 *   - `HonuaWfsStoredQuery` — bound to a stored-query identifier. Used by
 *     `Source.protocol("wfs").storedQuery(id)`.
 *
 * All wire calls go through `HonuaClient.requestText`, so the existing
 * interceptor / retry / timeout pipeline applies.
 *
 * Canonical translation (KVP and FES emission, GeoJSON ↔ canonical
 * envelope, etc.) lives in `src/contract/source.ts`'s `wfsSource` factory;
 * this module only carries the wire-level surface.
 *
 * @module
 */

import type { HonuaClient } from "./client.js";
import { HonuaHttpError, HonuaWfsExceptionError } from "./errors.js";
import {
  type WfsCapabilitiesSnapshot,
  type WfsTransactionSummary,
  parseListStoredQueriesResponse,
  parseWfsCapabilities,
  parseWfsExceptionReport,
  parseWfsTransactionResponse,
} from "./wfs-capabilities.js";

const DEFAULT_VERSION = "2.0.0";
const SERVICE_PARAM = "WFS";

/** Output formats (lower-cased) the canonical adapter treats as JSON. */
const JSON_OUTPUT_FORMATS = new Set([
  "application/json",
  "application/geo+json",
  "application/vnd.geo+json",
  "json",
  "geojson",
]);

/** Output formats (lower-cased) the canonical adapter treats as GML. */
const GML_OUTPUT_FORMATS = new Set([
  "application/gml+xml; version=3.2",
  "application/gml+xml;version=3.2",
  "application/gml+xml",
  "gml3.2",
  "gml32",
  "text/xml; subtype=gml/3.2",
  "text/xml;subtype=gml/3.2",
  "text/xml; subtype=gml/3.2.1",
  "text/xml;subtype=gml/3.2.1",
]);

/**
 * Negotiated output-format preference for a WFS GetFeature call. `format` is
 * the wire value to send back (the original case the server advertised); the
 * categorical kind is what the canonical surface acts on.
 */
export interface OutputFormatChoice {
  kind: "json" | "gml";
  format: string;
}

/**
 * Construction options for `HonuaWfs`. The adapter is endpoint-bound: one
 * `HonuaWfs` per server URL.
 */
export interface HonuaWfsOptions {
  client: HonuaClient;
  /** Fully qualified or relative WFS endpoint URL (e.g. `/wfs`). */
  endpointUrl: string;
  /** WFS version to request. Default `2.0.0`. */
  version?: string;
}

/**
 * Root WFS handle. Holds the capabilities cache and exposes feature-type /
 * stored-query factories.
 */
export class HonuaWfs {
  public readonly client: HonuaClient;
  public readonly endpointUrl: string;
  public readonly version: string;

  /** Counter exposed for tests / diagnostics: how many times capabilities was fetched. */
  public capabilitiesFetches = 0;

  private capabilitiesPromise: Promise<WfsCapabilitiesSnapshot> | undefined;
  private rawCapabilitiesXml: string | undefined;

  public constructor(options: HonuaWfsOptions) {
    this.client = options.client;
    this.endpointUrl = options.endpointUrl;
    this.version = options.version ?? DEFAULT_VERSION;
  }

  /**
   * Fetch and cache the GetCapabilities document. Subsequent calls reuse the
   * parsed snapshot. Throws `HonuaWfsExceptionError` on `<ows:ExceptionReport>`.
   */
  public capabilities(options?: { signal?: AbortSignal }): Promise<WfsCapabilitiesSnapshot> {
    if (!this.capabilitiesPromise) {
      this.capabilitiesPromise = this.fetchCapabilities(options).catch((err) => {
        // Allow retry after a transient failure.
        this.capabilitiesPromise = undefined;
        throw err;
      });
    }
    return this.capabilitiesPromise;
  }

  /** Discard the cached capabilities snapshot so the next call re-fetches. */
  public refresh(): void {
    this.capabilitiesPromise = undefined;
    this.rawCapabilitiesXml = undefined;
  }

  /** Last raw capabilities XML payload (populated after the first fetch). */
  public rawCapabilities(): string | undefined {
    return this.rawCapabilitiesXml;
  }

  /** Bind a feature-type handle. Does not network. */
  public featureType(typeName: string): HonuaWfsFeatureType {
    return new HonuaWfsFeatureType({ root: this, typeName });
  }

  /**
   * Discover stored queries through the `ListStoredQueries` operation. Returns
   * the bare list of identifier strings; per-query metadata is exposed via
   * `storedQuery(id).describe()`.
   */
  public async storedQueries(options?: { signal?: AbortSignal }): Promise<readonly string[]> {
    const params = new URLSearchParams({
      service: SERVICE_PARAM,
      version: this.version,
      request: "ListStoredQueries",
    });
    const requestOptions: { accept: string; signal?: AbortSignal } = { accept: "application/xml, text/xml" };
    if (options?.signal) requestOptions.signal = options.signal;
    const { text } = await this.requestText("GET", appendQuery(this.endpointUrl, params), requestOptions);
    return parseListStoredQueriesResponse(text);
  }

  public storedQuery(id: string): HonuaWfsStoredQuery {
    return new HonuaWfsStoredQuery({ root: this, id });
  }

  /** Internal helper used by feature-type / stored-query handles. */
  public async requestText(
    method: "GET" | "POST",
    path: string,
    options: { accept: string; contentType?: string; body?: string; signal?: AbortSignal },
  ): Promise<{ text: string; contentType: string; status: number }> {
    try {
      const requestOptions: { accept: string; contentType?: string; body?: string; signal?: AbortSignal } = {
        accept: options.accept,
      };
      if (options.contentType !== undefined) requestOptions.contentType = options.contentType;
      if (options.body !== undefined) requestOptions.body = options.body;
      if (options.signal !== undefined) requestOptions.signal = options.signal;
      return await this.client.requestText(method, path, requestOptions);
    } catch (err) {
      throw rethrowAsWfsExceptionIfPossible(err);
    }
  }

  /** Negotiate an output format for the GetFeature call. */
  public negotiateOutputFormat(snapshot: WfsCapabilitiesSnapshot): OutputFormatChoice | undefined {
    const formats = snapshot.outputFormatsByOp.get("GetFeature") ?? [];
    for (const format of formats) {
      if (JSON_OUTPUT_FORMATS.has(format)) return { kind: "json", format };
    }
    for (const format of formats) {
      if (GML_OUTPUT_FORMATS.has(format)) return { kind: "gml", format };
    }
    if (formats.length === 0) {
      // Honua Server advertises GeoJSON in OperationsMetadata; absence is
      // treated as "JSON unknown" — fall back to GeoJSON optimistically. The
      // first request will surface the actual server behaviour through an
      // ExceptionReport.
      return { kind: "json", format: "application/geo+json" };
    }
    // Server advertises an output format the canonical adapter does not
    // recognise — let the caller decide whether to throw or escape-hatch.
    return { kind: "gml", format: formats[0] };
  }

  private async fetchCapabilities(options?: { signal?: AbortSignal }): Promise<WfsCapabilitiesSnapshot> {
    this.capabilitiesFetches += 1;
    const params = new URLSearchParams({
      service: SERVICE_PARAM,
      version: this.version,
      request: "GetCapabilities",
    });
    const requestOptions: { accept: string; signal?: AbortSignal } = { accept: "application/xml, text/xml" };
    if (options?.signal) requestOptions.signal = options.signal;
    const { text } = await this.requestText("GET", appendQuery(this.endpointUrl, params), requestOptions);
    this.rawCapabilitiesXml = text;
    return parseWfsCapabilities(text);
  }
}

interface HonuaWfsFeatureTypeOptions {
  root: HonuaWfs;
  typeName: string;
}

/**
 * Per-feature-type WFS surface. Implements the wire methods that the
 * canonical `wfsSource` translates onto, and the protocol escape-hatch
 * methods that ship raw XML payloads back to callers.
 */
export class HonuaWfsFeatureType {
  public readonly root: HonuaWfs;
  public readonly typeName: string;

  public constructor(options: HonuaWfsFeatureTypeOptions) {
    this.root = options.root;
    this.typeName = options.typeName;
  }

  /** Convenience: capabilities snapshot from the bound root. */
  public capabilities(options?: { signal?: AbortSignal }): Promise<WfsCapabilitiesSnapshot> {
    return this.root.capabilities(options);
  }

  /**
   * Issue a GetFeature request. Returns parsed JSON when the negotiated
   * output format is JSON; otherwise returns the raw body as a string for
   * downstream callers (the canonical surface throws in that case).
   */
  public async getFeature(params: {
    filter?: string;
    bbox?: string;
    propertyName?: string[];
    sortBy?: string;
    count?: number;
    startIndex?: number;
    resultType?: "results" | "hits";
    srsName?: string;
    outputFormat?: string;
    method?: "GET" | "POST";
    body?: string;
    signal?: AbortSignal;
  }): Promise<
    { kind: "json"; data: unknown; contentType: string } | { kind: "raw"; text: string; contentType: string }
  > {
    const method = params.method ?? "GET";
    const accept = params.outputFormat ?? "application/geo+json, application/json;q=0.9, application/xml;q=0.5";
    const requestOptions: { accept: string; contentType?: string; body?: string; signal?: AbortSignal } = { accept };
    if (params.signal) requestOptions.signal = params.signal;
    let response: { text: string; contentType: string; status: number };
    if (method === "POST" && params.body !== undefined) {
      requestOptions.contentType = "application/xml";
      requestOptions.body = params.body;
      response = await this.root.requestText("POST", this.root.endpointUrl, requestOptions);
    } else {
      const search = new URLSearchParams({
        service: SERVICE_PARAM,
        version: this.root.version,
        request: "GetFeature",
        typeNames: this.typeName,
      });
      if (params.filter !== undefined) search.set("filter", params.filter);
      if (params.bbox !== undefined) search.set("bbox", params.bbox);
      if (params.propertyName && params.propertyName.length > 0) {
        search.set("propertyName", params.propertyName.join(","));
      }
      if (params.sortBy !== undefined) search.set("sortBy", params.sortBy);
      if (typeof params.count === "number") search.set("count", String(params.count));
      if (typeof params.startIndex === "number") search.set("startIndex", String(params.startIndex));
      if (params.resultType !== undefined) search.set("resultType", params.resultType);
      if (params.srsName !== undefined) search.set("srsName", params.srsName);
      if (params.outputFormat !== undefined) search.set("outputFormat", params.outputFormat);
      response = await this.root.requestText("GET", appendQuery(this.root.endpointUrl, search), requestOptions);
    }
    if (looksLikeJson(response.contentType, response.text)) {
      return { kind: "json", data: parseJsonOrThrow(response.text), contentType: response.contentType };
    }
    if (looksLikeXml(response.contentType, response.text) && /ExceptionReport/i.test(response.text)) {
      const report = parseWfsExceptionReport(response.text);
      throw new HonuaWfsExceptionError(report.exceptionCode, report.message, report.locator);
    }
    return { kind: "raw", text: response.text, contentType: response.contentType };
  }

  /**
   * Issue a `GetPropertyValue` request. WFS-specific (returns raw XML), so
   * the canonical surface only reaches it via `protocol("wfs")`.
   */
  public async getPropertyValue(params: {
    valueReference: string;
    filter?: string;
    count?: number;
    startIndex?: number;
    signal?: AbortSignal;
  }): Promise<{ text: string; contentType: string }> {
    const search = new URLSearchParams({
      service: SERVICE_PARAM,
      version: this.root.version,
      request: "GetPropertyValue",
      typeNames: this.typeName,
      valueReference: params.valueReference,
    });
    if (params.filter !== undefined) search.set("filter", params.filter);
    if (typeof params.count === "number") search.set("count", String(params.count));
    if (typeof params.startIndex === "number") search.set("startIndex", String(params.startIndex));
    const requestOptions: { accept: string; signal?: AbortSignal } = { accept: "application/xml, text/xml" };
    if (params.signal) requestOptions.signal = params.signal;
    const { text, contentType } = await this.root.requestText(
      "GET",
      appendQuery(this.root.endpointUrl, search),
      requestOptions,
    );
    return { text, contentType };
  }

  /**
   * Submit a `<wfs:Transaction>` POST body. Returns the parsed transaction
   * summary; throws `HonuaWfsExceptionError` on `<ows:ExceptionReport>`.
   */
  public async transaction(params: { body: string; signal?: AbortSignal }): Promise<WfsTransactionSummary> {
    const requestOptions: { accept: string; contentType: string; body: string; signal?: AbortSignal } = {
      accept: "application/xml, text/xml",
      contentType: "application/xml",
      body: params.body,
    };
    if (params.signal) requestOptions.signal = params.signal;
    const { text } = await this.root.requestText("POST", this.root.endpointUrl, requestOptions);
    return parseWfsTransactionResponse(text);
  }

  /** Build (but do not send) the URL the GET GetFeature request would use. */
  public buildGetFeatureUrl(params: {
    filter?: string;
    bbox?: string;
    count?: number;
    startIndex?: number;
    outputFormat?: string;
  }): string {
    const search = new URLSearchParams({
      service: SERVICE_PARAM,
      version: this.root.version,
      request: "GetFeature",
      typeNames: this.typeName,
    });
    if (params.filter !== undefined) search.set("filter", params.filter);
    if (params.bbox !== undefined) search.set("bbox", params.bbox);
    if (typeof params.count === "number") search.set("count", String(params.count));
    if (typeof params.startIndex === "number") search.set("startIndex", String(params.startIndex));
    if (params.outputFormat !== undefined) search.set("outputFormat", params.outputFormat);
    return appendQuery(this.root.endpointUrl, search);
  }
}

interface HonuaWfsStoredQueryOptions {
  root: HonuaWfs;
  id: string;
}

/**
 * Bound stored-query handle. `execute(params)` runs `GetFeature?storedquery_id=…`.
 */
export class HonuaWfsStoredQuery {
  public readonly root: HonuaWfs;
  public readonly id: string;

  public constructor(options: HonuaWfsStoredQueryOptions) {
    this.root = options.root;
    this.id = options.id;
  }

  /** Run `DescribeStoredQueries` for this stored query. Returns the raw XML. */
  public async describe(options?: { signal?: AbortSignal }): Promise<{ text: string; contentType: string }> {
    const search = new URLSearchParams({
      service: SERVICE_PARAM,
      version: this.root.version,
      request: "DescribeStoredQueries",
      storedQuery_Id: this.id,
    });
    const requestOptions: { accept: string; signal?: AbortSignal } = { accept: "application/xml, text/xml" };
    if (options?.signal) requestOptions.signal = options.signal;
    const { text, contentType } = await this.root.requestText(
      "GET",
      appendQuery(this.root.endpointUrl, search),
      requestOptions,
    );
    return { text, contentType };
  }

  /**
   * Execute the stored query against `GetFeature`. Caller passes the
   * stored-query parameter map; values are coerced to strings via
   * `String(value)`. Returns parsed JSON when the server replies with a
   * JSON output format, raw text otherwise.
   */
  public async execute(params: {
    parameters?: Record<string, string | number | boolean>;
    outputFormat?: string;
    count?: number;
    startIndex?: number;
    signal?: AbortSignal;
  }): Promise<
    { kind: "json"; data: unknown; contentType: string } | { kind: "raw"; text: string; contentType: string }
  > {
    const search = new URLSearchParams({
      service: SERVICE_PARAM,
      version: this.root.version,
      request: "GetFeature",
      storedquery_id: this.id,
    });
    if (typeof params.count === "number") search.set("count", String(params.count));
    if (typeof params.startIndex === "number") search.set("startIndex", String(params.startIndex));
    if (params.outputFormat !== undefined) search.set("outputFormat", params.outputFormat);
    if (params.parameters) {
      for (const [key, value] of Object.entries(params.parameters)) {
        search.set(key, String(value));
      }
    }
    const accept = params.outputFormat ?? "application/geo+json, application/json;q=0.9, application/xml;q=0.5";
    const requestOptions: { accept: string; signal?: AbortSignal } = { accept };
    if (params.signal) requestOptions.signal = params.signal;
    const { text, contentType } = await this.root.requestText(
      "GET",
      appendQuery(this.root.endpointUrl, search),
      requestOptions,
    );
    if (looksLikeJson(contentType, text)) {
      return { kind: "json", data: parseJsonOrThrow(text), contentType };
    }
    if (looksLikeXml(contentType, text) && /ExceptionReport/i.test(text)) {
      const report = parseWfsExceptionReport(text);
      throw new HonuaWfsExceptionError(report.exceptionCode, report.message, report.locator);
    }
    return { kind: "raw", text, contentType };
  }
}

// ── Helpers ───────────────────────────────────────────────────

export function appendQuery(url: string, params: URLSearchParams): string {
  // Preserve any pre-existing query string on the endpoint URL (some servers
  // sit behind URL signatures that include their own params).
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}${params.toString()}`;
}

export function looksLikeJson(contentType: string | undefined, text: string): boolean {
  if (contentType && /json/i.test(contentType)) return true;
  const trimmed = text.trimStart();
  return trimmed.startsWith("{") || trimmed.startsWith("[");
}

export function looksLikeXml(contentType: string | undefined, text: string): boolean {
  if (contentType && /xml/i.test(contentType)) return true;
  return text.trimStart().startsWith("<");
}

function parseJsonOrThrow(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`WFS GetFeature returned non-JSON output despite Accept negotiation: ${message}`);
  }
}

/**
 * If the underlying client failure carries a WFS ExceptionReport in its
 * body, re-throw as `HonuaWfsExceptionError`; otherwise leave the original
 * error in place. The body is wrapped by `parseResponseBody` as
 * `{ raw: text, contentType? }` for non-JSON responses.
 */
export function rethrowAsWfsExceptionIfPossible(err: unknown): unknown {
  if (!(err instanceof HonuaHttpError)) return err;
  const body = err.body as { raw?: unknown } | undefined;
  if (!body || typeof body !== "object" || typeof (body as { raw?: unknown }).raw !== "string") return err;
  const raw = (body as { raw: string }).raw;
  if (!/ExceptionReport/i.test(raw)) return err;
  try {
    const report = parseWfsExceptionReport(raw);
    return new HonuaWfsExceptionError(report.exceptionCode, report.message, report.locator);
  } catch {
    return err;
  }
}
