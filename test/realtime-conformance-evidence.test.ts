import fs from "node:fs";

import addFormats from "ajv-formats";
import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, it, vi } from "vitest";

import {
  REALTIME_CAPABILITY_DOCUMENT_MAX_BYTES,
  REALTIME_LIVE_SEMANTIC_LIMITS,
  REALTIME_SSE_BUFFER_MAX_BYTES,
  REALTIME_SSE_EVENT_MAX_BYTES,
  collectFixtureRealtimeConformanceEvidence,
  collectLiveRealtimeConformanceEvidence,
  collectorFailureRealtimeConformanceEvidence,
  isRealtimeLiveEnabled,
  normalizeLiveCapabilities,
  normalizeLiveEnv,
  summarizeRealtimeConformanceEvidence,
  validateRealtimeConformanceEvidence,
} from "../scripts/realtime-conformance-evidence.mjs";
import * as realtimeSdk from "../src/realtime/index.js";
import type { RealtimeCrossTransportCorpusV1 } from "./helpers/realtime-cross-transport-conformance.js";

const GENERATED_AT = "2026-07-27T12:00:00.000Z";
const SOURCE_REVISION = "0123456789abcdef0123456789abcdef01234567";
const SERVER_REVISION = "89abcdef0123456789abcdef0123456789abcdef";
const SERVER_VERSION = "1.0.0-fixture";
const BASE_URL = "http://127.0.0.1:4318";
const corpus = JSON.parse(
  fs.readFileSync(new URL("./fixtures/realtime/cross-transport-conformance.v1.json", import.meta.url), "utf8"),
) as RealtimeCrossTransportCorpusV1;

const ajv = new Ajv2020.default({ strict: false, allErrors: true });
addFormats.default(ajv);
const validateEvidence = ajv.compile(
  JSON.parse(fs.readFileSync(new URL("../schemas/realtime-conformance-evidence.v1.json", import.meta.url), "utf8")),
);

function expectSchemaValid(document: unknown): void {
  const valid = validateEvidence(document);
  if (!valid) throw new Error(`schema validation failed: ${JSON.stringify(validateEvidence.errors)}`);
  expect(valid).toBe(true);
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function streamedTextResponse(
  chunks: readonly string[],
  options: {
    readonly status?: number;
    readonly contentType: string;
    readonly onCancel?: () => void;
    readonly keepOpen?: boolean;
  },
): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        if (!options.keepOpen) controller.close();
      },
      cancel() {
        options.onCancel?.();
      },
    }),
    {
      status: options.status ?? 200,
      headers: { "content-type": options.contentType },
    },
  );
}

function capabilityDocumentAtBytes(byteLength: number): string {
  const prefix = '{"enabled":false,"padding":"';
  const suffix = '"}';
  const paddingLength = byteLength - new TextEncoder().encode(`${prefix}${suffix}`).byteLength;
  if (paddingLength < 0) throw new Error("capability boundary is too small for the fixture");
  return `${prefix}${"x".repeat(paddingLength)}${suffix}`;
}

function sseBlockAtBytes(event: Record<string, unknown>, byteLength: number): string {
  const empty = `data: ${JSON.stringify({ ...event, padding: "" })}`;
  const paddingLength = byteLength - new TextEncoder().encode(empty).byteLength;
  if (paddingLength < 0) throw new Error("SSE boundary is too small for the fixture");
  const block = `data: ${JSON.stringify({ ...event, padding: "x".repeat(paddingLength) })}`;
  expect(new TextEncoder().encode(block).byteLength).toBe(byteLength);
  return `${block}\n\n`;
}

function multilineSseBlockAtRawBytes(event: Record<string, unknown>, byteLength: number): string {
  const render = (paddingLength: number) => {
    const json = JSON.stringify({ ...event, padding: "x".repeat(paddingLength) });
    const splitAt = json.indexOf(",") + 1;
    if (splitAt < 1) throw new Error("SSE boundary fixture requires at least two JSON fields");
    return `data: ${json.slice(0, splitAt)}\r\ndata: ${json.slice(splitAt)}`;
  };
  const empty = render(0);
  const paddingLength = byteLength - new TextEncoder().encode(empty).byteLength;
  if (paddingLength < 0) throw new Error("SSE raw-wire boundary is too small for the fixture");
  const block = render(paddingLength);
  expect(new TextEncoder().encode(block).byteLength).toBe(byteLength);
  return block;
}

function crlfSplitSseResponse(events: readonly unknown[]): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const event of events) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\r`));
          controller.enqueue(encoder.encode("\n\r"));
          controller.enqueue(encoder.encode("\n"));
        }
      },
    }),
    {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    },
  );
}

const snapshotEvent = {
  type: "snapshot",
  eventId: "live-snapshot-1",
  sequence: 1,
  cursor: "live-secret-cursor-1",
  watermark: "live-secret-watermark-1",
  deltaToken: `${BASE_URL}/odata/Incidents?$deltatoken=live-secret-1`,
  features: [{ id: 1, feature: { Id: 1, status: "open" } }],
};

const deltaEvent = {
  type: "delta",
  eventId: "live-delta-2",
  sequence: 2,
  cursor: "live-secret-cursor-2",
  watermark: "live-secret-watermark-2",
  deltaToken: `${BASE_URL}/odata/Incidents?$deltatoken=live-secret-2`,
  upserts: [{ id: 1, feature: { Id: 1, status: "assigned" } }],
  deletes: [],
};

const replacementSnapshotEvent = {
  ...snapshotEvent,
  eventId: "live-snapshot-2",
  sequence: 2,
  cursor: "live-secret-cursor-2",
  features: [{ id: 1, feature: { Id: 1, status: "assigned" } }],
};

function currentServerSnapshot(
  status = "open",
  options: {
    readonly id?: string | number;
    readonly geometry?: unknown;
    readonly properties?: Readonly<Record<string, unknown>>;
  } = {},
) {
  const id = options.id ?? 1;
  return {
    ...snapshotEvent,
    timestamp: "2026-07-27T12:00:01.000Z",
    features: [
      {
        id,
        sourceId: "incidents",
        feature: {
          type: "Feature",
          id,
          geometry: options.geometry ?? null,
          properties: { Id: typeof id === "number" ? id : Number(id), status, ...options.properties },
        },
      },
    ],
  };
}

function currentServerChange(
  status: string,
  options: {
    readonly id?: string | number;
    readonly geometry?: unknown;
    readonly operation?: "insert" | "update" | "delete";
    readonly sequence?: number;
    readonly properties?: Readonly<Record<string, unknown>>;
  } = {},
) {
  const id = options.id ?? "1";
  const sequence = options.sequence ?? 2;
  const operation = options.operation ?? "update";
  return {
    type: "feature-change",
    serviceId: "incidents",
    featureId: id,
    objectId: typeof id === "number" ? id : Number(id),
    operation,
    version: sequence,
    timestamp: `2026-07-27T12:00:${String(sequence).padStart(2, "0")}.000Z`,
    ...(operation === "delete"
      ? {}
      : {
          geometry: options.geometry ?? null,
          attributes: { Id: typeof id === "number" ? id : Number(id), status, ...options.properties },
        }),
    eventId: `live-${operation}-${String(sequence)}`,
    sequence,
    cursor: `live-secret-cursor-${String(sequence)}`,
    watermark: `live-secret-watermark-${String(sequence)}`,
    deltaToken: `${BASE_URL}/odata/Incidents?$deltatoken=live-secret-${String(sequence)}`,
  };
}

function createScriptedEventSource(events: readonly unknown[] = [snapshotEvent, deltaEvent]) {
  const source = {
    readyState: 0,
    onopen: null as ((event: Event) => void) | null,
    onmessage: null as ((event: MessageEvent<string>) => void) | null,
    onerror: null as ((event: Event) => void) | null,
    close() {
      source.readyState = 2;
    },
  };
  queueMicrotask(() => {
    source.readyState = 1;
    source.onopen?.(new Event("open"));
    for (const event of events) {
      source.onmessage?.({ data: JSON.stringify(event) } as MessageEvent<string>);
    }
  });
  return source;
}

function createDeltaOnlyEventSource() {
  const source = {
    readyState: 0,
    onopen: null as ((event: Event) => void) | null,
    onmessage: null as ((event: MessageEvent<string>) => void) | null,
    onerror: null as ((event: Event) => void) | null,
    close() {
      source.readyState = 2;
    },
  };
  queueMicrotask(() => {
    source.readyState = 1;
    source.onopen?.(new Event("open"));
    source.onmessage?.({ data: JSON.stringify(deltaEvent) } as MessageEvent<string>);
  });
  return source;
}

function createSnapshotOnlyEventSource() {
  const source = {
    readyState: 0,
    onopen: null as ((event: Event) => void) | null,
    onmessage: null as ((event: MessageEvent<string>) => void) | null,
    onerror: null as ((event: Event) => void) | null,
    close() {
      source.readyState = 2;
    },
  };
  queueMicrotask(() => {
    source.readyState = 1;
    source.onopen?.(new Event("open"));
    source.onmessage?.({ data: JSON.stringify(snapshotEvent) } as MessageEvent<string>);
    source.onmessage?.({ data: JSON.stringify(replacementSnapshotEvent) } as MessageEvent<string>);
  });
  return source;
}

function createSilentEventSource() {
  const source = {
    readyState: 0,
    onopen: null as ((event: Event) => void) | null,
    onmessage: null as ((event: MessageEvent<string>) => void) | null,
    onerror: null as ((event: Event) => void) | null,
    close() {
      source.readyState = 2;
    },
  };
  return source;
}

function createScriptedWebSocket(events: readonly unknown[] = [snapshotEvent, deltaEvent]) {
  const socket = {
    onopen: null as ((event: Event) => void) | null,
    onmessage: null as ((event: MessageEvent<string>) => void) | null,
    onerror: null as ((event: Event) => void) | null,
    onclose: null as ((event: CloseEvent) => void) | null,
    send() {},
    close() {},
  };
  queueMicrotask(() => {
    socket.onopen?.(new Event("open"));
    for (const event of events) {
      socket.onmessage?.({ data: JSON.stringify(event) } as MessageEvent<string>);
    }
  });
  return socket;
}

function createDeltaOnlyWebSocket() {
  const socket = {
    onopen: null as ((event: Event) => void) | null,
    onmessage: null as ((event: MessageEvent<string>) => void) | null,
    onerror: null as ((event: Event) => void) | null,
    onclose: null as ((event: CloseEvent) => void) | null,
    send() {},
    close() {},
  };
  queueMicrotask(() => {
    socket.onopen?.(new Event("open"));
    socket.onmessage?.({ data: JSON.stringify(deltaEvent) } as MessageEvent<string>);
  });
  return socket;
}

function createSnapshotOnlyWebSocket() {
  const socket = {
    onopen: null as ((event: Event) => void) | null,
    onmessage: null as ((event: MessageEvent<string>) => void) | null,
    onerror: null as ((event: Event) => void) | null,
    onclose: null as ((event: CloseEvent) => void) | null,
    send() {},
    close() {},
  };
  queueMicrotask(() => {
    socket.onopen?.(new Event("open"));
    socket.onmessage?.({ data: JSON.stringify(snapshotEvent) } as MessageEvent<string>);
    socket.onmessage?.({ data: JSON.stringify(replacementSnapshotEvent) } as MessageEvent<string>);
  });
  return socket;
}

function createClosingWebSocket() {
  const socket = {
    onopen: null as ((event: Event) => void) | null,
    onmessage: null as ((event: MessageEvent<string>) => void) | null,
    onerror: null as ((event: Event) => void) | null,
    onclose: null as ((event: CloseEvent) => void) | null,
    send() {},
    close() {},
  };
  queueMicrotask(() => {
    socket.onclose?.({ code: 1006, wasClean: false } as CloseEvent);
  });
  return socket;
}

function commonLiveOptions(overrides: Record<string, unknown> = {}) {
  return {
    enabled: true,
    generatedAt: GENERATED_AT,
    sourceRevision: SOURCE_REVISION,
    baseUrl: BASE_URL,
    serverVersion: SERVER_VERSION,
    serverRevision: SERVER_REVISION,
    timeoutMs: 1_000,
    sdk: realtimeSdk,
    corpus,
    corpusBytes: Buffer.from(JSON.stringify(corpus)),
    ...overrides,
  };
}

function collectStubFixtureEvidence() {
  const scenarios = corpus.scenarios.map((scenario) => ({
    id: scenario.id,
    transports: ["sse", "websocket", "odata"].map((transport) => ({
      transport,
      result: "passed",
    })),
  }));
  return collectFixtureRealtimeConformanceEvidence({
    generatedAt: GENERATED_AT,
    sourceRevision: SOURCE_REVISION,
    sdk: {},
    corpus,
    corpusBytes: Buffer.from(JSON.stringify(corpus)),
    runMatrix: () =>
      Promise.resolve({
        scenarioCount: corpus.scenarios.length,
        transportCount: 3,
        executionCount: corpus.scenarios.length * 3,
        persistedReplay: {
          sameScopeCompatible: true,
          checkpointLoads: 2,
          connectionAttempts: 2,
          resumedSequence: corpus.positions.snapshot.sequence,
          acceptedSequence: corpus.positions.delta.sequence,
          cursorReplayed: true,
          watermarkReplayed: true,
        },
        scenarios,
      }),
  });
}

describe("realtime conformance evidence", () => {
  it("executes and validates all fixture scenarios for all transport identities", async () => {
    const evidence = await collectStubFixtureEvidence();

    expectSchemaValid(evidence);
    expect(evidence.summary).toMatchObject({
      status: "executed",
      scenarioCount: 10,
      executionCount: 30,
      executed: 3,
    });
    expect(summarizeRealtimeConformanceEvidence(evidence)).toContain(
      "odata: executed (10/10 scenarios, freshness=poll)",
    );
  });

  it("rejects contradictory retained summary, transport, and executed-revision semantics", async () => {
    const contradictorySummary = structuredClone(await collectStubFixtureEvidence());
    Reflect.set(contradictorySummary.summary, "status", "unsupported");
    expect(() => validateRealtimeConformanceEvidence(contradictorySummary)).toThrow(
      /summary status contradicts transport outcomes/u,
    );

    const contradictoryTransport = structuredClone(await collectStubFixtureEvidence());
    Reflect.set(contradictoryTransport.transports[0]!, "status", "failed");
    expect(() => validateRealtimeConformanceEvidence(contradictoryTransport)).toThrow(
      /failed status contradicts its scenario results/u,
    );

    const missingExecutedRevision = structuredClone(await collectStubFixtureEvidence());
    Reflect.set(missingExecutedRevision.server, "revision", null);
    expect(() => validateRealtimeConformanceEvidence(missingExecutedRevision)).toThrow(
      /Realtime evidence violates|requires an immutable server revision/u,
    );

    const mutableVersionAsRevision = structuredClone(await collectStubFixtureEvidence());
    Reflect.set(mutableVersionAsRevision.server, "revision", "1.0.0");
    expect(() => validateRealtimeConformanceEvidence(mutableVersionAsRevision)).toThrow(
      /Realtime evidence violates|full commit SHA|image digest/u,
    );

    const contradictoryCapabilities = structuredClone(await collectStubFixtureEvidence());
    Reflect.set(contradictoryCapabilities.server.capabilities, "sse", false);
    expect(() => validateRealtimeConformanceEvidence(contradictoryCapabilities)).toThrow(
      /sse advertisement contradicts server capabilities/u,
    );
  });

  it("classifies an opt-out as degraded rather than silently passing", async () => {
    expect(isRealtimeLiveEnabled({ HONUA_REALTIME_LIVE_CONFORMANCE_ENABLED: "true" })).toBe(true);
    const evidence = await collectLiveRealtimeConformanceEvidence({
      ...commonLiveOptions(),
      enabled: false,
    });

    expectSchemaValid(evidence);
    expect(evidence.summary).toMatchObject({ status: "degraded", degraded: 3, executionCount: 0 });
    expect(evidence.transports.every((transport) => transport.status === "degraded")).toBe(true);
  });

  it("classifies an unavailable capability contract as explicitly unsupported", async () => {
    const evidence = await collectLiveRealtimeConformanceEvidence({
      ...commonLiveOptions(),
      fetchFn: () => Promise.resolve(jsonResponse({}, 404)),
    });

    expectSchemaValid(evidence);
    expect(evidence.summary).toMatchObject({ status: "unsupported", unsupported: 3 });
    expect(evidence.transports[0]?.diagnostics[0]?.code).toBe("capability-endpoint-unavailable");
  });

  it.each([{}, { transports: {} }, { transports: [{ id: 42 }] }])(
    "fails closed when a successful capability response violates its contract shape",
    async (payload) => {
      const evidence = await collectLiveRealtimeConformanceEvidence({
        ...commonLiveOptions(),
        fetchFn: () => Promise.resolve(jsonResponse(payload)),
      });

      expectSchemaValid(evidence);
      expect(evidence.summary).toMatchObject({ status: "failed", failed: 3, unsupported: 0 });
      expect(evidence.transports[0]?.diagnostics[0]).toMatchObject({
        code: "capability-contract-invalid",
        message: "Realtime capability response failed contract validation.",
      });
    },
  );

  it("does not certify an advertised transport without an exact server revision", async () => {
    const eventSourceFactory = vi.fn(() => createScriptedEventSource());
    const evidence = await collectLiveRealtimeConformanceEvidence({
      ...commonLiveOptions({ serverRevision: undefined }),
      fetchFn: () =>
        Promise.resolve(
          jsonResponse({
            transports: [{ id: "sse", url: `${BASE_URL}/stream` }],
          }),
        ),
      eventSourceFactory,
    });

    expectSchemaValid(evidence);
    expect(evidence.server.revision).toBeNull();
    expect(evidence.summary).toMatchObject({ status: "failed", failed: 1, unsupported: 2, executed: 0 });
    expect(evidence.transports[0]?.diagnostics[0]?.code).toBe("server-revision-missing");
    expect(eventSourceFactory).not.toHaveBeenCalled();
  });

  it("does not substitute a configured revision when the server publishes no immutable identity", async () => {
    const eventSourceFactory = vi.fn(() => createScriptedEventSource());
    const evidence = await collectLiveRealtimeConformanceEvidence({
      ...commonLiveOptions(),
      fetchFn: (input: string | URL | Request) => {
        const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
        return Promise.resolve(
          url.pathname.endsWith("/capabilities")
            ? jsonResponse({
                serverVersion: SERVER_VERSION,
                transports: [{ id: "sse", url: `${BASE_URL}/stream` }],
              })
            : jsonResponse({}, 404),
        );
      },
      eventSourceFactory,
    });

    expectSchemaValid(evidence);
    expect(evidence.server.revision).toBeNull();
    expect(evidence.summary).toMatchObject({ status: "failed", failed: 1, unsupported: 2, executed: 0 });
    expect(evidence.transports[0]?.diagnostics[0]?.code).toBe("server-revision-missing");
    expect(eventSourceFactory).not.toHaveBeenCalled();
  });

  it("fails advertised transports when configured and observed immutable revisions differ", async () => {
    const eventSourceFactory = vi.fn(() => createScriptedEventSource());
    const observedRevision = "fedcba9876543210fedcba9876543210fedcba98";
    const evidence = await collectLiveRealtimeConformanceEvidence({
      ...commonLiveOptions(),
      fetchFn: () =>
        Promise.resolve(
          jsonResponse({
            serverVersion: SERVER_VERSION,
            serverRevision: observedRevision,
            transports: [{ id: "sse", url: `${BASE_URL}/stream` }],
          }),
        ),
      eventSourceFactory,
    });

    expectSchemaValid(evidence);
    expect(evidence.server).toMatchObject({
      version: SERVER_VERSION,
      revision: observedRevision,
    });
    expect(evidence.summary).toMatchObject({ status: "failed", failed: 1, unsupported: 2, executed: 0 });
    expect(evidence.transports[0]?.diagnostics[0]?.code).toBe("server-revision-mismatch");
    expect(eventSourceFactory).not.toHaveBeenCalled();
  });

  it("treats capability authorization failure as failed rather than unsupported", async () => {
    const evidence = await collectLiveRealtimeConformanceEvidence({
      ...commonLiveOptions(),
      fetchFn: () => Promise.resolve(jsonResponse({}, 403)),
    });

    expectSchemaValid(evidence);
    expect(evidence.summary).toMatchObject({ status: "failed", failed: 3, unsupported: 0 });
    expect(evidence.transports[0]?.diagnostics[0]?.code).toBe("capability-access-failed");
  });

  it.each([429, 500, 501, 503])("classifies HTTP %s capability availability as degraded", async (status) => {
    const evidence = await collectLiveRealtimeConformanceEvidence({
      ...commonLiveOptions(),
      fetchFn: () => Promise.resolve(jsonResponse({}, status)),
    });

    expectSchemaValid(evidence);
    expect(evidence.summary).toMatchObject({ status: "degraded", degraded: 3 });
    expect(evidence.transports[0]?.diagnostics[0]?.code).toBe("capability-probe-degraded");
  });

  it("does not retain invalid capability JSON parser excerpts", async () => {
    const evidence = await collectLiveRealtimeConformanceEvidence({
      ...commonLiveOptions(),
      fetchFn: () =>
        Promise.resolve(
          new Response("sekrit818", {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        ),
    });

    expectSchemaValid(evidence);
    expect(evidence.summary).toMatchObject({ status: "failed", failed: 3 });
    expect(evidence.transports[0]?.diagnostics[0]).toMatchObject({
      code: "capability-json-invalid",
      message: "Realtime capability endpoint returned invalid JSON.",
    });
    expect(JSON.stringify(evidence)).not.toContain("sekrit818");
  });

  it("accepts a capability document exactly at the byte ceiling", async () => {
    const body = capabilityDocumentAtBytes(REALTIME_CAPABILITY_DOCUMENT_MAX_BYTES);
    const evidence = await collectLiveRealtimeConformanceEvidence({
      ...commonLiveOptions({ serverRevision: undefined }),
      fetchFn: () =>
        Promise.resolve(
          streamedTextResponse([body], {
            contentType: "application/json",
          }),
        ),
    });

    expectSchemaValid(evidence);
    expect(evidence.summary).toMatchObject({ status: "unsupported", unsupported: 3 });
  });

  it("cancels and fails closed above the capability byte ceiling", async () => {
    const cancelled = vi.fn();
    const body = capabilityDocumentAtBytes(REALTIME_CAPABILITY_DOCUMENT_MAX_BYTES + 1);
    const evidence = await collectLiveRealtimeConformanceEvidence({
      ...commonLiveOptions(),
      fetchFn: () =>
        Promise.resolve(
          streamedTextResponse([body], {
            contentType: "application/json",
            onCancel: cancelled,
            keepOpen: true,
          }),
        ),
    });

    expectSchemaValid(evidence);
    expect(evidence.summary).toMatchObject({ status: "failed", failed: 3 });
    expect(evidence.transports[0]?.diagnostics[0]?.code).toBe("capability-response-too-large");
    expect(cancelled).toHaveBeenCalledTimes(1);
  });

  it("accepts an SSE event and pending buffer exactly at their byte ceilings", async () => {
    const cancelled = vi.fn();
    const exactSnapshotBlock = multilineSseBlockAtRawBytes(snapshotEvent, REALTIME_SSE_EVENT_MAX_BYTES);
    const evidence = await collectLiveRealtimeConformanceEvidence({
      ...commonLiveOptions(),
      fetchFn: (input: string | URL | Request) => {
        const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
        if (url.pathname.endsWith("/capabilities")) {
          return Promise.resolve(
            jsonResponse({
              serverVersion: SERVER_VERSION,
              serverRevision: SERVER_REVISION,
              transports: [{ id: "sse", url: `${BASE_URL}/stream` }],
            }),
          );
        }
        if (url.pathname.endsWith("/manifest")) {
          return Promise.resolve(
            jsonResponse({ server: { serverVersion: SERVER_VERSION, serverRevision: SERVER_REVISION } }),
          );
        }
        return Promise.resolve(
          streamedTextResponse([exactSnapshotBlock, "\r", "\n\r", `\ndata: ${JSON.stringify(deltaEvent)}\n\n`], {
            contentType: "text/event-stream",
            onCancel: cancelled,
            keepOpen: true,
          }),
        );
      },
    });

    expectSchemaValid(evidence);
    expect(evidence.summary).toMatchObject({ status: "executed", executed: 1, unsupported: 2 });
    expect(evidence.transports[0]?.diagnostics[0]?.code).toBe("contract-events-accepted");
    expect(cancelled).toHaveBeenCalledTimes(1);
  });

  it("rejects a raw CRLF event above the ceiling before newline normalization can hide the extra byte", async () => {
    const cancelled = vi.fn();
    const oversizedRawBlock = multilineSseBlockAtRawBytes(snapshotEvent, REALTIME_SSE_EVENT_MAX_BYTES + 1);
    expect(new TextEncoder().encode(oversizedRawBlock.replaceAll("\r\n", "\n")).byteLength).toBe(
      REALTIME_SSE_EVENT_MAX_BYTES,
    );
    const interiorCrLf = oversizedRawBlock.indexOf("\r\n");
    const evidence = await collectLiveRealtimeConformanceEvidence({
      ...commonLiveOptions(),
      fetchFn: (input: string | URL | Request) => {
        const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
        if (url.pathname.endsWith("/capabilities")) {
          return Promise.resolve(
            jsonResponse({
              serverVersion: SERVER_VERSION,
              serverRevision: SERVER_REVISION,
              transports: [{ id: "sse", url: `${BASE_URL}/stream` }],
            }),
          );
        }
        if (url.pathname.endsWith("/manifest")) {
          return Promise.resolve(
            jsonResponse({ server: { serverVersion: SERVER_VERSION, serverRevision: SERVER_REVISION } }),
          );
        }
        return Promise.resolve(
          streamedTextResponse(
            [
              oversizedRawBlock.slice(0, interiorCrLf + 1),
              oversizedRawBlock.slice(interiorCrLf + 1),
              `\r\n\r\ndata: ${JSON.stringify(deltaEvent)}\n\n`,
            ],
            {
              contentType: "text/event-stream",
              onCancel: cancelled,
              keepOpen: true,
            },
          ),
        );
      },
    });

    expectSchemaValid(evidence);
    expect(evidence.summary).toMatchObject({ status: "failed", failed: 1, unsupported: 2 });
    expect(evidence.transports[0]?.diagnostics[0]?.code).toBe("invalid-event");
    expect(cancelled).toHaveBeenCalledTimes(1);
  });

  it("cancels and fails closed above the SSE event byte ceiling", async () => {
    const cancelled = vi.fn();
    const oversizedBlock = sseBlockAtBytes(snapshotEvent, REALTIME_SSE_EVENT_MAX_BYTES + 1);
    const evidence = await collectLiveRealtimeConformanceEvidence({
      ...commonLiveOptions(),
      fetchFn: (input: string | URL | Request) => {
        const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
        if (url.pathname.endsWith("/capabilities")) {
          return Promise.resolve(
            jsonResponse({
              serverVersion: SERVER_VERSION,
              serverRevision: SERVER_REVISION,
              transports: [{ id: "sse", url: `${BASE_URL}/stream` }],
            }),
          );
        }
        if (url.pathname.endsWith("/manifest")) {
          return Promise.resolve(
            jsonResponse({ server: { serverVersion: SERVER_VERSION, serverRevision: SERVER_REVISION } }),
          );
        }
        return Promise.resolve(
          streamedTextResponse([oversizedBlock], {
            contentType: "text/event-stream",
            onCancel: cancelled,
            keepOpen: true,
          }),
        );
      },
    });

    expectSchemaValid(evidence);
    expect(evidence.summary).toMatchObject({ status: "failed", failed: 1, unsupported: 2 });
    expect(evidence.transports[0]?.diagnostics[0]?.code).toBe("invalid-event");
    expect(cancelled).toHaveBeenCalledTimes(1);
  });

  it("cancels and fails closed above the incomplete SSE buffer byte ceiling", async () => {
    const cancelled = vi.fn();
    const evidence = await collectLiveRealtimeConformanceEvidence({
      ...commonLiveOptions(),
      fetchFn: (input: string | URL | Request) => {
        const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
        if (url.pathname.endsWith("/capabilities")) {
          return Promise.resolve(
            jsonResponse({
              serverVersion: SERVER_VERSION,
              serverRevision: SERVER_REVISION,
              transports: [{ id: "sse", url: `${BASE_URL}/stream` }],
            }),
          );
        }
        if (url.pathname.endsWith("/manifest")) {
          return Promise.resolve(
            jsonResponse({ server: { serverVersion: SERVER_VERSION, serverRevision: SERVER_REVISION } }),
          );
        }
        return Promise.resolve(
          streamedTextResponse(["x".repeat(REALTIME_SSE_BUFFER_MAX_BYTES + 1)], {
            contentType: "text/event-stream",
            onCancel: cancelled,
            keepOpen: true,
          }),
        );
      },
    });

    expectSchemaValid(evidence);
    expect(evidence.summary).toMatchObject({ status: "failed", failed: 1, unsupported: 2 });
    expect(evidence.transports[0]?.diagnostics[0]?.code).toBe("invalid-event");
    expect(cancelled).toHaveBeenCalledTimes(1);
  });

  it("classifies a capability-probe outage as degraded", async () => {
    const evidence = await collectLiveRealtimeConformanceEvidence({
      ...commonLiveOptions(),
      fetchFn: () => Promise.reject(new TypeError("sekrit818 network detail")),
    });

    expectSchemaValid(evidence);
    expect(evidence.summary).toMatchObject({ status: "degraded", degraded: 3 });
    expect(evidence.transports[0]?.diagnostics[0]?.message).toBe(
      "Realtime capability probe was unavailable because of a network failure.",
    );
    expect(JSON.stringify(evidence)).not.toContain("sekrit818");
  });

  it("classifies a bounded capability timeout as degraded without retaining abort detail", async () => {
    const evidence = await collectLiveRealtimeConformanceEvidence({
      ...commonLiveOptions({ timeoutMs: 10 }),
      fetchFn: (_input: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new TypeError("sekrit818 timeout detail")), {
            once: true,
          });
        }),
    });

    expectSchemaValid(evidence);
    expect(evidence.summary).toMatchObject({ status: "degraded", degraded: 3 });
    expect(evidence.transports[0]?.diagnostics[0]?.code).toBe("capability-timeout");
    expect(JSON.stringify(evidence)).not.toContain("sekrit818");
  });

  it("executes advertised SSE, WebSocket, and OData with equivalent non-null geometry", async () => {
    let odataPoll = 0;
    const initialGeometry = { type: "Point", coordinates: [-157.8583, 21.3069] };
    const assignedGeometry = { type: "Point", coordinates: [-157.857, 21.308] };
    const initialSourceFields = {
      sourceVersion: 1,
      sourceUpdatedAt: "2026-07-27T11:59:59.000Z",
    };
    const assignedSourceFields = {
      sourceVersion: 2,
      sourceUpdatedAt: "2026-07-27T12:00:01.000Z",
    };
    const fetchFn = (input: string | URL | Request): Promise<Response> => {
      const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
      if (url.pathname.endsWith("/capabilities")) {
        return Promise.resolve(
          jsonResponse({
            serverVersion: SERVER_VERSION,
            serverRevision: SERVER_REVISION,
            transports: [
              { id: "sse", url: `${BASE_URL}/stream` },
              { id: "websocket", url: "ws://127.0.0.1:4318/stream" },
              {
                id: "odata",
                url: `${BASE_URL}/odata/Incidents`,
                entityIdField: "Id",
                pollIntervalMs: 1,
              },
            ],
          }),
        );
      }
      odataPoll += 1;
      return Promise.resolve(
        jsonResponse(
          odataPoll === 1
            ? {
                value: [{ Id: 1, status: "open", geometry: initialGeometry, ...initialSourceFields }],
                "@odata.deltaLink": `${BASE_URL}/odata/Incidents?$deltatoken=1`,
              }
            : {
                value: [{ Id: 1, status: "assigned", geometry: assignedGeometry, ...assignedSourceFields }],
                "@odata.deltaLink": `${BASE_URL}/odata/Incidents?$deltatoken=2`,
              },
        ),
      );
    };
    const evidence = await collectLiveRealtimeConformanceEvidence(
      commonLiveOptions({
        fetchFn,
        eventSourceFactory: () =>
          createScriptedEventSource([
            currentServerSnapshot("open", {
              geometry: initialGeometry,
              properties: initialSourceFields,
            }),
            currentServerChange("assigned", {
              geometry: assignedGeometry,
              properties: assignedSourceFields,
            }),
          ]),
        webSocketFactory: () =>
          createScriptedWebSocket([
            currentServerSnapshot("open", {
              geometry: initialGeometry,
              properties: initialSourceFields,
            }),
            currentServerChange("assigned", {
              geometry: assignedGeometry,
              properties: assignedSourceFields,
            }),
          ]),
      }),
    );

    expectSchemaValid(evidence);
    expect(evidence.summary).toMatchObject({
      status: "executed",
      executed: 3,
      executionCount: 3,
      scenarioCount: 1,
    });
    expect(evidence.server).toMatchObject({
      version: SERVER_VERSION,
      revision: SERVER_REVISION,
    });
    expect(evidence.transports.map((transport) => [transport.id, transport.freshness])).toEqual([
      ["sse", "push"],
      ["websocket", "push"],
      ["odata", "poll"],
    ]);
    expect(JSON.stringify(evidence)).not.toContain("live-secret");
    expect(odataPoll).toBeGreaterThanOrEqual(2);
    expect(evidence.transports[0]?.diagnostics[0]?.message).toMatch(
      /normalized state-transition history sha256:[a-f0-9]{64}, final state sha256:[a-f0-9]{64}/u,
    );
    expect(evidence.transports.map((transport) => transport.acceptedState)).toEqual([
      evidence.transports[0]?.acceptedState,
      evidence.transports[0]?.acceptedState,
      evidence.transports[0]?.acceptedState,
    ]);

    const reorderedEvidence = structuredClone(evidence);
    if (!reorderedEvidence.transports[1]?.acceptedState) throw new Error("expected accepted-state evidence");
    Reflect.set(reorderedEvidence.transports[1], "acceptedState", {
      finalStateSha256: reorderedEvidence.transports[1].acceptedState.finalStateSha256,
      historySha256: reorderedEvidence.transports[1].acceptedState.historySha256,
      eventCount: reorderedEvidence.transports[1].acceptedState.eventCount,
    });
    expect(validateRealtimeConformanceEvidence(reorderedEvidence)).toBe(reorderedEvidence);

    const divergentEvidence = structuredClone(evidence);
    if (!divergentEvidence.transports[1]?.acceptedState) throw new Error("expected accepted-state evidence");
    Reflect.set(divergentEvidence.transports[1].acceptedState, "historySha256", `sha256:${"0".repeat(64)}`);
    expect(() => validateRealtimeConformanceEvidence(divergentEvidence)).toThrow(/accepted divergent histories/u);
  });

  it.each([
    {
      label: "geometry",
      events: [
        currentServerSnapshot(),
        currentServerChange("assigned", {
          geometry: { type: "Point", coordinates: [-157.85, 21.3] },
        }),
      ],
    },
    {
      label: "attributes",
      events: [currentServerSnapshot(), currentServerChange("closed")],
    },
    {
      label: "identity",
      events: [currentServerSnapshot(), currentServerChange("assigned", { id: "2" })],
    },
    {
      label: "deletion",
      events: [currentServerSnapshot(), currentServerChange("", { operation: "delete" })],
    },
  ])("fails all executed transports for a genuine $label divergence after wire normalization", async ({ events }) => {
    let odataPoll = 0;
    const evidence = await collectLiveRealtimeConformanceEvidence(
      commonLiveOptions({
        fetchFn: (input: string | URL | Request) => {
          const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
          if (url.pathname.endsWith("/capabilities")) {
            return Promise.resolve(
              jsonResponse({
                serverVersion: SERVER_VERSION,
                serverRevision: SERVER_REVISION,
                transports: [
                  { id: "sse", url: `${BASE_URL}/stream` },
                  { id: "websocket", url: "ws://127.0.0.1:4318/stream" },
                  {
                    id: "odata",
                    url: `${BASE_URL}/odata/Incidents`,
                    entityIdField: "Id",
                    pollIntervalMs: 1,
                  },
                ],
              }),
            );
          }
          odataPoll += 1;
          return Promise.resolve(
            jsonResponse(
              odataPoll === 1
                ? {
                    value: [{ Id: 1, status: "open" }],
                    "@odata.deltaLink": `${BASE_URL}/odata/Incidents?$deltatoken=1`,
                  }
                : {
                    value: [{ Id: 1, status: "assigned" }],
                    "@odata.deltaLink": `${BASE_URL}/odata/Incidents?$deltatoken=2`,
                  },
            ),
          );
        },
        eventSourceFactory: () => createScriptedEventSource([currentServerSnapshot(), currentServerChange("assigned")]),
        webSocketFactory: () => createScriptedWebSocket(events),
      }),
    );

    expectSchemaValid(evidence);
    expect(evidence.summary).toMatchObject({ status: "failed", failed: 3, executed: 0 });
    expect(evidence.transports.map((transport) => transport.diagnostics[0]?.code)).toEqual([
      "cross-transport-state-divergence",
      "cross-transport-state-divergence",
      "cross-transport-state-divergence",
    ]);
  });

  it("retains cross-event mutation order while excluding transport routing wrappers", async () => {
    const finalChange = currentServerChange("resolved", { sequence: 4 });
    const evidence = await collectLiveRealtimeConformanceEvidence(
      commonLiveOptions({
        fetchFn: () =>
          Promise.resolve(
            jsonResponse({
              serverVersion: SERVER_VERSION,
              serverRevision: SERVER_REVISION,
              transports: [
                { id: "sse", url: `${BASE_URL}/stream` },
                { id: "websocket", url: "ws://127.0.0.1:4318/stream" },
              ],
            }),
          ),
        eventSourceFactory: () =>
          createScriptedEventSource([
            currentServerSnapshot(),
            currentServerChange("assigned"),
            currentServerChange("closed", { sequence: 3 }),
            finalChange,
          ]),
        webSocketFactory: () =>
          createScriptedWebSocket([
            currentServerSnapshot(),
            currentServerChange("closed"),
            currentServerChange("assigned", { sequence: 3 }),
            finalChange,
          ]),
      }),
    );

    expectSchemaValid(evidence);
    expect(evidence.summary).toMatchObject({ status: "failed", failed: 2, unsupported: 1, executed: 0 });
    expect(evidence.transports.slice(0, 2).map((transport) => transport.diagnostics[0]?.code)).toEqual([
      "cross-transport-state-divergence",
      "cross-transport-state-divergence",
    ]);
    expect(
      new Set(evidence.transports.slice(0, 2).map((transport) => transport.acceptedState?.finalStateSha256)).size,
    ).toBe(1);
    expect(
      new Set(evidence.transports.slice(0, 2).map((transport) => transport.acceptedState?.historySha256)).size,
    ).toBe(2);
  });

  it.each([
    {
      label: "depth",
      buildSnapshot() {
        let payload: unknown = "sekrit818";
        for (let index = 0; index <= REALTIME_LIVE_SEMANTIC_LIMITS.maxDepth; index += 1) {
          payload = { nested: payload };
        }
        const snapshot = structuredClone(currentServerSnapshot());
        Reflect.set(snapshot.features[0]!.feature.properties, "payload", payload);
        return snapshot;
      },
    },
    {
      label: "object-key count",
      buildSnapshot() {
        const snapshot = structuredClone(currentServerSnapshot());
        const properties = Object.fromEntries(
          Array.from({ length: REALTIME_LIVE_SEMANTIC_LIMITS.maxObjectKeys + 1 }, (_, index) => [
            `field-${String(index)}`,
            index,
          ]),
        );
        Reflect.set(snapshot.features[0]!.feature, "properties", properties);
        return snapshot;
      },
    },
    {
      label: "string bytes",
      buildSnapshot() {
        const snapshot = structuredClone(currentServerSnapshot());
        Reflect.set(
          snapshot.features[0]!.feature.properties,
          "payload",
          `sekrit818-${"x".repeat(REALTIME_LIVE_SEMANTIC_LIMITS.maxStringBytes)}`,
        );
        return snapshot;
      },
    },
    {
      label: "feature count",
      buildSnapshot() {
        const snapshot = structuredClone(currentServerSnapshot());
        Reflect.set(
          snapshot,
          "features",
          Array.from({ length: REALTIME_LIVE_SEMANTIC_LIMITS.maxFeaturesPerEvent + 1 }, (_, index) => ({
            id: index,
            feature: { Id: index, status: "open" },
          })),
        );
        return snapshot;
      },
    },
    {
      label: "geometry positions",
      buildSnapshot() {
        return currentServerSnapshot("open", {
          geometry: {
            type: "MultiPoint",
            coordinates: Array.from({ length: REALTIME_LIVE_SEMANTIC_LIMITS.maxGeometryPositions + 1 }, (_, index) => [
              index,
              index,
            ]),
          },
        });
      },
    },
    {
      label: "malformed geometry",
      buildSnapshot() {
        return currentServerSnapshot("open", {
          geometry: {
            type: "Point",
            coordinates: ["sekrit818", 21.3069],
          },
        });
      },
    },
  ])("fails closed and redacted when live semantic $label violates its bounded contract", async ({ buildSnapshot }) => {
    const evidence = await collectLiveRealtimeConformanceEvidence(
      commonLiveOptions({
        fetchFn: () =>
          Promise.resolve(
            jsonResponse({
              serverVersion: SERVER_VERSION,
              serverRevision: SERVER_REVISION,
              transports: [{ id: "sse", url: `${BASE_URL}/stream` }],
            }),
          ),
        eventSourceFactory: () => createScriptedEventSource([buildSnapshot(), currentServerChange("assigned")]),
      }),
    );

    expectSchemaValid(evidence);
    expect(evidence.summary).toMatchObject({ status: "failed", failed: 1, unsupported: 2 });
    expect(evidence.transports[0]?.diagnostics[0]).toMatchObject({
      code: "semantic-normalization-invalid",
      message: "Advertised realtime transport failed the live conformance contract.",
    });
    expect(JSON.stringify(evidence)).not.toContain("sekrit818");
  });

  it("fails every otherwise executed transport when accepted final states diverge", async () => {
    let odataPoll = 0;
    const divergentDelta = {
      ...deltaEvent,
      eventId: "live-delta-divergent",
      upserts: [{ id: 1, feature: { Id: 1, status: "closed" } }],
    };
    const evidence = await collectLiveRealtimeConformanceEvidence(
      commonLiveOptions({
        fetchFn: (input: string | URL | Request) => {
          const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
          if (url.pathname.endsWith("/capabilities")) {
            return Promise.resolve(
              jsonResponse({
                serverVersion: SERVER_VERSION,
                serverRevision: SERVER_REVISION,
                transports: [
                  { id: "sse", url: `${BASE_URL}/stream` },
                  { id: "websocket", url: "ws://127.0.0.1:4318/stream" },
                  {
                    id: "odata",
                    url: `${BASE_URL}/odata/Incidents`,
                    entityIdField: "Id",
                    pollIntervalMs: 1,
                  },
                ],
              }),
            );
          }
          odataPoll += 1;
          return Promise.resolve(
            jsonResponse(
              odataPoll === 1
                ? {
                    value: [{ Id: 1, status: "open" }],
                    "@odata.deltaLink": `${BASE_URL}/odata/Incidents?$deltatoken=1`,
                  }
                : {
                    value: [{ Id: 1, status: "assigned" }],
                    "@odata.deltaLink": `${BASE_URL}/odata/Incidents?$deltatoken=2`,
                  },
            ),
          );
        },
        eventSourceFactory: () => createScriptedEventSource(),
        webSocketFactory: () => createScriptedWebSocket([snapshotEvent, divergentDelta]),
      }),
    );

    expectSchemaValid(evidence);
    expect(evidence.summary).toMatchObject({ status: "failed", failed: 3, executed: 0, executionCount: 3 });
    expect(evidence.transports.map((transport) => transport.diagnostics[0]?.code)).toEqual([
      "cross-transport-state-divergence",
      "cross-transport-state-divergence",
      "cross-transport-state-divergence",
    ]);
    expect(new Set(evidence.transports.map((transport) => transport.acceptedState?.finalStateSha256)).size).toBe(2);
  });

  it("fails equal-count transports whose intermediate state histories diverge before converging", async () => {
    const intermediateDivergence = {
      ...deltaEvent,
      eventId: "live-delta-intermediate-divergence",
      upserts: [{ id: 1, feature: { Id: 1, status: "investigating" } }],
    };
    const convergedDelta = {
      ...deltaEvent,
      eventId: "live-delta-converged",
      sequence: 3,
      cursor: "live-secret-cursor-3",
      watermark: "live-secret-watermark-3",
      upserts: [{ id: 1, feature: { Id: 1, status: "closed" } }],
    };
    const evidence = await collectLiveRealtimeConformanceEvidence(
      commonLiveOptions({
        fetchFn: () =>
          Promise.resolve(
            jsonResponse({
              serverVersion: SERVER_VERSION,
              serverRevision: SERVER_REVISION,
              transports: [
                { id: "sse", url: `${BASE_URL}/stream` },
                { id: "websocket", url: "ws://127.0.0.1:4318/stream" },
              ],
            }),
          ),
        eventSourceFactory: () => createScriptedEventSource([snapshotEvent, deltaEvent, convergedDelta]),
        webSocketFactory: () => createScriptedWebSocket([snapshotEvent, intermediateDivergence, convergedDelta]),
      }),
    );

    expectSchemaValid(evidence);
    expect(evidence.summary).toMatchObject({ status: "failed", failed: 2, unsupported: 1, executed: 0 });
    expect(evidence.transports.slice(0, 2).map((transport) => transport.diagnostics[0]?.code)).toEqual([
      "cross-transport-state-divergence",
      "cross-transport-state-divergence",
    ]);
    expect(new Set(evidence.transports.slice(0, 2).map((transport) => transport.acceptedState?.eventCount))).toEqual(
      new Set([3]),
    );
    expect(
      new Set(evidence.transports.slice(0, 2).map((transport) => transport.acceptedState?.finalStateSha256)).size,
    ).toBe(1);
    expect(
      new Set(evidence.transports.slice(0, 2).map((transport) => transport.acceptedState?.historySha256)).size,
    ).toBe(2);
  });

  it("accepts short cursors while validating cursor, watermark, and delta-token hashes by field", async () => {
    const events = [
      {
        ...snapshotEvent,
        cursor: "1",
        watermark: "wm-1",
        deltaToken: "dt-1",
      },
      {
        ...deltaEvent,
        cursor: "2",
        watermark: "wm-2",
        deltaToken: "dt-2",
      },
    ];
    const evidence = await collectLiveRealtimeConformanceEvidence({
      ...commonLiveOptions(),
      fetchFn: () =>
        Promise.resolve(
          jsonResponse({
            serverVersion: SERVER_VERSION,
            serverRevision: SERVER_REVISION,
            transports: [{ id: "sse", url: `${BASE_URL}/stream` }],
          }),
        ),
      eventSourceFactory: () => createScriptedEventSource(events),
    });

    expectSchemaValid(evidence);
    expect(evidence.summary).toMatchObject({ status: "executed", executed: 1, unsupported: 2 });
    expect(evidence.transports[0]?.diagnostics[0]?.code).toBe("contract-events-accepted");
  });

  it.each(["cursor", "watermark", "deltaToken"] as const)(
    "rejects a valid-looking %s digest that is not the field-aware hash of the durable value",
    async (field) => {
      const tamperingSdk: typeof realtimeSdk = {
        ...realtimeSdk,
        createResumableServerSentEventsTransport(transportOptions, resumableOptions) {
          const onTelemetry = resumableOptions.onTelemetry;
          return realtimeSdk.createResumableServerSentEventsTransport(transportOptions, {
            ...resumableOptions,
            onTelemetry(event) {
              const checkpoint = event.checkpoint;
              if (checkpoint?.resume[field] === undefined) {
                onTelemetry?.(event);
                return;
              }
              onTelemetry?.({
                ...event,
                checkpoint: {
                  ...checkpoint,
                  resume: {
                    ...checkpoint.resume,
                    [field]: `sha256:${"0".repeat(64)}`,
                  },
                },
              } as typeof event);
            },
          });
        },
      };
      const evidence = await collectLiveRealtimeConformanceEvidence({
        ...commonLiveOptions({ sdk: tamperingSdk }),
        fetchFn: () =>
          Promise.resolve(
            jsonResponse({
              serverVersion: SERVER_VERSION,
              serverRevision: SERVER_REVISION,
              transports: [{ id: "sse", url: `${BASE_URL}/stream` }],
            }),
          ),
        eventSourceFactory: () => createScriptedEventSource(),
      });

      expectSchemaValid(evidence);
      expect(evidence.summary).toMatchObject({ status: "failed", failed: 1, unsupported: 2 });
      expect(evidence.transports[0]?.diagnostics[0]?.code).toBe("checkpoint-telemetry-leak");
    },
  );

  it("parses CRLF SSE delimiters split across response chunks", async () => {
    const evidence = await collectLiveRealtimeConformanceEvidence({
      ...commonLiveOptions(),
      fetchFn: (input: string | URL | Request) => {
        const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
        return Promise.resolve(
          url.pathname.endsWith("/capabilities")
            ? jsonResponse({
                serverVersion: SERVER_VERSION,
                serverRevision: SERVER_REVISION,
                transports: [{ id: "sse", url: `${BASE_URL}/stream` }],
              })
            : crlfSplitSseResponse([snapshotEvent, deltaEvent]),
        );
      },
    });

    expectSchemaValid(evidence);
    expect(evidence.summary).toMatchObject({ status: "executed", executed: 1, unsupported: 2 });
    expect(evidence.transports[0]?.diagnostics[0]?.code).toBe("contract-events-accepted");
  });

  it("fails an advertised transport that cannot satisfy its public adapter contract", async () => {
    const evidence = await collectLiveRealtimeConformanceEvidence({
      ...commonLiveOptions(),
      fetchFn: () =>
        Promise.resolve(
          jsonResponse({
            serverVersion: SERVER_VERSION,
            serverRevision: SERVER_REVISION,
            transports: [{ id: "websocket" }],
          }),
        ),
      webSocketFactory: () => {
        throw new Error("sekrit818 WebSocket construction detail");
      },
    });

    expectSchemaValid(evidence);
    expect(evidence.summary).toMatchObject({
      status: "failed",
      scenarioCount: 1,
      executionCount: 1,
      failed: 1,
      unsupported: 2,
    });
    expect(evidence.transports[1]?.diagnostics[0]?.code).toBe("delivery-failed");
    expect(evidence.transports[1]?.diagnostics[0]?.message).toBe(
      "Advertised realtime transport failed the live conformance contract.",
    );
    expect(JSON.stringify(evidence)).not.toContain("sekrit818");
  });

  it("fails closed with explicit missing-history evidence when connected push streams omit snapshots", async () => {
    const evidence = await collectLiveRealtimeConformanceEvidence({
      ...commonLiveOptions(),
      fetchFn: () =>
        Promise.resolve(
          jsonResponse({
            serverVersion: SERVER_VERSION,
            serverRevision: SERVER_REVISION,
            transports: [
              { id: "sse", url: `${BASE_URL}/stream` },
              { id: "websocket", url: "ws://127.0.0.1:4318/stream" },
            ],
          }),
        ),
      eventSourceFactory: () => createDeltaOnlyEventSource(),
      webSocketFactory: () => createDeltaOnlyWebSocket(),
    });

    expectSchemaValid(evidence);
    expect(evidence.summary).toMatchObject({
      status: "failed",
      scenarioCount: 1,
      executionCount: 2,
      failed: 2,
      unsupported: 1,
    });
    expect(evidence.transports.slice(0, 2).map((transport) => transport.diagnostics[0]?.code)).toEqual([
      "contract-history-missing",
      "contract-history-missing",
    ]);
  });

  it("observes one minimal baseline per advertised transport without weakening full-history conformance", async () => {
    const evidence = await collectLiveRealtimeConformanceEvidence({
      ...commonLiveOptions(),
      baselineOnly: true,
      fetchFn: () =>
        Promise.resolve(
          jsonResponse({
            serverVersion: SERVER_VERSION,
            serverRevision: SERVER_REVISION,
            transports: [
              { id: "sse", url: `${BASE_URL}/stream` },
              { id: "websocket", url: "ws://127.0.0.1:4318/stream" },
            ],
          }),
        ),
      eventSourceFactory: () => createScriptedEventSource([snapshotEvent]),
      webSocketFactory: () => createScriptedWebSocket([snapshotEvent]),
    });

    expectSchemaValid(evidence);
    expect(evidence.summary).toMatchObject({
      status: "executed",
      scenarioCount: 1,
      executionCount: 2,
      executed: 2,
      unsupported: 1,
    });
    expect(evidence.transports.slice(0, 2).map((transport) => transport.scenarios)).toEqual([
      [{ id: "baseline-completion", result: "passed" }],
      [{ id: "baseline-completion", result: "passed" }],
    ]);
    expect(evidence.transports.slice(0, 2).map((transport) => transport.diagnostics[0]?.code)).toEqual([
      "baseline-completed",
      "baseline-completed",
    ]);
    expect(evidence.transports.slice(0, 2).map((transport) => transport.baselineState?.eventCount)).toEqual([1, 1]);
    expect(evidence.transports.slice(0, 2).every((transport) => transport.acceptedState === undefined)).toBe(true);
    expect(summarizeRealtimeConformanceEvidence(evidence)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("sse: executed"),
        expect.stringContaining("websocket: executed"),
        expect.stringContaining("odata: unsupported"),
      ]),
    );
  });

  it("reports sequential passive baselines independently when the source changes between transports", async () => {
    const evidence = await collectLiveRealtimeConformanceEvidence({
      ...commonLiveOptions(),
      baselineOnly: true,
      fetchFn: () =>
        Promise.resolve(
          jsonResponse({
            serverVersion: SERVER_VERSION,
            serverRevision: SERVER_REVISION,
            transports: [
              { id: "sse", url: `${BASE_URL}/stream` },
              { id: "websocket", url: "ws://127.0.0.1:4318/stream" },
            ],
          }),
        ),
      eventSourceFactory: () => createScriptedEventSource([currentServerSnapshot("open")]),
      webSocketFactory: () => createScriptedWebSocket([currentServerSnapshot("assigned")]),
    });

    expectSchemaValid(evidence);
    expect(evidence.summary).toMatchObject({ status: "executed", executed: 2, failed: 0, unsupported: 1 });
    expect(evidence.transports.slice(0, 2).every((transport) => transport.status === "executed")).toBe(true);
    expect(
      new Set(evidence.transports.slice(0, 2).map((transport) => transport.baselineState?.finalStateSha256)).size,
    ).toBe(2);
  });

  it("does not certify two replacement snapshots as snapshot-plus-delta history", async () => {
    const evidence = await collectLiveRealtimeConformanceEvidence({
      ...commonLiveOptions({ timeoutMs: 20 }),
      fetchFn: () =>
        Promise.resolve(
          jsonResponse({
            serverVersion: SERVER_VERSION,
            serverRevision: SERVER_REVISION,
            transports: [
              { id: "sse", url: `${BASE_URL}/stream` },
              { id: "websocket", url: "ws://127.0.0.1:4318/stream" },
            ],
          }),
        ),
      eventSourceFactory: () => createSnapshotOnlyEventSource(),
      webSocketFactory: () => createSnapshotOnlyWebSocket(),
    });

    expectSchemaValid(evidence);
    expect(evidence.summary).toMatchObject({
      status: "failed",
      scenarioCount: 1,
      executionCount: 2,
      failed: 2,
      unsupported: 1,
    });
    expect(evidence.transports.slice(0, 2).map((transport) => transport.diagnostics[0]?.code)).toEqual([
      "contract-history-missing",
      "contract-history-missing",
    ]);
  });

  it("fails when accepted live history does not match independently normalized final state", async () => {
    const evidence = await collectLiveRealtimeConformanceEvidence({
      ...commonLiveOptions({
        sdk: {
          ...realtimeSdk,
          reduceRealtimeFeatureState: realtimeSdk.emptyRealtimeFeatureState,
        },
      }),
      fetchFn: () =>
        Promise.resolve(
          jsonResponse({
            serverVersion: SERVER_VERSION,
            serverRevision: SERVER_REVISION,
            transports: [{ id: "sse", url: `${BASE_URL}/stream` }],
          }),
        ),
      eventSourceFactory: () => createScriptedEventSource(),
    });

    expectSchemaValid(evidence);
    expect(evidence.summary).toMatchObject({ status: "failed", failed: 1, unsupported: 2 });
    expect(evidence.transports[0]?.diagnostics[0]?.code).toBe("normalized-final-state-mismatch");
  });

  it("records live SSE timeout and WebSocket 1006 paths as degraded availability", async () => {
    const evidence = await collectLiveRealtimeConformanceEvidence({
      ...commonLiveOptions({ timeoutMs: 500 }),
      fetchFn: () =>
        Promise.resolve(
          jsonResponse({
            serverVersion: SERVER_VERSION,
            serverRevision: SERVER_REVISION,
            transports: [
              { id: "sse", url: `${BASE_URL}/stream` },
              { id: "websocket", url: "ws://127.0.0.1:4318/stream" },
            ],
          }),
        ),
      eventSourceFactory: () => createSilentEventSource(),
      webSocketFactory: () => createClosingWebSocket(),
    });

    expectSchemaValid(evidence);
    expect(evidence.summary).toMatchObject({
      status: "degraded",
      scenarioCount: 1,
      executionCount: 2,
      degraded: 2,
      unsupported: 1,
    });
    expect(evidence.transports.slice(0, 2).map((transport) => transport.diagnostics[0]?.code)).toEqual([
      "observation-timeout",
      "transport-unavailable",
    ]);
  });

  it("treats an explicit transport list as authoritative over the legacy enabled flag", () => {
    const explicit = normalizeLiveCapabilities(
      {
        enabled: true,
        serverVersion: "legacy-version",
        serverRevision: SERVER_REVISION,
        streamUrl: "https://unadvertised.invalid/must-not-be-admitted",
        transports: ["websocket"],
      },
      "https://example.test",
    );

    expect(explicit.sse).toMatchObject({
      advertised: false,
      url: null,
    });
    expect(explicit.websocket).toMatchObject({
      advertised: true,
      url: "wss://example.test/api/v1/streaming/features",
    });
    expect(explicit.serverVersion).toBe("legacy-version");
    expect(explicit.serverRevision).toBe(SERVER_REVISION);

    const legacy = normalizeLiveCapabilities(
      {
        enabled: true,
        serverVersion: "legacy-version",
        serverRevision: SERVER_REVISION,
      },
      "https://example.test",
    );
    expect(legacy.sse).toMatchObject({
      advertised: true,
      url: "https://example.test/api/v1/streaming/features",
    });
    expect(legacy.websocket.advertised).toBe(false);
  });
});

/**
 * Regressions from the scheduled lane's own failure record. Every run of
 * `realtime-live-conformance.yml` between 2026-07-29 and 2026-08-12 exited 1
 * before writing a live document, so the lane whose entire product is retained
 * evidence retained none. The cause was not the server: an unset
 * `workflow_dispatch` input reaches the process as `""`, which the revision
 * reader treated as supplied-and-invalid rather than absent.
 */
describe("scheduled live lane retention", () => {
  const DEPLOYMENT_REVISION = "6ad71ac701ca709ec671afd09257217e8d17a149";

  function scheduledEnv(overrides: Record<string, string> = {}): Record<string, string> {
    // Exactly the shape GitHub Actions renders for a scheduled run: the
    // enable flag is set at workflow level, every dispatch-only input is "".
    return {
      HONUA_REALTIME_LIVE_CONFORMANCE_ENABLED: "true",
      HONUA_REALTIME_LIVE_SERVER_REVISION: "",
      HONUA_REALTIME_LIVE_SERVER_VERSION: "",
      HONUA_REALTIME_LIVE_API_KEY: "",
      HONUA_REALTIME_LIVE_CONFORMANCE_MUTATE: "",
      HONUA_REALTIME_LIVE_CONFORMANCE_LABEL: "",
      HONUA_REALTIME_LIVE_CONFORMANCE_TTL_SECONDS: "",
      ...overrides,
    };
  }

  it("drops blank environment values instead of treating them as supplied", () => {
    const normalized = normalizeLiveEnv({
      HONUA_REALTIME_LIVE_SERVER_REVISION: "",
      HONUA_REALTIME_LIVE_LAYER_ID: "   ",
      HONUA_REALTIME_LIVE_SOURCE_ID: "maui-parcels",
    });
    expect(Object.hasOwn(normalized, "HONUA_REALTIME_LIVE_SERVER_REVISION")).toBe(false);
    expect(Object.hasOwn(normalized, "HONUA_REALTIME_LIVE_LAYER_ID")).toBe(false);
    expect(normalized.HONUA_REALTIME_LIVE_SOURCE_ID).toBe("maui-parcels");
  });

  it("classifies a scheduled run with blank dispatch inputs instead of throwing", async () => {
    // The exact reproduction of the 2026-08-12 failure. Before the fix this
    // rejected with "Realtime server revision must be a non-empty string when
    // provided." and no document was produced at all.
    const evidence = await collectLiveRealtimeConformanceEvidence({
      generatedAt: GENERATED_AT,
      sourceRevision: SOURCE_REVISION,
      baseUrl: BASE_URL,
      timeoutMs: 1_000,
      sdk: realtimeSdk,
      corpus,
      corpusBytes: Buffer.from(JSON.stringify(corpus)),
      env: scheduledEnv(),
      fetchFn: () => Promise.resolve(jsonResponse({ enabled: false })),
    });

    expectSchemaValid(evidence);
    expect(evidence.lane).toBe("live");
    expect(evidence.summary.status).toBe("unsupported");
    expect(evidence.summary.unsupported).toBe(3);
  });

  it("binds evidence to the deploymentRevision honua-server advertises on its capability response", async () => {
    const evidence = await collectLiveRealtimeConformanceEvidence({
      ...commonLiveOptions({ serverRevision: undefined, serverVersion: undefined }),
      env: scheduledEnv(),
      fetchFn: (input: string | URL | Request) => {
        const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
        if (url.pathname.endsWith("/capabilities")) {
          // The live demo.honua.io shape after honua-server#3038.
          return Promise.resolve(
            jsonResponse({
              enabled: true,
              transports: ["websocket", "sse"],
              modes: ["delta", "snapshot"],
              subscriptionSequence: true,
              serverVersion: "1.0.0",
              deploymentRevision: DEPLOYMENT_REVISION,
              deploymentRevisionSource: "commit-sha",
            }),
          );
        }
        return Promise.resolve(jsonResponse({}, 503));
      },
    });

    expectSchemaValid(evidence);
    expect(evidence.server.revision).toBe(DEPLOYMENT_REVISION);
    expect(evidence.server.revisionSource).toBe("capabilities");
    expect(evidence.server.version).toBe("1.0.0");
    // A revision it could not read would have failed both advertised
    // transports on server-revision-missing rather than reaching the stream.
    expect(evidence.transports.map((transport) => transport.diagnostics[0]?.code)).not.toContain(
      "server-revision-missing",
    );
  });

  it("binds evidence to the manifest deploymentRevision when the capability response omits one", async () => {
    const evidence = await collectLiveRealtimeConformanceEvidence({
      ...commonLiveOptions({ serverRevision: undefined, serverVersion: undefined }),
      env: scheduledEnv(),
      fetchFn: (input: string | URL | Request) => {
        const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
        if (url.pathname.endsWith("/manifest")) {
          return Promise.resolve(
            jsonResponse({
              server: {
                serverVersion: "1.0.0",
                deploymentRevision: DEPLOYMENT_REVISION,
                deploymentRevisionSource: "commit-sha",
              },
            }),
          );
        }
        if (url.pathname.endsWith("/capabilities")) {
          return Promise.resolve(jsonResponse({ enabled: true, transports: ["sse"] }));
        }
        return Promise.resolve(jsonResponse({}, 503));
      },
    });

    expectSchemaValid(evidence);
    expect(evidence.server.revision).toBe(DEPLOYMENT_REVISION);
    expect(evidence.server.revisionSource).toBe("manifest");
  });

  it("names which document came up empty when no immutable revision exists", async () => {
    const evidence = await collectLiveRealtimeConformanceEvidence({
      ...commonLiveOptions({ serverRevision: undefined, serverVersion: undefined }),
      env: scheduledEnv(),
      fetchFn: (input: string | URL | Request) => {
        const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
        if (url.pathname.endsWith("/manifest")) {
          // Reachable, but revision-less: a different deployment fact from a
          // 404, and the retained diagnostic has to say which one it was.
          return Promise.resolve(jsonResponse({ server: { serverVersion: "1.0.0" } }));
        }
        return Promise.resolve(jsonResponse({ enabled: true, transports: ["sse"] }));
      },
    });

    expectSchemaValid(evidence);
    expect(evidence.summary.status).toBe("failed");
    expect(evidence.server.revision).toBeNull();
    expect(evidence.server.revisionSource).toBeNull();
    const diagnostic = evidence.transports.find((transport) => transport.id === "sse")?.diagnostics[0];
    expect(diagnostic?.code).toBe("server-revision-missing");
    expect(diagnostic?.message).toContain("manifest-revision-absent");
  });

  it("distinguishes an unreachable manifest from a revision-less one", async () => {
    const evidence = await collectLiveRealtimeConformanceEvidence({
      ...commonLiveOptions({ serverRevision: undefined, serverVersion: undefined }),
      env: scheduledEnv(),
      fetchFn: (input: string | URL | Request) => {
        const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
        if (url.pathname.endsWith("/manifest")) return Promise.resolve(jsonResponse({}, 404));
        return Promise.resolve(jsonResponse({ enabled: true, transports: ["sse"] }));
      },
    });

    expectSchemaValid(evidence);
    const diagnostic = evidence.transports.find((transport) => transport.id === "sse")?.diagnostics[0];
    expect(diagnostic?.code).toBe("server-revision-missing");
    expect(diagnostic?.message).toContain("manifest-unreachable");
  });

  it("still enforces an operator-supplied revision against the advertised deployment revision", async () => {
    const evidence = await collectLiveRealtimeConformanceEvidence({
      ...commonLiveOptions({ serverRevision: undefined, serverVersion: undefined }),
      env: scheduledEnv({ HONUA_REALTIME_LIVE_SERVER_REVISION: SERVER_REVISION }),
      fetchFn: () =>
        Promise.resolve(
          jsonResponse({
            enabled: true,
            transports: ["sse"],
            deploymentRevision: DEPLOYMENT_REVISION,
          }),
        ),
    });

    expectSchemaValid(evidence);
    expect(evidence.summary.status).toBe("failed");
    expect(evidence.transports.find((transport) => transport.id === "sse")?.diagnostics[0]?.code).toBe(
      "server-revision-mismatch",
    );
  });

  it("rejects a malformed advertised deployment revision rather than binding to it", async () => {
    const evidence = await collectLiveRealtimeConformanceEvidence({
      ...commonLiveOptions({ serverRevision: undefined, serverVersion: undefined }),
      env: scheduledEnv(),
      fetchFn: () =>
        Promise.resolve(jsonResponse({ enabled: true, transports: ["sse"], deploymentRevision: "v1.0.0" })),
    });

    expectSchemaValid(evidence);
    expect(evidence.summary.status).toBe("failed");
    expect(evidence.transports.find((transport) => transport.id === "sse")?.diagnostics[0]?.code).toBe(
      "capability-contract-invalid",
    );
  });

  it("retains a failed document with diagnostics when the collector itself throws", () => {
    const evidence = collectorFailureRealtimeConformanceEvidence(
      "live",
      new Error("Realtime server revision must be a non-empty string when provided."),
      { generatedAt: GENERATED_AT, env: { HONUA_SAMPLE_SOURCE_REVISION: SOURCE_REVISION } },
    );

    expectSchemaValid(evidence);
    expect(evidence.summary.status).toBe("failed");
    expect(evidence.summary.failed).toBe(3);
    expect(evidence.server.revision).toBeNull();
    expect(evidence.server.revisionSource).toBeNull();
    for (const transport of evidence.transports) {
      expect(transport.status).toBe("failed");
      expect(transport.diagnostics[0]?.code).toBe("collector-failed");
      expect(transport.diagnostics[0]?.message).toContain("must be a non-empty string");
    }
    // Still a real, summarizable document rather than a stderr line.
    expect(summarizeRealtimeConformanceEvidence(evidence)[0]).toContain("status=failed");
  });

  it("refuses to certify without recording how the revision was bound", async () => {
    const evidence = await collectStubFixtureEvidence();
    expect(evidence.summary.executed).toBe(3);
    expect(() =>
      validateRealtimeConformanceEvidence({
        ...evidence,
        server: { ...evidence.server, revisionSource: null },
      }),
    ).toThrow(/revisionSource|revision source/u);
  });

  it("refuses a revision whose provenance no document accounts for", async () => {
    // Reachable below the schema's executed-only rule: a document with no
    // executed transport may still carry a revision, and a revision nothing
    // accounted for would read as a checked deployment binding.
    const evidence = await collectLiveRealtimeConformanceEvidence({
      ...commonLiveOptions(),
      env: scheduledEnv(),
      fetchFn: () => Promise.resolve(jsonResponse({ enabled: false })),
    });
    expect(evidence.summary.executed).toBe(0);
    expect(() =>
      validateRealtimeConformanceEvidence({
        ...evidence,
        server: { ...evidence.server, revision: DEPLOYMENT_REVISION, revisionSource: null },
      }),
    ).toThrow(/revision and revision source disagree/u);
  });

  it("refuses live evidence that claims a fixture revision source", async () => {
    const evidence = await collectLiveRealtimeConformanceEvidence({
      ...commonLiveOptions(),
      env: scheduledEnv(),
      fetchFn: () => Promise.resolve(jsonResponse({ enabled: false })),
    });
    expect(() =>
      validateRealtimeConformanceEvidence({
        ...evidence,
        server: { ...evidence.server, revision: `sha256:${"a".repeat(64)}`, revisionSource: "fixture" },
      }),
    ).toThrow(/claimed a fixture revision source/u);
  });
});
