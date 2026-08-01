import { describe, expect, it } from "vitest";
import { isHonuaError, serializeHonuaError } from "../src/index.js";
import {
  type EnqueueOfflineEditInput,
  type HonuaOfflineEditQueueError,
  createMemoryOfflineEditQueue,
} from "../src/offline/index.js";

const AUTHORIZATION_SCOPE = `sha256:${"a".repeat(64)}` as const;
const PARTITION = { authorizationScopeDigest: AUTHORIZATION_SCOPE, sourceId: "incidents" } as const;

function input(idempotencyKey: string, overrides: Partial<EnqueueOfflineEditInput> = {}): EnqueueOfflineEditInput {
  return {
    authorizationScopeDigest: AUTHORIZATION_SCOPE,
    sourceId: "incidents",
    idempotencyKey,
    edit: { operation: "add", attributes: { status: "open", priority: 2 } },
    ...overrides,
  };
}

async function expectQueueError(
  promise: Promise<unknown>,
  code: HonuaOfflineEditQueueError["code"],
  path?: string,
): Promise<HonuaOfflineEditQueueError> {
  let caught: unknown;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  expect(isHonuaError(caught)).toBe(true);
  expect(caught).toMatchObject({
    name: "HonuaOfflineEditQueueError",
    code,
    ...(path === undefined ? {} : { path }),
  });
  return caught as HonuaOfflineEditQueueError;
}

describe("offline edit queue", () => {
  it("deduplicates the same scoped request and rejects divergent idempotency-key reuse", async () => {
    const queue = createMemoryOfflineEditQueue();
    const first = await queue.enqueue(input("create-17"));
    const duplicate = await queue.enqueue(input("create-17"));

    expect(first.status).toBe("enqueued");
    expect(duplicate).toEqual({ status: "duplicate", edit: first.edit });
    expect(await queue.list(PARTITION)).toHaveLength(1);

    const error = await expectQueueError(
      queue.enqueue(
        input("create-17", {
          edit: { operation: "add", attributes: { status: "closed", priority: 2 } },
        }),
      ),
      "idempotency-conflict",
    );
    expect(serializeHonuaError(error)).toMatchObject({
      name: "HonuaOfflineEditQueueError",
      domain: "offline",
      code: "offline.replica-sync.validation",
      retryable: false,
      context: { reasonCode: "idempotency-conflict" },
    });
  });

  it("claims dependency-ready edits in deterministic order and excludes active leases", async () => {
    let lease = 0;
    const queue = createMemoryOfflineEditQueue({
      now: () => new Date("2026-08-01T10:00:00.000Z"),
      createLeaseToken: () => `lease-${++lease}`,
    });
    const first = await queue.enqueue(input("first"));
    const dependent = await queue.enqueue(
      input("dependent", {
        edit: { operation: "update", featureId: "feature-1", attributes: { status: "assigned" } },
        dependencyIds: [first.edit.id],
      }),
    );

    const claimed = await queue.claimReady({
      ...PARTITION,
      workerId: "worker-a",
      limit: 10,
      leaseDurationMs: 30_000,
    });
    expect(claimed.map((edit) => edit.id)).toEqual([first.edit.id]);
    expect(claimed[0]).toMatchObject({ state: "leased", attemptCount: 1, lease: { token: "lease-1" } });
    await expect(
      queue.claimReady({ ...PARTITION, workerId: "worker-b", limit: 10, leaseDurationMs: 30_000 }),
    ).resolves.toEqual([]);

    const applied = await queue.markApplied(first.edit.id, "lease-1", {
      serverOperationId: "operation-17",
      serverGeneration: "42",
    });
    expect(applied).toMatchObject({
      state: "applied",
      applied: { serverOperationId: "operation-17", serverGeneration: "42" },
    });
    expect((await queue.get(first.edit.id, PARTITION))?.applied).toMatchObject({
      serverOperationId: "operation-17",
      serverGeneration: "42",
    });
    const next = await queue.claimReady({
      ...PARTITION,
      workerId: "worker-b",
      limit: 10,
      leaseDurationMs: 30_000,
    });
    expect(next.map((edit) => edit.id)).toEqual([dependent.edit.id]);
    expect(next[0]?.audit.map((event) => event.kind)).toEqual(["enqueued", "claimed"]);
  });

  it("reclaims expired leases and honors durable retry schedules", async () => {
    let current = Date.parse("2026-08-01T10:00:00.000Z");
    let lease = 0;
    const queue = createMemoryOfflineEditQueue({
      now: () => new Date(current),
      createLeaseToken: () => `lease-${++lease}`,
    });
    const enqueued = await queue.enqueue(input("retry"));
    await queue.claimReady({ ...PARTITION, workerId: "worker-a", limit: 1, leaseDurationMs: 1_000 });

    current += 1_001;
    const reclaimed = await queue.claimReady({
      ...PARTITION,
      workerId: "worker-b",
      limit: 1,
      leaseDurationMs: 1_000,
    });
    expect(reclaimed[0]).toMatchObject({ attemptCount: 2, lease: { token: "lease-2", workerId: "worker-b" } });
    expect(reclaimed[0]?.audit.at(-1)?.kind).toBe("lease-reclaimed");

    const retryable = await queue.markRetry(enqueued.edit.id, "lease-2", {
      retryAt: "2026-08-01T10:00:05.000Z",
      reasonCode: "transport-timeout",
    });
    expect(retryable).toMatchObject({
      state: "retryable",
      retry: { retryAt: "2026-08-01T10:00:05.000Z", reasonCode: "transport-timeout" },
    });
    expect(retryable.audit.at(-1)).toEqual({
      sequence: 4,
      kind: "retry-scheduled",
      at: "2026-08-01T10:00:01.001Z",
      attempt: 2,
      reasonCode: "transport-timeout",
    });
    await expect(
      queue.claimReady({ ...PARTITION, workerId: "worker-c", limit: 1, leaseDurationMs: 1_000 }),
    ).resolves.toEqual([]);
    current = Date.parse("2026-08-01T10:00:05.000Z");
    const retried = await queue.claimReady({
      ...PARTITION,
      workerId: "worker-c",
      limit: 1,
      leaseDurationMs: 1_000,
    });
    expect(retried[0]).toMatchObject({ attemptCount: 3, lease: { token: "lease-3" }, retry: undefined });
  });

  it("requires a live matching lease for terminal and retry transitions", async () => {
    let current = Date.parse("2026-08-01T10:00:00.000Z");
    const queue = createMemoryOfflineEditQueue({
      now: () => new Date(current),
      createLeaseToken: () => "lease-token",
    });
    const enqueued = await queue.enqueue(input("conflict"));
    await expectQueueError(queue.markApplied(enqueued.edit.id, "lease-token"), "invalid-transition");
    await queue.claimReady({ ...PARTITION, workerId: "worker", limit: 1, leaseDurationMs: 1_000 });
    await expectQueueError(queue.markApplied(enqueued.edit.id, "wrong-token"), "lease-mismatch");
    current += 1_001;
    await expectQueueError(queue.markApplied(enqueued.edit.id, "lease-token"), "lease-expired");
    const [reclaimed] = await queue.claimReady({
      ...PARTITION,
      workerId: "worker",
      limit: 1,
      leaseDurationMs: 1_000,
    });
    const conflicted = await queue.markConflicted(enqueued.edit.id, reclaimed.lease?.token ?? "", {
      conflictId: "conflict-17",
      serverGeneration: "43",
    });
    expect(conflicted).toMatchObject({
      state: "conflicted",
      lease: undefined,
      conflict: { conflictId: "conflict-17", serverGeneration: "43" },
    });
  });

  it("captures plain JSON without retaining mutable caller data", async () => {
    const queue = createMemoryOfflineEditQueue();
    const attributes = { nested: { owner: "field-a" }, tags: ["urgent"] };
    const enqueued = await queue.enqueue(input("immutable", { edit: { operation: "add", attributes } }));
    attributes.nested.owner = "field-b";
    attributes.tags.push("changed");

    expect(enqueued.edit.edit.attributes).toEqual({ nested: { owner: "field-a" }, tags: ["urgent"] });
    expect(Object.isFrozen(enqueued.edit)).toBe(true);
    expect(Object.isFrozen(enqueued.edit.edit.attributes)).toBe(true);
    expect((await queue.get(enqueued.edit.id, PARTITION))?.edit.attributes).toEqual({
      nested: { owner: "field-a" },
      tags: ["urgent"],
    });
  });

  it("isolates listing, claiming, and dependencies by authorization scope and source", async () => {
    const otherPartition = {
      authorizationScopeDigest: `sha256:${"b".repeat(64)}` as const,
      sourceId: "incidents",
    };
    let lease = 0;
    const queue = createMemoryOfflineEditQueue({ createLeaseToken: () => `lease-${++lease}` });
    const first = await queue.enqueue(input("partition-a"));
    const other = await queue.enqueue(
      input("partition-b", {
        authorizationScopeDigest: otherPartition.authorizationScopeDigest,
      }),
    );

    expect((await queue.list(PARTITION)).map((edit) => edit.id)).toEqual([first.edit.id]);
    expect((await queue.list(otherPartition)).map((edit) => edit.id)).toEqual([other.edit.id]);
    expect(await queue.get(other.edit.id, PARTITION)).toBeUndefined();
    const claimed = await queue.claimReady({
      ...PARTITION,
      workerId: "partition-a-worker",
      limit: 10,
      leaseDurationMs: 1_000,
    });
    expect(claimed.map((edit) => edit.id)).toEqual([first.edit.id]);
    expect((await queue.get(other.edit.id, otherPartition))?.state).toBe("pending");

    await expectQueueError(
      queue.enqueue(
        input("cross-partition-dependency", {
          dependencyIds: [other.edit.id],
        }),
      ),
      "invalid-edit",
      "dependencyIds[0]",
    );
  });

  it("prunes bounded terminal history without removing prerequisites of active work", async () => {
    let current = Date.parse("2026-08-01T10:00:00.000Z");
    let lease = 0;
    const queue = createMemoryOfflineEditQueue({
      maxEdits: 2,
      now: () => new Date(current),
      createLeaseToken: () => `lease-${++lease}`,
    });
    const first = await queue.enqueue(input("prune-first"));
    const dependent = await queue.enqueue(
      input("prune-dependent", {
        edit: { operation: "update", featureId: "feature-1", attributes: { status: "closed" } },
        dependencyIds: [first.edit.id],
      }),
    );
    const [firstLease] = await queue.claimReady({
      ...PARTITION,
      workerId: "worker",
      limit: 1,
      leaseDurationMs: 10_000,
    });
    current += 1_000;
    await queue.markApplied(first.edit.id, firstLease.lease?.token ?? "");
    await expect(
      queue.pruneTerminal({
        ...PARTITION,
        terminalBefore: new Date(current).toISOString(),
        limit: 1,
      }),
    ).resolves.toEqual([]);

    const [dependentLease] = await queue.claimReady({
      ...PARTITION,
      workerId: "worker",
      limit: 1,
      leaseDurationMs: 10_000,
    });
    current += 1_000;
    await queue.markApplied(dependent.edit.id, dependentLease.lease?.token ?? "");
    const removed = await queue.pruneTerminal({
      ...PARTITION,
      terminalBefore: new Date(current).toISOString(),
      limit: 1,
    });
    expect(removed).toEqual([first.edit.id]);
    expect(await queue.get(first.edit.id, PARTITION)).toBeUndefined();
    await expect(queue.enqueue(input("after-prune"))).resolves.toMatchObject({ status: "enqueued" });
  });

  it("rejects accessors, unknown secret-bearing fields, sparse arrays, and oversized payloads", async () => {
    const queue = createMemoryOfflineEditQueue({ maxPayloadBytes: 64 });
    let reads = 0;
    const accessorInput = {
      authorizationScopeDigest: AUTHORIZATION_SCOPE,
      get sourceId() {
        reads += 1;
        return "incidents";
      },
      idempotencyKey: "accessor",
      edit: { operation: "add", attributes: { status: "open" } },
    } as EnqueueOfflineEditInput;
    await expectQueueError(queue.enqueue(accessorInput), "invalid-edit", "input.sourceId");
    expect(reads).toBe(0);

    await expectQueueError(
      queue.enqueue({ ...input("secret"), authorization: "Bearer secret" } as EnqueueOfflineEditInput),
      "invalid-edit",
      "input.authorization",
    );
    await expectQueueError(queue.enqueue(input("x".repeat(1_025))), "invalid-edit", "idempotencyKey");
    const sparse = new Array<`sha256:${string}`>(1);
    await expectQueueError(
      queue.enqueue(input("sparse", { dependencyIds: sparse })),
      "invalid-edit",
      "dependencyIds[0]",
    );
    await expectQueueError(
      queue.enqueue(input("large", { edit: { operation: "add", attributes: { description: "x".repeat(100) } } })),
      "invalid-edit",
      "edit.attributes.description",
    );
  });

  it("enforces queue, dependency, claim, lease, and audit bounds", async () => {
    const queue = createMemoryOfflineEditQueue({
      maxEdits: 1,
      maxDependencies: 1,
      maxAuditEvents: 2,
      createLeaseToken: () => "lease",
      now: () => new Date("2026-08-01T10:00:00.000Z"),
    });
    const first = await queue.enqueue(input("bounded"));
    await expectQueueError(queue.enqueue(input("overflow")), "queue-limit-exceeded");
    await expectQueueError(
      queue.enqueue(
        input("dependencies", {
          dependencyIds: [`sha256:${"b".repeat(64)}`, `sha256:${"c".repeat(64)}`],
        }),
      ),
      "invalid-edit",
      "dependencyIds",
    );
    await expectQueueError(
      queue.claimReady({ ...PARTITION, workerId: "worker", limit: 101, leaseDurationMs: 1_000 }),
      "invalid-edit",
      "limit",
    );
    await expectQueueError(
      queue.claimReady({
        ...PARTITION,
        workerId: "worker",
        limit: 1,
        leaseDurationMs: 24 * 60 * 60 * 1000 + 1,
      }),
      "invalid-edit",
      "leaseDurationMs",
    );
    await queue.claimReady({ ...PARTITION, workerId: "worker", limit: 1, leaseDurationMs: 1_000 });
    await expectQueueError(queue.markApplied(first.edit.id, "lease"), "audit-limit-exceeded");
  });
});
