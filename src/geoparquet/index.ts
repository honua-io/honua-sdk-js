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

import type {
  AdapterKind,
  AggregationSpec,
  Capabilities,
  Capability,
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
      const value = rows[0]?.value;
      if (typeof value === "string") geoJson = value;
      else if (value instanceof Uint8Array) geoJson = new TextDecoder().decode(value);
    } catch {
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
): Source<T> {
  const sources = sourcesFromDescriptor(descriptor);
  const geometryColumnOverride = descriptor.locator.geoparquet?.geometryColumn;
  const caps = descriptor.capabilities ?? PROTOCOL_DEFAULT_CAPABILITIES.geoparquet;
  const runtime =
    options.runtime ?? new GeoparquetRuntime(options.driverFactory ? { driverFactory: options.driverFactory } : {});

  async function compileOptions(): Promise<{ profile: SourceProfile; opts: CompileOptions }> {
    const profile = await runtime.profile(sources, geometryColumnOverride);
    const opts: CompileOptions = {
      sources,
      geometryAlias: GEOPARQUET_ALIAS,
      ...(profile.geometry ? { geometry: profile.geometry } : {}),
      ...(profile.columns.length > 0 ? { columns: profile.columns } : {}),
    };
    return { profile, opts };
  }

  function degradedFor(bboxApproximated: boolean): DegradedReason[] | undefined {
    if (!bboxApproximated) return undefined;
    return [
      {
        capability: "query",
        reason:
          "geoparquet: non-envelope spatialFilter was reduced to its bounding box for predicate pushdown; " +
          "results may include features outside the exact geometry.",
        protocol: "geoparquet",
        sourceId: descriptor.id,
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
        ...(profile.geometry ? { geometryEncoding: profile.geometry.encoding } : {}),
        ...(profile.crs ? { crs: profile.crs } : {}),
        ...(profile.rowEstimate !== undefined ? { rowEstimate: profile.rowEstimate } : {}),
      };
    },
    sql(query: string) {
      return runtime.query(query);
    },
  };

  const adapterRegistry: Partial<Record<AdapterKind, unknown>> = { geoparquet: handle };

  async function runQuery(request: Query<T> | undefined): Promise<Result<T>> {
    ensureCapability(descriptor, caps, "query");
    const { profile, opts } = await compileOptions();
    if (request?.aggregation) {
      return runAggregate({ ...(request as Query<T>), aggregation: request.aggregation }, profile);
    }
    const wantGeometry = request?.returnGeometry !== false && profile.geometry !== undefined;
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
      ? {
          sources,
          geometryAlias: GEOPARQUET_ALIAS,
          ...(profile.geometry ? { geometry: profile.geometry } : {}),
          ...(profile.columns.length > 0 ? { columns: profile.columns } : {}),
        }
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
      const { profile, opts } = await compileOptions();
      const wantGeometry = request?.returnGeometry !== false && profile.geometry !== undefined;
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
  return source;
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
