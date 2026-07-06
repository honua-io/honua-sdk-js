/**
 * DuckDB driver abstraction for the GeoParquet `Source`. The `Source` is
 * written against {@link DuckDbDriver}, not against `@duckdb/duckdb-wasm`
 * directly, so that (a) the heavy WASM peer is only ever reached through a
 * dynamic `import()` (no static dependency edge from core), and (b) unit tests
 * can drive the real engine through the synchronous Node bindings.
 *
 * @module
 */

/** One result row as a plain object keyed by output column name. */
export type DuckRow = Record<string, unknown>;

/**
 * Minimal DuckDB surface the GeoParquet `Source` needs. A driver owns exactly
 * one DuckDB instance + connection; `close()` disposes both (and, in the
 * browser, terminates the shared Web Worker).
 */
export interface DuckDbDriver {
  /** Run a statement for its side effect (e.g. `LOAD spatial`). */
  run(sql: string): Promise<void>;
  /** Run a query and materialize every row as a plain object. */
  query(sql: string): Promise<DuckRow[]>;
  /**
   * Make a parquet buffer addressable by name inside `read_parquet('name')`.
   * Used by tests and by callers that already hold bytes; HTTP(S) URLs are read
   * directly by DuckDB and need no registration.
   */
  registerFileBuffer(name: string, bytes: Uint8Array): Promise<void>;
  /** Dispose the instance/connection (and worker, in the browser). */
  close(): Promise<void>;
}

/** Options for constructing the browser (duckdb-wasm) driver. */
export interface BrowserDriverOptions {
  /**
   * Explicit CDN/base bundle to instantiate. When omitted, the default jsDelivr
   * bundles that ship with `@duckdb/duckdb-wasm` are selected by
   * `duckdb.selectBundle(getJsDelivrBundles())`. Supply this in bundler setups
   * that self-host the `.wasm` + worker assets.
   */
  readonly bundle?: {
    readonly mainModule: string;
    readonly mainWorker: string;
    readonly pthreadWorker?: string;
  };
  /** Log level passed to the duckdb-wasm `ConsoleLogger`. Defaults to WARNING. */
  readonly logLevel?: "DEBUG" | "INFO" | "WARNING" | "ERROR" | "NONE";
}

/**
 * Lazily construct a browser-side {@link DuckDbDriver} backed by
 * `@duckdb/duckdb-wasm`. The peer is reached through a dynamic `import()` so it
 * never enters the static graph of `/contract` or `/honua`. Loads the `spatial`
 * extension eagerly (needed for `ST_Intersects` / `ST_AsGeoJSON`).
 *
 * @throws if `@duckdb/duckdb-wasm` is not installed.
 */
export async function createBrowserDuckDbDriver(options: BrowserDriverOptions = {}): Promise<DuckDbDriver> {
  let duckdb: typeof import("@duckdb/duckdb-wasm");
  try {
    duckdb = await import("@duckdb/duckdb-wasm");
  } catch (cause) {
    throw new Error(
      "geoparquet: @duckdb/duckdb-wasm is an optional peer dependency and is not installed. " +
        "Install it with `npm i @duckdb/duckdb-wasm` to use the geoparquet Source.",
      { cause: cause instanceof Error ? cause : undefined },
    );
  }

  const bundle = options.bundle ?? (await duckdb.selectBundle(duckdb.getJsDelivrBundles()));
  const logLevelName = options.logLevel ?? "WARNING";
  const logger = new duckdb.ConsoleLogger(duckdb.LogLevel[logLevelName]);

  // The worker is created from a Blob URL so a strict CSP or cross-origin CDN
  // does not block the `new Worker(url)` (the standard duckdb-wasm recipe). The
  // worker script path is resolved to an absolute URL first: `importScripts`
  // inside a `blob:` worker has no document base, so a root-relative or bare
  // path would be rejected as invalid.
  if (!bundle.mainWorker) {
    throw new Error("geoparquet: the selected DuckDB-WASM bundle has no worker script (mainWorker).");
  }
  const base = typeof globalThis !== "undefined" ? globalThis.location?.href : undefined;
  const workerScriptUrl = new URL(bundle.mainWorker, base).href;
  // The wasm module is fetched inside the worker, whose base is the `blob:` URL,
  // so it too must be absolute.
  const mainModuleUrl = new URL(bundle.mainModule, base).href;
  const pthreadWorkerUrl = bundle.pthreadWorker ? new URL(bundle.pthreadWorker, base).href : null;
  const workerUrl = URL.createObjectURL(
    new Blob([`importScripts(${JSON.stringify(workerScriptUrl)});`], { type: "text/javascript" }),
  );
  const worker = new Worker(workerUrl);
  const db = new duckdb.AsyncDuckDB(logger, worker);
  await db.instantiate(mainModuleUrl, pthreadWorkerUrl);
  URL.revokeObjectURL(workerUrl);

  const conn = await db.connect();
  await conn.query("INSTALL spatial; LOAD spatial;");

  return {
    async run(sql) {
      await conn.query(sql);
    },
    async query(sql) {
      const table = await conn.query(sql);
      return table.toArray().map((row: { toJSON(): DuckRow }) => row.toJSON());
    },
    async registerFileBuffer(name, bytes) {
      await db.registerFileBuffer(name, bytes);
    },
    async close() {
      await conn.close();
      await db.terminate();
      worker.terminate();
    },
  };
}
