import { describe, expect, it } from "vitest";
import {
  HONUA_OFFLINE_EDIT_REPLAY_VERSION,
  type OfflineEditReplayAcknowledgement,
  type OfflineEditReplayRequest,
  createMemoryOfflineEditQueue,
  replayOfflineEditPass,
} from "../src/offline/index.js";

const AUTHORIZATION_SCOPE = `sha256:${"a".repeat(64)}` as const;
const PARTITION = { authorizationScopeDigest: AUTHORIZATION_SCOPE, sourceId: "incidents" } as const;
const PASS_OPTIONS = {
  ...PARTITION,
  workerId: "replay-worker",
  limit: 100,
  leaseDurationMs: 60_000,
} as const;

function enqueueInput(idempotencyKey: string) {
  return {
    ...PARTITION,
    idempotencyKey,
    edit: { operation: "add" as const, attributes: { status: "open", secret: `payload-${idempotencyKey}` } },
  };
}

function identity(request: OfflineEditReplayRequest) {
  return {
    editId: request.editId,
    requestFingerprint: request.requestFingerprint,
    idempotencyKey: request.idempotencyKey,
  };
}

describe("offline edit replay", () => {
  it("records only strictly bound applied, retryable, and conflicted acknowledgements", async () => {
    let lease = 0;
    const queue = createMemoryOfflineEditQueue({
      now: () => new Date("2026-08-01T10:00:00.000Z"),
      createLeaseToken: () => `lease-${++lease}`,
    });
    const edits = await Promise.all([
      queue.enqueue(enqueueInput("apply")),
      queue.enqueue(enqueueInput("retry")),
      queue.enqueue(enqueueInput("conflict")),
    ]);
    const requests: OfflineEditReplayRequest[] = [];

    const receipt = await replayOfflineEditPass(
      queue,
      (request): OfflineEditReplayAcknowledgement => {
        requests.push(request);
        if (request.idempotencyKey === "apply") {
          return {
            kind: "applied",
            ...identity(request),
            serverOperationId: "operation-1",
            serverGeneration: "8",
          };
        }
        if (request.idempotencyKey === "retry") {
          return {
            kind: "retryable",
            ...identity(request),
            retryAt: "2026-08-01T10:05:00.000Z",
            reasonCode: "server-busy",
          };
        }
        return {
          kind: "conflicted",
          ...identity(request),
          conflictId: "conflict-1",
          serverGeneration: "9",
        };
      },
      PASS_OPTIONS,
    );

    expect(receipt).toMatchObject({
      version: HONUA_OFFLINE_EDIT_REPLAY_VERSION,
      claimedCount: 3,
      invokedCount: 3,
      appliedCount: 1,
      retryableCount: 1,
      conflictedCount: 1,
      unacknowledgedCount: 0,
    });
    expect(Object.isFrozen(receipt)).toBe(true);
    expect(Object.isFrozen(receipt.outcomes)).toBe(true);
    expect(JSON.stringify(receipt)).not.toContain("payload-");
    expect(JSON.stringify(receipt)).not.toContain(AUTHORIZATION_SCOPE);
    expect(requests).toHaveLength(3);
    for (const request of requests) {
      expect(Object.isFrozen(request)).toBe(true);
      expect(request).not.toHaveProperty("authorizationScopeDigest");
      expect(request).not.toHaveProperty("lease");
      expect(request).not.toHaveProperty("audit");
    }
    expect((await queue.get(edits[0].edit.id, PARTITION))?.state).toBe("applied");
    expect((await queue.get(edits[1].edit.id, PARTITION))?.state).toBe("retryable");
    expect((await queue.get(edits[2].edit.id, PARTITION))?.state).toBe("conflicted");
  });

  it("rejects identity mismatches without inventing a terminal acknowledgement", async () => {
    const queue = createMemoryOfflineEditQueue({ createLeaseToken: () => "lease" });
    const enqueued = await queue.enqueue(enqueueInput("mismatch"));
    const receipt = await replayOfflineEditPass(
      queue,
      (request) => ({
        kind: "applied",
        ...identity(request),
        editId: `sha256:${"b".repeat(64)}`,
        serverOperationId: "operation-wrong",
      }),
      { ...PASS_OPTIONS, limit: 1 },
    );

    expect(receipt.outcomes).toEqual([
      { editId: enqueued.edit.id, outcome: "unacknowledged", reasonCode: "identity-mismatch" },
    ]);
    expect((await queue.get(enqueued.edit.id, PARTITION))?.state).toBe("leased");
  });

  it("does not invoke acknowledgement accessors or accept unknown fields", async () => {
    const queue = createMemoryOfflineEditQueue({ createLeaseToken: () => "lease" });
    const enqueued = await queue.enqueue(enqueueInput("hostile"));
    let reads = 0;
    const receipt = await replayOfflineEditPass(
      queue,
      (request) => ({
        kind: "applied",
        ...identity(request),
        get serverOperationId() {
          reads += 1;
          return "operation-secret";
        },
        authorization: "Bearer secret",
      }),
      { ...PASS_OPTIONS, limit: 1 },
    );

    expect(reads).toBe(0);
    expect(receipt.outcomes[0]).toMatchObject({
      editId: enqueued.edit.id,
      outcome: "unacknowledged",
      reasonCode: "invalid-acknowledgement",
    });
    expect(JSON.stringify(receipt)).not.toContain("secret");
    expect((await queue.get(enqueued.edit.id, PARTITION))?.state).toBe("leased");
  });

  it("runs one bounded pass and rejects invalid or accessor-bearing options", async () => {
    let lease = 0;
    const queue = createMemoryOfflineEditQueue({ createLeaseToken: () => `lease-${++lease}` });
    await queue.enqueue(enqueueInput("bounded-1"));
    await queue.enqueue(enqueueInput("bounded-2"));
    const calls: string[] = [];
    const receipt = await replayOfflineEditPass(
      queue,
      (request) => {
        calls.push(request.editId);
        return { kind: "applied", ...identity(request), serverOperationId: "operation" };
      },
      { ...PASS_OPTIONS, limit: 1 },
    );
    expect(receipt).toMatchObject({ claimedCount: 1, invokedCount: 1 });
    expect(calls).toHaveLength(1);

    await expect(replayOfflineEditPass(queue, () => undefined, { ...PASS_OPTIONS, limit: 101 })).rejects.toMatchObject({
      name: "HonuaOfflineEditQueueError",
      code: "invalid-edit",
      path: "options.limit",
    });
    let reads = 0;
    const accessorOptions = {
      ...PASS_OPTIONS,
      get workerId() {
        reads += 1;
        return "worker";
      },
    };
    await expect(replayOfflineEditPass(queue, () => undefined, accessorOptions)).rejects.toMatchObject({
      name: "HonuaOfflineEditQueueError",
      code: "invalid-edit",
      path: "options.workerId",
    });
    expect(reads).toBe(0);
  });

  it("preserves dependency ordering across replay passes", async () => {
    let lease = 0;
    const queue = createMemoryOfflineEditQueue({ createLeaseToken: () => `lease-${++lease}` });
    const first = await queue.enqueue(enqueueInput("dependency-first"));
    const dependent = await queue.enqueue({
      ...PARTITION,
      idempotencyKey: "dependency-second",
      edit: { operation: "update", featureId: "incident-1", attributes: { status: "assigned" } },
      dependencyIds: [first.edit.id],
    });
    const transport = (request: OfflineEditReplayRequest) => ({
      kind: "applied",
      ...identity(request),
      serverOperationId: `operation-${request.idempotencyKey}`,
    });

    const firstPass = await replayOfflineEditPass(queue, transport, PASS_OPTIONS);
    const secondPass = await replayOfflineEditPass(queue, transport, PASS_OPTIONS);
    expect(firstPass.outcomes.map((outcome) => outcome.editId)).toEqual([first.edit.id]);
    expect(secondPass.outcomes.map((outcome) => outcome.editId)).toEqual([dependent.edit.id]);
  });

  it("leaves thrown transports and rejected transitions recoverable by lease expiry", async () => {
    const queue = createMemoryOfflineEditQueue({
      now: () => new Date("2026-08-01T10:00:00.000Z"),
      createLeaseToken: () => "lease",
    });
    const thrown = await queue.enqueue(enqueueInput("transport-throws"));
    const thrownReceipt = await replayOfflineEditPass(
      queue,
      () => {
        throw new Error("Bearer secret transport URL");
      },
      { ...PASS_OPTIONS, limit: 1 },
    );
    expect(thrownReceipt.outcomes).toEqual([
      { editId: thrown.edit.id, outcome: "unacknowledged", reasonCode: "transport-threw" },
    ]);
    expect(JSON.stringify(thrownReceipt)).not.toContain("secret");
    expect((await queue.get(thrown.edit.id, PARTITION))?.state).toBe("leased");

    const secondQueue = createMemoryOfflineEditQueue({
      now: () => new Date("2026-08-01T10:00:00.000Z"),
      createLeaseToken: () => "lease",
    });
    const rejected = await secondQueue.enqueue(enqueueInput("transition-rejected"));
    const rejectedReceipt = await replayOfflineEditPass(
      secondQueue,
      (request) => ({
        kind: "retryable",
        ...identity(request),
        retryAt: "2026-08-01T09:59:00.000Z",
        reasonCode: "bad-retry-time",
      }),
      { ...PASS_OPTIONS, limit: 1 },
    );
    expect(rejectedReceipt.outcomes).toEqual([
      { editId: rejected.edit.id, outcome: "unacknowledged", reasonCode: "transition-rejected" },
    ]);
    expect((await secondQueue.get(rejected.edit.id, PARTITION))?.state).toBe("leased");
  });

  it("stops before the next transport invocation when cancelled", async () => {
    let lease = 0;
    const queue = createMemoryOfflineEditQueue({ createLeaseToken: () => `lease-${++lease}` });
    await queue.enqueue(enqueueInput("cancel-1"));
    await queue.enqueue(enqueueInput("cancel-2"));
    const controller = new AbortController();
    let calls = 0;
    const receipt = await replayOfflineEditPass(
      queue,
      (request) => {
        calls += 1;
        controller.abort();
        return { kind: "applied", ...identity(request), serverOperationId: "operation" };
      },
      { ...PASS_OPTIONS, signal: controller.signal },
    );
    expect(calls).toBe(1);
    expect(receipt).toMatchObject({
      claimedCount: 2,
      invokedCount: 1,
      appliedCount: 1,
      unacknowledgedCount: 1,
      stoppedReason: "cancelled",
    });
    expect(receipt.outcomes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ outcome: "applied" }),
        expect.objectContaining({ outcome: "unacknowledged", reasonCode: "cancelled" }),
      ]),
    );

    const preCancelled = new AbortController();
    preCancelled.abort();
    const empty = await replayOfflineEditPass(queue, () => undefined, {
      ...PASS_OPTIONS,
      signal: preCancelled.signal,
    });
    expect(empty).toMatchObject({ claimedCount: 0, invokedCount: 0, stoppedReason: "cancelled" });
  });
});
