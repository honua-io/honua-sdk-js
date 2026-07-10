import { describe, expect, it, vi } from "vitest";

import {
  REALTIME_DURABLE_CHECKPOINT_VERSION,
  createResumableRealtimeSubscription,
  evaluateRealtimeCheckpoint,
} from "../src/realtime/index.js";
import type {
  RealtimeCheckpointStore,
  RealtimeDurableCheckpointV1,
  RealtimeResumeContextV1,
  RealtimeSequencedEvent,
} from "../src/realtime/index.js";

interface Feature {
  readonly id: number;
  readonly status: string;
}

const context: RealtimeResumeContextV1 = {
  kind: "honua.realtime-resume-context",
  version: 1,
  sourceId: "incidents",
  queryFingerprint: "sha256:accepted-query-v1",
  sourceVersion: "incidents-snapshot-v7",
  schemaVersion: "incident-schema-v3",
  authorizationScopeFingerprint: "sha256:dispatch-read-v2",
};

describe("resumable realtime subscription", () => {
  it("reduces snapshot plus ordered deltas to the same state as a fresh snapshot and persists checkpoints", async () => {
    const records = new Map<number, Feature>();
    const saved: RealtimeDurableCheckpointV1[] = [];
    const gate = await createResumableRealtimeSubscription<Feature>({
      context,
      now: () => Date.parse("2026-07-10T23:00:00.000Z"),
      apply: (event) => applyToMap(records, event),
      checkpointStore: {
        async load() {
          return undefined;
        },
        async save(value) {
          saved.push(value);
        },
      },
    });

    expect(gate.state.phase).toBe("awaiting-snapshot");
    await expect(
      gate.enqueue({
        type: "snapshot",
        eventId: "snapshot-5",
        sequence: 5,
        cursor: "cursor-5",
        features: [patch(1, "open"), patch(2, "monitoring")],
      }),
    ).resolves.toMatchObject({ status: "applied", checkpoint: { resume: { sequence: 5, cursor: "cursor-5" } } });
    await gate.enqueue({
      type: "delta",
      eventId: "delta-6",
      sequence: 6,
      cursor: "cursor-6",
      upserts: [patch(1, "assigned"), patch(3, "open")],
      deletes: [{ sourceId: "incidents", id: 2 }],
    });

    expect([...records.values()]).toEqual([
      { id: 1, status: "assigned" },
      { id: 3, status: "open" },
    ]);
    expect(saved).toHaveLength(2);
    expect(gate.state).toMatchObject({ phase: "live", checkpointPersisted: true, acceptedEventCount: 2 });
    expect(gate.state.checkpoint).toMatchObject({
      kind: "honua.realtime-checkpoint",
      version: REALTIME_DURABLE_CHECKPOINT_VERSION,
      context,
      resume: { cursor: "cursor-6", sequence: 6 },
      recentEventIds: ["snapshot-5", "delta-6"],
      savedAt: "2026-07-10T23:00:00.000Z",
    });
    expect(() => (gate.state.checkpoint?.recentEventIds as string[]).push("tamper")).toThrow(TypeError);
  });

  it("resumes only a compatible source, query, schema, version, and authorization scope", async () => {
    const base = durableCheckpoint();
    expect(evaluateRealtimeCheckpoint(context, base)).toMatchObject({ compatible: true, code: "compatible" });

    for (const [field, code] of [
      ["sourceId", "source-changed"],
      ["queryFingerprint", "query-changed"],
      ["sourceVersion", "source-version-changed"],
      ["schemaVersion", "schema-version-changed"],
      ["authorizationScopeFingerprint", "authorization-scope-changed"],
    ] as const) {
      const changed = { ...context, [field]: `${context[field]}-changed` };
      expect(evaluateRealtimeCheckpoint(changed, base)).toMatchObject({ compatible: false, code });
    }

    const gate = await createResumableRealtimeSubscription({
      context: { ...context, schemaVersion: "incident-schema-v4" },
      initialCheckpoint: base,
      apply: vi.fn(),
    });
    expect(gate.state).toMatchObject({ phase: "resnapshot-required", reason: "schema-version-changed" });
    await expect(gate.enqueue({ type: "upsert", sequence: 11, feature: patch(1, "closed") })).resolves.toMatchObject({
      status: "resnapshot-required",
      reason: "schema-version-changed",
    });

    expect(
      evaluateRealtimeCheckpoint(context, {
        ...base,
        context: undefined,
      } as unknown as RealtimeDurableCheckpointV1),
    ).toMatchObject({ compatible: false, code: "invalid-checkpoint" });
    expect(
      evaluateRealtimeCheckpoint(context, {
        ...base,
        resume: { sequence: 10, cursor: 42 },
      } as unknown as RealtimeDurableCheckpointV1),
    ).toMatchObject({ compatible: false, code: "invalid-checkpoint" });
  });

  it("deduplicates replays, detects sequence gaps, and recovers only with a replacement snapshot", async () => {
    const applied: number[] = [];
    const gate = await createResumableRealtimeSubscription<Feature>({
      context,
      initialCheckpoint: durableCheckpoint(),
      apply: (event) => {
        applied.push(event.sequence ?? -1);
      },
    });

    await expect(
      gate.enqueue({ type: "upsert", eventId: "old", sequence: 10, feature: patch(1, "open") }),
    ).resolves.toMatchObject({ status: "duplicate" });
    await expect(
      gate.enqueue({ type: "upsert", eventId: "event-11", sequence: 11, feature: patch(1, "open") }),
    ).resolves.toMatchObject({ status: "applied" });
    expect(gate.state.checkpointPersisted).toBe(false);
    await expect(
      gate.enqueue({ type: "upsert", eventId: "event-13", sequence: 13, feature: patch(1, "closed") }),
    ).resolves.toMatchObject({ status: "resnapshot-required", reason: "sequence-gap" });
    expect(gate.state).toMatchObject({ phase: "resnapshot-required", gapCount: 1 });
    expect(applied).toEqual([11]);

    await expect(gate.enqueue({ type: "upsert", sequence: 12, feature: patch(1, "closed") })).resolves.toMatchObject({
      status: "resnapshot-required",
    });
    await expect(
      gate.enqueue({ type: "snapshot", eventId: "snapshot-20", sequence: 20, features: [patch(1, "closed")] }),
    ).resolves.toMatchObject({ status: "applied", checkpoint: { resume: { sequence: 20 } } });
    expect(gate.state.phase).toBe("live");
    expect(applied).toEqual([11, 20]);
  });

  it("fails closed on conflicting checkpoint fields and reused event ids at a new sequence", async () => {
    const apply = vi.fn();
    const conflict = await createResumableRealtimeSubscription<Feature>({
      context,
      initialCheckpoint: durableCheckpoint(),
      apply,
    });
    await expect(
      conflict.enqueue({
        type: "upsert",
        sequence: 11,
        cursor: "direct",
        checkpoint: { sequence: 11, cursor: "nested" },
        feature: patch(1, "open"),
      }),
    ).resolves.toMatchObject({ status: "resnapshot-required", reason: "checkpoint-conflict" });
    expect(apply).not.toHaveBeenCalled();

    const reused = await createResumableRealtimeSubscription<Feature>({
      context,
      initialCheckpoint: durableCheckpoint({ recentEventIds: ["event-11"] }),
      apply,
    });
    await expect(
      reused.enqueue({ type: "upsert", eventId: "event-11", sequence: 11, feature: patch(1, "open") }),
    ).resolves.toMatchObject({ status: "resnapshot-required", reason: "event-id-reused" });
    expect(apply).not.toHaveBeenCalled();
  });

  it("projects server cursor expiry or unsupported resume into an explicit replacement-snapshot transition", async () => {
    const apply = vi.fn();
    const gate = await createResumableRealtimeSubscription<Feature>({
      context,
      initialCheckpoint: durableCheckpoint(),
      apply,
    });
    gate.requireResnapshot("cursor-expired", "Server retention no longer includes cursor-10.");
    expect(gate.state).toMatchObject({ phase: "resnapshot-required", reason: "cursor-expired" });
    await expect(gate.enqueue({ type: "upsert", sequence: 11, feature: patch(1, "unsafe") })).resolves.toMatchObject({
      status: "resnapshot-required",
      reason: "cursor-expired",
    });
    expect(apply).not.toHaveBeenCalled();
    await expect(
      gate.enqueue({ type: "snapshot", sequence: 20, features: [patch(1, "fresh")] }),
    ).resolves.toMatchObject({ status: "applied" });
  });

  it("bounds slow-consumer buffering and explicitly requires a resnapshot without committing stale queued events", async () => {
    let release = () => {};
    const deferred = new Promise<void>((resolve) => {
      release = resolve;
    });
    const applied: number[] = [];
    const gate = await createResumableRealtimeSubscription<Feature>({
      context,
      initialCheckpoint: durableCheckpoint(),
      maxPendingEvents: 2,
      apply: async (event) => {
        applied.push(event.sequence ?? -1);
        if (event.sequence === 11) await deferred;
      },
    });

    const active = gate.enqueue({ type: "upsert", sequence: 11, feature: patch(1, "active") });
    const queued = gate.enqueue({ type: "upsert", sequence: 12, feature: patch(1, "queued") });
    await expect(gate.enqueue({ type: "upsert", sequence: 13, feature: patch(1, "overflow") })).resolves.toMatchObject({
      status: "resnapshot-required",
      reason: "buffer-overflow",
    });
    await expect(queued).resolves.toMatchObject({ status: "resnapshot-required", reason: "buffer-overflow" });
    expect(gate.state).toMatchObject({ phase: "resnapshot-required", overflowCount: 1 });
    release();
    await expect(active).resolves.toMatchObject({ status: "cancelled" });
    expect(applied).toEqual([11]);

    await expect(
      gate.enqueue({ type: "snapshot", sequence: 20, features: [patch(1, "recovered")] }),
    ).resolves.toMatchObject({ status: "applied" });
    expect(gate.state).toMatchObject({ phase: "live", pendingEvents: 0 });
  });

  it("allows the sole recovery snapshot to wait behind an abort-ignoring consumer at a one-event bound", async () => {
    let release = () => {};
    const deferred = new Promise<void>((resolve) => {
      release = resolve;
    });
    const gate = await createResumableRealtimeSubscription<Feature>({
      context,
      initialCheckpoint: durableCheckpoint(),
      maxPendingEvents: 1,
      apply: async (event) => {
        if (event.sequence === 11) await deferred;
      },
    });
    const active = gate.enqueue({ type: "upsert", sequence: 11, feature: patch(1, "slow") });
    await expect(gate.enqueue({ type: "upsert", sequence: 12, feature: patch(1, "overflow") })).resolves.toMatchObject({
      status: "resnapshot-required",
      reason: "buffer-overflow",
    });
    const recovery = gate.enqueue({ type: "snapshot", sequence: 20, features: [patch(1, "recovered")] });
    release();
    await expect(active).resolves.toMatchObject({ status: "cancelled" });
    await expect(recovery).resolves.toMatchObject({ status: "applied" });
    expect(gate.state.phase).toBe("live");
  });

  it("cancels before effects and reports consumer or persistence failures without advancing silently", async () => {
    const controller = new AbortController();
    controller.abort("caller cancelled");
    const apply = vi.fn();
    const cancelled = await createResumableRealtimeSubscription<Feature>({ context, apply, signal: controller.signal });
    await expect(
      cancelled.enqueue({ type: "snapshot", sequence: 1, features: [patch(1, "open")] }),
    ).resolves.toMatchObject({ status: "cancelled" });
    expect(cancelled.state).toMatchObject({ phase: "closed", reason: "cancelled" });
    expect(apply).not.toHaveBeenCalled();

    const consumerFailure = await createResumableRealtimeSubscription<Feature>({
      context,
      apply: () => {
        throw new Error("sink unavailable");
      },
    });
    await expect(
      consumerFailure.enqueue({ type: "snapshot", sequence: 1, features: [patch(1, "open")] }),
    ).resolves.toMatchObject({ status: "error", reason: "consumer-failed" });
    expect(consumerFailure.state.checkpoint).toBeUndefined();

    let failActive = () => {};
    const activeFailure = new Promise<void>((_resolve, reject) => {
      failActive = () => reject(new Error("active sink failed"));
    });
    const queuedFailure = await createResumableRealtimeSubscription<Feature>({
      context,
      apply: async (event) => {
        if (event.sequence === 1) await activeFailure;
      },
    });
    const activeDelivery = queuedFailure.enqueue({
      type: "snapshot",
      sequence: 1,
      features: [patch(1, "open")],
    });
    const queuedDelivery = queuedFailure.enqueue({ type: "upsert", sequence: 2, feature: patch(1, "closed") });
    failActive();
    await expect(activeDelivery).resolves.toMatchObject({ status: "error", reason: "consumer-failed" });
    await expect(queuedDelivery).resolves.toMatchObject({ status: "error", reason: "consumer-failed" });
    await vi.waitFor(() => expect(queuedFailure.state.pendingEvents).toBe(0));

    const store: RealtimeCheckpointStore = {
      async load() {
        return undefined;
      },
      async save() {
        throw new Error("disk full");
      },
    };
    const persistenceFailure = await createResumableRealtimeSubscription<Feature>({
      context,
      checkpointStore: store,
      apply: vi.fn(),
    });
    await expect(
      persistenceFailure.enqueue({ type: "snapshot", sequence: 1, features: [patch(1, "open")] }),
    ).resolves.toMatchObject({ status: "error", reason: "checkpoint-save-failed" });
    expect(persistenceFailure.state).toMatchObject({
      phase: "error",
      checkpointPersisted: false,
      checkpoint: { resume: { sequence: 1 } },
    });

    const invalidClock = await createResumableRealtimeSubscription<Feature>({
      context,
      now: () => Number.NaN,
      apply: vi.fn(),
    });
    await expect(
      invalidClock.enqueue({ type: "snapshot", sequence: 1, features: [patch(1, "open")] }),
    ).resolves.toMatchObject({ status: "error", reason: "delivery-failed" });
  });
});

function patch(id: number, status: string) {
  return { sourceId: "incidents", id, feature: { id, status } } as const;
}

function durableCheckpoint(
  overrides: Partial<Pick<RealtimeDurableCheckpointV1, "recentEventIds">> = {},
): RealtimeDurableCheckpointV1 {
  return {
    kind: "honua.realtime-checkpoint",
    version: 1,
    context,
    resume: { cursor: "cursor-10", sequence: 10 },
    recentEventIds: overrides.recentEventIds ?? ["event-10"],
    savedAt: "2026-07-10T22:00:00.000Z",
  };
}

function applyToMap(records: Map<number, Feature>, event: RealtimeSequencedEvent<Feature>): void {
  if (event.type === "snapshot") {
    if (event.replace !== false) records.clear();
    for (const item of event.features) records.set(Number(item.id), item.feature);
    return;
  }
  if (event.type === "upsert") {
    records.set(Number(event.feature.id), event.feature.feature);
    return;
  }
  if (event.type === "delete") {
    records.delete(Number(event.id));
    return;
  }
  for (const item of event.upserts ?? []) records.set(Number(item.id), item.feature);
  for (const item of event.deletes ?? []) records.delete(Number(item.id));
}
