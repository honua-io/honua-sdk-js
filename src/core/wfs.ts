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
import { HonuaAbortError, HonuaHttpError, HonuaWfsExceptionError } from "./errors.js";
import {
  type WfsCapabilitiesSnapshot,
  type WfsTransactionSummary,
  parseListStoredQueriesResponse,
  parseWfsCapabilities,
  parseWfsDescribeFeatureTypeGeometry,
  parseWfsExceptionReport,
  parseWfsTransactionResponse,
} from "./wfs-capabilities.js";
import { HonuaWfsProtocolError } from "./wfs-protocol-error.js";

const DEFAULT_VERSION = "2.0.0";
const SERVICE_PARAM = "WFS";
const WFS_METADATA_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const WFS_FEATURE_MAX_RESPONSE_BYTES = 32 * 1024 * 1024;

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

interface CapabilitiesFlight {
  readonly generation: number;
  readonly identity: object;
  readonly controller: AbortController;
  readonly promise: Promise<WfsCapabilitiesSnapshot>;
  subscribers: number;
  settled: boolean;
}

interface CapabilitiesState {
  generation: number;
  flight?: CapabilitiesFlight;
}

const CAPABILITIES_STATES = new WeakMap<HonuaWfs, CapabilitiesState>();

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

  private rawCapabilitiesXml: string | undefined;
  private resolvedSnapshot: WfsCapabilitiesSnapshot | undefined;
  /** Resolved geometry property per feature type; shares the metadata cache lifecycle. */
  private readonly geometryPropertyNames = new Map<string, string>();

  public constructor(options: HonuaWfsOptions) {
    this.client = options.client;
    this.endpointUrl = options.endpointUrl;
    this.version = options.version ?? DEFAULT_VERSION;
    CAPABILITIES_STATES.set(this, { generation: 0 });
  }

  /**
   * Fetch and cache the GetCapabilities document. Subsequent calls reuse the
   * parsed snapshot. Throws `HonuaWfsExceptionError` on `<ows:ExceptionReport>`.
   */
  public async capabilities(options?: { signal?: AbortSignal }): Promise<WfsCapabilitiesSnapshot> {
    if (options?.signal?.aborted) throw new HonuaAbortError();
    if (this.resolvedSnapshot) return this.resolvedSnapshot;

    const state = capabilitiesState(this);
    const generation = state.generation;
    let flight = state.flight;
    if (!flight || flight.generation !== generation) {
      const identity = {};
      const controller = new AbortController();
      const promise = this.fetchCapabilities({ signal: controller.signal }).then((fetched) => {
        // A refresh advances the generation. An older response may still
        // settle after a transport ignores abort, but it must never repopulate
        // the cache or become evidence for the new generation.
        if (state.generation === generation && state.flight?.identity === identity) {
          this.rawCapabilitiesXml = fetched.xml;
          this.resolvedSnapshot = fetched.snapshot;
        }
        return fetched.snapshot;
      });
      const nextFlight: CapabilitiesFlight = {
        generation,
        identity,
        controller,
        promise,
        subscribers: 0,
        settled: false,
      };
      flight = nextFlight;
      state.flight = nextFlight;
      void promise.then(
        () => {
          nextFlight.settled = true;
          if (state.flight === nextFlight) state.flight = undefined;
        },
        () => {
          nextFlight.settled = true;
          if (state.flight === nextFlight) state.flight = undefined;
        },
      );
    }
    return subscribeCapabilitiesFlight(state, flight, options?.signal);
  }

  /** Discard the cached capabilities snapshot so the next call re-fetches. */
  public refresh(): void {
    const state = capabilitiesState(this);
    state.generation += 1;
    const staleFlight = state.flight;
    state.flight = undefined;
    this.rawCapabilitiesXml = undefined;
    this.resolvedSnapshot = undefined;
    this.geometryPropertyNames.clear();
    if (staleFlight && !staleFlight.settled) staleFlight.controller.abort();
  }

  /**
   * Fetch the `DescribeFeatureType` XSD for one feature type. Returned raw so
   * `Source.protocol("wfs")` callers can read schema detail the canonical
   * surface does not model.
   */
  public async describeFeatureType(
    typeName: string,
    options?: { signal?: AbortSignal },
  ): Promise<{ text: string; contentType: string }> {
    const params = new URLSearchParams({
      service: SERVICE_PARAM,
      version: this.version,
      request: "DescribeFeatureType",
      typeNames: typeName,
    });
    const requestOptions: { accept: string; signal?: AbortSignal; maxResponseBytes: number } = {
      accept: "application/xml, text/xml",
      maxResponseBytes: WFS_METADATA_MAX_RESPONSE_BYTES,
    };
    if (options?.signal) requestOptions.signal = options.signal;
    const { text, contentType } = await this.requestText(
      "GET",
      appendQuery(this.operationUrl("DescribeFeatureType", "GET"), params),
      requestOptions,
    );
    return { text, contentType };
  }

  /**
   * Resolve the geometry property name of one feature type from its
   * `DescribeFeatureType` schema, caching the result alongside the
   * capabilities snapshot. Fails closed with
   * `HonuaWfsProtocolError("unresolved-geometry-property")` rather than
   * assuming a vendor default: `the_geom` is only the PostGIS-via-GeoServer
   * convention, MapServer serves `msGeometry`, and other servers use
   * per-schema names, so guessing silently matches nothing.
   *
   * Feature types that declare several geometry properties resolve to the
   * first declared one (the server's default geometry); pin a different one
   * with `locator.geometryName`.
   */
  public async geometryPropertyName(typeName: string, options?: { signal?: AbortSignal }): Promise<string> {
    const cached = this.geometryPropertyNames.get(typeName);
    if (cached !== undefined) return cached;
    let candidates: readonly string[];
    try {
      const { text } = await this.describeFeatureType(typeName, options);
      candidates = parseWfsDescribeFeatureTypeGeometry(text, typeName);
    } catch (error) {
      if (error instanceof HonuaAbortError) throw error;
      throw new HonuaWfsProtocolError(
        "unresolved-geometry-property",
        `WFS DescribeFeatureType could not resolve the geometry property of feature type "${typeName}"; set locator.geometryName to name it explicitly`,
        { cause: error },
      );
    }
    const resolved = candidates[0];
    if (resolved === undefined) {
      throw new HonuaWfsProtocolError(
        "unresolved-geometry-property",
        `WFS DescribeFeatureType declares no geometry property for feature type "${typeName}"; set locator.geometryName to name it explicitly`,
      );
    }
    this.geometryPropertyNames.set(typeName, resolved);
    return resolved;
  }

  /**
   * Resolve the concrete request URL for a WFS operation, honouring the
   * DCP `xlink:href` a raw server advertises in GetCapabilities (e.g.
   * GeoServer mounted at `/geoserver/ows` that advertises its operation
   * URL at `/geoserver/wfs`). Falls back to the configured endpoint URL
   * when capabilities have not been resolved yet or the server omits the
   * DCP href. This peeks at the already-resolved snapshot synchronously,
   * so it never forces an extra GetCapabilities round-trip: the canonical
   * WFS query path resolves capabilities for output-format negotiation
   * before issuing GetFeature.
   */
  public operationUrl(operation: string, method: "GET" | "POST"): string {
    const op = this.resolvedSnapshot?.operations.get(operation);
    const url = method === "GET" ? op?.getUrl : op?.postUrl;
    return url ?? this.endpointUrl;
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
    const requestOptions: { accept: string; signal?: AbortSignal; maxResponseBytes: number } = {
      accept: "application/xml, text/xml",
      maxResponseBytes: WFS_METADATA_MAX_RESPONSE_BYTES,
    };
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
    options: {
      accept: string;
      contentType?: string;
      body?: string;
      signal?: AbortSignal;
      maxResponseBytes?: number;
    },
  ): Promise<{ text: string; contentType: string; status: number }> {
    try {
      const requestOptions: {
        accept: string;
        contentType?: string;
        body?: string;
        signal?: AbortSignal;
        maxResponseBytes: number;
      } = {
        accept: options.accept,
        maxResponseBytes: options.maxResponseBytes ?? WFS_METADATA_MAX_RESPONSE_BYTES,
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
      if (JSON_OUTPUT_FORMATS.has(format.toLowerCase())) return { kind: "json", format };
    }
    for (const format of formats) {
      if (GML_OUTPUT_FORMATS.has(format.toLowerCase())) return { kind: "gml", format };
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

  private async fetchCapabilities(options?: { signal?: AbortSignal }): Promise<{
    snapshot: WfsCapabilitiesSnapshot;
    xml: string;
  }> {
    this.capabilitiesFetches += 1;
    const params = new URLSearchParams({
      service: SERVICE_PARAM,
      version: this.version,
      request: "GetCapabilities",
    });
    const requestOptions: { accept: string; signal?: AbortSignal; maxResponseBytes: number } = {
      accept: "application/xml, text/xml",
      maxResponseBytes: WFS_METADATA_MAX_RESPONSE_BYTES,
    };
    if (options?.signal) requestOptions.signal = options.signal;
    const { text } = await this.requestText("GET", appendQuery(this.endpointUrl, params), requestOptions);
    const snapshot = canonicalizeOperationUrls(parseWfsCapabilities(text), this.endpointUrl, this.client.serverBaseUrl);
    return { snapshot, xml: text };
  }
}

function capabilitiesState(root: HonuaWfs): CapabilitiesState {
  const state = CAPABILITIES_STATES.get(root);
  if (!state) throw new TypeError("WFS capabilities state is unavailable");
  return state;
}

function subscribeCapabilitiesFlight(
  state: CapabilitiesState,
  flight: CapabilitiesFlight,
  signal: AbortSignal | undefined,
): Promise<WfsCapabilitiesSnapshot> {
  flight.subscribers += 1;
  return new Promise<WfsCapabilitiesSnapshot>((resolve, reject) => {
    let finished = false;
    const finish = () => {
      if (finished) return false;
      finished = true;
      signal?.removeEventListener("abort", onCallerAbort);
      flight.controller.signal.removeEventListener("abort", onGenerationAbort);
      flight.subscribers -= 1;
      return true;
    };
    const abortOrphanedFlight = () => {
      if (flight.settled || flight.subscribers !== 0 || flight.controller.signal.aborted) return;
      if (state.flight === flight) state.flight = undefined;
      flight.controller.abort();
    };
    const onCallerAbort = () => {
      if (!finish()) return;
      reject(new HonuaAbortError());
      abortOrphanedFlight();
    };
    const onGenerationAbort = () => {
      if (!finish()) return;
      reject(new HonuaAbortError("WFS capabilities discovery was invalidated"));
    };

    signal?.addEventListener("abort", onCallerAbort, { once: true });
    flight.controller.signal.addEventListener("abort", onGenerationAbort, { once: true });
    if (signal?.aborted) onCallerAbort();
    else if (flight.controller.signal.aborted) onGenerationAbort();
    flight.promise.then(
      (snapshot) => {
        if (!finish()) return;
        resolve(snapshot);
      },
      (error: unknown) => {
        if (!finish()) return;
        reject(error);
      },
    );
  });
}

function canonicalizeOperationUrls(
  snapshot: WfsCapabilitiesSnapshot,
  endpointUrl: string,
  clientBaseUrl: string,
): WfsCapabilitiesSnapshot {
  const capabilitiesEndpoint = new URL(endpointUrl, clientBaseUrl);
  const operations = new Map(
    [...snapshot.operations].map(([name, operation]) => [
      name,
      Object.freeze({
        ...operation,
        ...(operation.getUrl ? { getUrl: new URL(operation.getUrl, capabilitiesEndpoint).toString() } : {}),
        ...(operation.postUrl ? { postUrl: new URL(operation.postUrl, capabilitiesEndpoint).toString() } : {}),
      }),
    ]),
  );
  return Object.freeze({
    ...snapshot,
    operations: immutableWfsMap(operations),
  });
}

function immutableWfsMap<K, V>(source: ReadonlyMap<K, V>): ReadonlyMap<K, V> {
  const owned = new Map(source);
  const view: ReadonlyMap<K, V> = {
    get size(): number {
      return owned.size;
    },
    get(key: K): V | undefined {
      return owned.get(key);
    },
    has(key: K): boolean {
      return owned.has(key);
    },
    forEach(callbackfn: (value: V, key: K, map: ReadonlyMap<K, V>) => void, thisArg?: unknown): void {
      for (const [key, value] of owned) callbackfn.call(thisArg, value, key, view);
    },
    entries(): MapIterator<[K, V]> {
      return owned.entries();
    },
    keys(): MapIterator<K> {
      return owned.keys();
    },
    values(): MapIterator<V> {
      return owned.values();
    },
    [Symbol.iterator](): MapIterator<[K, V]> {
      return owned[Symbol.iterator]();
    },
  };
  return Object.freeze(view);
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

  /** Raw `DescribeFeatureType` XSD for the bound type name. */
  public describeFeatureType(options?: { signal?: AbortSignal }): Promise<{ text: string; contentType: string }> {
    return this.root.describeFeatureType(this.typeName, options);
  }

  /**
   * Geometry property name of the bound feature type, resolved from
   * `DescribeFeatureType` and cached on the root. Fails closed when the schema
   * does not name one — see {@link HonuaWfs.geometryPropertyName}.
   */
  public geometryPropertyName(options?: { signal?: AbortSignal }): Promise<string> {
    return this.root.geometryPropertyName(this.typeName, options);
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
    namespace?: { readonly prefix: string; readonly uri: string };
    signal?: AbortSignal;
  }): Promise<
    { kind: "json"; data: unknown; contentType: string } | { kind: "raw"; text: string; contentType: string }
  > {
    const method = params.method ?? "GET";
    const accept = params.outputFormat ?? "application/geo+json, application/json;q=0.9, application/xml;q=0.5";
    const requestOptions: {
      accept: string;
      contentType?: string;
      body?: string;
      signal?: AbortSignal;
      maxResponseBytes: number;
    } = {
      accept,
      maxResponseBytes: WFS_FEATURE_MAX_RESPONSE_BYTES,
    };
    if (params.signal) requestOptions.signal = params.signal;
    let response: { text: string; contentType: string; status: number };
    if (method === "POST" && params.body !== undefined) {
      requestOptions.contentType = "application/xml";
      requestOptions.body = params.body;
      response = await this.root.requestText("POST", this.root.operationUrl("GetFeature", "POST"), requestOptions);
    } else {
      const search = new URLSearchParams({
        service: SERVICE_PARAM,
        version: this.root.version,
        request: "GetFeature",
        typeNames: this.typeName,
      });
      if (params.namespace !== undefined) {
        search.set("NAMESPACES", `xmlns(${params.namespace.prefix},${params.namespace.uri})`);
      }
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
      response = await this.root.requestText(
        "GET",
        appendQuery(this.root.operationUrl("GetFeature", "GET"), search),
        requestOptions,
      );
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
    const requestOptions: { accept: string; signal?: AbortSignal; maxResponseBytes: number } = {
      accept: "application/xml, text/xml",
      maxResponseBytes: WFS_FEATURE_MAX_RESPONSE_BYTES,
    };
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
    const { text } = await this.root.requestText("POST", this.root.operationUrl("Transaction", "POST"), requestOptions);
    return parseWfsTransactionResponse(text);
  }

  /** Build (but do not send) the URL the GET GetFeature request would use. */
  public buildGetFeatureUrl(params: {
    filter?: string;
    bbox?: string;
    count?: number;
    startIndex?: number;
    outputFormat?: string;
    namespace?: { readonly prefix: string; readonly uri: string };
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
    if (params.namespace !== undefined) {
      search.set("NAMESPACES", `xmlns(${params.namespace.prefix},${params.namespace.uri})`);
    }
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
    const requestOptions: { accept: string; signal?: AbortSignal; maxResponseBytes: number } = {
      accept,
      maxResponseBytes: WFS_FEATURE_MAX_RESPONSE_BYTES,
    };
    if (params.signal) requestOptions.signal = params.signal;
    const { text, contentType } = await this.root.requestText(
      "GET",
      appendQuery(this.root.operationUrl("GetFeature", "GET"), search),
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
