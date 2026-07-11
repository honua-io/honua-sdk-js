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

export interface DuckDbQueryOptions {
  /** Cancels an in-flight DuckDB query when the driver supports cancellation. */
  readonly signal?: AbortSignal;
}

/**
 * Minimal DuckDB surface the GeoParquet `Source` needs. A driver owns exactly
 * one DuckDB instance + connection; `close()` disposes both (and, in the
 * browser, terminates the shared Web Worker).
 */
export interface DuckDbDriver {
  /** Run a statement for its side effect (e.g. `LOAD spatial`). */
  run(sql: string): Promise<void>;
  /** Run a query and materialize every row as a plain object. Prefer `streamQuery` for progressive work. */
  query(sql: string, options?: DuckDbQueryOptions): Promise<DuckRow[]>;
  /** Stream bounded Arrow record batches without materializing the full relation. */
  streamQuery?(sql: string, options?: DuckDbQueryOptions): AsyncIterable<DuckRow[]>;
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
  /** Cancels driver initialization and synchronously terminates any worker already created. */
  readonly signal?: AbortSignal;
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
  /** Load DuckDB's spatial extension. Disable when bbox covering columns are sufficient. Defaults to true. */
  readonly loadSpatial?: boolean;
  /** Optional self-hosted DuckDB extension repository base URL. */
  readonly extensionRepository?: string;
  /** Extensions to install and load before use (for example `parquet`). */
  readonly preloadExtensions?: readonly string[];
  /** Browser filesystem policy. Set `allowFullHttpReads: false` to fail closed when range I/O is unavailable. */
  readonly filesystem?: {
    readonly reliableHeadRequests?: boolean;
    readonly allowFullHttpReads?: boolean;
  };
}

/**
 * Lazily construct a browser-side {@link DuckDbDriver} backed by
 * `@duckdb/duckdb-wasm`. The peer is reached through a dynamic `import()` so it
 * never enters the static graph of `/contract` or `/honua`. Loads the `spatial`
 * extension by default (needed for `ST_Intersects` / `ST_AsGeoJSON`); bbox-only
 * deployments may disable it.
 *
 * @throws if `@duckdb/duckdb-wasm` is not installed.
 */
export async function createBrowserDuckDbDriver(options: BrowserDriverOptions = {}): Promise<DuckDbDriver> {
  const initializationSignal = options.signal;
  const initializationAbortError = () => new DOMException("DuckDB initialization was aborted.", "AbortError");
  if (initializationSignal?.aborted) throw initializationAbortError();
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
  if (initializationSignal?.aborted) throw initializationAbortError();

  const bundle = options.bundle ?? (await duckdb.selectBundle(duckdb.getJsDelivrBundles()));
  if (initializationSignal?.aborted) throw initializationAbortError();
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
  let worker: Worker;
  try {
    worker = new Worker(workerUrl);
  } catch (cause) {
    URL.revokeObjectURL(workerUrl);
    throw cause;
  }
  let db: InstanceType<typeof duckdb.AsyncDuckDB>;
  try {
    db = new duckdb.AsyncDuckDB(logger, worker);
  } catch (cause) {
    URL.revokeObjectURL(workerUrl);
    worker.terminate();
    throw cause;
  }

  function terminateNow(connection?: { close(): Promise<void> }): void {
    worker.terminate();
    if (connection) void connection.close().catch(() => undefined);
    void db.terminate().catch(() => undefined);
  }
  const abortInitialization = () => terminateNow();
  initializationSignal?.addEventListener("abort", abortInitialization, { once: true });

  try {
    await db.instantiate(mainModuleUrl, pthreadWorkerUrl);
    if (options.filesystem) {
      await db.open({
        filesystem: {
          reliableHeadRequests: options.filesystem.reliableHeadRequests,
          allowFullHTTPReads: options.filesystem.allowFullHttpReads,
          forceFullHTTPReads: false,
        },
      });
    }
  } catch (cause) {
    terminateNow();
    throw initializationSignal?.aborted ? initializationAbortError() : cause;
  } finally {
    URL.revokeObjectURL(workerUrl);
  }

  const conn = await db.connect().catch((cause) => {
    terminateNow();
    throw initializationSignal?.aborted ? initializationAbortError() : cause;
  });
  try {
    if (options.extensionRepository) {
      const repository = new URL(options.extensionRepository, base).href.replace(/\/$/, "");
      await conn.query(`SET custom_extension_repository='${repository.replaceAll("'", "''")}';`);
    }
    for (const extension of options.preloadExtensions ?? []) {
      if (!/^[a-z][a-z0-9_]*$/.test(extension)) throw new Error(`geoparquet: invalid extension name ${extension}`);
      await conn.query(`INSTALL ${extension}; LOAD ${extension};`);
    }
    if (options.loadSpatial !== false) await conn.query("INSTALL spatial; LOAD spatial;");
  } catch (cause) {
    terminateNow(conn);
    throw initializationSignal?.aborted ? initializationAbortError() : cause;
  }
  initializationSignal?.removeEventListener("abort", abortInitialization);
  let closePromise: Promise<void> | undefined;

  function abortError(): DOMException {
    return new DOMException("The DuckDB query was aborted.", "AbortError");
  }

  function installCancellation(signal: AbortSignal | undefined): () => void {
    if (!signal) return () => {};
    if (signal.aborted) throw abortError();
    const cancel = () => {
      void conn.cancelSent().catch(() => undefined);
    };
    signal.addEventListener("abort", cancel, { once: true });
    return () => signal.removeEventListener("abort", cancel);
  }

  return {
    async run(sql) {
      await conn.query(sql);
    },
    async query(sql, queryOptions) {
      const removeCancellation = installCancellation(queryOptions?.signal);
      try {
        const table = await conn.query(sql);
        if (queryOptions?.signal?.aborted) throw abortError();
        return table.toArray().map((row: { toJSON(): DuckRow }) => row.toJSON());
      } finally {
        removeCancellation();
      }
    },
    async *streamQuery(sql, queryOptions) {
      const removeCancellation = installCancellation(queryOptions?.signal);
      try {
        const reader = await conn.send(sql, true);
        for await (const batch of reader) {
          if (queryOptions?.signal?.aborted) throw abortError();
          yield batch.toArray().map((row: { toJSON(): DuckRow }) => row.toJSON());
        }
      } finally {
        removeCancellation();
      }
    },
    async registerFileBuffer(name, bytes) {
      await db.registerFileBuffer(name, bytes);
    },
    close() {
      if (!closePromise) {
        terminateNow(conn);
        closePromise = Promise.resolve();
      }
      return closePromise;
    },
  };
}
