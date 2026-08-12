/**
 * Plans bounded columnar query workflows and decodes the supported Honua Arrow
 * response subset into normative SDK batches.
 *
 * @experimental Not yet covered by the SDK's semver contract; this entrypoint
 *   may change in any minor release prior to `1.0.0`.
 * @packageDocumentation
 */

import type {
  ColumnarBatchIdentityV1,
  ColumnarBatchMetrics,
  ColumnarBatchV1,
  DecodedGeoArrowRow,
  LoadApacheArrowOptions,
} from "../columnar/index.js";
import * as Columnar from "../columnar/index.js";
import { type QueryFilterExpression, compileQueryFilterToSql92 } from "../contract/query-filter.js";
import { HonuaClient } from "../core/client.js";
import { encodeServiceIdPath } from "../core/path-utils.js";
import { envelope } from "../core/spatial-filter.js";
import type { HonuaClientOptions } from "../core/types.js";
import * as GeoParquet from "../geoparquet/index.js";
import {
  HonuaArrowWkbError,
  type HonuaArrowWkbMappingOptions,
  decodeHonuaArrowWkbRecordBatch,
  hasHonuaArrowWkbGeometry,
} from "./honua-arrow-wkb.js";

export type ColumnarWorkflowFormat = "arrow" | "parquet";
export type ColumnarWorkflowExecution = "browser-bounded" | "server-pushdown";

export interface DirectGeoParquetColumnarSource {
  readonly kind: "direct-geoparquet";
  readonly id: string;
  readonly url: string;
  readonly sourceVersion: string;
  readonly schemaVersion: string;
  readonly authorizationScope: string;
  readonly geometryColumn?: string;
}

export interface HonuaColumnarQuerySource {
  readonly kind: "honua-feature-query";
  readonly id: string;
  readonly baseUrl: string;
  readonly serviceId: string;
  readonly layerId: number;
  readonly format: ColumnarWorkflowFormat;
  readonly sourceVersion: string;
  readonly schemaVersion: string;
  readonly authorizationScope: string;
}

export type ColumnarWorkflowSource = DirectGeoParquetColumnarSource | HonuaColumnarQuerySource;

export interface ColumnarWorkflowAggregation {
  readonly name: string;
  readonly operation: "count" | "sum" | "min" | "max" | "avg";
  readonly field?: string;
}

export interface ColumnarWorkflowOrderBy {
  readonly field: string;
  readonly direction: "asc" | "desc";
}

export interface ColumnarWorkflowQuery {
  readonly columns?: readonly string[];
  readonly filter?: QueryFilterExpression;
  readonly bbox?: readonly [number, number, number, number];
  readonly limit: number;
  readonly offset?: number;
  readonly orderBy?: readonly ColumnarWorkflowOrderBy[];
  readonly aggregations?: readonly ColumnarWorkflowAggregation[];
  readonly returnGeometry?: boolean;
  readonly preferPost?: boolean;
  readonly signal?: AbortSignal;
}

export interface ColumnarWorkflowBudgets {
  readonly maxRows: number;
  readonly maxBatches: number;
  readonly maxTransferBytes: number;
  readonly maxBackingBytes: number;
}

export interface ColumnarWorkflowRequest {
  readonly method: "GET" | "POST";
  readonly path: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string;
  readonly format: ColumnarWorkflowFormat;
}

export interface ColumnarWorkflowPlan {
  readonly sourceId: string;
  readonly execution: ColumnarWorkflowExecution;
  readonly format: ColumnarWorkflowFormat;
  readonly pushdown: readonly string[];
  readonly browser: readonly string[];
  readonly boundedBy: ColumnarWorkflowBudgets;
  readonly request?: ColumnarWorkflowRequest;
}

export interface ColumnarWorkflowDescription {
  readonly sourceId: string;
  readonly execution: ColumnarWorkflowExecution;
  readonly format: ColumnarWorkflowFormat;
  readonly schema?: unknown;
  readonly geometryEncoding?: string;
  readonly crs?: unknown;
  readonly bbox?: readonly number[];
  readonly rowEstimate?: number;
  readonly rowGroupCount?: number;
  readonly raw?: unknown;
}

export interface ColumnarWorkflowEvidence {
  readonly sourceId: string;
  readonly execution: ColumnarWorkflowExecution;
  readonly rows: number;
  readonly batches: number;
  readonly transferBytes: number;
  readonly elapsedMs: number;
  readonly peakBackingBytes: number;
  readonly ceilings: ColumnarWorkflowBudgets;
}

export interface ColumnarWorkflowBatch {
  readonly batch: ColumnarBatchV1;
  readonly metrics: ColumnarBatchMetrics;
  readonly evidence: ColumnarWorkflowEvidence;
}

export interface ColumnarResponseDecoderContext {
  readonly source: HonuaColumnarQuerySource;
  readonly query: ColumnarWorkflowQuery;
  readonly response: Response;
  readonly signal?: AbortSignal;
  readonly budgets: ColumnarWorkflowBudgets;
  readonly identity: Pick<
    ColumnarBatchIdentityV1,
    "sourceId" | "sourceVersion" | "schemaVersion" | "authorizationScope"
  >;
}

export type ColumnarResponseDecoder = (context: ColumnarResponseDecoderContext) => AsyncIterable<ColumnarBatchV1>;

/** Mapping hints for the bounded Honua Server geoarrow.wkb response bridge. */
export interface ApacheArrowResponseDecoderOptions extends HonuaArrowWkbMappingOptions, LoadApacheArrowOptions {}

export interface DirectGeoParquetHandle {
  /**
   * Exact HTTP payload bytes admitted by the opener. They are charged only to
   * the session operation that initiated this cached handle.
   */
  readonly transferBytes?: number;
  describe(signal?: AbortSignal): Promise<unknown> | unknown;
  queryColumnar(query: unknown): Promise<ColumnarBatchV1> | ColumnarBatchV1;
  close?(): Promise<void> | void;
}

export type DirectGeoParquetOpener = (
  source: DirectGeoParquetColumnarSource,
  signal?: AbortSignal,
) => Promise<DirectGeoParquetHandle> | DirectGeoParquetHandle;

export interface ColumnarWorkflowProgress {
  readonly phase: "inspect" | "request" | "decode" | "batch" | "complete";
  readonly evidence?: ColumnarWorkflowEvidence;
}

export interface ColumnarWorkflowOptions {
  readonly clientOptions?: Omit<HonuaClientOptions, "baseUrl">;
  readonly budgets?: Partial<ColumnarWorkflowBudgets>;
  readonly decodeServerResponse?: ColumnarResponseDecoder;
  readonly openDirectGeoParquet?: DirectGeoParquetOpener;
  /** Fetch implementation used by the default bounded direct-GeoParquet opener. */
  readonly directFetchFn?: typeof fetch;
  readonly inspectBatch?: (
    batch: ColumnarBatchV1,
    limits: Pick<ColumnarWorkflowBudgets, "maxRows" | "maxBackingBytes">,
  ) => ColumnarBatchMetrics;
  readonly beforeRequest?: (
    request: ColumnarWorkflowRequest,
  ) => Promise<ColumnarWorkflowRequest | void> | ColumnarWorkflowRequest | void;
  readonly onProgress?: (progress: ColumnarWorkflowProgress) => void;
  readonly now?: () => number;
}

export type ColumnarWorkflowErrorCode =
  | "ABORTED"
  | "INVALID_QUERY"
  | "ROW_LIMIT_EXCEEDED"
  | "BATCH_LIMIT_EXCEEDED"
  | "TRANSFER_LIMIT_EXCEEDED"
  | "BACKING_LIMIT_EXCEEDED"
  | "INVALID_RESPONSE"
  | "DECODER_REQUIRED"
  | "BROWSER_AGGREGATION_REQUIRED"
  | "UNSUPPORTED_HANDOFF"
  | "REQUEST_FAILED";

export class ColumnarWorkflowError extends Error {
  readonly code: ColumnarWorkflowErrorCode;
  readonly details?: Readonly<Record<string, unknown>>;

  constructor(
    code: ColumnarWorkflowErrorCode,
    message: string,
    details?: Readonly<Record<string, unknown>>,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ColumnarWorkflowError";
    this.code = code;
    this.details = details;
  }
}

export interface ColumnarTableHandoff {
  readonly kind: "table";
  readonly rows: readonly DecodedGeoArrowRow[];
  readonly truncated: boolean;
}

export interface ColumnarWorkerHandoff {
  readonly kind: "worker";
  readonly batch: ColumnarBatchV1;
  readonly transfer: readonly ArrayBuffer[];
  /** Application-owned key registered with startColumnarWorkerHost(). */
  readonly operation: string;
}

export interface ColumnarRenderHandoff {
  readonly kind: "deck.gl";
  readonly geometry: "point" | "line" | "polygon";
  readonly batch: ColumnarBatchV1;
  readonly zeroCopyPreferred: true;
}

export interface ColumnarDownloadHandoff {
  readonly kind: "download";
  readonly request: ColumnarWorkflowRequest;
  readonly suggestedFileName: string;
}

export interface ColumnarWorkflowSession {
  inspect(signal?: AbortSignal): Promise<ColumnarWorkflowDescription>;
  plan(query: ColumnarWorkflowQuery): ColumnarWorkflowPlan;
  stream(query: ColumnarWorkflowQuery): AsyncIterable<ColumnarWorkflowBatch>;
  table(batch: ColumnarBatchV1, maxRows: number): ColumnarTableHandoff;
  worker(batch: ColumnarBatchV1, operation?: string): ColumnarWorkerHandoff;
  render(batch: ColumnarBatchV1, geometry: "point" | "line" | "polygon"): ColumnarRenderHandoff;
  download(query: ColumnarWorkflowQuery): ColumnarDownloadHandoff;
  dispose(): Promise<void>;
}

const DEFAULT_BUDGETS: ColumnarWorkflowBudgets = Object.freeze({
  maxRows: 100_000,
  maxBatches: 128,
  maxTransferBytes: 64 * 1024 * 1024,
  maxBackingBytes: 64 * 1024 * 1024,
});

const resolveBudgets = (overrides?: Partial<ColumnarWorkflowBudgets>): ColumnarWorkflowBudgets => {
  const budgets = { ...DEFAULT_BUDGETS, ...overrides };
  for (const name of Object.keys(DEFAULT_BUDGETS) as Array<keyof ColumnarWorkflowBudgets>) {
    if (!Number.isSafeInteger(budgets[name]) || budgets[name] <= 0) {
      throw new ColumnarWorkflowError("INVALID_QUERY", `${name} must be a positive safe integer.`);
    }
  }
  return Object.freeze(budgets);
};

const metricNumber = (metrics: ColumnarBatchMetrics, names: readonly string[]): number => {
  const value = metrics as unknown as Record<string, unknown>;
  for (const name of names) {
    if (typeof value[name] === "number" && Number.isFinite(value[name])) return value[name] as number;
  }
  return 0;
};

const throwIfAborted = (signal?: AbortSignal): void => {
  if (signal?.aborted) {
    throw new ColumnarWorkflowError("ABORTED", "Columnar workflow was aborted.", undefined, {
      cause: signal.reason,
    });
  }
};

const containsWidenedSpatialFilter = (filter: QueryFilterExpression): boolean => {
  if (filter.kind === "spatial") return filter.geometry.geometryType !== "esriGeometryEnvelope";
  if (filter.kind === "boolean") return filter.args.some(containsWidenedSpatialFilter);
  if (filter.kind === "not") return containsWidenedSpatialFilter(filter.arg);
  return false;
};

const validateQuery = (
  source: ColumnarWorkflowSource,
  query: ColumnarWorkflowQuery,
  budgets: ColumnarWorkflowBudgets,
): void => {
  if (!Number.isSafeInteger(query.limit) || query.limit <= 0) {
    throw new ColumnarWorkflowError("INVALID_QUERY", "limit must be a positive safe integer.");
  }
  if (query.limit > budgets.maxRows) {
    throw new ColumnarWorkflowError(
      "ROW_LIMIT_EXCEEDED",
      `Requested ${query.limit} rows exceeds the ${budgets.maxRows} row ceiling.`,
    );
  }
  if (
    query.bbox &&
    (query.bbox.length !== 4 ||
      query.bbox.some((coordinate) => !Number.isFinite(coordinate)) ||
      query.bbox[0] > query.bbox[2] ||
      query.bbox[1] > query.bbox[3])
  ) {
    throw new ColumnarWorkflowError(
      "INVALID_QUERY",
      "bbox must contain finite, ordered xmin/ymin/xmax/ymax coordinates.",
    );
  }
  if (query.offset !== undefined && (!Number.isSafeInteger(query.offset) || query.offset < 0)) {
    throw new ColumnarWorkflowError("INVALID_QUERY", "offset must be a non-negative safe integer.");
  }
  if (query.returnGeometry === false) {
    throw new ColumnarWorkflowError(
      "INVALID_QUERY",
      "returnGeometry: false is not supported because bounded columnar batches require one geometry field.",
    );
  }
  if (source.kind === "direct-geoparquet" && query.columns?.length) {
    throw new ColumnarWorkflowError(
      "INVALID_QUERY",
      "Direct GeoParquet column projection is not supported by the bounded workflow.",
    );
  }
  if (source.kind === "direct-geoparquet" && query.filter && containsWidenedSpatialFilter(query.filter)) {
    throw new ColumnarWorkflowError(
      "INVALID_QUERY",
      "Direct GeoParquet spatial filter expressions must use an envelope so execution cannot widen the geometry.",
    );
  }
  for (const aggregation of query.aggregations ?? []) {
    if (typeof aggregation.field !== "string" || aggregation.field.trim().length === 0) {
      throw new ColumnarWorkflowError(
        "INVALID_QUERY",
        `Aggregation "${aggregation.name}" requires a non-empty source field.`,
      );
    }
  }
};

const WGS84_BBOX_CRS = new Set([
  "epsg:4326",
  "crs:84",
  "crs84",
  "ogc:crs84",
  "wgs 84",
  "urn:ogc:def:crs:ogc:1.3:crs84",
  "urn:ogc:def:crs:ogc::crs84",
  "urn:ogc:def:crs:epsg::4326",
  "http://www.opengis.net/def/crs/ogc/1.3/crs84",
  "http://www.opengis.net/def/crs/epsg/0/4326",
]);

const supportsWgs84Bbox = (crs: unknown): boolean =>
  typeof crs === "string" && WGS84_BBOX_CRS.has(crs.trim().toLowerCase());

const buildServerRequest = (
  source: HonuaColumnarQuerySource,
  query: ColumnarWorkflowQuery,
): ColumnarWorkflowRequest => {
  const parameters = new URLSearchParams();
  parameters.set("f", source.format);
  parameters.set("resultRecordCount", String(query.limit));
  if (query.offset !== undefined) parameters.set("resultOffset", String(query.offset));
  parameters.set("outFields", query.columns?.length ? query.columns.join(",") : "*");
  parameters.set("where", "1=1");
  if (query.filter) {
    const compiled = compileQueryFilterToSql92(query.filter, {
      protocol: "geoservices-feature-service",
      sourceId: source.id,
    });
    if (compiled.spatialFilter) {
      throw new ColumnarWorkflowError(
        "INVALID_QUERY",
        "Spatial filter expressions must use the explicit bbox query field for columnar server requests.",
      );
    }
    parameters.set("where", compiled.where ?? "1=1");
  }
  if (query.bbox) {
    parameters.set("geometry", query.bbox.join(","));
    parameters.set("geometryType", "esriGeometryEnvelope");
    parameters.set("spatialRel", "esriSpatialRelIntersects");
    parameters.set("inSR", "4326");
  }
  if (query.orderBy?.length) {
    parameters.set(
      "orderByFields",
      query.orderBy.map((order) => `${order.field} ${order.direction.toUpperCase()}`).join(","),
    );
  }
  if (query.aggregations?.length) {
    parameters.set(
      "outStatistics",
      JSON.stringify(
        query.aggregations.map((aggregation) => ({
          statisticType: aggregation.operation,
          onStatisticField: aggregation.field,
          outStatisticFieldName: aggregation.name,
        })),
      ),
    );
  }
  parameters.set("returnGeometry", String(query.returnGeometry ?? true));

  const path = `/rest/services/${encodeServiceIdPath(source.serviceId)}/FeatureServer/${source.layerId}/query`;
  const queryString = parameters.toString();
  const usePost = query.preferPost === true || queryString.length > 1_800;
  const requestPath = usePost ? path : `${path}?${queryString}`;
  return Object.freeze({
    method: usePost ? "POST" : "GET",
    path: requestPath,
    url: `${trimTrailingSlashes(source.baseUrl)}${requestPath}`,
    headers: usePost ? Object.freeze({ "content-type": "application/x-www-form-urlencoded" }) : Object.freeze({}),
    body: usePost ? queryString : undefined,
    format: source.format,
  });
};

const trimTrailingSlashes = (value: string): string => {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 47) end -= 1;
  return value.slice(0, end);
};

const normalizeDescription = (source: DirectGeoParquetColumnarSource, raw: unknown): ColumnarWorkflowDescription => {
  const value = (raw ?? {}) as Record<string, unknown>;
  return Object.freeze({
    sourceId: source.id,
    execution: "browser-bounded",
    format: "parquet",
    schema: value.schema ?? value.fields ?? value.columns,
    geometryEncoding: typeof value.geometryEncoding === "string" ? value.geometryEncoding : undefined,
    crs: value.crs,
    bbox: Array.isArray(value.bbox) ? (value.bbox as readonly number[]) : undefined,
    rowEstimate: typeof value.rowEstimate === "number" ? value.rowEstimate : undefined,
    rowGroupCount: typeof value.rowGroupCount === "number" ? value.rowGroupCount : undefined,
    raw,
  });
};

const readBoundedDirectResponse = async (
  response: Response,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<Uint8Array> => {
  const advertisedLength = response.headers.get("content-length");
  if (advertisedLength === null || !/^\d+$/.test(advertisedLength)) {
    await response.body?.cancel().catch(() => undefined);
    throw new ColumnarWorkflowError(
      "INVALID_RESPONSE",
      "Direct GeoParquet requires an explicit non-negative Content-Length for bounded allocation.",
    );
  }
  const expectedLength = Number(advertisedLength);
  if (!Number.isSafeInteger(expectedLength) || expectedLength <= 0) {
    await response.body?.cancel().catch(() => undefined);
    throw new ColumnarWorkflowError(
      "INVALID_RESPONSE",
      "Direct GeoParquet Content-Length must be a positive safe integer.",
    );
  }
  if (expectedLength > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new ColumnarWorkflowError(
      "TRANSFER_LIMIT_EXCEEDED",
      `Direct GeoParquet content length exceeds the ${maxBytes} byte transfer ceiling.`,
    );
  }
  const contentEncoding = response.headers.get("content-encoding");
  if (contentEncoding && contentEncoding.toLowerCase() !== "identity") {
    await response.body?.cancel().catch(() => undefined);
    throw new ColumnarWorkflowError(
      "INVALID_RESPONSE",
      "Direct GeoParquet responses must use identity encoding so Content-Length bounds the readable bytes.",
    );
  }
  if (!response.body) {
    throw new ColumnarWorkflowError("INVALID_RESPONSE", "Direct GeoParquet response has no readable body.");
  }

  let output: Uint8Array;
  try {
    output = new Uint8Array(expectedLength);
  } catch (cause) {
    throw new ColumnarWorkflowError(
      "BACKING_LIMIT_EXCEEDED",
      `Unable to reserve the ${expectedLength} byte direct GeoParquet response.`,
      undefined,
      { cause },
    );
  }
  const reader = response.body.getReader();
  let length = 0;
  try {
    while (true) {
      throwIfAborted(signal);
      const next = await reader.read();
      throwIfAborted(signal);
      if (next.done) break;
      if (next.value.byteLength > expectedLength - length) {
        await reader.cancel().catch(() => undefined);
        throw new ColumnarWorkflowError(
          "INVALID_RESPONSE",
          "Direct GeoParquet response bytes exceed the declared Content-Length.",
        );
      }
      output.set(next.value, length);
      length += next.value.byteLength;
    }
  } catch (cause) {
    throwIfAborted(signal);
    throw cause;
  } finally {
    reader.releaseLock();
  }
  if (length !== expectedLength) {
    throw new ColumnarWorkflowError(
      "INVALID_RESPONSE",
      `Direct GeoParquet response ended after ${length} bytes; ${expectedLength} bytes were declared.`,
    );
  }
  return output;
};

const defaultDirectOpener = async (
  source: DirectGeoParquetColumnarSource,
  signal: AbortSignal | undefined,
  budgets: ColumnarWorkflowBudgets,
  fetchFn: typeof fetch,
): Promise<DirectGeoParquetHandle> => {
  throwIfAborted(signal);
  let response: Response;
  try {
    response = await fetchFn(source.url, {
      headers: { accept: "application/vnd.apache.parquet" },
      signal,
    });
  } catch (cause) {
    throwIfAborted(signal);
    throw new ColumnarWorkflowError(
      "REQUEST_FAILED",
      `Direct GeoParquet request failed for ${source.id}.`,
      { url: source.url },
      { cause },
    );
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new ColumnarWorkflowError("REQUEST_FAILED", `Direct GeoParquet request returned HTTP ${response.status}.`, {
      status: response.status,
      url: source.url,
    });
  }
  const bytes = await readBoundedDirectResponse(
    response,
    Math.min(budgets.maxTransferBytes, budgets.maxBackingBytes),
    signal,
  );
  const runtime = new GeoParquet.GeoparquetRuntime();
  try {
    const registeredName = "honua-direct-source.parquet";
    await runtime.registerFileBuffer(registeredName, bytes);
    throwIfAborted(signal);
    const sdkSource = GeoParquet.geoparquetSource(
      {
        id: source.id,
        protocol: "geoparquet",
        locator: {
          url: registeredName,
          ...(source.geometryColumn ? { geoparquet: { geometryColumn: source.geometryColumn } } : {}),
        },
      } as Parameters<typeof GeoParquet.geoparquetSource>[0],
      { runtime },
    );
    const handle = sdkSource.protocol("geoparquet");
    if (!handle) {
      throw new ColumnarWorkflowError("REQUEST_FAILED", `GeoParquet protocol handle is unavailable for ${source.id}.`);
    }
    return {
      transferBytes: bytes.byteLength,
      describe: (signal) => handle.describe(signal),
      async queryColumnar(input) {
        const query = input as ColumnarWorkflowQuery;
        if (query.aggregations?.length) {
          throw new ColumnarWorkflowError(
            "BROWSER_AGGREGATION_REQUIRED",
            "Direct GeoParquet aggregation uses the explicit worker aggregation handoff after bounded decode.",
          );
        }
        const produced = await handle.queryColumnar({
          query: {
            filter: query.filter,
            spatialFilter: query.bbox ? envelope(...query.bbox) : undefined,
            pagination: { limit: query.limit, offset: query.offset },
            orderBy: query.orderBy,
            returnGeometry: query.returnGeometry,
            signal: query.signal,
          },
          identity: {
            sourceId: source.id,
            sourceVersion: source.sourceVersion,
            schemaVersion: source.schemaVersion,
            planId: `columnar-workflow:${source.id}:${JSON.stringify({
              filter: query.filter,
              bbox: query.bbox,
              limit: query.limit,
              offset: query.offset,
              orderBy: query.orderBy,
            })}`,
            authorizationScope: source.authorizationScope,
            ordering: {
              stable: Boolean(query.orderBy?.length),
              keys: (query.orderBy ?? []).map((order) => ({
                field: order.field,
                direction: order.direction === "asc" ? "ascending" : "descending",
                nulls: "last",
              })),
            },
            freshness: { observedAt: new Date().toISOString() },
          },
          batchId: `${source.id}:0`,
          sequence: 0,
          ...(query.offset === undefined ? {} : { rowOffset: query.offset }),
          limits: {
            maxRows: query.limit,
            maxVertices: Math.max(1, Math.min(2_147_483_647, Math.floor(budgets.maxBackingBytes / 16))),
            maxRings: Math.max(1, Math.min(2_147_483_647, Math.floor(budgets.maxBackingBytes / 4))),
            maxBackingBytes: budgets.maxBackingBytes,
            maxCopiedBytes: Math.min(2_147_483_647, budgets.maxBackingBytes),
          },
        });
        return produced.batch;
      },
      close: () => runtime.dispose(),
    };
  } catch (cause) {
    await runtime.dispose();
    throw cause;
  }
};

const collectTransfers = (value: unknown, output: ArrayBuffer[], seen: Set<ArrayBuffer>): void => {
  if (value instanceof ArrayBuffer) {
    if (!seen.has(value)) {
      seen.add(value);
      output.push(value);
    }
    return;
  }
  if (ArrayBuffer.isView(value)) {
    collectTransfers(value.buffer, output, seen);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const nested of Object.values(value as Record<string, unknown>)) collectTransfers(nested, output, seen);
};

export const openColumnarSession = (
  source: ColumnarWorkflowSource,
  options: ColumnarWorkflowOptions = {},
): ColumnarWorkflowSession => {
  const budgets = resolveBudgets(options.budgets);
  const inspectBatch =
    options.inspectBatch ??
    ((batch: ColumnarBatchV1) =>
      (
        Columnar.inspectColumnarBatch as unknown as (
          value: ColumnarBatchV1,
          limits: Pick<ColumnarWorkflowBudgets, "maxRows" | "maxBackingBytes">,
        ) => ColumnarBatchMetrics
      )(batch, budgets));
  const now = options.now ?? (() => Date.now());
  let directHandle: DirectGeoParquetHandle | undefined;
  let directHandlePromise: Promise<DirectGeoParquetHandle> | undefined;
  const directOpenAbort = new AbortController();
  let disposed = false;

  const plan = (query: ColumnarWorkflowQuery): ColumnarWorkflowPlan => {
    validateQuery(source, query, budgets);
    const pushdown = ["columns", "filter", "bbox", "limit", "offset", "orderBy"].filter(
      (name) => query[name as keyof ColumnarWorkflowQuery] !== undefined,
    );
    if (source.kind === "honua-feature-query" && query.aggregations?.length) pushdown.push("aggregations");
    const request = source.kind === "honua-feature-query" ? buildServerRequest(source, query) : undefined;
    return Object.freeze({
      sourceId: source.id,
      execution: source.kind === "honua-feature-query" ? "server-pushdown" : "browser-bounded",
      format: source.kind === "honua-feature-query" ? source.format : "parquet",
      pushdown: Object.freeze(pushdown),
      browser: Object.freeze([
        "decode",
        ...(source.kind === "direct-geoparquet" && query.aggregations?.length ? ["aggregations"] : []),
        "render-handoff",
      ]),
      boundedBy: budgets,
      request,
    });
  };

  const getDirectHandle = async (
    signal?: AbortSignal,
  ): Promise<{ readonly handle: DirectGeoParquetHandle; readonly openedByCaller: boolean }> => {
    throwIfAborted(signal);
    if (disposed) {
      throw new ColumnarWorkflowError("ABORTED", "Columnar workflow session is disposed.");
    }
    let openedByCaller = false;
    if (!directHandlePromise) {
      openedByCaller = true;
      const directSource = source as DirectGeoParquetColumnarSource;
      const pending = options.openDirectGeoParquet
        ? Promise.resolve(options.openDirectGeoParquet(directSource, directOpenAbort.signal))
        : defaultDirectOpener(directSource, directOpenAbort.signal, budgets, options.directFetchFn ?? fetch);
      directHandlePromise = pending;
      void pending.then(
        (opened) => {
          if (directHandlePromise === pending) directHandle = opened;
        },
        () => {
          if (directHandlePromise === pending) {
            directHandlePromise = undefined;
            directHandle = undefined;
          }
        },
      );
    }
    const pending = directHandlePromise;
    const opened = signal
      ? await new Promise<DirectGeoParquetHandle>((resolve, reject) => {
          let settled = false;
          const finish = (callback: () => void): void => {
            if (settled) return;
            settled = true;
            signal.removeEventListener("abort", abort);
            callback();
          };
          const abort = (): void => {
            finish(() => {
              try {
                throwIfAborted(signal);
              } catch (error) {
                reject(error);
              }
            });
          };
          signal.addEventListener("abort", abort, { once: true });
          if (signal.aborted) abort();
          pending.then(
            (handle) => finish(() => resolve(handle)),
            (error: unknown) => finish(() => reject(error)),
          );
        })
      : await pending;
    throwIfAborted(signal);
    return { handle: opened, openedByCaller };
  };

  return Object.freeze({
    async inspect(signal) {
      throwIfAborted(signal);
      options.onProgress?.({ phase: "inspect" });
      if (source.kind === "honua-feature-query") {
        return Object.freeze({
          sourceId: source.id,
          execution: "server-pushdown",
          format: source.format,
        });
      }
      const { handle } = await getDirectHandle(signal);
      try {
        const description = await handle.describe(signal);
        throwIfAborted(signal);
        return normalizeDescription(source, description);
      } catch (cause) {
        throwIfAborted(signal);
        throw cause;
      }
    },

    plan,

    async *stream(query) {
      const workflowPlan = plan(query);
      const startedAt = now();
      let rows = 0;
      let batches = 0;
      let transferBytes = 0;
      let peakBackingBytes = 0;

      const decoded = async function* (): AsyncIterable<ColumnarBatchV1> {
        throwIfAborted(query.signal);
        if (source.kind === "direct-geoparquet") {
          const { handle, openedByCaller } = await getDirectHandle(query.signal);
          if (query.bbox) {
            const description = normalizeDescription(source, await handle.describe(query.signal));
            if (!supportsWgs84Bbox(description.crs)) {
              throw new ColumnarWorkflowError(
                "INVALID_QUERY",
                "Direct GeoParquet bbox queries require an explicitly declared WGS84 longitude/latitude CRS.",
                { crs: description.crs },
              );
            }
          }
          const admittedBytes = openedByCaller ? (handle.transferBytes ?? 0) : 0;
          if (!Number.isSafeInteger(admittedBytes) || admittedBytes < 0) {
            throw new ColumnarWorkflowError(
              "INVALID_RESPONSE",
              "Direct GeoParquet opener reported an invalid transfer byte count.",
            );
          }
          transferBytes = admittedBytes;
          try {
            yield await handle.queryColumnar(query);
          } catch (cause) {
            if (cause instanceof GeoParquet.GeoParquetNativeGeometryError) {
              if (cause.code === "GEOPARQUET_NATIVE_ROW_LIMIT_EXCEEDED") {
                throw new ColumnarWorkflowError("ROW_LIMIT_EXCEEDED", cause.message, cause.detail, { cause });
              }
              if (
                cause.code === "GEOPARQUET_NATIVE_VERTEX_LIMIT_EXCEEDED" ||
                cause.code === "GEOPARQUET_NATIVE_RING_LIMIT_EXCEEDED" ||
                cause.code === "GEOPARQUET_NATIVE_BACKING_LIMIT_EXCEEDED"
              ) {
                throw new ColumnarWorkflowError("BACKING_LIMIT_EXCEEDED", cause.message, cause.detail, { cause });
              }
            }
            throw cause;
          }
          return;
        }
        if (!options.decodeServerResponse) {
          throw new ColumnarWorkflowError(
            "DECODER_REQUIRED",
            `A ${source.format} response decoder is required for Honua columnar queries.`,
            { format: source.format },
          );
        }
        const originalRequest = workflowPlan.request as ColumnarWorkflowRequest;
        const request = (await options.beforeRequest?.(originalRequest)) ?? originalRequest;
        options.onProgress?.({ phase: "request" });
        const client = new HonuaClient({ baseUrl: source.baseUrl, ...options.clientOptions });
        let response: Response;
        try {
          const maximumResponseBytes = Math.min(budgets.maxTransferBytes, budgets.maxBackingBytes);
          const overflowCode: "TRANSFER_LIMIT_EXCEEDED" | "BACKING_LIMIT_EXCEEDED" =
            budgets.maxBackingBytes < budgets.maxTransferBytes ? "BACKING_LIMIT_EXCEEDED" : "TRANSFER_LIMIT_EXCEEDED";
          response = await client.pipelineFetch(
            request.method,
            request.path,
            { headers: request.headers, body: request.body },
            query.signal,
            {
              discardErrorBody: true,
              prepareResponse: async (networkResponse, deadlineSignal) => {
                const bytes = await readBoundedResponseBytes(
                  networkResponse,
                  maximumResponseBytes,
                  deadlineSignal ?? query.signal,
                  overflowCode,
                );
                transferBytes = bytes.byteLength;
                const prepared = boundedColumnarResponse(networkResponse, bytes);
                preparedColumnarResponseBytes.set(prepared, bytes);
                return prepared;
              },
            },
          );
        } catch (error) {
          throwIfAborted(query.signal);
          if (error instanceof ColumnarWorkflowError) throw error;
          throw new ColumnarWorkflowError(
            "REQUEST_FAILED",
            `Columnar query failed for ${source.id}.`,
            { url: request.url },
            { cause: error },
          );
        }
        if (!response.ok) {
          throw new ColumnarWorkflowError("REQUEST_FAILED", `Columnar query returned HTTP ${response.status}.`, {
            status: response.status,
            url: request.url,
          });
        }
        options.onProgress?.({ phase: "decode" });
        yield* options.decodeServerResponse({
          source,
          query,
          response,
          signal: query.signal,
          budgets,
          identity: {
            sourceId: source.id,
            sourceVersion: source.sourceVersion,
            schemaVersion: source.schemaVersion,
            authorizationScope: source.authorizationScope,
          },
        });
      };

      for await (const batch of decoded()) {
        throwIfAborted(query.signal);
        batches += 1;
        if (batches > budgets.maxBatches) {
          throw new ColumnarWorkflowError(
            "BATCH_LIMIT_EXCEEDED",
            `Decoded batch count exceeds the ${budgets.maxBatches} batch ceiling.`,
          );
        }
        const metrics = inspectBatch(batch, budgets);
        const batchRows = metricNumber(metrics, ["rowCount", "rows"]);
        const batchBackingBytes = metricNumber(metrics, ["backingBytes", "byteLength"]);
        rows += batchRows;
        peakBackingBytes = Math.max(peakBackingBytes, batchBackingBytes);
        if (rows > Math.min(query.limit, budgets.maxRows)) {
          throw new ColumnarWorkflowError(
            "ROW_LIMIT_EXCEEDED",
            "Decoded rows exceed the requested or configured row ceiling.",
            {
              rows,
              limit: query.limit,
              maxRows: budgets.maxRows,
            },
          );
        }
        if (transferBytes > budgets.maxTransferBytes) {
          throw new ColumnarWorkflowError(
            "TRANSFER_LIMIT_EXCEEDED",
            `Decoded bytes exceed the ${budgets.maxTransferBytes} byte transfer ceiling.`,
          );
        }
        if (peakBackingBytes > budgets.maxBackingBytes) {
          throw new ColumnarWorkflowError(
            "BACKING_LIMIT_EXCEEDED",
            `Batch backing bytes exceed the ${budgets.maxBackingBytes} byte memory ceiling.`,
          );
        }
        const evidence = Object.freeze({
          sourceId: source.id,
          execution: workflowPlan.execution,
          rows,
          batches,
          transferBytes,
          elapsedMs: Math.max(0, now() - startedAt),
          peakBackingBytes,
          ceilings: budgets,
        });
        options.onProgress?.({ phase: "batch", evidence });
        yield Object.freeze({ batch, metrics, evidence });
      }
      options.onProgress?.({
        phase: "complete",
        evidence: Object.freeze({
          sourceId: source.id,
          execution: workflowPlan.execution,
          rows,
          batches,
          transferBytes,
          elapsedMs: Math.max(0, now() - startedAt),
          peakBackingBytes,
          ceilings: budgets,
        }),
      });
    },

    table(batch, maxRows) {
      if (!Number.isSafeInteger(maxRows) || maxRows <= 0 || maxRows > budgets.maxRows) {
        throw new ColumnarWorkflowError(
          "ROW_LIMIT_EXCEEDED",
          `Table handoff must be bounded between 1 and ${budgets.maxRows} rows.`,
        );
      }
      const rows = Columnar.decodeGeoArrowBatch(batch, { maxRows }).rows;
      return Object.freeze({ kind: "table", rows, truncated: batch.rowCount > rows.length });
    },

    worker(batch, operation = "decode") {
      if (operation.trim() !== operation || operation.length === 0) {
        throw new ColumnarWorkflowError("UNSUPPORTED_HANDOFF", "Worker operation must be a non-empty trimmed string.");
      }
      const transfer: ArrayBuffer[] = [];
      collectTransfers(batch, transfer, new Set<ArrayBuffer>());
      return Object.freeze({ kind: "worker", batch, transfer: Object.freeze(transfer), operation });
    },

    render(batch, geometry) {
      return Object.freeze({ kind: "deck.gl", geometry, batch, zeroCopyPreferred: true });
    },

    download(query) {
      const workflowPlan = plan(query);
      if (!workflowPlan.request) {
        throw new ColumnarWorkflowError(
          "UNSUPPORTED_HANDOFF",
          "Download handoffs are available only for Honua server query results.",
        );
      }
      return Object.freeze({
        kind: "download",
        request: workflowPlan.request,
        suggestedFileName: `${source.id}.${workflowPlan.format}`,
      });
    },

    async dispose() {
      if (disposed) return;
      disposed = true;
      directOpenAbort.abort(new Error("Columnar workflow session was disposed."));
      const pending = directHandlePromise;
      const opened = directHandle;
      directHandlePromise = undefined;
      directHandle = undefined;
      const handle = pending ? await pending.catch(() => undefined) : opened;
      await handle?.close?.();
    },
  } satisfies ColumnarWorkflowSession);
};

function throwArrowDecoderError(error: unknown): never {
  if (error instanceof ColumnarWorkflowError) throw error;
  if (error instanceof HonuaArrowWkbError) {
    if (error.code === "aborted") {
      throw new ColumnarWorkflowError("ABORTED", error.message, error.details, { cause: error });
    }
    if (error.code === "row-limit") {
      throw new ColumnarWorkflowError("ROW_LIMIT_EXCEEDED", error.message, error.details, { cause: error });
    }
    if (error.code === "backing-limit") {
      throw new ColumnarWorkflowError("BACKING_LIMIT_EXCEEDED", error.message, error.details, { cause: error });
    }
    throw new ColumnarWorkflowError("INVALID_RESPONSE", error.message, error.details, { cause: error });
  }
  if (error instanceof Columnar.HonuaGeoArrowError) {
    if (error.code === "row-limit-exceeded") {
      throw new ColumnarWorkflowError("ROW_LIMIT_EXCEEDED", error.message, error.detail, { cause: error });
    }
    if (
      error.code === "vertex-limit-exceeded" ||
      error.code === "ring-limit-exceeded" ||
      error.code === "dictionary-limit-exceeded" ||
      error.code === "copy-limit-exceeded"
    ) {
      throw new ColumnarWorkflowError("BACKING_LIMIT_EXCEEDED", error.message, error.detail, { cause: error });
    }
  }
  throw new ColumnarWorkflowError(
    "INVALID_RESPONSE",
    "Arrow response is not a supported bounded columnar payload.",
    undefined,
    {
      cause: error,
    },
  );
}

async function readBoundedResponseBytes(
  response: Response,
  maximum: number,
  signal?: AbortSignal,
  overflowCode: "TRANSFER_LIMIT_EXCEEDED" | "BACKING_LIMIT_EXCEEDED" = "TRANSFER_LIMIT_EXCEEDED",
): Promise<Uint8Array> {
  throwIfAborted(signal);
  const advertised = response.headers.get("content-length");
  if (advertised !== null) {
    const declaredLength = Number(advertised);
    if (Number.isFinite(declaredLength) && declaredLength > maximum) {
      await response.body?.cancel().catch(() => undefined);
      throw new ColumnarWorkflowError(
        overflowCode,
        `Arrow response exceeds the ${maximum} byte materialization ceiling.`,
      );
    }
  }
  if (!response.body) return new Uint8Array();

  const reader = response.body.getReader();
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(maximum);
  } catch (cause) {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
    throw new ColumnarWorkflowError(
      "BACKING_LIMIT_EXCEEDED",
      `Unable to reserve the ${maximum} byte Arrow response backing ceiling.`,
      undefined,
      { cause },
    );
  }
  let total = 0;
  const abort = () => void reader.cancel(signal?.reason).catch(() => undefined);
  signal?.addEventListener("abort", abort, { once: true });
  try {
    for (;;) {
      throwIfAborted(signal);
      const { done, value } = await reader.read();
      throwIfAborted(signal);
      if (done) break;
      if (value.byteLength > maximum - total) {
        await reader.cancel().catch(() => undefined);
        throw new ColumnarWorkflowError(
          overflowCode,
          `Arrow response exceeds the ${maximum} byte materialization ceiling.`,
        );
      }
      bytes.set(value, total);
      total += value.byteLength;
    }
  } finally {
    signal?.removeEventListener("abort", abort);
    reader.releaseLock();
  }

  return bytes.subarray(0, total);
}

const preparedColumnarResponseBytes = new WeakMap<Response, Uint8Array>();

function boundedColumnarResponse(response: Response, bytes: Uint8Array): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

export const createApacheArrowResponseDecoder = (
  options: ApacheArrowResponseDecoderOptions = {},
): ColumnarResponseDecoder =>
  async function* ({ response, identity: sourceIdentity, budgets, query, signal }) {
    throwIfAborted(signal);
    const preparedBytes = preparedColumnarResponseBytes.get(response);
    if (preparedBytes) {
      preparedColumnarResponseBytes.delete(response);
      await response.body?.cancel().catch(() => undefined);
    }
    const bytes =
      preparedBytes ??
      (await readBoundedResponseBytes(
        response,
        Math.min(budgets.maxTransferBytes, budgets.maxBackingBytes),
        signal,
        budgets.maxBackingBytes < budgets.maxTransferBytes ? "BACKING_LIMIT_EXCEEDED" : "TRANSFER_LIMIT_EXCEEDED",
      ));
    const apache = (await Columnar.loadApacheArrow({ importModule: options.importModule })) as {
      RecordBatchReader: { from(input: Uint8Array): Promise<AsyncIterable<unknown>> | AsyncIterable<unknown> };
    };
    let reader: AsyncIterable<unknown>;
    try {
      reader = await apache.RecordBatchReader.from(bytes);
    } catch (error) {
      throwArrowDecoderError(error);
    }
    let batchIndex = 0;
    let decodedRows = 0;
    const observedAt = new Date().toISOString();
    const planId = `columnar-workflow:${sourceIdentity.sourceId}:arrow:${JSON.stringify({
      columns: query.columns,
      filter: query.filter,
      bbox: query.bbox,
      limit: query.limit,
      offset: query.offset,
      orderBy: query.orderBy,
      aggregations: query.aggregations,
    })}`;
    for await (const recordBatch of reader) {
      throwIfAborted(signal);
      if (batchIndex >= budgets.maxBatches) {
        throw new ColumnarWorkflowError(
          "BATCH_LIMIT_EXCEEDED",
          `Arrow response exceeds the ${budgets.maxBatches}-batch ceiling.`,
        );
      }
      const value = recordBatch as { readonly numRows?: unknown };
      if (!Number.isSafeInteger(value.numRows) || (value.numRows as number) < 0) {
        throw new ColumnarWorkflowError("INVALID_RESPONSE", "Arrow RecordBatch has an invalid row count.");
      }
      const remainingRows = Math.min(budgets.maxRows, query.limit) - decodedRows;
      if ((value.numRows as number) > remainingRows) {
        throw new ColumnarWorkflowError(
          "ROW_LIMIT_EXCEEDED",
          `Arrow response exceeds the ${Math.min(budgets.maxRows, query.limit)}-row ceiling.`,
        );
      }
      const identity: ColumnarBatchIdentityV1 = {
        ...sourceIdentity,
        planId,
        ordering: {
          stable: Boolean(query.orderBy?.length),
          keys: (query.orderBy ?? []).map((order) => ({
            field: order.field,
            direction: order.direction === "asc" ? "ascending" : "descending",
            nulls: "last",
          })),
        },
        freshness: { observedAt },
      };
      let converted: ColumnarBatchV1;
      try {
        converted = hasHonuaArrowWkbGeometry(recordBatch)
          ? decodeHonuaArrowWkbRecordBatch({
              recordBatch,
              id: `${identity.sourceId}:${batchIndex}`,
              sequence: batchIndex,
              rowOffset: (query.offset ?? 0) + decodedRows,
              schemaId: identity.schemaVersion,
              identity,
              maxRows: remainingRows,
              maxBackingBytes: budgets.maxBackingBytes,
              signal,
              ...options,
            })
          : Columnar.fromApacheArrowRecordBatch(
              recordBatch as Parameters<typeof Columnar.fromApacheArrowRecordBatch>[0],
              {
                id: `${identity.sourceId}:${batchIndex}`,
                sequence: batchIndex,
                rowOffset: (query.offset ?? 0) + decodedRows,
                schemaId: identity.schemaVersion,
                identity,
                limits: {
                  maxRows: remainingRows,
                  maxBackingBytes: budgets.maxBackingBytes,
                  maxCopiedBytes: budgets.maxBackingBytes,
                },
              },
            ).batch;
      } catch (error) {
        throwArrowDecoderError(error);
      }
      throwIfAborted(signal);
      decodedRows += converted.rowCount;
      yield converted;
      batchIndex += 1;
    }
  };
