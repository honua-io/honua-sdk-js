import type { Query, Result, Source } from "../../src/contract/index.js";
import type { HonuaClient } from "../../src/core/client.js";
import type { HonuaServerCompatibility } from "../../src/core/types.js";

/** A promise plus its resolvers, for driving async query timing in tests. */
export interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

export function makeResult(features: Array<Record<string, unknown>> = []): Result {
  return {
    features: features.map((attributes) => ({ attributes })),
    exceededTransferLimit: false,
  };
}

/** A recorded invocation of the fake source's `query`. */
export interface RecordedCall {
  request: Query | undefined;
  signal: AbortSignal | undefined;
  aborted: () => boolean;
}

/** Controllable fake `Source` for driving `useQuery` lifecycle tests. */
export interface ControllableSource {
  source: Source;
  calls: RecordedCall[];
  /** Number of times `query`/`queryAll` was invoked. */
  queryCount: () => number;
  /** Resolve the most recent pending call. */
  resolveLatest: (result: Result) => void;
  /** Reject the most recent pending call. */
  rejectLatest: (error: unknown) => void;
}

export function controllableSource(id = "source-1"): ControllableSource {
  const calls: RecordedCall[] = [];
  const pending: Array<Deferred<Result>> = [];

  const run = (request?: Query): Promise<Result> => {
    const signal = request?.signal;
    calls.push({ request, signal, aborted: () => signal?.aborted ?? false });
    const d = deferred<Result>();
    pending.push(d);
    if (signal) {
      signal.addEventListener("abort", () => d.reject(signal.reason ?? new DOMException("Aborted", "AbortError")));
    }
    return d.promise;
  };

  const source = {
    descriptor: { id, protocol: "geoservices-feature-service", locator: { url: "" }, capabilities: new Set() },
    capabilities: new Set(["query"]),
    query: run,
    queryAll: run,
  } as unknown as Source;

  return {
    source,
    calls,
    queryCount: () => calls.length,
    resolveLatest: (result) => pending[pending.length - 1]?.resolve(result),
    rejectLatest: (error) => pending[pending.length - 1]?.reject(error),
  };
}

/** Minimal fake `HonuaClient` exposing a controllable `getCompatibility`. */
export interface FakeClient {
  client: HonuaClient;
  compatCalls: number;
  resolveCompat: (value: HonuaServerCompatibility) => void;
  rejectCompat: (error: unknown) => void;
}

export function fakeClient(): FakeClient {
  const state = { compatCalls: 0 };
  let d = deferred<HonuaServerCompatibility>();
  const client = {
    getCompatibility: (options?: { signal?: AbortSignal }) => {
      state.compatCalls += 1;
      const current = d;
      options?.signal?.addEventListener("abort", () =>
        current.reject(new DOMException("Aborted", "AbortError")),
      );
      return current.promise;
    },
  } as unknown as HonuaClient;

  return {
    client,
    get compatCalls() {
      return state.compatCalls;
    },
    resolveCompat: (value) => {
      d.resolve(value);
      d = deferred<HonuaServerCompatibility>();
    },
    rejectCompat: (error) => {
      d.reject(error);
      d = deferred<HonuaServerCompatibility>();
    },
  };
}

export const sampleCompatibility: HonuaServerCompatibility = {
  serverVersion: "1.2.3",
  releaseChannel: "stable",
  controlPlaneApi: { major: 1, basePath: "/api/v1/admin", deprecated: false },
  metadataSchemas: [{ version: "v2", deprecated: false }],
  features: {
    metadataResources: true,
    manifestExport: true,
    manifestApply: true,
    manifestDryRun: true,
    manifestPrune: true,
  },
};
