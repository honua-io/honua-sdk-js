// Deterministic chaos/backpressure/reconnect/leak evidence matrix for
// `@honua/sdk-js/realtime` (issue #560), exercising the full #556 delivery
// gate + #557 resumable transport stack against every named failure mode
// from the issue's user workflow: disconnects, duplicates, reorder, gaps,
// cursor expiry, slow consumers, schema reset, and mutation conflict. Every
// scenario is fault-injected against a fake transport under fake timers --
// no real network, no sleeps.
//
// This file deliberately does not assert an exact reconnect count for a
// *synchronous burst* of more than one resnapshot-triggering delivery in the
// same tick: `resumable-transport.ts` can schedule more than one reconnect
// timer in that case (see issue #666, "dedupe reconnect timers on burst
// resnapshot-required"). Every scenario below that forces a resnapshot does
// so with exactly one overflow/conflict/gap event in flight at a time, which
// keeps reconnect counts exact and avoids depending on that known gap.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  HonuaRealtimeResumeError,
  createRealtimeFeatureStore,
  createResumableRealtimeTransport,
} from "../src/realtime/index.js";
import type {
  RealtimeCheckpointStore,
  RealtimeDurableCheckpointV1,
  RealtimeFeatureObserver,
  RealtimeFeatureTransport,
  RealtimeResumableTransportTelemetry,
  RealtimeResumeContextV1,
  RealtimeSubscriptionHandle,
  RealtimeSubscriptionRequest,
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

interface RecordedAttempt {
  readonly request: RealtimeSubscriptionRequest;
  readonly observer: RealtimeFeatureObserver<Feature>;
  closed: boolean;
}

function createFakeTransport(): {
  transport: RealtimeFeatureTransport<Feature>;
  attempts: RecordedAttempt[];
} {
  const attempts: RecordedAttempt[] = [];
  const transport: RealtimeFeatureTransport<Feature> = {
    capabilities: { kind: "custom" },
    subscribe(request, observer): RealtimeSubscriptionHandle {
      const attempt: RecordedAttempt = { request, observer, closed: false };
      attempts.push(attempt);
      return {
        close: () => {
          attempt.closed = true;
        },
      };
    },
  };
  return { transport, attempts };
}

function snapshotEvent(sequence: number, cursor: string, status = "open") {
  return {
    type: "snapshot" as const,
    sequence,
    cursor,
    features: [{ id: 1, sourceId: "incidents", feature: { id: 1, status } }],
  };
}

function deltaEvent(sequence: number, cursor: string, status = "open") {
  return {
    type: "delta" as const,
    sequence,
    cursor,
    upserts: [{ id: 1, sourceId: "incidents", feature: { id: 1, status } }],
  };
}

/** Gate construction is async, so the first `transport.subscribe()` call lands one microtask after `subscribe()` returns; every scenario flushes that before touching `attempts[0]`. */
async function flush(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

describe("realtime chaos matrix", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  describe("disconnects", () => {
    it("forces a fresh snapshot after a transport disconnect and recovers full delivery", async () => {
      const { transport, attempts } = createFakeTransport();
      const telemetry: RealtimeResumableTransportTelemetry[] = [];
      const next = vi.fn();
      const wrapped = createResumableRealtimeTransport(transport, {
        context,
        reconnect: { baseDelayMs: 20, maxDelayMs: 20 },
        onTelemetry: (event) => telemetry.push(event),
      });
      wrapped.subscribe({ sourceId: "incidents" }, { next, error: vi.fn(), complete: vi.fn() });
      await flush();

      attempts[0]?.observer.next(snapshotEvent(1, "c1"));
      await flush();
      expect(telemetry.at(-1)?.authority).toMatchObject({ state: "live", authoritative: true });

      // Fault injection: the connection drops mid-stream.
      attempts[0]?.observer.error(new HonuaRealtimeResumeError("transport-gap", "socket reset"));
      expect(attempts[0]?.closed).toBe(true);
      await vi.advanceTimersByTimeAsync(20);

      expect(attempts).toHaveLength(2);
      expect(attempts[1]?.request.resumeFrom).toBeUndefined(); // never resumes from a stale position

      // A genuine replacement snapshot from the reconnected server carries a
      // fresh baseline sequence, not a reuse of the pre-disconnect one.
      attempts[1]?.observer.next(snapshotEvent(2, "c1-after-reconnect"));
      await flush();
      expect(next).toHaveBeenCalledWith(expect.objectContaining({ cursor: "c1-after-reconnect" }));
      expect(telemetry.at(-1)?.authority).toMatchObject({ state: "live", authoritative: true });
    });
  });

  describe("duplicates", () => {
    it("applies a redelivered event exactly once and never reconnects for it", async () => {
      const { transport, attempts } = createFakeTransport();
      const telemetry: RealtimeResumableTransportTelemetry[] = [];
      const applied: string[] = [];
      const wrapped = createResumableRealtimeTransport(transport, {
        context,
        onTelemetry: (event) => telemetry.push(event),
      });
      wrapped.subscribe(
        { sourceId: "incidents" },
        {
          next: (event) => {
            if ("cursor" in event && event.cursor) applied.push(event.cursor);
          },
          error: vi.fn(),
          complete: vi.fn(),
        },
      );
      await flush();

      attempts[0]?.observer.next(snapshotEvent(5, "c5"));
      await flush();
      // Fault injection: an at-least-once transport retry redelivers the same event verbatim.
      attempts[0]?.observer.next(snapshotEvent(5, "c5"));
      await flush();
      attempts[0]?.observer.next(deltaEvent(6, "c6"));
      await flush();

      expect(applied).toEqual(["c5", "c6"]); // the duplicate was never re-applied or forwarded
      expect(telemetry.at(-1)?.duplicateEventCount).toBe(1);
      expect(attempts).toHaveLength(1); // a duplicate never triggers a reconnect
    });
  });

  describe("reorder", () => {
    it("ignores a late-arriving, already-superseded event without regressing reconciled state", async () => {
      const { transport, attempts } = createFakeTransport();
      const store = createRealtimeFeatureStore<Feature>();
      const telemetry: RealtimeResumableTransportTelemetry[] = [];
      const wrapped = createResumableRealtimeTransport(transport, {
        context,
        onTelemetry: (event) => telemetry.push(event),
      });
      store.connect(wrapped, { sourceId: "incidents" });
      await flush();

      attempts[0]?.observer.next(snapshotEvent(1, "c1", "open"));
      await flush();
      attempts[0]?.observer.next(deltaEvent(2, "c2", "assigned"));
      await flush();
      expect(store.state.records["incidents:1"]?.feature.status).toBe("assigned");

      // Fault injection: a reordered/late-arriving redelivery of the OLDER
      // event races the newer one (e.g. an SSE retry crossing a live delta).
      attempts[0]?.observer.next(snapshotEvent(1, "c1", "open"));
      await flush();

      expect(store.state.records["incidents:1"]?.feature.status).toBe("assigned"); // never regressed
      expect(telemetry.at(-1)?.duplicateEventCount).toBe(1);
      expect(attempts).toHaveLength(1); // no reconnect for a stale replay
    });
  });

  describe("sequence gaps", () => {
    it("detects a sequence gap, counts it, and requires a fresh snapshot before resuming", async () => {
      const { transport, attempts } = createFakeTransport();
      const telemetry: RealtimeResumableTransportTelemetry[] = [];
      const wrapped = createResumableRealtimeTransport(transport, {
        context,
        reconnect: { baseDelayMs: 15, maxDelayMs: 15 },
        onTelemetry: (event) => telemetry.push(event),
      });
      wrapped.subscribe({ sourceId: "incidents" }, { next: vi.fn(), error: vi.fn(), complete: vi.fn() });
      await flush();

      attempts[0]?.observer.next(snapshotEvent(1, "c1"));
      await flush();
      // Fault injection: sequence jumps from 1 straight to 9 -- a dropped batch of deltas.
      attempts[0]?.observer.next(deltaEvent(9, "c9"));
      await flush();

      expect(telemetry.at(-1)?.gapCount).toBe(1);
      await vi.advanceTimersByTimeAsync(15);

      expect(attempts).toHaveLength(2);
      expect(attempts[1]?.request.resumeFrom).toBeUndefined();
    });
  });

  describe("cursor expiry", () => {
    it("treats an expired resume cursor as a retryable failure and never resumes from it", async () => {
      const { transport, attempts } = createFakeTransport();
      const telemetry: RealtimeResumableTransportTelemetry[] = [];
      const wrapped = createResumableRealtimeTransport(transport, {
        context,
        reconnect: { baseDelayMs: 10, maxDelayMs: 10 },
        onTelemetry: (event) => telemetry.push(event),
      });
      wrapped.subscribe({ sourceId: "incidents" }, { next: vi.fn(), error: vi.fn(), complete: vi.fn() });
      await flush();

      attempts[0]?.observer.next(snapshotEvent(1, "c1"));
      await flush();
      expect(telemetry.at(-1)?.authority).toMatchObject({ state: "live", authoritative: true });

      // Fault injection: the server reports the resume cursor has expired (TTL eviction).
      attempts[0]?.observer.error(new HonuaRealtimeResumeError("cursor-expired", "resume cursor evicted by TTL"));
      expect(telemetry.at(-1)?.authority).toMatchObject({ state: "replaying", authoritative: false });

      await vi.advanceTimersByTimeAsync(10);
      expect(attempts).toHaveLength(2);
      expect(attempts[1]?.request.resumeFrom).toBeUndefined();
    });
  });

  describe("schema reset", () => {
    it("refuses to resume from a checkpoint saved under a superseded schema, forcing a fresh snapshot from the first connection", async () => {
      const { transport, attempts } = createFakeTransport();
      const telemetry: RealtimeResumableTransportTelemetry[] = [];
      // A checkpoint persisted before a server-side schema migration: saved
      // under the OLD context, loaded against the NEW (current) one.
      const staleCheckpoint: RealtimeDurableCheckpointV1 = {
        kind: "honua.realtime-checkpoint",
        version: 1,
        context,
        resume: { cursor: "c9", sequence: 9 },
        recentEventIds: [],
        savedAt: "2026-07-10T00:00:00.000Z",
      };
      const checkpointStore: RealtimeCheckpointStore = {
        load: () => Promise.resolve(staleCheckpoint),
        save: () => Promise.resolve(),
      };
      const migratedContext: RealtimeResumeContextV1 = { ...context, schemaVersion: "incident-schema-v4" };
      const wrapped = createResumableRealtimeTransport(transport, {
        context: migratedContext,
        checkpointStore,
        onTelemetry: (event) => telemetry.push(event),
      });
      wrapped.subscribe({ sourceId: "incidents" }, { next: vi.fn(), error: vi.fn(), complete: vi.fn() });
      await flush();

      expect(attempts).toHaveLength(1);
      expect(attempts[0]?.request.resumeFrom).toBeUndefined(); // the schema no longer matches; never resumed
      expect(telemetry.at(-1)?.authority).toMatchObject({ state: "replaying", authoritative: false });

      // Only a fresh, replacing snapshot under the new schema recovers delivery.
      attempts[0]?.observer.next(snapshotEvent(1, "c-fresh"));
      await flush();
      expect(telemetry.at(-1)?.authority).toMatchObject({ state: "live", authoritative: true });
    });
  });

  describe("mutation conflict", () => {
    it("treats two writers disagreeing at the same sequence as a checkpoint conflict requiring a fresh snapshot", async () => {
      const { transport, attempts } = createFakeTransport();
      const wrapped = createResumableRealtimeTransport(transport, {
        context,
        reconnect: { baseDelayMs: 10, maxDelayMs: 10 },
      });
      wrapped.subscribe({ sourceId: "incidents" }, { next: vi.fn(), error: vi.fn(), complete: vi.fn() });
      await flush();

      attempts[0]?.observer.next(snapshotEvent(1, "c1"));
      await flush();
      attempts[0]?.observer.next(deltaEvent(2, "c2"));
      await flush();
      // Fault injection: sequence 2 replays with a different cursor -- two
      // writers (or a misbehaving load balancer) disagree about what
      // happened at that position.
      attempts[0]?.observer.next(deltaEvent(2, "c2-diverged"));
      await flush();

      await vi.advanceTimersByTimeAsync(10);
      expect(attempts).toHaveLength(2);
      expect(attempts[1]?.request.resumeFrom).toBeUndefined();
    });
  });

  describe("slow consumers and backpressure", () => {
    it("never silently drops backlog past the bound and recovers to a consistent state after overflow", async () => {
      const { transport, attempts } = createFakeTransport();
      const store = createRealtimeFeatureStore<Feature>();
      const wrapped = createResumableRealtimeTransport(transport, {
        context,
        maxPendingEvents: 1,
        reconnect: { baseDelayMs: 5, maxDelayMs: 5 },
      });
      store.connect(wrapped, { sourceId: "incidents" });
      await flush();

      // Two events land in the same synchronous tick, ahead of the gate's
      // async single-flight pump: the first becomes the in-flight delivery,
      // the second exceeds the one-event bound -- a slow consumer that
      // cannot keep up with the arrival rate.
      attempts[0]?.observer.next(snapshotEvent(1, "c1", "open"));
      attempts[0]?.observer.next(deltaEvent(2, "c2", "triaged"));
      await flush();

      // Overflow forces a fresh reconnect rather than dropping the backlog silently.
      await vi.advanceTimersByTimeAsync(5);
      expect(attempts).toHaveLength(2);
      expect(attempts[1]?.request.resumeFrom).toBeUndefined();

      // The replacement snapshot is the only trusted path back to live
      // state. It must carry a fresh baseline sequence: both the gate's
      // same-sequence checkpoint-conflict guard and the store reducer's
      // independent dedup tracking would otherwise reject a resnapshot that
      // reuses the exact sequence of the event applied (and delivered to
      // the store) just before the overflow-triggered cancellation.
      attempts[1]?.observer.next(snapshotEvent(100, "c1-recovered", "resolved"));
      await flush();

      expect(store.state.records["incidents:1"]?.feature.status).toBe("resolved");
      expect(store.state.status).toBe("live");
    });
  });

  describe("reconnect storms", () => {
    it("resets the reconnect budget on every successful delivery, surviving an indefinite storm of short-lived connections", async () => {
      const { transport, attempts } = createFakeTransport();
      const error = vi.fn();
      const wrapped = createResumableRealtimeTransport(transport, {
        context,
        reconnect: { maxAttempts: 2, baseDelayMs: 5, maxDelayMs: 5 },
      });
      wrapped.subscribe({ sourceId: "incidents" }, { next: vi.fn(), error, complete: vi.fn() });
      await flush();

      for (let round = 0; round < 10; round += 1) {
        // Each recovering snapshot carries an advancing sequence, matching a
        // real server's monotonic counter -- reusing the same sequence
        // across rounds would itself look like a same-sequence checkpoint
        // conflict and never register as a successful, budget-resetting
        // delivery.
        attempts.at(-1)?.observer.next(snapshotEvent(round + 1, `storm-${round}`));
        await flush();
        attempts.at(-1)?.observer.error(new HonuaRealtimeResumeError("transport-gap", "storm disconnect"));
        await vi.advanceTimersByTimeAsync(5);
      }

      expect(error).not.toHaveBeenCalled();
      expect(attempts).toHaveLength(11); // initial + 10 recoveries; the budget never exhausted
    });

    it("fails closed and stops retrying once a storm never lets delivery recover, leaking no timers afterward", async () => {
      const { transport, attempts } = createFakeTransport();
      const error = vi.fn();
      const wrapped = createResumableRealtimeTransport(transport, {
        context,
        reconnect: { maxAttempts: 3, baseDelayMs: 5, maxDelayMs: 5 },
      });
      wrapped.subscribe({ sourceId: "incidents" }, { next: vi.fn(), error, complete: vi.fn() });
      await flush();

      for (let round = 0; round < 5; round += 1) {
        attempts.at(-1)?.observer.error(new HonuaRealtimeResumeError("transport-gap", "storm disconnect, no recovery"));
        await vi.advanceTimersByTimeAsync(5);
      }

      expect(error).toHaveBeenCalledTimes(1);
      expect(error).toHaveBeenCalledWith(
        expect.objectContaining({ sdkCode: "realtime.protocol.terminal", retryable: false }),
      );
      const attemptsAtExhaustion = attempts.length;
      expect(attemptsAtExhaustion).toBe(4); // initial + 3 reconnects, then fail closed

      await vi.advanceTimersByTimeAsync(500_000);
      expect(attempts).toHaveLength(attemptsAtExhaustion); // no further reconnect after fail-closed
      expect(vi.getTimerCount()).toBe(0); // terminal state leaves nothing pending
    });
  });

  describe("leak and dispose budgets (REQ-003)", () => {
    it("cancels a pending reconnect timer immediately on dispose instead of leaking it", async () => {
      const { transport, attempts } = createFakeTransport();
      const complete = vi.fn();
      const wrapped = createResumableRealtimeTransport(transport, {
        context,
        reconnect: { baseDelayMs: 1_000, maxDelayMs: 1_000 },
      });
      const handle = wrapped.subscribe({ sourceId: "incidents" }, { next: vi.fn(), error: vi.fn(), complete });
      await flush();

      attempts[0]?.observer.error(new HonuaRealtimeResumeError("transport-gap", "disconnect"));
      expect(vi.getTimerCount()).toBeGreaterThan(0); // a reconnect is scheduled

      handle.close(); // dispose while the reconnect is still pending

      expect(vi.getTimerCount()).toBe(0);
      expect(complete).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(10_000);
      expect(attempts).toHaveLength(1); // the pending reconnect never fired
    });

    it("returns to zero pending timers and balanced signal listeners across many chaotic disconnect/reconnect/dispose cycles", async () => {
      const { transport, attempts } = createFakeTransport();
      const wrapped = createResumableRealtimeTransport(transport, {
        context,
        reconnect: { baseDelayMs: 5, maxDelayMs: 5 },
        heartbeatTimeoutMs: 200,
      });

      const CYCLES = 25;
      for (let cycle = 0; cycle < CYCLES; cycle += 1) {
        const controller = new AbortController();
        const addSpy = vi.spyOn(controller.signal, "addEventListener");
        const removeSpy = vi.spyOn(controller.signal, "removeEventListener");
        const complete = vi.fn();
        const handle = wrapped.subscribe(
          { sourceId: "incidents", signal: controller.signal },
          { next: vi.fn(), error: vi.fn(), complete },
        );
        await flush();

        const opened = attempts.length;
        attempts.at(-1)?.observer.next(snapshotEvent(1, `cycle-${cycle}`));
        await flush();
        attempts.at(-1)?.observer.error(new HonuaRealtimeResumeError("transport-gap", "cycle disconnect"));
        await vi.advanceTimersByTimeAsync(5);
        expect(attempts.length).toBe(opened + 1);

        handle.close();

        expect(attempts.at(-1)?.closed).toBe(true);
        expect(complete).toHaveBeenCalledTimes(1);
        expect(addSpy.mock.calls.length).toBeGreaterThan(0);
        expect(addSpy.mock.calls.length).toBe(removeSpy.mock.calls.length); // no leaked "abort" listener
        expect(vi.getTimerCount()).toBe(0); // no orphaned heartbeat/reconnect timer survives disposal
      }
    });

    it("returns to zero pending timers when repeated external navigation-away aborts dispose an active subscription", async () => {
      const { transport, attempts } = createFakeTransport();
      const wrapped = createResumableRealtimeTransport(transport, {
        context,
        reconnect: { baseDelayMs: 5, maxDelayMs: 5 },
        heartbeatTimeoutMs: 200,
      });

      const CYCLES = 15;
      for (let cycle = 0; cycle < CYCLES; cycle += 1) {
        const controller = new AbortController();
        const complete = vi.fn();
        const error = vi.fn();
        wrapped.subscribe({ sourceId: "incidents", signal: controller.signal }, { next: vi.fn(), error, complete });
        await flush();

        attempts.at(-1)?.observer.next(snapshotEvent(1, `nav-${cycle}`));
        await flush();

        controller.abort(`navigated away #${cycle}`); // simulates an SPA route change tearing down the map

        expect(attempts.at(-1)?.closed).toBe(true);
        expect(complete).toHaveBeenCalledTimes(1);
        expect(error).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
      }
    });

    it("store.close() stops forwarding further transport activity and is idempotent", async () => {
      const { transport, attempts } = createFakeTransport();
      const store = createRealtimeFeatureStore<Feature>();
      const wrapped = createResumableRealtimeTransport(transport, { context });
      store.connect(wrapped, { sourceId: "incidents" });
      await flush();

      attempts[0]?.observer.next(snapshotEvent(1, "c1"));
      await flush();
      expect(store.state.records["incidents:1"]).toBeDefined();

      store.close();
      store.close(); // idempotent

      expect(store.state.status).toBe("closed");
      expect(attempts[0]?.closed).toBe(true);

      // Nothing further reaches the store once closed: the underlying handle
      // was released along with its observer.
      await vi.advanceTimersByTimeAsync(60_000);
      expect(attempts).toHaveLength(1);
    });
  });
});
