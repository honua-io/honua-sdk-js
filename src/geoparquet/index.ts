/**
 * `@honua/sdk-js/geoparquet` — a GeoParquet / DuckDB-WASM–backed `Source`.
 *
 * The same protocol-neutral {@link Query} that runs against a FeatureServer or
 * an OGC API Features collection compiles here to DuckDB SQL over
 * `read_parquet(...)`, with spatial predicate pushdown, and returns the same
 * {@link Result} envelope (GeoJSON features + schema). Overture's monthly
 * GeoParquet drops, single files, and hive-partitioned theme prefixes are all
 * addressable.
 *
 * ## Why a separate entrypoint
 *
 * The DuckDB WASM engine (`@duckdb/duckdb-wasm`, an optional peer) is multiple
 * megabytes and must never enter the static graph of `/contract` or `/honua`.
 * This module is that graph boundary: it is reached either by importing
 * `@honua/sdk-js/geoparquet` directly, or by handing {@link geoparquetResolver}
 * to `createDataset({ resolveSource })`. The `@duckdb/duckdb-wasm` peer itself
 * is only ever loaded through a dynamic `import()` inside the driver, so even
 * this entrypoint carries no static dependency edge to it.
 *
 * ## Lifecycle & memory ceiling
 *
 * A {@link GeoparquetRuntime} owns exactly one DuckDB instance and one Web
 * Worker, created lazily on first query and shared across every source it
 * backs. Call {@link GeoparquetRuntime.dispose} (or the `dispose()` on the
 * value returned by {@link geoparquetResolver}) when the owning client is torn
 * down to terminate the worker. DuckDB-WASM runs inside a single WASM linear
 * memory whose ceiling is ~4 GiB (32-bit addressing); in practice keep the
 * working set (scanned columns × matched rows, plus the spatial index) well
 * under ~2 GiB. Parquet footers / row-group metadata are cached per source-URL
 * set within the runtime; there is no on-disk persistence.
 *
 * @experimental This entrypoint is not yet covered by the SDK's semver contract
 *   — the surface may change in any minor release prior to `1.0.0`.
 * @module
 */

import { addCapabilitySupport, normalizeCapabilityDescriptor } from "../contract/source-capability-support.js";
import type {
  AdapterKind,
  AggregationSpec,
  Capabilities,
  Capability,
  CapabilityAwareSource,
  CapabilityPolicy,
  DegradedReason,
  FeatureId,
  Protocol,
  Query,
  ResolveSourceContext,
  Result,
  Source,
  SourceDescriptor,
  SourceResolver,
} from "../contract/types.js";
import { PROTOCOL_DEFAULT_CAPABILITIES } from "../contract/types.js";
import { HonuaCapabilityNotSupportedError } from "../core/errors.js";
import {
  type CompileOptions,
  type GeometryColumnPlan,
  compileAggregate,
  compileQuery,
  describeSql,
  geoMetadataSql,
  rowEstimateSql,
} from "../core/geoparquet-sql.js";
import type { EsriFieldType, HonuaExtent, HonuaFieldInfo, HonuaTypedFeature } from "../core/types.js";
import { type DescribeRow, type SourceProfile, buildSourceProfile } from "./metadata.js";
export * from "./driver.js";
export * from "./metadata.js";
export {
  bboxFromSpatialFilter,
  compileAggregate,
  compileQuery,
  type CompiledSql,
  type CompileOptions,
  type GeometryColumnPlan,
  type GeometryEncoding,
  geometryExpr,
  integerLiteral,
  numberLiteral,
  parquetSourceExpr,
  quoteIdentifier,
  spatialPredicate,
  stringLiteral,
} from "../core/geoparquet-sql.js";

import { createBrowserDuckDbDriver } from "./driver.js";
import type { DuckDbDriver, DuckDbQueryOptions, DuckRow } from "./driver.js";

const GEOPARQUET_ALIAS = "__geometry_geojson";
const MAX_GEO_METADATA_BYTES = 1024 * 1024;
const MAX_GEO_METADATA_TOTAL_BYTES = 8 * 1024 * 1024;
const MAX_GEO_METADATA_DOCUMENTS = 10_000;
const MAX_GEO_METADATA_DEPTH = 32;
const MAX_GEO_METADATA_NODES = 100_000;

/** Lifecycle options supplied while a fresh {@link DuckDbDriver} is initialized. */
export interface DuckDbDriverFactoryOptions {
  readonly signal: AbortSignal;
}

/** Factory that produces a fresh {@link DuckDbDriver}. */
export type DuckDbDriverFactory = (options?: DuckDbDriverFactoryOptions) => Promise<DuckDbDriver>;

export interface GeoparquetRuntimeOptions {
  /**
   * Driver factory. Defaults to {@link createBrowserDuckDbDriver} (loads
   * `@duckdb/duckdb-wasm` lazily). Tests and Node consumers inject a driver
   * built on the DuckDB Node bindings here.
   */
  readonly driverFactory?: DuckDbDriverFactory;
}

/**
 * Owns a single, lazily-initialized DuckDB instance shared across every
 * GeoParquet source. Profiles (footer schema + geometry plan + row estimate)
 * are memoized per source-URL set.
 */
export class GeoparquetRuntime {
  private readonly driverFactory: DuckDbDriverFactory;
  private driverPromise: Promise<DuckDbDriver> | undefined;
  private driverInstance: DuckDbDriver | undefined;
  private readonly initializationAbort = new AbortController();
  private disposed = false;
  private disposePromise: Promise<void> | undefined;
  private readonly profiles = new Map<string, Promise<SourceProfile>>();

  constructor(options: GeoparquetRuntimeOptions = {}) {
    this.driverFactory = options.driverFactory ?? createBrowserDuckDbDriver;
  }

  private async driver(): Promise<DuckDbDriver> {
    if (this.disposed) throw new Error("geoparquet: runtime has been disposed");
    if (!this.driverPromise) {
      this.driverPromise = this.driverFactory({ signal: this.initializationAbort.signal }).then(async (driver) => {
        if (this.disposed) {
          await driver.close().catch(() => undefined);
          throw new Error("geoparquet: runtime has been disposed");
        }
        this.driverInstance = driver;
        return driver;
      });
    }
    const driver = await this.driverPromise;
    if (this.disposed) throw new Error("geoparquet: runtime has been disposed");
    return driver;
  }

  /** Run a query and return raw rows. Escape hatch for advanced callers. */
  async query(sql: string, options?: DuckDbQueryOptions): Promise<DuckRow[]> {
    const driver = await this.driver();
    return driver.query(sql, options);
  }

  /** Stream Arrow record batches when supported, falling back to one materialized batch. */
  async *stream(sql: string, options?: DuckDbQueryOptions): AsyncIterable<DuckRow[]> {
    const driver = await this.driver();
    if (driver.streamQuery) {
      yield* driver.streamQuery(sql, options);
      return;
    }
    yield await driver.query(sql, options);
  }

  /** Register parquet bytes under a name usable in `read_parquet('name')`. */
  async registerFileBuffer(name: string, bytes: Uint8Array): Promise<void> {
    const driver = await this.driver();
    await driver.registerFileBuffer(name, bytes);
  }

  /** Detect (and memoize) the schema + geometry plan for a source-URL set. */
  profile(sources: readonly string[], geometryColumnOverride?: string): Promise<SourceProfile> {
    const key = JSON.stringify([sources, geometryColumnOverride ?? null]);
    const cached = this.profiles.get(key);
    if (cached) return cached;
    const built = this.detectProfile(sources, geometryColumnOverride);
    this.profiles.set(key, built);
    return built;
  }

  private async detectProfile(sources: readonly string[], geometryColumnOverride?: string): Promise<SourceProfile> {
    const driver = await this.driver();
    const describe = (await driver.query(describeSql(sources))) as unknown as DescribeRow[];
    let geoJson: string | undefined;
    try {
      const rows = await driver.query(geoMetadataSql(sources));
      geoJson = consistentGeoMetadata(rows);
    } catch (cause) {
      if (cause instanceof InconsistentGeoMetadataError || sources.length > 1) throw cause;
      geoJson = undefined;
    }
    let rowEstimate: number | undefined;
    try {
      const rows = await driver.query(rowEstimateSql(sources));
      rowEstimate = toNumber(rows[0]?.row_estimate);
    } catch {
      rowEstimate = undefined;
    }
    return buildSourceProfile({
      describe,
      ...(geoJson ? { geoJson } : {}),
      ...(geometryColumnOverride ? { geometryColumnOverride } : {}),
      ...(rowEstimate !== undefined ? { rowEstimate } : {}),
    });
  }

  /** Terminate the DuckDB worker / instance. Idempotent. */
  async dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise;
    this.disposed = true;
    this.initializationAbort.abort();
    const pending = this.driverPromise;
    const initialized = this.driverInstance;
    this.driverInstance = undefined;
    this.driverPromise = undefined;
    this.profiles.clear();
    this.disposePromise = (async () => {
      if (initialized) {
        await initialized.close().catch(() => undefined);
        return;
      }
      // Do not await an initialization promise that may be stalled in a peer,
      // extension loader, or injected factory. The lifecycle signal hard-stops
      // the browser worker; ignored-signal factories are closed if they settle.
      if (pending) void pending.then((driver) => driver.close()).catch(() => undefined);
    })();
    await this.disposePromise;
  }
}

// ── Row → feature mapping ─────────────────────────────────────

function toNumber(value: unknown): number | undefined {
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  return undefined;
}

class InconsistentGeoMetadataError extends Error {}

function consistentGeoMetadata(rows: readonly DuckRow[]): string | undefined {
  if (rows.length === 0) return undefined;
  if (rows.length > MAX_GEO_METADATA_DOCUMENTS) {
    throw new InconsistentGeoMetadataError("geoparquet: too many geo metadata documents");
  }
  let totalBytes = 0;
  const documents = rows.map((row) => {
    const value = row.value;
    if (value === null || value === undefined) return undefined;
    if (value instanceof Uint8Array && value.byteLength > MAX_GEO_METADATA_BYTES) {
      throw new InconsistentGeoMetadataError("geoparquet: geo metadata exceeds the one-megabyte safety bound");
    }
    const document =
      typeof value === "string" ? value : value instanceof Uint8Array ? new TextDecoder().decode(value) : undefined;
    if (document === undefined) {
      throw new InconsistentGeoMetadataError("geoparquet: geo metadata contains a non-text value");
    }
    totalBytes += assertGeoMetadataSize(document);
    if (totalBytes > MAX_GEO_METADATA_TOTAL_BYTES) {
      throw new InconsistentGeoMetadataError("geoparquet: aggregate geo metadata exceeds the safety bound");
    }
    return document;
  });
  if (documents.every((value) => value === undefined)) return undefined;
  if (documents.some((value) => value === undefined)) {
    throw new InconsistentGeoMetadataError("geoparquet: only some source files contain geo metadata");
  }
  if (documents.length === 1) {
    parseGeoMetadata(documents[0]!);
    return documents[0];
  }
  const parsed = documents.map((value) => parseGeoMetadata(value!));
  return JSON.stringify(mergeCompatibleGeoMetadata(parsed));
}

function assertGeoMetadataSize(value: string): number {
  const byteLength = new TextEncoder().encode(value).byteLength;
  if (value.length > MAX_GEO_METADATA_BYTES || byteLength > MAX_GEO_METADATA_BYTES) {
    throw new InconsistentGeoMetadataError("geoparquet: geo metadata exceeds the one-megabyte safety bound");
  }
  return byteLength;
}

function parseGeoMetadata(value: string): Record<string, unknown> {
  assertGeoMetadataSize(value);
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!isJsonRecord(parsed)) throw new InconsistentGeoMetadataError("geoparquet: geo metadata is not an object");
    assertBoundedGeoMetadataGraph(parsed);
    return parsed;
  } catch (cause) {
    if (cause instanceof InconsistentGeoMetadataError) throw cause;
    throw new InconsistentGeoMetadataError("geoparquet: geo metadata is not valid JSON");
  }
}

function assertBoundedGeoMetadataGraph(root: unknown): void {
  const stack: Array<{ readonly value: unknown; readonly depth: number }> = [{ value: root, depth: 0 }];
  let nodes = 0;
  while (stack.length > 0) {
    const current = stack.pop()!;
    nodes += 1;
    if (nodes > MAX_GEO_METADATA_NODES) {
      throw new InconsistentGeoMetadataError("geoparquet: geo metadata exceeds the node-count safety bound");
    }
    if (current.depth > MAX_GEO_METADATA_DEPTH) {
      throw new InconsistentGeoMetadataError("geoparquet: geo metadata exceeds the nesting-depth safety bound");
    }
    const value = current.value;
    if (value === null || typeof value === "string" || typeof value === "boolean") continue;
    if (typeof value === "number") {
      if (!Number.isFinite(value)) {
        throw new InconsistentGeoMetadataError("geoparquet: geo metadata is not finite JSON");
      }
      continue;
    }
    if (Array.isArray(value)) {
      for (const child of value) stack.push({ value: child, depth: current.depth + 1 });
      continue;
    }
    if (!isJsonRecord(value)) {
      throw new InconsistentGeoMetadataError("geoparquet: geo metadata is not JSON data");
    }
    for (const child of Object.values(value)) stack.push({ value: child, depth: current.depth + 1 });
  }
}

function mergeCompatibleGeoMetadata(documents: readonly Record<string, unknown>[]): Record<string, unknown> {
  const first = documents[0]!;
  const version = first.version;
  const primaryColumn = first.primary_column;
  const firstColumns = geoMetadataColumns(first);
  const columnNames = Object.keys(firstColumns).sort();
  for (const document of documents.slice(1)) {
    if (document.version !== version || document.primary_column !== primaryColumn) {
      throw new InconsistentGeoMetadataError("geoparquet: source files contain incompatible geo metadata");
    }
    const names = Object.keys(geoMetadataColumns(document)).sort();
    if (JSON.stringify(names) !== JSON.stringify(columnNames)) {
      throw new InconsistentGeoMetadataError("geoparquet: source files declare different geometry columns");
    }
  }

  const mergedColumns = Object.create(null) as Record<string, unknown>;
  for (const columnName of columnNames) {
    const columns = documents.map((document) => geoMetadataColumns(document)[columnName]);
    if (columns.some((column) => !isJsonRecord(column))) {
      throw new InconsistentGeoMetadataError("geoparquet: geometry column metadata is not an object");
    }
    const typedColumns = columns as Record<string, unknown>[];
    const compatibility = typedColumns.map((column) => {
      const { bbox: _bbox, geometry_types: _geometryTypes, ...critical } = column;
      void _bbox;
      void _geometryTypes;
      return JSON.stringify(sortJsonValue(critical));
    });
    if (new Set(compatibility).size !== 1) {
      throw new InconsistentGeoMetadataError(
        `geoparquet: source files contain incompatible metadata for geometry column ${columnName}`,
      );
    }
    const merged = { ...typedColumns[0] };
    const geometryTypes = typedColumns.flatMap((column) =>
      Array.isArray(column.geometry_types) ? column.geometry_types : [],
    );
    if (typedColumns.every((column) => Array.isArray(column.geometry_types))) {
      merged.geometry_types = [...new Set(geometryTypes)].sort();
    } else if (typedColumns.some((column) => column.geometry_types !== undefined)) {
      throw new InconsistentGeoMetadataError(
        `geoparquet: source files contain invalid geometry types for column ${columnName}`,
      );
    }
    const bboxes = typedColumns.map((column) => column.bbox);
    const providedBboxes = bboxes.filter((bbox) => bbox !== undefined);
    if (providedBboxes.some((bbox) => !validGeoMetadataBbox(bbox))) {
      throw new InconsistentGeoMetadataError(
        `geoparquet: source files contain an invalid bbox for column ${columnName}`,
      );
    }
    if (providedBboxes.length === bboxes.length) {
      merged.bbox = unionGeoMetadataBboxes(providedBboxes as number[][]);
    } else {
      delete merged.bbox;
    }
    mergedColumns[columnName] = merged;
  }
  return { ...first, columns: mergedColumns };
}

function geoMetadataColumns(document: Record<string, unknown>): Record<string, unknown> {
  if (!isJsonRecord(document.columns)) {
    throw new InconsistentGeoMetadataError("geoparquet: geo metadata columns are not an object");
  }
  return document.columns;
}

function validGeoMetadataBbox(value: unknown): value is number[] {
  return (
    Array.isArray(value) &&
    (value.length === 4 || value.length === 6) &&
    value.every((coordinate) => typeof coordinate === "number" && Number.isFinite(coordinate))
  );
}

function unionGeoMetadataBboxes(values: readonly number[][]): number[] {
  const dimensions = values[0]!.length / 2;
  if (values.some((bbox) => bbox.length !== dimensions * 2)) {
    throw new InconsistentGeoMetadataError("geoparquet: source files use different bbox dimensions");
  }
  const minimums = Array.from({ length: dimensions }, (_, index) => Math.min(...values.map((bbox) => bbox[index]!)));
  const maximums = Array.from({ length: dimensions }, (_, index) =>
    Math.max(...values.map((bbox) => bbox[index + dimensions]!)),
  );
  return [...minimums, ...maximums];
}

function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sortJsonValue(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new InconsistentGeoMetadataError("geoparquet: geo metadata is not finite JSON");
    return value;
  }
  if (Array.isArray(value)) return value.map(sortJsonValue);
  if (typeof value !== "object") {
    throw new InconsistentGeoMetadataError("geoparquet: geo metadata is not JSON data");
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, sortJsonValue(child)]),
  );
}

/** Normalize DuckDB scalar values (BigInt → number) for JSON-friendly output. */
function normalizeScalar(value: unknown): unknown {
  return typeof value === "bigint" ? Number(value) : value;
}

function rowToFeature<T>(row: DuckRow, wantGeometry: boolean): HonuaTypedFeature<T> {
  const attributes: Record<string, unknown> = {};
  let geometry: Record<string, unknown> | null = null;
  for (const [key, value] of Object.entries(row)) {
    if (key === GEOPARQUET_ALIAS) {
      if (wantGeometry && typeof value === "string") {
        try {
          geometry = JSON.parse(value) as Record<string, unknown>;
        } catch {
          geometry = null;
        }
      }
      continue;
    }
    attributes[key] = normalizeScalar(value);
  }
  return { attributes: attributes as T, geometry: wantGeometry ? geometry : undefined };
}

const DUCK_TYPE_TO_ESRI: ReadonlyArray<[RegExp, EsriFieldType]> = [
  [/^BOOLEAN/i, "esriFieldTypeSmallInteger"],
  [/^(TINYINT|SMALLINT|USMALLINT|UTINYINT)/i, "esriFieldTypeSmallInteger"],
  [/^(INTEGER|INT|UINTEGER)/i, "esriFieldTypeInteger"],
  [/^(BIGINT|HUGEINT|UBIGINT|LONG)/i, "esriFieldTypeInteger"],
  [/^(DOUBLE|FLOAT|REAL|DECIMAL|NUMERIC)/i, "esriFieldTypeDouble"],
  [/^(TIMESTAMP|DATE|TIME)/i, "esriFieldTypeDate"],
  [/^(BLOB|BYTEA)/i, "esriFieldTypeBlob"],
  [/^(GEOMETRY|GEOGRAPHY)/i, "esriFieldTypeGeometry"],
];

function esriFieldType(duckType: string): EsriFieldType {
  for (const [pattern, esri] of DUCK_TYPE_TO_ESRI) {
    if (pattern.test(duckType)) return esri;
  }
  return "esriFieldTypeString";
}

function fieldsFromDescribe(describe: readonly DescribeRow[]): HonuaFieldInfo[] {
  return describe.map((r) => ({ name: r.column_name, type: esriFieldType(r.column_type) }));
}

// ── Description handle (REQ-003) ──────────────────────────────

export interface GeoparquetDescription {
  /** Field schema, mirroring `HonuaFieldInfo`. */
  readonly schema: readonly HonuaFieldInfo[];
  /** Geometry column name(s) (currently one; array for forward-compat). */
  readonly geometryColumns: readonly string[];
  /** How the geometry is stored. */
  readonly geometryEncoding?: GeometryColumnPlan["encoding"];
  /** CRS identifier. */
  readonly crs?: string;
  /** Footer-derived row estimate. */
  readonly rowEstimate?: number;
}

/**
 * Typed escape hatch returned by `Source.protocol("geoparquet")`. Exposes the
 * DuckDB `describe()` metadata (REQ-003) and a raw-SQL run for advanced use.
 */
export interface GeoparquetSourceHandle {
  readonly runtime: GeoparquetRuntime;
  readonly sources: readonly string[];
  /** Schema, geometry column(s), CRS, and row estimate. */
  describe(): Promise<GeoparquetDescription>;
  /** Run arbitrary SQL against the shared DuckDB instance. */
  sql(query: string): Promise<DuckRow[]>;
  /**
   * Execute a reviewed plan with ephemeral sources supplied by an opaque
   * resource resolver. The sources are compiled and consumed immediately and
   * never enter the runtime profile cache.
   */
  executeResolvedQuery<T = Record<string, unknown>>(input: GeoparquetResolvedQueryInput<T>): Promise<Result<T>>;
}

export interface GeoparquetResolvedQueryInput<T = Record<string, unknown>> {
  readonly sources: readonly string[];
  readonly operation: "query" | "queryAll" | "queryAggregate";
  readonly query: Query<T>;
  /** Validated logical id from the opaque handle, used only for degradation diagnostics. */
  readonly sourceId: string;
  readonly geometry?: GeometryColumnPlan;
}

declare module "../contract/types.js" {
  interface AdapterTypeMap {
    geoparquet: GeoparquetSourceHandle;
  }
}

// ── Source factory ────────────────────────────────────────────

export interface GeoparquetSourceOptions {
  /** Shared runtime. When omitted a private one-off runtime is created. */
  readonly runtime?: GeoparquetRuntime;
  /** Driver factory used only when `runtime` is omitted. */
  readonly driverFactory?: DuckDbDriverFactory;
  readonly capabilityPolicy?: CapabilityPolicy;
}

function sourcesFromDescriptor(descriptor: SourceDescriptor): string[] {
  const { url, geoparquet } = descriptor.locator;
  const urls: string[] = [];
  if (typeof url === "string" && url.length > 0) urls.push(url);
  if (geoparquet?.urls) urls.push(...geoparquet.urls);
  if (urls.length === 0) {
    throw new Error(`geoparquet: source "${descriptor.id}" requires locator.url (parquet file or hive glob)`);
  }
  return urls;
}

function ensureCapability(descriptor: SourceDescriptor, caps: Capabilities, capability: Capability): void {
  if (!caps.has(capability)) {
    throw new HonuaCapabilityNotSupportedError(capability, descriptor.protocol, descriptor.id);
  }
}

/**
 * Build a GeoParquet {@link Source} from a descriptor. Prefer
 * {@link geoparquetResolver} + `createDataset`, which shares one runtime across
 * every geoparquet source in a dataset.
 */
export function geoparquetSource<T = Record<string, unknown>>(
  descriptor: SourceDescriptor,
  options: GeoparquetSourceOptions = {},
): CapabilityAwareSource<T> {
  descriptor = normalizeCapabilityDescriptor(descriptor);
  const sources = sourcesFromDescriptor(descriptor);
  const geometryColumnOverride = descriptor.locator.geoparquet?.geometryColumn;
  const caps = descriptor.capabilities ?? PROTOCOL_DEFAULT_CAPABILITIES.geoparquet;
  const runtime =
    options.runtime ?? new GeoparquetRuntime(options.driverFactory ? { driverFactory: options.driverFactory } : {});

  async function compileOptions(): Promise<{ profile: SourceProfile; opts: CompileOptions }> {
    const profile = await runtime.profile(sources, geometryColumnOverride);
    const geometry = profile.geometry?.runtimeSupported === false ? undefined : profile.geometry;
    const opts: CompileOptions = {
      sources,
      geometryAlias: GEOPARQUET_ALIAS,
      ...(geometry ? { geometry } : {}),
      ...(profile.columns.length > 0 ? { columns: profile.columns } : {}),
    };
    return { profile, opts };
  }

  function degradedFor(bboxApproximated: boolean, sourceId = descriptor.id): DegradedReason[] | undefined {
    if (!bboxApproximated) return undefined;
    return [
      {
        capability: "query",
        reason:
          "geoparquet: non-envelope spatialFilter was reduced to its bounding box for predicate pushdown; " +
          "results may include features outside the exact geometry.",
        protocol: "geoparquet",
        sourceId,
      },
    ];
  }

  const handle: GeoparquetSourceHandle = {
    runtime,
    sources,
    async describe() {
      const driver = await runtime.query(describeSql(sources));
      const describe = driver as unknown as DescribeRow[];
      const profile = await runtime.profile(sources, geometryColumnOverride);
      return {
        schema: fieldsFromDescribe(describe),
        geometryColumns: profile.geometry ? [profile.geometry.column] : [],
        ...(profile.geometry?.runtimeSupported === false || !profile.geometry
          ? {}
          : { geometryEncoding: profile.geometry.encoding }),
        ...(profile.crs ? { crs: profile.crs } : {}),
        ...(profile.rowEstimate !== undefined ? { rowEstimate: profile.rowEstimate } : {}),
      };
    },
    sql(query: string) {
      return runtime.query(query);
    },
    async executeResolvedQuery<TResolved>(input: GeoparquetResolvedQueryInput<TResolved>) {
      const opts: CompileOptions = {
        sources: input.sources,
        geometryAlias: GEOPARQUET_ALIAS,
        ...(input.geometry ? { geometry: input.geometry } : {}),
      };
      if (input.operation === "queryAggregate") {
        ensureCapability(descriptor, caps, "queryAggregate");
        if (!input.query.aggregation) throw new Error("geoparquet: planned aggregate is missing aggregation intent");
        const compiled = compileAggregate(
          { ...input.query, aggregation: input.query.aggregation as AggregationSpec },
          opts,
        );
        const rows = await runtime.query(compiled.sql, { signal: input.query.signal });
        const aggregateRows = rows.map((row) => {
          const out: Record<string, unknown> = {};
          for (const [key, value] of Object.entries(row)) out[key] = normalizeScalar(value);
          return out;
        });
        const degraded = degradedFor(compiled.bboxApproximated, input.sourceId);
        return {
          features: [],
          exceededTransferLimit: false,
          aggregateRows,
          ...(degraded ? { degraded } : {}),
        };
      }

      ensureCapability(descriptor, caps, "query");
      const wantGeometry = input.query.returnGeometry !== false && input.geometry !== undefined;
      const compiled = compileQuery(input.query, opts);
      const rows = await runtime.query(compiled.sql, { signal: input.query.signal });
      const features = rows.map((row) => rowToFeature<TResolved>(row, wantGeometry));
      const degraded = degradedFor(compiled.bboxApproximated, input.sourceId);
      if (input.operation === "queryAll") {
        return {
          features,
          exceededTransferLimit: false,
          totalCount: features.length,
          ...(degraded ? { degraded } : {}),
        };
      }
      const limit = input.query.pagination?.limit;
      return {
        features,
        exceededTransferLimit: typeof limit === "number" && features.length >= limit,
        ...(degraded ? { degraded } : {}),
      };
    },
  };

  const adapterRegistry: Partial<Record<AdapterKind, unknown>> = { geoparquet: handle };

  async function runQuery(request: Query<T> | undefined): Promise<Result<T>> {
    ensureCapability(descriptor, caps, "query");
    const { profile, opts } = await compileOptions();
    if (request?.aggregation) {
      return runAggregate({ ...(request as Query<T>), aggregation: request.aggregation }, profile);
    }
    const wantGeometry = request?.returnGeometry !== false && opts.geometry !== undefined;
    const compiled = compileQuery(request ?? {}, opts);
    const rows = await runtime.query(compiled.sql, { signal: request?.signal });
    const features = rows.map((row) => rowToFeature<T>(row, wantGeometry));
    const limit = request?.pagination?.limit;
    const exceededTransferLimit = typeof limit === "number" && features.length >= limit;
    const degraded = degradedFor(compiled.bboxApproximated);
    return {
      features,
      exceededTransferLimit,
      ...(degraded ? { degraded } : {}),
    };
  }

  async function runAggregate(
    request: Query<T> & { aggregation: AggregationSpec },
    profile?: SourceProfile,
  ): Promise<Result<T>> {
    ensureCapability(descriptor, caps, "queryAggregate");
    const opts = profile
      ? ({
          sources,
          geometryAlias: GEOPARQUET_ALIAS,
          ...(profile.geometry && profile.geometry.runtimeSupported !== false ? { geometry: profile.geometry } : {}),
          ...(profile.columns.length > 0 ? { columns: profile.columns } : {}),
        } satisfies CompileOptions)
      : (await compileOptions()).opts;
    const compiled = compileAggregate(request, opts);
    const rows = await runtime.query(compiled.sql, { signal: request.signal });
    const aggregateRows = rows.map((row) => {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(row)) out[k] = normalizeScalar(v);
      return out;
    });
    const degraded = degradedFor(compiled.bboxApproximated);
    return {
      features: [],
      exceededTransferLimit: false,
      aggregateRows,
      ...(degraded ? { degraded } : {}),
    };
  }

  const unsupported = (capability: Capability): never => {
    throw new HonuaCapabilityNotSupportedError(capability, descriptor.protocol, descriptor.id);
  };

  const source: Source<T> = {
    descriptor: { ...descriptor, capabilities: caps },
    capabilities: caps,
    query(request) {
      return runQuery(request);
    },
    async queryAll(request) {
      // Static parquet has no server paging; a single scan is the whole set.
      // Honor an explicit pagination.limit via the compiled LIMIT.
      const result = await runQuery(request);
      return { ...result, exceededTransferLimit: false, totalCount: result.features.length };
    },
    queryAggregate(request) {
      return runAggregate(request);
    },
    async queryExtent() {
      return unsupported("queryExtent");
    },
    async *stream(request) {
      ensureCapability(descriptor, caps, "stream");
      if (request?.aggregation) {
        yield await runAggregate({ ...(request as Query<T>), aggregation: request.aggregation });
        return;
      }
      const { opts } = await compileOptions();
      const wantGeometry = request?.returnGeometry !== false && opts.geometry !== undefined;
      const compiled = compileQuery(request ?? {}, opts);
      for await (const rows of runtime.stream(compiled.sql, { signal: request?.signal })) {
        const features = rows.map((row) => rowToFeature<T>(row, wantGeometry));
        const degraded = degradedFor(compiled.bboxApproximated);
        yield {
          features,
          exceededTransferLimit: false,
          ...(degraded ? { degraded } : {}),
        };
      }
    },
    async queryObjectIds() {
      return unsupported("queryObjectIds");
    },
    async applyEdits() {
      return unsupported("applyEdits");
    },
    async queryRelated() {
      return unsupported("queryRelated");
    },
    attachments: {
      async query() {
        return unsupported("attachments");
      },
      async list() {
        return unsupported("attachments");
      },
      async add() {
        return unsupported("attachments");
      },
      async update() {
        return unsupported("attachments");
      },
      async delete() {
        return unsupported("attachments");
      },
    },
    protocol<K extends AdapterKind>(kind: K) {
      return adapterRegistry[kind] as never;
    },
    adapter<K extends AdapterKind>(kind: K) {
      return adapterRegistry[kind] as never;
    },
  };
  return addCapabilitySupport(source, descriptor);
}

// ── Resolver (createDataset integration) ──────────────────────

/**
 * A {@link SourceResolver} that also exposes `dispose()` to tear down the
 * shared runtime.
 */
export interface GeoparquetResolver {
  (descriptor: SourceDescriptor, ctx: ResolveSourceContext): Source | undefined;
  /** The shared runtime backing every geoparquet source this resolver builds. */
  readonly runtime: GeoparquetRuntime;
  /** Terminate the shared DuckDB worker. Call when the client is disposed. */
  dispose(): Promise<void>;
}

export interface GeoparquetResolverOptions {
  /** Reuse an existing runtime instead of creating one. */
  readonly runtime?: GeoparquetRuntime;
  /** Driver factory used to build the runtime when none is supplied. */
  readonly driverFactory?: DuckDbDriverFactory;
}

/**
 * Build a resolver for `createDataset({ resolveSource })` that handles
 * `protocol: "geoparquet"` descriptors, sharing one {@link GeoparquetRuntime}
 * (one DuckDB worker) across every geoparquet source in the dataset — the
 * NFR-001 "single shared worker per client" contract.
 *
 * @example
 * ```ts
 * import { createDataset } from "@honua/sdk-js/contract";
 * import { geoparquetResolver } from "@honua/sdk-js/geoparquet";
 *
 * const geoparquet = geoparquetResolver();
 * const dataset = createDataset({
 *   id: "overture",
 *   client,
 *   capabilityPolicy: "degraded",
 *   resolveSource: geoparquet,
 *   sources: [{
 *     id: "places",
 *     protocol: "geoparquet",
 *     locator: { url: "https://example.com/overture/places.parquet" },
 *     capabilities: PROTOCOL_DEFAULT_CAPABILITIES.geoparquet,
 *   }],
 * });
 * const places = dataset.source("places")!;
 * const result = await places.query({ spatialFilter: envelope(-158.5, 21.2, -157.6, 21.7) });
 * // ...later:
 * await geoparquet.dispose();
 * ```
 */
export function geoparquetResolver(options: GeoparquetResolverOptions = {}): GeoparquetResolver {
  const runtime =
    options.runtime ?? new GeoparquetRuntime(options.driverFactory ? { driverFactory: options.driverFactory } : {});
  const fn = (descriptor: SourceDescriptor): Source | undefined => {
    if (descriptor.protocol !== ("geoparquet" satisfies Protocol)) return undefined;
    return geoparquetSource(descriptor, { runtime });
  };
  return Object.assign(fn, { runtime, dispose: () => runtime.dispose() });
}

// Re-assert the public type so `SourceResolver` consumers see the narrow shape.
export type { SourceResolver };
