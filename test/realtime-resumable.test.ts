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

  it("preserves live snapshot dedupe history and resets it only for an explicit recovery epoch", async () => {
    const liveApply = vi.fn();
    const live = await createResumableRealtimeSubscription<Feature>({
      context,
      initialCheckpoint: durableCheckpoint({ recentEventIds: ["older-event", "reused-snapshot"] }),
      apply: liveApply,
    });
    const checkpointBeforeReuse = live.state.checkpoint;

    await expect(
      live.enqueue({
        type: "snapshot",
        eventId: "reused-snapshot",
        sequence: 12,
        features: [patch(1, "unsafe")],
      }),
    ).resolves.toMatchObject({ status: "resnapshot-required", reason: "event-id-reused" });
    expect(liveApply).not.toHaveBeenCalled();
    expect(live.state.acceptedEventCount).toBe(0);
    expect(live.state.checkpoint).toBe(checkpointBeforeReuse);

    const recoveryApply = vi.fn();
    const recovery = await createResumableRealtimeSubscription<Feature>({
      context,
      initialCheckpoint: durableCheckpoint({ recentEventIds: ["older-event", "reused-snapshot"] }),
      apply: recoveryApply,
    });
    recovery.requireResnapshot("cursor-expired");
    await expect(
      recovery.enqueue({
        type: "snapshot",
        eventId: "reused-snapshot",
        sequence: 1,
        cursor: "recovery-epoch-1",
        features: [patch(1, "recovered")],
      }),
    ).resolves.toMatchObject({ status: "applied" });
    expect(recoveryApply).toHaveBeenCalledTimes(1);
    expect(recovery.state).toMatchObject({
      acceptedEventCount: 1,
      checkpoint: {
        resume: { sequence: 1, cursor: "recovery-epoch-1" },
        recentEventIds: ["reused-snapshot"],
      },
    });
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

  it("does not let an unsolicited replacement snapshot regress a live baseline", async () => {
    const apply = vi.fn();
    const gate = await createResumableRealtimeSubscription<Feature>({
      context,
      initialCheckpoint: durableCheckpoint(),
      apply,
    });

    await expect(gate.enqueue({ type: "snapshot", sequence: 9, features: [patch(1, "stale")] })).resolves.toMatchObject(
      { status: "duplicate", checkpoint: { resume: { sequence: 10 } } },
    );
    expect(apply).not.toHaveBeenCalled();

    await expect(
      gate.enqueue({ type: "snapshot", sequence: 12, cursor: "cursor-12", features: [patch(1, "fresh")] }),
    ).resolves.toMatchObject({ status: "applied", checkpoint: { resume: { sequence: 12, cursor: "cursor-12" } } });

    gate.requireResnapshot("cursor-expired");
    await expect(
      gate.enqueue({ type: "snapshot", sequence: 1, cursor: "new-epoch-1", features: [patch(1, "reset")] }),
    ).resolves.toMatchObject({ status: "applied", checkpoint: { resume: { sequence: 1, cursor: "new-epoch-1" } } });
    expect(apply).toHaveBeenCalledTimes(2);
  });

  it("rejects non-data and unknown event discriminators before consumer effects or checkpoint advancement", async () => {
    for (const invalid of [
      { type: "status", status: "live", sequence: 11 },
      { type: "credential-refresh", sequence: 11 },
    ]) {
      const apply = vi.fn();
      const gate = await createResumableRealtimeSubscription<Feature>({
        context,
        initialCheckpoint: durableCheckpoint(),
        apply,
      });
      await expect(gate.enqueue(invalid as unknown as RealtimeSequencedEvent<Feature>)).resolves.toMatchObject({
        status: "resnapshot-required",
        reason: "invalid-event",
      });
      expect(apply).not.toHaveBeenCalled();
      expect(gate.state).toMatchObject({
        acceptedEventCount: 0,
        duplicateEventCount: 0,
        checkpoint: { resume: { sequence: 10 } },
      });
    }
  });

  it("projects credential-free checkpoint envelopes across load, event delivery, and save", async () => {
    const loaded = {
      ...durableCheckpoint(),
      resume: { sequence: 10, cursor: "cursor-10", secretToken: "loaded-secret" },
      secretToken: "envelope-secret",
    } as unknown as RealtimeDurableCheckpointV1;
    const applied: Array<Record<string, unknown>> = [];
    const saved: RealtimeDurableCheckpointV1[] = [];
    const gate = await createResumableRealtimeSubscription<Feature>({
      context,
      apply(event) {
        applied.push(event as unknown as Record<string, unknown>);
      },
      checkpointStore: {
        async load() {
          return loaded;
        },
        async save(checkpoint) {
          saved.push(checkpoint);
        },
      },
    });

    expect(gate.state.checkpoint).not.toHaveProperty("secretToken");
    expect(gate.state.checkpoint?.resume).not.toHaveProperty("secretToken");
    await gate.enqueue({
      type: "upsert",
      eventId: "event-11",
      sequence: 11,
      cursor: "cursor-11",
      checkpoint: { sequence: 11, cursor: "cursor-11", secretToken: "event-secret" } as never,
      feature: patch(1, "safe"),
      secretToken: "top-level-secret",
    } as RealtimeSequencedEvent<Feature>);

    expect(applied[0]).not.toHaveProperty("secretToken");
    expect(applied[0]?.checkpoint).not.toHaveProperty("secretToken");
    expect(saved[0]).toMatchObject({ kind: "honua.realtime-checkpoint", version: 1 });
    expect(saved[0]).not.toHaveProperty("secretToken");
    expect(saved[0]?.resume).not.toHaveProperty("secretToken");
  });

  it("captures event identity and resume metadata before queueing", async () => {
    let release = () => {};
    const deferred = new Promise<void>((resolve) => {
      release = resolve;
    });
    const seen: RealtimeSequencedEvent<Feature>[] = [];
    const gate = await createResumableRealtimeSubscription<Feature>({
      context,
      initialCheckpoint: durableCheckpoint(),
      apply: async (event) => {
        seen.push(event);
        if (event.sequence === 11) await deferred;
      },
    });
    const active = gate.enqueue({ type: "upsert", sequence: 11, feature: patch(1, "blocking") });
    const mutable = {
      type: "upsert" as const,
      eventId: "immutable-id",
      sequence: 12,
      cursor: "cursor-12",
      checkpoint: { sequence: 12, cursor: "cursor-12" },
      feature: patch(1, "queued"),
    };
    const queued = gate.enqueue(mutable);
    mutable.eventId = "mutated-id";
    mutable.cursor = "mutated-cursor";
    mutable.checkpoint.cursor = "mutated-checkpoint";
    release();

    await expect(active).resolves.toMatchObject({ status: "applied" });
    await expect(queued).resolves.toMatchObject({
      status: "applied",
      checkpoint: { resume: { cursor: "cursor-12" }, recentEventIds: ["event-10", "immutable-id"] },
    });
    expect(seen[1]).toMatchObject({ eventId: "immutable-id", cursor: "cursor-12" });
    await expect(
      gate.enqueue({ type: "upsert", eventId: "immutable-id", sequence: 13, feature: patch(1, "reused") }),
    ).resolves.toMatchObject({ status: "resnapshot-required", reason: "event-id-reused" });
  });

  it("bounds persisted event-id histories before scanning and copies only the configured tail", async () => {
    const oversized = new Array<string>(4097);
    Object.defineProperty(oversized, 0, {
      get() {
        throw new Error("must not scan oversized history");
      },
    });
    expect(evaluateRealtimeCheckpoint(context, durableCheckpoint({ recentEventIds: oversized }))).toMatchObject({
      compatible: false,
      code: "invalid-checkpoint",
    });

    const gate = await createResumableRealtimeSubscription({
      context,
      initialCheckpoint: durableCheckpoint({ recentEventIds: ["a", "b", "c"] }),
      maxRecentEventIds: 2,
      apply: vi.fn(),
    });
    expect(gate.state.checkpoint?.recentEventIds).toEqual(["b", "c"]);
    await expect(
      createResumableRealtimeSubscription({ context, maxRecentEventIds: 4097, apply: vi.fn() }),
    ).rejects.toThrow("4096-entry safety ceiling");
  });

  it("reports same-sequence cursor and delta-token conflicts before classifying duplicates", async () => {
    for (const incoming of [
      { type: "upsert", sequence: 10, cursor: "different-cursor", feature: patch(1, "unsafe") },
      {
        type: "upsert",
        sequence: 10,
        deltaToken: "different-token",
        feature: patch(1, "unsafe"),
      },
    ] as const) {
      const apply = vi.fn();
      const gate = await createResumableRealtimeSubscription<Feature>({
        context,
        initialCheckpoint: {
          ...durableCheckpoint(),
          resume: { sequence: 10, cursor: "cursor-10", deltaToken: "token-10" },
        },
        apply,
      });
      await expect(gate.enqueue(incoming)).resolves.toMatchObject({
        status: "resnapshot-required",
        reason: "checkpoint-conflict",
      });
      expect(gate.state.duplicateEventCount).toBe(0);
      expect(apply).not.toHaveBeenCalled();
    }
  });

  it("does not install an abort listener when initialization starts pre-aborted", async () => {
    const controller = new AbortController();
    controller.abort("already cancelled");
    const add = vi.spyOn(controller.signal, "addEventListener");
    const gate = await createResumableRealtimeSubscription({ context, signal: controller.signal, apply: vi.fn() });
    expect(add).not.toHaveBeenCalled();
    expect(gate.state).toMatchObject({ phase: "closed", reason: "cancelled" });
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
