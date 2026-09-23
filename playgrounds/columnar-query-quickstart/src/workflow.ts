import {
  createApacheArrowResponseDecoder,
  openColumnarSession,
  type ColumnarWorkflowBudgets,
  type ColumnarWorkflowQuery,
} from "@honua/sdk-js/columnar-workflow";

import {
  HONUA_ARROW_FIXTURE_BYTES,
  HONUA_ARROW_FIXTURE_SERVER_COMMIT,
  honuaArrowFixtureBytes,
} from "./fixture.js";

export const COLUMNAR_BUDGETS: ColumnarWorkflowBudgets = Object.freeze({
  maxRows: 25,
  maxBatches: 2,
  maxTransferBytes: 16 * 1024,
  maxBackingBytes: 64 * 1024,
});

export const COLUMNAR_QUERY = Object.freeze({
  columns: ["objectid", "name", "created", "geometry"],
  bbox: [-158.25, 21.2, -157.65, 21.75],
  filter: {
    kind: "comparison",
    operator: "gte",
    left: { kind: "property", name: "objectid" },
    right: { kind: "literal", value: 1 },
  },
  orderBy: [{ field: "created", direction: "desc" }],
  limit: 25,
} satisfies ColumnarWorkflowQuery);

export interface FixtureRequestEvidence {
  readonly method: string;
  readonly url: string;
}

const abortableDelay = (durationMs: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException("Fixture response was cancelled.", "AbortError"));
      return;
    }
    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, durationMs);
    const abort = () => {
      clearTimeout(timeout);
      reject(new DOMException("Fixture response was cancelled.", "AbortError"));
    };
    signal.addEventListener("abort", abort, { once: true });
  });

export function createFixtureWorkflow(delayMs = 140) {
  if (!Number.isSafeInteger(delayMs) || delayMs < 0 || delayMs > 5_000) {
    throw new Error("Fixture delay must be a safe integer between 0 and 5000 milliseconds.");
  }
  let lastRequest: FixtureRequestEvidence | undefined;
  const session = openColumnarSession(
    {
      kind: "honua-feature-query",
      id: "honua-harbor-arrow-fixture",
      baseUrl: "https://example.invalid/",
      serviceId: "Interoperability/Harbors",
      layerId: 0,
      format: "arrow",
      sourceVersion: HONUA_ARROW_FIXTURE_SERVER_COMMIT,
      schemaVersion: "honua-server-geoarrow-02-point-v1",
      authorizationScope: "public-fixture",
    },
    {
      budgets: COLUMNAR_BUDGETS,
      decodeServerResponse: createApacheArrowResponseDecoder({
        importModule: () => import("apache-arrow"),
      }),
      clientOptions: {
        fetchFn: async (input: RequestInfo | URL, init?: RequestInit) => {
          const request = new Request(input, init);
          lastRequest = Object.freeze({ method: request.method, url: request.url });
          await abortableDelay(delayMs, request.signal);
          const bytes = honuaArrowFixtureBytes();
          const body = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
          return new Response(body, {
            status: 200,
            headers: {
              "content-length": String(HONUA_ARROW_FIXTURE_BYTES),
              "content-type": "application/vnd.apache.arrow.stream",
              "x-honua-fixture": "exact-server-artifact",
            },
          });
        },
      },
    },
  );

  return {
    session,
    get lastRequest(): FixtureRequestEvidence | undefined {
      return lastRequest;
    },
  };
}
