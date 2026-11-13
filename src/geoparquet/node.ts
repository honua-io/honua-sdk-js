/**
 * Native DuckDB factory for Node GeoParquet sources.
 * @experimental
 * @packageDocumentation
 */
import type { DuckDBConnection, DuckDBInstance, DuckDBResult } from "@duckdb/node-api";
import type { DuckDbDriver, DuckDbQueryOptions, DuckRow } from "./driver.js";

export interface NodeDriverOptions {
  readonly signal?: AbortSignal;
  /** Install and load DuckDB's spatial extension (default: true; first use requires network access). */
  readonly loadSpatial?: boolean;
}

function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("GeoParquet query aborted", "AbortError");
}

async function waitForSlot(previous: Promise<void>, signal?: AbortSignal): Promise<void> {
  if (!signal) return previous;
  checkAbort(signal);
  let onAbort!: () => void;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(new DOMException("GeoParquet query aborted", "AbortError"));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    await Promise.race([previous, aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

async function closeNative(instance?: DuckDBInstance, connection?: DuckDBConnection): Promise<void> {
  const results = await Promise.allSettled([
    Promise.resolve().then(() => connection?.closeSync()),
    Promise.resolve().then(() => instance?.closeSync()),
  ]);
  const errors = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
  if (errors.length) throw new AggregateError(errors, "geoparquet: native DuckDB cleanup failed");
}

class NodeDuckDbDriver implements DuckDbDriver {
  private tail = Promise.resolve();
  private closed = false;
  private closePromise?: Promise<void>;
  private stopPausedStream?: () => void;

  constructor(
    private readonly instance: DuckDBInstance,
    private readonly connection: DuckDBConnection,
  ) {}

  private checkOpen(signal?: AbortSignal): void {
    checkAbort(signal);
    if (this.closed) throw new Error("geoparquet: Node driver is closed");
  }

  private async acquire(signal?: AbortSignal): Promise<() => void> {
    this.checkOpen(signal);
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      await waitForSlot(previous, signal);
      this.checkOpen(signal);
      return release;
    } catch (error) {
      // A cancelled waiter still keeps later work behind the active operation.
      void previous.then(release);
      throw error;
    }
  }

  private cancellation(signal?: AbortSignal): () => void {
    const interrupt = () => this.connection.interrupt();
    signal?.addEventListener("abort", interrupt, { once: true });
    return () => signal?.removeEventListener("abort", interrupt);
  }

  async run(sql: string): Promise<void> {
    const release = await this.acquire();
    try {
      this.checkOpen();
      const result = await this.connection.run(sql);
      result.closeSync();
    } finally {
      release();
    }
  }

  async query(sql: string, options?: DuckDbQueryOptions): Promise<DuckRow[]> {
    const release = await this.acquire(options?.signal);
    const removeCancellation = this.cancellation(options?.signal);
    let result: DuckDBResult | undefined;
    try {
      this.checkOpen(options?.signal);
      result = await this.connection.run(sql, options?.parameters ? [...options.parameters] : undefined);
      const rows = await result.getRowObjectsJS();
      this.checkOpen(options?.signal);
      return rows;
    } catch (error) {
      this.checkOpen(options?.signal);
      throw error;
    } finally {
      try {
        result?.closeSync();
      } finally {
        removeCancellation();
        release();
      }
    }
  }

  async *streamQuery(sql: string, options?: DuckDbQueryOptions): AsyncIterable<DuckRow[]> {
    const release = await this.acquire(options?.signal);
    let result: DuckDBResult | undefined;
    let finished = false;
    let cleanupError: unknown;
    let operationFailed = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      this.stopPausedStream = undefined;
      options?.signal?.removeEventListener("abort", cancel);
      try {
        result?.closeSync();
      } catch (error) {
        cleanupError = error;
      } finally {
        release();
      }
    };
    const cancel = () => {
      this.connection.interrupt();
      if (this.stopPausedStream === finish) finish();
    };
    options?.signal?.addEventListener("abort", cancel, { once: true });
    try {
      this.checkOpen(options?.signal);
      result = await this.connection.stream(sql, options?.parameters ? [...options.parameters] : undefined);
      const batches = result.yieldRowObjectJs()[Symbol.asyncIterator]();
      while (true) {
        this.checkOpen(options?.signal);
        const batch = await batches.next();
        this.checkOpen(options?.signal);
        if (batch.done) break;
        this.stopPausedStream = finish;
        yield batch.value;
        if (this.stopPausedStream === finish) this.stopPausedStream = undefined;
      }
    } catch (error) {
      operationFailed = true;
      this.checkOpen(options?.signal);
      throw error;
    } finally {
      finish();
      if (cleanupError && !operationFailed) {
        // biome-ignore lint/correctness/noUnsafeFinally: early iterator return must report cleanup failure; an operation error is preserved.
        throw cleanupError;
      }
    }
  }

  async registerFileBuffer(_name: string, _bytes: Uint8Array): Promise<void> {
    this.checkOpen();
    throw new Error(
      "geoparquet: Node byte registration is unsupported. Write bytes to a file and use its absolute path as the source URL.",
    );
  }

  close(): Promise<void> {
    if (!this.closePromise) {
      this.closed = true;
      this.closePromise = (async () => {
        this.connection.interrupt();
        this.stopPausedStream?.();
        await this.tail;
        await closeNative(this.instance, this.connection);
      })();
    }
    return this.closePromise;
  }
}

/** Create a native DuckDB driver for Node; install the optional @duckdb/node-api peer. */
export async function createNodeDuckDbDriver(options: NodeDriverOptions = {}): Promise<DuckDbDriver> {
  checkAbort(options.signal);
  const { DuckDBInstance } = await import("@duckdb/node-api").catch((cause: unknown) => {
    throw new Error(
      "Cannot load native DuckDB. Install @duckdb/node-api and check that its native binary supports this Node platform.",
      { cause },
    );
  });
  checkAbort(options.signal);
  let instance: DuckDBInstance | undefined;
  let connection: DuckDBConnection | undefined;
  try {
    instance = await DuckDBInstance.create(":memory:");
    connection = await instance.connect();
    const driver = new NodeDuckDbDriver(instance, connection);
    if (options.loadSpatial !== false) await driver.query("INSTALL spatial; LOAD spatial;", { signal: options.signal });
    checkAbort(options.signal);
    return driver;
  } catch (error) {
    try {
      await closeNative(instance, connection);
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "geoparquet: native initialization failed");
    }
    throw error;
  }
}
