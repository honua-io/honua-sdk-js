import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createOdataDeltaTransport } from "../src/realtime/index.js";
import type { OdataDeltaPollTelemetry, RealtimeFeatureEvent, RealtimeFeatureObserver } from "../src/realtime/index.js";

interface Incident {
  readonly Id: number;
  readonly Status: string;
}

interface MockResponseInit {
  readonly status?: number;
  readonly body?: unknown;
}

function mockResponse(init: MockResponseInit = {}): Response {
  const status = init.status ?? 200;
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Error",
    async json() {
      if (init.body === undefined) throw new Error("no body");
      return init.body;
    },
  } as unknown as Response;
}

interface RecordedCall {
  readonly url: string;
  readonly headers: Record<string, string>;
}

function createMockFetch(queue: MockResponseInit[]): { fetchImpl: typeof fetch; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const fetchImpl = (async (input: unknown, init?: RequestInit) => {
    calls.push({ url: String(input), headers: { ...(init?.headers as Record<string, string> | undefined) } });
    const next = queue.shift();
    if (!next) throw new Error(`No mock OData response queued for ${String(input)}`);
    return mockResponse(next);
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

function createRecordingObserver<TFeature = unknown>(): RealtimeFeatureObserver<TFeature> & {
  readonly events: RealtimeFeatureEvent<TFeature>[];
  readonly errors: unknown[];
  completed: boolean;
} {
  const events: RealtimeFeatureEvent<TFeature>[] = [];
  const errors: unknown[] = [];
  return {
    events,
    errors,
    completed: false,
    next(event) {
      events.push(event);
    },
    error(error) {
      errors.push(error);
    },
    complete() {
      this.completed = true;
    },
  };
}

const COLLECTION_URL = "https://honua.example/odata/Incidents";

function entityId(entity: Record<string, unknown>): number {
  const id = entity.Id;
  if (typeof id !== "number") throw new Error("Incident entity is missing a numeric Id.");
  return id;
}

describe("createOdataDeltaTransport", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("declares polling capabilities and never claims to emit heartbeats or watermarks", () => {
    const { fetchImpl } = createMockFetch([]);
    const transport = createOdataDeltaTransport<Incident>({
      url: COLLECTION_URL,
      pollIntervalMs: 1_000,
      entityId,
      fetchImpl,
    });
    expect(transport.capabilities).toEqual({
      kind: "polling",
      resumeModes: ["delta-token"],
      emitsHeartbeats: false,
      emitsWatermarks: false,
    });
  });

  it("throws synchronously at construction for a non-absolute url", () => {
    expect(() =>
      createOdataDeltaTransport<Incident>({
        url: "/odata/Incidents",
        pollIntervalMs: 1_000,
        entityId,
      }),
    ).toThrow(TypeError);
  });

  it("throws synchronously when entityId is missing", () => {
    expect(() =>
      createOdataDeltaTransport<Incident>({
        url: COLLECTION_URL,
        pollIntervalMs: 1_000,
      } as never),
    ).toThrow(TypeError);
  });

  it("performs an initial snapshot with Prefer: odata.track-changes and the configured $filter/$select/$orderby/$top", async () => {
    const { fetchImpl, calls } = createMockFetch([
      {
        body: {
          value: [{ Id: 1, Status: "open" }],
          "@odata.deltaLink": `${COLLECTION_URL}?$deltatoken=v1`,
        },
      },
    ]);
    const transport = createOdataDeltaTransport<Incident>({
      url: COLLECTION_URL,
      pollIntervalMs: 30_000,
      entityId,
      fetchImpl,
      initialQuery: { filter: "Status ne 'closed'", select: ["Id", "Status"], orderBy: ["Id"], top: 500 },
    });
    const observer = createRecordingObserver<Incident>();
    transport.subscribe({ sourceId: "incidents" }, observer);
    await vi.advanceTimersByTimeAsync(0);

    expect(calls).toHaveLength(1);
    const url = new URL(calls[0]!.url);
    expect(url.origin + url.pathname).toBe(COLLECTION_URL);
    expect(url.searchParams.get("$filter")).toBe("Status ne 'closed'");
    expect(url.searchParams.get("$select")).toBe("Id,Status");
    expect(url.searchParams.get("$orderby")).toBe("Id");
    expect(url.searchParams.get("$top")).toBe("500");
    expect(calls[0]!.headers.Prefer).toBe("odata.track-changes");

    expect(observer.events).toHaveLength(1);
    expect(observer.events[0]).toMatchObject({
      type: "snapshot",
      sequence: 1,
      replace: true,
      deltaToken: `${COLLECTION_URL}?$deltatoken=v1`,
      features: [{ id: 1, feature: { Id: 1, Status: "open" } }],
    });
  });

  it("follows @odata.nextLink pages during the initial snapshot and merges rows", async () => {
    const { fetchImpl } = createMockFetch([
      { body: { value: [{ Id: 1, Status: "open" }], "@odata.nextLink": `${COLLECTION_URL}?$skiptoken=p2` } },
      { body: { value: [{ Id: 2, Status: "open" }], "@odata.deltaLink": `${COLLECTION_URL}?$deltatoken=v1` } },
    ]);
    const transport = createOdataDeltaTransport<Incident>({
      url: COLLECTION_URL,
      pollIntervalMs: 30_000,
      entityId,
      fetchImpl,
    });
    const observer = createRecordingObserver<Incident>();
    transport.subscribe({ sourceId: "incidents" }, observer);
    await vi.advanceTimersByTimeAsync(0);

    expect(observer.events).toHaveLength(1);
    const snapshot = observer.events[0];
    expect(snapshot?.type).toBe("snapshot");
    expect(snapshot?.type === "snapshot" && snapshot.features.map((feature) => feature.id)).toEqual([1, 2]);
  });

  it("fails explicitly when the server never returns a terminal @odata.deltaLink", async () => {
    const { fetchImpl } = createMockFetch([{ body: { value: [{ Id: 1, Status: "open" }] } }]);
    const transport = createOdataDeltaTransport<Incident>({
      url: COLLECTION_URL,
      pollIntervalMs: 30_000,
      entityId,
      fetchImpl,
    });
    const observer = createRecordingObserver<Incident>();
    transport.subscribe({ sourceId: "incidents" }, observer);
    await vi.advanceTimersByTimeAsync(0);

    expect(observer.events).toHaveLength(0);
    expect(observer.errors).toHaveLength(1);
    expect((observer.errors[0] as { code?: string }).code).toBe("invalid-event");
  });

  it("emits an empty poll as a status event, not a delta, and reports honest onPoll telemetry", async () => {
    const { fetchImpl } = createMockFetch([
      { body: { value: [{ Id: 1, Status: "open" }], "@odata.deltaLink": `${COLLECTION_URL}?$deltatoken=v1` } },
      { body: { value: [], "@odata.deltaLink": `${COLLECTION_URL}?$deltatoken=v2` } },
    ]);
    const polls: OdataDeltaPollTelemetry[] = [];
    const transport = createOdataDeltaTransport<Incident>({
      url: COLLECTION_URL,
      pollIntervalMs: 10_000,
      entityId,
      fetchImpl,
      onPoll: (telemetry) => polls.push(telemetry),
    });
    const observer = createRecordingObserver<Incident>();
    transport.subscribe({ sourceId: "incidents" }, observer);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(10_000);

    expect(observer.events).toHaveLength(2);
    expect(observer.events[1]).toMatchObject({
      type: "status",
      status: "live",
      sequence: 1,
      reason: "poll-unchanged",
    });
    expect(polls).toHaveLength(2);
    expect(polls[1]).toMatchObject({ changed: false, upsertCount: 0, deleteCount: 0, intervalMs: 10_000 });
    expect(polls[1]!.nextPollAt).toBe(polls[1]!.polledAt + 10_000);
  });

  it("does not advance the durable sequence across unchanged polls", async () => {
    const { fetchImpl } = createMockFetch([
      { body: { value: [{ Id: 1, Status: "open" }], "@odata.deltaLink": `${COLLECTION_URL}?$deltatoken=v1` } },
      { body: { value: [], "@odata.deltaLink": `${COLLECTION_URL}?$deltatoken=v2` } },
      {
        body: {
          value: [{ Id: 1, Status: "closed" }],
          "@odata.deltaLink": `${COLLECTION_URL}?$deltatoken=v3`,
        },
      },
    ]);
    const transport = createOdataDeltaTransport<Incident>({
      url: COLLECTION_URL,
      pollIntervalMs: 5_000,
      entityId,
      fetchImpl,
    });
    const observer = createRecordingObserver<Incident>();
    transport.subscribe({ sourceId: "incidents" }, observer);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(5_000);
    await vi.advanceTimersByTimeAsync(5_000);

    expect(observer.events).toHaveLength(3);
    expect(observer.events[0]).toMatchObject({ type: "snapshot", sequence: 1 });
    expect(observer.events[1]).toMatchObject({ type: "status", sequence: 1, reason: "poll-unchanged" });
    expect(observer.events[2]).toMatchObject({ type: "delta", sequence: 2 });
  });

  it("emits creates/updates as delta upserts on the next poll", async () => {
    const { fetchImpl } = createMockFetch([
      { body: { value: [{ Id: 1, Status: "open" }], "@odata.deltaLink": `${COLLECTION_URL}?$deltatoken=v1` } },
      {
        body: {
          value: [{ Id: 1, Status: "closed" }],
          "@odata.deltaLink": `${COLLECTION_URL}?$deltatoken=v2`,
        },
      },
    ]);
    const transport = createOdataDeltaTransport<Incident>({
      url: COLLECTION_URL,
      pollIntervalMs: 5_000,
      entityId,
      fetchImpl,
    });
    const observer = createRecordingObserver<Incident>();
    transport.subscribe({ sourceId: "incidents" }, observer);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(5_000);

    expect(observer.events).toHaveLength(2);
    expect(observer.events[1]).toMatchObject({
      type: "delta",
      sequence: 2,
      upserts: [{ id: 1, feature: { Id: 1, Status: "closed" } }],
    });
  });

  it("normalizes both @removed and @odata.removed delta entries into deletes, deriving the id from retained key properties", async () => {
    const { fetchImpl } = createMockFetch([
      { body: { value: [], "@odata.deltaLink": `${COLLECTION_URL}?$deltatoken=v1` } },
      {
        body: {
          value: [
            { Id: 1, "@removed": { reason: "deleted" } },
            { Id: 2, "@odata.removed": { reason: "changed" } },
          ],
          "@odata.deltaLink": `${COLLECTION_URL}?$deltatoken=v2`,
        },
      },
    ]);
    const transport = createOdataDeltaTransport<Incident>({
      url: COLLECTION_URL,
      pollIntervalMs: 5_000,
      entityId,
      fetchImpl,
    });
    const observer = createRecordingObserver<Incident>();
    transport.subscribe({ sourceId: "incidents" }, observer);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(5_000);

    expect(observer.events[1]).toMatchObject({
      type: "delta",
      deletes: [{ id: 1 }, { id: 2 }],
    });
  });

  it("derives a delete id from @id when a removed entry carries no key properties, and rejects a composite key", async () => {
    const { fetchImpl } = createMockFetch([
      { body: { value: [], "@odata.deltaLink": `${COLLECTION_URL}?$deltatoken=v1` } },
      {
        body: {
          value: [{ "@id": "Incidents(42)", "@removed": { reason: "deleted" } }],
          "@odata.deltaLink": `${COLLECTION_URL}?$deltatoken=v2`,
        },
      },
    ]);
    const transport = createOdataDeltaTransport<Incident>({
      url: COLLECTION_URL,
      pollIntervalMs: 5_000,
      entityId,
      fetchImpl,
    });
    const observer = createRecordingObserver<Incident>();
    transport.subscribe({ sourceId: "incidents" }, observer);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(5_000);

    expect(observer.events[1]).toMatchObject({ type: "delta", deletes: [{ id: 42 }] });
  });

  it("fails explicitly on a composite-key removed entry with no retained key properties", async () => {
    const { fetchImpl } = createMockFetch([
      { body: { value: [], "@odata.deltaLink": `${COLLECTION_URL}?$deltatoken=v1` } },
      {
        body: {
          value: [{ "@id": "Incidents(Key1=1,Key2='a')", "@removed": { reason: "deleted" } }],
          "@odata.deltaLink": `${COLLECTION_URL}?$deltatoken=v2`,
        },
      },
    ]);
    const transport = createOdataDeltaTransport<Incident>({
      url: COLLECTION_URL,
      pollIntervalMs: 5_000,
      entityId,
      fetchImpl,
    });
    const observer = createRecordingObserver<Incident>();
    transport.subscribe({ sourceId: "incidents" }, observer);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(5_000);

    expect(observer.events).toHaveLength(1); // only the empty snapshot
    expect(observer.errors).toHaveLength(1);
    expect((observer.errors[0] as { code?: string }).code).toBe("invalid-event");
  });

  it("rejects unsupported relationship (link) delta entries explicitly instead of dropping or misreading them", async () => {
    const { fetchImpl } = createMockFetch([
      { body: { value: [], "@odata.deltaLink": `${COLLECTION_URL}?$deltatoken=v1` } },
      {
        body: {
          value: [{ source: "Incidents(1)", relationship: "AssignedUnits", target: "Units(9)" }],
          "@odata.deltaLink": `${COLLECTION_URL}?$deltatoken=v2`,
        },
      },
    ]);
    const transport = createOdataDeltaTransport<Incident>({
      url: COLLECTION_URL,
      pollIntervalMs: 5_000,
      entityId,
      fetchImpl,
    });
    const observer = createRecordingObserver<Incident>();
    transport.subscribe({ sourceId: "incidents" }, observer);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(5_000);

    expect(observer.events).toHaveLength(1);
    expect(observer.errors).toHaveLength(1);
    expect((observer.errors[0] as { code?: string }).code).toBe("invalid-event");
  });

  it("rejects a delta link that resolves to a foreign origin or collection path (REQ-002)", async () => {
    const { fetchImpl } = createMockFetch([
      {
        body: {
          value: [{ Id: 1, Status: "open" }],
          "@odata.deltaLink": "https://evil.example/odata/Incidents?$deltatoken=v1",
        },
      },
    ]);
    const transport = createOdataDeltaTransport<Incident>({
      url: COLLECTION_URL,
      pollIntervalMs: 5_000,
      entityId,
      fetchImpl,
    });
    const observer = createRecordingObserver<Incident>();
    transport.subscribe({ sourceId: "incidents" }, observer);
    await vi.advanceTimersByTimeAsync(0);

    expect(observer.events).toHaveLength(0);
    expect(observer.errors).toHaveLength(1);
    expect((observer.errors[0] as { code?: string }).code).toBe("invalid-event");
  });

  it("rejects a foreign resumeFrom.deltaToken synchronously at subscribe time, before any request is made", () => {
    const { fetchImpl, calls } = createMockFetch([]);
    const transport = createOdataDeltaTransport<Incident>({
      url: COLLECTION_URL,
      pollIntervalMs: 5_000,
      entityId,
      fetchImpl,
    });
    const observer = createRecordingObserver<Incident>();
    expect(() =>
      transport.subscribe(
        { sourceId: "incidents", resumeFrom: { deltaToken: "https://evil.example/odata/Other?$deltatoken=x" } },
        observer,
      ),
    ).toThrow(/foreign link/);
    expect(calls).toHaveLength(0);
  });

  it("resumes directly from resumeFrom.deltaToken without an initial snapshot request", async () => {
    const { fetchImpl, calls } = createMockFetch([
      {
        body: {
          value: [{ Id: 1, Status: "reopened" }],
          "@odata.deltaLink": `${COLLECTION_URL}?$deltatoken=v2`,
        },
      },
    ]);
    const transport = createOdataDeltaTransport<Incident>({
      url: COLLECTION_URL,
      pollIntervalMs: 5_000,
      entityId,
      fetchImpl,
    });
    const observer = createRecordingObserver<Incident>();
    transport.subscribe(
      { sourceId: "incidents", resumeFrom: { deltaToken: `${COLLECTION_URL}?$deltatoken=v1`, sequence: 41 } },
      observer,
    );
    await vi.advanceTimersByTimeAsync(0);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toContain("$deltatoken=v1");
    expect(calls[0]!.headers.Prefer).toBeUndefined();
    expect(observer.events).toHaveLength(1);
    expect(observer.events[0]).toMatchObject({ type: "delta", sequence: 42 });
  });

  it("self-heals on an expired delta link (HTTP 410) with an explicit reconnecting status then a fresh snapshot", async () => {
    const { fetchImpl } = createMockFetch([
      { body: { value: [{ Id: 1, Status: "open" }], "@odata.deltaLink": `${COLLECTION_URL}?$deltatoken=v1` } },
      { status: 410, body: { error: { message: "delta token expired" } } },
      { body: { value: [{ Id: 1, Status: "open" }], "@odata.deltaLink": `${COLLECTION_URL}?$deltatoken=v3` } },
    ]);
    const transport = createOdataDeltaTransport<Incident>({
      url: COLLECTION_URL,
      pollIntervalMs: 5_000,
      entityId,
      fetchImpl,
    });
    const observer = createRecordingObserver<Incident>();
    transport.subscribe({ sourceId: "incidents" }, observer);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(5_000);

    const types = observer.events.map((event) => event.type);
    expect(types).toEqual(["snapshot", "status", "snapshot"]);
    expect(observer.events[1]).toMatchObject({ type: "status", status: "reconnecting", reason: "cursor-expired" });
    expect(observer.events[2]).toMatchObject({
      type: "snapshot",
      replace: true,
      deltaToken: `${COLLECTION_URL}?$deltatoken=v3`,
    });
    expect(observer.errors).toHaveLength(0);
  });

  it("fails closed after maxConsecutiveResnapshots consecutive expired-delta-link recoveries (REQ-005 bounded retries)", async () => {
    const { fetchImpl } = createMockFetch([
      { body: { value: [], "@odata.deltaLink": `${COLLECTION_URL}?$deltatoken=v1` } },
      { status: 410 }, // poll -> expired
      { status: 410 }, // resnapshot #1 -> expired
      { status: 410 }, // resnapshot #2 -> expired, exceeds bound of 2
    ]);
    const transport = createOdataDeltaTransport<Incident>({
      url: COLLECTION_URL,
      pollIntervalMs: 5_000,
      entityId,
      fetchImpl,
      maxConsecutiveResnapshots: 2,
    });
    const observer = createRecordingObserver<Incident>();
    transport.subscribe({ sourceId: "incidents" }, observer);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(5_000);

    expect(observer.errors).toHaveLength(1);
    expect((observer.errors[0] as { code?: string }).code).toBe("delivery-failed");
  });

  it("bounds pages followed within one cycle (REQ-005)", async () => {
    const { fetchImpl } = createMockFetch([
      { body: { value: [{ Id: 1, Status: "open" }], "@odata.nextLink": `${COLLECTION_URL}?$skiptoken=p2` } },
      { body: { value: [{ Id: 2, Status: "open" }], "@odata.deltaLink": `${COLLECTION_URL}?$deltatoken=v1` } },
    ]);
    const transport = createOdataDeltaTransport<Incident>({
      url: COLLECTION_URL,
      pollIntervalMs: 5_000,
      entityId,
      fetchImpl,
      maxPagesPerCycle: 1,
    });
    const observer = createRecordingObserver<Incident>();
    transport.subscribe({ sourceId: "incidents" }, observer);
    await vi.advanceTimersByTimeAsync(0);

    expect(observer.events).toHaveLength(0);
    expect(observer.errors).toHaveLength(1);
    expect((observer.errors[0] as { code?: string }).code).toBe("delivery-failed");
  });

  it("bounds rows collected by one snapshot cycle (REQ-005)", async () => {
    const { fetchImpl } = createMockFetch([
      {
        body: {
          value: [
            { Id: 1, Status: "open" },
            { Id: 2, Status: "open" },
          ],
          "@odata.deltaLink": `${COLLECTION_URL}?$deltatoken=v1`,
        },
      },
    ]);
    const transport = createOdataDeltaTransport<Incident>({
      url: COLLECTION_URL,
      pollIntervalMs: 5_000,
      entityId,
      fetchImpl,
      maxSnapshotRows: 1,
    });
    const observer = createRecordingObserver<Incident>();
    transport.subscribe({ sourceId: "incidents" }, observer);
    await vi.advanceTimersByTimeAsync(0);

    expect(observer.events).toHaveLength(0);
    expect(observer.errors).toHaveLength(1);
    expect((observer.errors[0] as { code?: string }).code).toBe("delivery-failed");
  });

  it("classifies a 5xx failure as retryable transport-gap and a 4xx failure as terminal invalid-event", async () => {
    const { fetchImpl: fetch5xx } = createMockFetch([{ status: 503 }]);
    const transport5xx = createOdataDeltaTransport<Incident>({
      url: COLLECTION_URL,
      pollIntervalMs: 5_000,
      entityId,
      fetchImpl: fetch5xx,
    });
    const observer5xx = createRecordingObserver<Incident>();
    transport5xx.subscribe({ sourceId: "incidents" }, observer5xx);
    await vi.advanceTimersByTimeAsync(0);
    expect((observer5xx.errors[0] as { code?: string; retryable?: boolean }).code).toBe("transport-gap");
    expect((observer5xx.errors[0] as { retryable?: boolean }).retryable).toBe(true);

    const { fetchImpl: fetch4xx } = createMockFetch([{ status: 400 }]);
    const transport4xx = createOdataDeltaTransport<Incident>({
      url: COLLECTION_URL,
      pollIntervalMs: 5_000,
      entityId,
      fetchImpl: fetch4xx,
    });
    const observer4xx = createRecordingObserver<Incident>();
    transport4xx.subscribe({ sourceId: "incidents" }, observer4xx);
    await vi.advanceTimersByTimeAsync(0);
    expect((observer4xx.errors[0] as { code?: string; retryable?: boolean }).code).toBe("invalid-event");
    expect((observer4xx.errors[0] as { retryable?: boolean }).retryable).toBe(false);
  });

  it("stops polling once the caller closes the subscription handle", async () => {
    const { fetchImpl, calls } = createMockFetch([
      { body: { value: [{ Id: 1, Status: "open" }], "@odata.deltaLink": `${COLLECTION_URL}?$deltatoken=v1` } },
    ]);
    const transport = createOdataDeltaTransport<Incident>({
      url: COLLECTION_URL,
      pollIntervalMs: 5_000,
      entityId,
      fetchImpl,
    });
    const observer = createRecordingObserver<Incident>();
    const handle = transport.subscribe({ sourceId: "incidents" }, observer);
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(1);

    handle.close();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(calls).toHaveLength(1);
    expect(observer.completed).toBe(true);
  });

  it("stops polling and completes when the caller's AbortSignal fires", async () => {
    const { fetchImpl, calls } = createMockFetch([
      { body: { value: [{ Id: 1, Status: "open" }], "@odata.deltaLink": `${COLLECTION_URL}?$deltatoken=v1` } },
    ]);
    const transport = createOdataDeltaTransport<Incident>({
      url: COLLECTION_URL,
      pollIntervalMs: 5_000,
      entityId,
      fetchImpl,
    });
    const controller = new AbortController();
    const observer = createRecordingObserver<Incident>();
    transport.subscribe({ sourceId: "incidents", signal: controller.signal }, observer);
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(1);

    controller.abort();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(calls).toHaveLength(1);
    expect(observer.completed).toBe(true);
  });

  it("completes immediately without any request when the signal is already aborted at subscribe time", async () => {
    const { fetchImpl, calls } = createMockFetch([]);
    const transport = createOdataDeltaTransport<Incident>({
      url: COLLECTION_URL,
      pollIntervalMs: 5_000,
      entityId,
      fetchImpl,
    });
    const controller = new AbortController();
    controller.abort();
    const observer = createRecordingObserver<Incident>();
    transport.subscribe({ sourceId: "incidents", signal: controller.signal }, observer);
    await vi.advanceTimersByTimeAsync(0);

    expect(calls).toHaveLength(0);
    expect(observer.completed).toBe(true);
  });

  it("strips @-prefixed annotations from the default feature projection", async () => {
    const { fetchImpl } = createMockFetch([
      {
        body: {
          value: [{ "@odata.id": "Incidents(1)", "@odata.etag": "W/1", Id: 1, Status: "open" }],
          "@odata.deltaLink": `${COLLECTION_URL}?$deltatoken=v1`,
        },
      },
    ]);
    const transport = createOdataDeltaTransport<Incident>({
      url: COLLECTION_URL,
      pollIntervalMs: 5_000,
      entityId,
      fetchImpl,
    });
    const observer = createRecordingObserver<Incident>();
    transport.subscribe({ sourceId: "incidents" }, observer);
    await vi.advanceTimersByTimeAsync(0);

    expect(observer.events[0]).toMatchObject({
      type: "snapshot",
      features: [{ id: 1, feature: { Id: 1, Status: "open" } }],
    });
  });
});
