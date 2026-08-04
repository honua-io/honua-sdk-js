import { describe, expect, it, vi } from "vitest";

import {
  DEFAULT_REALTIME_CHECKPOINT_MAX_AGE_MS,
  DEFAULT_REALTIME_CHECKPOINT_MAX_RECORDS,
  HONUA_REALTIME_CHECKPOINT_STORE_FORMAT,
  MAX_REALTIME_CHECKPOINT_MAX_AGE_MS,
  MAX_REALTIME_CHECKPOINT_RECORDS,
  createMemoryRealtimeCheckpointStore,
  createRealtimeCheckpointStore,
  createResumableRealtimeSubscription,
  realtimeAuthorizationScopeDigest,
  realtimeCheckpointScopeKey,
} from "../src/realtime/index.js";
import type {
  RealtimeCheckpointRecordStorage,
  RealtimeCheckpointRecordV1,
  RealtimeCheckpointStoreDiagnosticV1,
  RealtimeCheckpointStoreOptions,
  RealtimeDurableCheckpointV1,
  RealtimeResumeContextV1,
} from "../src/realtime/index.js";

interface Feature {
  readonly id: number;
  readonly status: string;
}

const NOW = Date.parse("2026-08-03T12:00:00.000Z");

const context: RealtimeResumeContextV1 = {
  kind: "honua.realtime-resume-context",
  version: 1,
  sourceId: "incidents",
  queryFingerprint: `sha256:${"a".repeat(64)}`,
  sourceVersion: "incidents-snapshot-v7",
  schemaVersion: "incident-schema-v3",
  authorizationScopeFingerprint: "dispatch-read-v2",
};

describe("realtime checkpoint store", () => {
  it("resumes a subscription from a stored cursor after a reload", async () => {
    const store = createMemoryRealtimeCheckpointStore({ now: () => NOW });
    const first = await createResumableRealtimeSubscription<Feature>({
      context,
      now: () => NOW,
      apply: vi.fn(),
      checkpointStore: store,
    });
    await first.enqueue({
      type: "snapshot",
      eventId: "snapshot-5",
      sequence: 5,
      cursor: "cursor-5",
      watermark: "watermark-5",
      features: [patch(1, "open")],
    });
    await first.enqueue({
      type: "upsert",
      eventId: "delta-6",
      sequence: 6,
      cursor: "cursor-6",
      feature: patch(1, "assigned"),
    });
    expect(first.state).toMatchObject({ phase: "live", checkpointPersisted: true });
    first.close();

    // A reload is a brand new gate reading the same durable store.
    const reloaded = await createResumableRealtimeSubscription<Feature>({
      context,
      now: () => NOW + 1_000,
      apply: vi.fn(),
      checkpointStore: store,
    });
    expect(reloaded.state).toMatchObject({
      phase: "resuming",
      checkpointPersisted: true,
      checkpoint: { resume: { sequence: 6, cursor: "cursor-6", watermark: "watermark-5" } },
    });

    // Resuming means the next contiguous delta applies without a resnapshot.
    await expect(
      reloaded.enqueue({
        type: "upsert",
        eventId: "delta-7",
        sequence: 7,
        cursor: "cursor-7",
        feature: patch(1, "closed"),
      }),
    ).resolves.toMatchObject({ status: "applied", checkpoint: { resume: { sequence: 7 } } });
  });

  it("keeps one bounded record per scope and persists only resume state", async () => {
    const store = createMemoryRealtimeCheckpointStore({ now: () => NOW });
    await store.save(checkpoint({ sequence: 5, cursor: "cursor-5" }), signal());
    await store.save(checkpoint({ sequence: 6, cursor: "cursor-6", deltaToken: "delta-6" }), signal());

    const records = await store.records();
    expect(records).toHaveLength(1);
    expect(records[0]).toEqual({
      key: realtimeCheckpointScopeKey(context),
      format: HONUA_REALTIME_CHECKPOINT_STORE_FORMAT,
      sourceId: "incidents",
      queryFingerprint: context.queryFingerprint,
      sourceVersion: "incidents-snapshot-v7",
      schemaVersion: "incident-schema-v3",
      authorizationScopeDigest: realtimeAuthorizationScopeDigest("dispatch-read-v2"),
      resume: { sequence: 6, cursor: "cursor-6", deltaToken: "delta-6" },
      savedAt: "2026-08-03T11:59:30.000Z",
      observedAt: new Date(NOW).toISOString(),
    });
    // A record is a cursor, not delivery history or a payload.
    expect(records[0]).not.toHaveProperty("recentEventIds");
    expect(HONUA_REALTIME_CHECKPOINT_STORE_FORMAT).toBe("honua.realtime-checkpoint-store/1.0");
  });

  it("persists no credential, header, or request URL for any stored scope", async () => {
    const diagnostics: RealtimeCheckpointStoreDiagnosticV1[] = [];
    const store = createMemoryRealtimeCheckpointStore({ now: () => NOW, onDiagnostic: collect(diagnostics) });
    await store.save(checkpoint({ sequence: 1, cursor: "cursor-1", watermark: "watermark-1" }), signal());
    await store.save(
      checkpoint({ sequence: 2, cursor: "cursor-2", deltaToken: "delta-2" }, otherScope("vehicles")),
      signal(),
    );

    const records = await store.records();
    expect(records).toHaveLength(2);
    // The persisted field set is closed: cursors, scope identity, times.
    for (const record of records) {
      expect(Object.keys(record).sort()).toEqual([
        "authorizationScopeDigest",
        "format",
        "key",
        "observedAt",
        "queryFingerprint",
        "resume",
        "savedAt",
        "schemaVersion",
        "sourceId",
        "sourceVersion",
      ]);
      expect(Object.keys(record.resume).sort()).toEqual(
        record.resume.deltaToken === undefined
          ? ["cursor", "sequence", "watermark"]
          : ["cursor", "deltaToken", "sequence"],
      );
    }
    const values = enumerateStringValues(records);
    for (const value of values) {
      expect(value).not.toMatch(/^https?:\/\//i);
      expect(value).not.toMatch(/[?#@]/);
      expect(value).not.toMatch(/(?:authorization|bearer|cookie|password|secret|session|token|api[-_]?key)/i);
    }
    // The raw authorization-scope fingerprint never reaches storage; only its digest does.
    expect(values).not.toContain("dispatch-read-v2");
    expect(diagnostics).toHaveLength(0);
  });

  it("refuses to persist a credential-shaped or request-URL resume position", async () => {
    const diagnostics: RealtimeCheckpointStoreDiagnosticV1[] = [];
    const store = createMemoryRealtimeCheckpointStore({ now: () => NOW, onDiagnostic: collect(diagnostics) });
    await store.save(checkpoint({ sequence: 4, cursor: "https://example.test/features?$deltatoken=abc" }), signal());
    expect(await store.records()).toHaveLength(0);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({
      kind: "honua.realtime-checkpoint-store-diagnostic",
      version: 1,
      operation: "save",
      reason: "credential-screened",
    });
    expect(diagnostics[0]?.error.code).toBe("checkpoint-save-failed");
    // The refusal must never echo the offending value.
    expect(diagnostics[0]?.error.message).not.toContain("deltatoken");

    await store.save(checkpoint({ sequence: 5, deltaToken: "authorization=abcdef" }), signal());
    expect(await store.records()).toHaveLength(0);
    expect(diagnostics.map((value) => value.reason)).toEqual(["credential-screened", "credential-screened"]);

    // A refused write is not a subscription failure: the gate keeps running.
    const gate = await createResumableRealtimeSubscription<Feature>({
      context,
      now: () => NOW,
      apply: vi.fn(),
      checkpointStore: store,
    });
    await expect(
      gate.enqueue({
        type: "snapshot",
        sequence: 9,
        cursor: "https://example.test/features?token=1",
        features: [patch(1, "open")],
      }),
    ).resolves.toMatchObject({ status: "applied" });
    expect(gate.state.phase).toBe("live");
    expect(await store.records()).toHaveLength(0);
  });

  it("discards a checkpoint whose scope identity changed and forces an explicit resnapshot", async () => {
    const diagnostics: RealtimeCheckpointStoreDiagnosticV1[] = [];
    const store = createMemoryRealtimeCheckpointStore({ now: () => NOW, onDiagnostic: collect(diagnostics) });
    await store.save(checkpoint({ sequence: 6, cursor: "cursor-6" }), signal());

    const upgraded: RealtimeResumeContextV1 = { ...context, sourceVersion: "incidents-snapshot-v8" };
    await expect(store.load(upgraded, signal())).resolves.toBeUndefined();
    expect(await store.records()).toHaveLength(0);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({ operation: "load", reason: "source-version-changed" });
    expect(diagnostics[0]?.error.code).toBe("source-version-changed");

    const gate = await createResumableRealtimeSubscription<Feature>({
      context: upgraded,
      now: () => NOW,
      apply: vi.fn(),
      checkpointStore: store,
    });
    expect(gate.state).toMatchObject({ phase: "awaiting-snapshot", checkpointPersisted: false });
    // Fail closed: a delta cannot apply until a replacement snapshot arrives.
    await expect(gate.enqueue({ type: "upsert", sequence: 7, feature: patch(1, "closed") })).resolves.toMatchObject({
      status: "resnapshot-required",
      reason: "snapshot-required",
    });
  });

  it("discards a checkpoint whose schema version changed", async () => {
    const diagnostics: RealtimeCheckpointStoreDiagnosticV1[] = [];
    const store = createMemoryRealtimeCheckpointStore({ now: () => NOW, onDiagnostic: collect(diagnostics) });
    await store.save(checkpoint({ sequence: 6, cursor: "cursor-6" }), signal());
    await expect(store.load({ ...context, schemaVersion: "incident-schema-v4" }, signal())).resolves.toBeUndefined();
    expect(diagnostics.at(-1)).toMatchObject({ operation: "load", reason: "schema-version-changed" });
    expect(await store.records()).toHaveLength(0);
  });

  it("never returns another authorization scope's checkpoint", async () => {
    const diagnostics: RealtimeCheckpointStoreDiagnosticV1[] = [];
    const store = createMemoryRealtimeCheckpointStore({ now: () => NOW, onDiagnostic: collect(diagnostics) });
    await store.save(checkpoint({ sequence: 6, cursor: "cursor-6" }), signal());

    const otherTenant: RealtimeResumeContextV1 = { ...context, authorizationScopeFingerprint: "dispatch-read-other" };
    await expect(store.load(otherTenant, signal())).resolves.toBeUndefined();
    // The scope key itself is scoped, so another tenant cannot even address the record.
    expect(await store.records()).toHaveLength(1);
    expect(realtimeCheckpointScopeKey(otherTenant)).not.toBe(realtimeCheckpointScopeKey(context));
    expect(diagnostics).toHaveLength(0);

    // A record whose stored digest was tampered with is discarded explicitly.
    const seeded = seededStorage({ ...validRecord(), authorizationScopeDigest: `sha256:${"f".repeat(64)}` });
    const tampered = createRealtimeCheckpointStore(seeded.storage, {
      now: () => NOW,
      onDiagnostic: collect(diagnostics),
    });
    await expect(tampered.load(context, signal())).resolves.toBeUndefined();
    expect(seeded.rows.size).toBe(0);
    expect(diagnostics.at(-1)).toMatchObject({ operation: "load", reason: "authorization-scope-changed" });
  });

  it("forces a resnapshot once a checkpoint passes the maximum age", async () => {
    const diagnostics: RealtimeCheckpointStoreDiagnosticV1[] = [];
    let now = NOW;
    const store = createMemoryRealtimeCheckpointStore({
      maxAgeMs: 60_000,
      now: () => now,
      onDiagnostic: collect(diagnostics),
    });
    await store.save(checkpoint({ sequence: 6, cursor: "cursor-6" }, context, NOW), signal());

    now = NOW + 60_000;
    await expect(store.load(context, signal())).resolves.toMatchObject({
      resume: { sequence: 6, cursor: "cursor-6" },
    });

    now = NOW + 60_001;
    await expect(store.load(context, signal())).resolves.toBeUndefined();
    expect(await store.records()).toHaveLength(0);
    expect(diagnostics.at(-1)).toMatchObject({ operation: "load", reason: "checkpoint-expired" });
    expect(diagnostics.at(-1)?.error.code).toBe("cursor-expired");
    expect(diagnostics.at(-1)?.error.sdkCode).toBe("realtime.transport.reconnectable");

    // A checkpoint stamped in the future is corrupt time, not a fresh cursor.
    const skewed = createMemoryRealtimeCheckpointStore({ now: () => NOW });
    await skewed.save(checkpoint({ sequence: 6 }, context, NOW + 10_000), signal());
    await expect(skewed.load(context, signal())).resolves.toBeUndefined();
  });

  it("discards corrupt records on load without failing the subscription", async () => {
    const corrupt: readonly unknown[] = [
      null,
      "not-a-record",
      { ...validRecord(), resume: { sequence: -1 } },
      { ...validRecord(), resume: { sequence: 6, cursor: 7 } },
      { ...validRecord(), resume: undefined },
      { ...validRecord(), savedAt: "not-a-timestamp" },
      { ...validRecord(), observedAt: undefined },
      { ...validRecord(), sourceId: "" },
      { ...validRecord(), authorizationScopeDigest: "not-a-digest" },
    ];
    for (const value of corrupt) {
      const diagnostics: RealtimeCheckpointStoreDiagnosticV1[] = [];
      const seeded = seededStorage(value);
      const store = createRealtimeCheckpointStore(seeded.storage, {
        now: () => NOW,
        onDiagnostic: collect(diagnostics),
      });
      const gate = await createResumableRealtimeSubscription<Feature>({
        context,
        now: () => NOW,
        apply: vi.fn(),
        checkpointStore: store,
      });
      expect(gate.state.phase).toBe("awaiting-snapshot");
      expect(seeded.rows.size).toBe(0);
      expect(diagnostics.at(-1)).toMatchObject({ operation: "load", reason: "invalid-checkpoint" });
      await expect(
        gate.enqueue({ type: "snapshot", sequence: 1, cursor: "cursor-1", features: [patch(1, "open")] }),
      ).resolves.toMatchObject({ status: "applied" });
    }
  });

  it("reports a foreign store format as a version fact rather than corruption", async () => {
    // A record written in another store layout is not damage: it is a layout
    // this build declines to interpret. The cursor is still discarded — cursors
    // are cheap and resnapshotting is honest — but the reason says which.
    for (const format of ["honua.realtime-checkpoint-store/2.0", "honua.realtime-checkpoint-store/0.9", undefined, 7]) {
      const diagnostics: RealtimeCheckpointStoreDiagnosticV1[] = [];
      const seeded = seededStorage({ ...validRecord(), format });
      const store = createRealtimeCheckpointStore(seeded.storage, {
        now: () => NOW,
        onDiagnostic: collect(diagnostics),
      });
      const gate = await createResumableRealtimeSubscription<Feature>({
        context,
        now: () => NOW,
        apply: vi.fn(),
        checkpointStore: store,
      });
      expect(gate.state.phase).toBe("awaiting-snapshot");
      expect(seeded.rows.size).toBe(0);
      expect(diagnostics.at(-1)).toMatchObject({ operation: "load", reason: "unsupported-format" });
      // The offending value is never echoed; a hostile record could put
      // anything in that field.
      expect(diagnostics.at(-1)?.error.message).not.toContain(String(format));
      expect(diagnostics.at(-1)?.error).toMatchObject({ code: "invalid-checkpoint" });
      await expect(
        gate.enqueue({ type: "snapshot", sequence: 1, cursor: "cursor-1", features: [patch(1, "open")] }),
      ).resolves.toMatchObject({ status: "applied" });
    }
  });

  it("degrades a storage failure to a resnapshot instead of throwing into the subscription", async () => {
    const diagnostics: RealtimeCheckpointStoreDiagnosticV1[] = [];
    const readError = new Error("storage unavailable");
    const failing: RealtimeCheckpointRecordStorage = {
      read: () => Promise.reject(readError),
      write: () => Promise.reject(new Error("quota exceeded")),
      remove: () => Promise.reject(new Error("quota exceeded")),
      list: async () => [],
      clear: async () => undefined,
    };
    const store = createRealtimeCheckpointStore(failing, { now: () => NOW, onDiagnostic: collect(diagnostics) });

    const gate = await createResumableRealtimeSubscription<Feature>({
      context,
      now: () => NOW,
      apply: vi.fn(),
      checkpointStore: store,
    });
    expect(gate.state.phase).toBe("awaiting-snapshot");
    expect(diagnostics[0]).toMatchObject({ operation: "load", reason: "storage-failed" });
    expect(diagnostics[0]?.error.code).toBe("checkpoint-load-failed");
    expect(diagnostics[0]?.error.cause).toBe(readError);

    await expect(
      gate.enqueue({ type: "snapshot", sequence: 1, cursor: "cursor-1", features: [patch(1, "open")] }),
    ).resolves.toMatchObject({ status: "applied" });
    expect(gate.state.phase).toBe("live");
    expect(diagnostics.at(-1)).toMatchObject({ operation: "save", reason: "storage-failed" });
    expect(diagnostics.at(-1)?.error.code).toBe("checkpoint-load-failed");
  });

  it("bounds the record count and evicts the least recently written scope", async () => {
    let now = NOW;
    const store = createMemoryRealtimeCheckpointStore({ maxRecords: 2, now: () => now });
    for (const sourceId of ["alpha", "bravo", "charlie"]) {
      now += 1_000;
      await store.save(checkpoint({ sequence: 1, cursor: `cursor-${sourceId}` }, otherScope(sourceId)), signal());
    }
    const records = await store.records();
    expect(records).toHaveLength(2);
    expect(records.map((record) => record.sourceId).sort()).toEqual(["bravo", "charlie"]);
    await expect(store.load(otherScope("alpha"), signal())).resolves.toBeUndefined();

    await store.clear();
    expect(await store.records()).toHaveLength(0);
  });

  it("rejects limits outside the documented safety ceilings", () => {
    expect(DEFAULT_REALTIME_CHECKPOINT_MAX_AGE_MS).toBe(15 * 60 * 1000);
    expect(DEFAULT_REALTIME_CHECKPOINT_MAX_RECORDS).toBe(64);
    expect(MAX_REALTIME_CHECKPOINT_MAX_AGE_MS).toBe(24 * 60 * 60 * 1000);
    expect(MAX_REALTIME_CHECKPOINT_RECORDS).toBe(512);
    const overAge: RealtimeCheckpointStoreOptions = { maxAgeMs: MAX_REALTIME_CHECKPOINT_MAX_AGE_MS + 1 };
    expect(() => createMemoryRealtimeCheckpointStore(overAge)).toThrow(/maxAgeMs cannot exceed/);
    expect(() => createMemoryRealtimeCheckpointStore({ maxRecords: MAX_REALTIME_CHECKPOINT_RECORDS + 1 })).toThrow(
      /maxRecords cannot exceed/,
    );
    expect(() => createMemoryRealtimeCheckpointStore({ maxRecords: 0 })).toThrow(/safe integer greater than zero/);
    expect(() => createMemoryRealtimeCheckpointStore({ maxAgeMs: 1.5 })).toThrow(/safe integer greater than zero/);
  });

  it("changes nothing when no store is configured", async () => {
    const gate = await createResumableRealtimeSubscription<Feature>({ context, now: () => NOW, apply: vi.fn() });
    expect(gate.state).toMatchObject({ phase: "awaiting-snapshot", checkpointPersisted: false });
    await expect(
      gate.enqueue({ type: "snapshot", sequence: 1, cursor: "cursor-1", features: [patch(1, "open")] }),
    ).resolves.toMatchObject({ status: "applied" });
    // Without a store the accepted position stays in memory and claims no durability.
    expect(gate.state).toMatchObject({ phase: "live", checkpointPersisted: false });

    const fresh = await createResumableRealtimeSubscription<Feature>({ context, now: () => NOW, apply: vi.fn() });
    expect(fresh.state.checkpoint).toBeUndefined();
  });

  it("honours an aborted signal without touching storage", async () => {
    const store = createMemoryRealtimeCheckpointStore({ now: () => NOW });
    const aborted = AbortSignal.abort();
    await expect(store.load(context, aborted)).resolves.toBeUndefined();
    await store.save(checkpoint({ sequence: 1, cursor: "cursor-1" }), aborted);
    expect(await store.records()).toHaveLength(0);
  });

  it("refuses to persist a structurally invalid checkpoint", async () => {
    const diagnostics: RealtimeCheckpointStoreDiagnosticV1[] = [];
    const store = createMemoryRealtimeCheckpointStore({ now: () => NOW, onDiagnostic: collect(diagnostics) });
    await store.save({ kind: "honua.realtime-checkpoint", version: 1 } as RealtimeDurableCheckpointV1, signal());
    expect(await store.records()).toHaveLength(0);
    expect(diagnostics.at(-1)).toMatchObject({ operation: "save", reason: "invalid-checkpoint" });

    await store.save(undefined as unknown as RealtimeDurableCheckpointV1, signal());
    expect(diagnostics.at(-1)).toMatchObject({ operation: "save", reason: "invalid-checkpoint" });
    expect(await store.records()).toHaveLength(0);
  });
});

function patch(id: number, status: string) {
  return { sourceId: "incidents", id, feature: { id, status } } as const;
}

function signal(): AbortSignal {
  return new AbortController().signal;
}

function collect(
  diagnostics: RealtimeCheckpointStoreDiagnosticV1[],
): (diagnostic: RealtimeCheckpointStoreDiagnosticV1) => void {
  return (diagnostic) => {
    diagnostics.push(diagnostic);
  };
}

function otherScope(sourceId: string): RealtimeResumeContextV1 {
  return { ...context, sourceId, queryFingerprint: `sha256:${sourceId.padEnd(64, "0")}` };
}

function checkpoint(
  resume: { sequence: number; cursor?: string; watermark?: string; deltaToken?: string },
  boundContext: RealtimeResumeContextV1 = context,
  savedAtMs = NOW - 30_000,
): RealtimeDurableCheckpointV1 {
  return {
    kind: "honua.realtime-checkpoint",
    version: 1,
    context: boundContext,
    resume,
    recentEventIds: ["event-a", "event-b"],
    savedAt: new Date(savedAtMs).toISOString(),
  };
}

function validRecord(): Record<string, unknown> {
  return {
    key: realtimeCheckpointScopeKey(context),
    format: HONUA_REALTIME_CHECKPOINT_STORE_FORMAT,
    sourceId: "incidents",
    queryFingerprint: context.queryFingerprint,
    sourceVersion: context.sourceVersion,
    schemaVersion: context.schemaVersion,
    authorizationScopeDigest: realtimeAuthorizationScopeDigest(context.authorizationScopeFingerprint),
    resume: { sequence: 6, cursor: "cursor-6" },
    savedAt: new Date(NOW - 1_000).toISOString(),
    observedAt: new Date(NOW - 1_000).toISOString(),
  };
}

/**
 * Storage seeded with an arbitrary raw row under the context's scope key, so a
 * corrupt or hostile record can be reproduced without a browser.
 */
function seededStorage(value: unknown): { storage: RealtimeCheckpointRecordStorage; rows: Map<string, unknown> } {
  const rows = new Map<string, unknown>([[realtimeCheckpointScopeKey(context), value]]);
  return {
    rows,
    storage: {
      read: async (key) => rows.get(key),
      write: async (record) => {
        rows.set(record.key, record);
      },
      remove: async (key) => {
        rows.delete(key);
      },
      list: async () => [...rows.values()],
      clear: async () => rows.clear(),
    },
  };
}

function enumerateStringValues(value: unknown, output: string[] = []): string[] {
  if (typeof value === "string") output.push(value);
  else if (Array.isArray(value)) for (const item of value) enumerateStringValues(item, output);
  else if (typeof value === "object" && value !== null) {
    for (const item of Object.values(value)) enumerateStringValues(item, output);
  }
  return output;
}
