import { describe, expect, it } from "vitest";
import { serializeHonuaError } from "../src/index.js";
import {
  type EnqueueOfflineEditInput,
  type HonuaOfflineEditQueueError,
  type OfflineEditQueueMetadata,
  type OfflineEditQueueRecoveryRowsV1,
  type OfflineEditQueueStoredRecord,
  type OfflineQueuedEdit,
  createMemoryOfflineEditQueue,
  inspectStoredOfflineEdit,
  inspectStoredOfflineEditMetadata,
  inspectStoredOfflineEditTombstone,
  planOfflineEditQueueRecovery,
} from "../src/offline/index.js";

const AUTHORIZATION_SCOPE = `sha256:${"a".repeat(64)}` as const;
const PARTITION = { authorizationScopeDigest: AUTHORIZATION_SCOPE, sourceId: "incidents" } as const;
// Distinctive enough that a non-echo assertion cannot pass by coincidence.
const SECRET_ATTRIBUTE = "VeryDistinctiveIncidentNarrativeValue";

function input(idempotencyKey: string, overrides: Partial<EnqueueOfflineEditInput> = {}): EnqueueOfflineEditInput {
  return {
    authorizationScopeDigest: AUTHORIZATION_SCOPE,
    sourceId: "incidents",
    idempotencyKey,
    edit: { operation: "add", attributes: { status: "open", narrative: SECRET_ATTRIBUTE } },
    ...overrides,
  };
}

/** Real persisted records, produced by the queue rather than hand-written. */
async function storedEdits(count = 2): Promise<readonly OfflineQueuedEdit[]> {
  const queue = createMemoryOfflineEditQueue({ createLeaseToken: () => "lease-token" });
  for (let index = 0; index < count; index += 1) await queue.enqueue(input(`incident-${index}`));
  return queue.list(PARTITION);
}

/**
 * The canonical index rows, derived by the planner itself, so "healthy" is
 * defined by exactly the projection the queue writes.
 */
function canonicalMetadata(edits: readonly OfflineQueuedEdit[]): readonly OfflineEditQueueMetadata[] {
  return planOfflineEditQueueRecovery({
    edits: edits.map((edit) => ({ key: edit.id, value: structuredClone(edit) })),
    metadata: [],
    tombstones: [],
  }).putMetadata;
}

function rows(
  edits: readonly OfflineQueuedEdit[],
  overrides: Partial<OfflineEditQueueRecoveryRowsV1> = {},
): OfflineEditQueueRecoveryRowsV1 {
  return {
    edits: edits.map((edit) => ({ key: edit.id, value: structuredClone(edit) })),
    metadata: canonicalMetadata(edits).map(
      (row) => ({ key: row.id, value: structuredClone(row) }) satisfies OfflineEditQueueStoredRecord,
    ),
    tombstones: [],
    ...overrides,
  };
}

function damaged(edit: OfflineQueuedEdit, patch: Record<string, unknown>): OfflineEditQueueStoredRecord {
  return { key: edit.id, value: { ...structuredClone(edit), ...patch } };
}

describe("offline edit queue record validation", () => {
  it("accepts a record the queue itself wrote", async () => {
    const [edit] = await storedEdits(1);
    expect(inspectStoredOfflineEdit(structuredClone(edit))).toEqual({ status: "valid", record: edit });
  });

  it("gates the persisted version before any other field", async () => {
    const [edit] = await storedEdits(1);
    expect(inspectStoredOfflineEdit({ ...structuredClone(edit), version: "0.9" })).toEqual({
      status: "invalid",
      reason: "foreign-version",
    });
    // A foreign version is refused even when everything else is destroyed too,
    // because a field this build reads may mean something else in that layout.
    expect(inspectStoredOfflineEdit({ version: "2.0" })).toEqual({ status: "invalid", reason: "foreign-version" });
  });

  it("refuses a record whose identity, state, timing, or audit does not hold together", async () => {
    const [edit] = await storedEdits(1);
    const cases: Record<string, unknown>[] = [
      { id: "not-a-digest" },
      { requestFingerprint: `sha256:${"z".repeat(64)}` },
      { authorizationScopeDigest: "sha256:short" },
      { state: "unknown-state" },
      { createdAt: "2026-08-04" },
      { updatedAt: 1_754_000_000_000 },
      { attemptCount: -1 },
      { dependencyIds: ["not-a-digest"] },
      { dependencyIds: [edit.id] },
      { edit: { operation: "teleport" } },
      { edit: { operation: "delete" } },
      { edit: { operation: "delete", featureId: "f-1", attributes: { a: 1 } } },
      { audit: [] },
      { audit: [{ sequence: 1, kind: "invented", at: edit.createdAt, attempt: 0 }] },
      { audit: [{ sequence: 0, kind: "enqueued", at: edit.createdAt, attempt: 0 }] },
      // A pending record carrying a lease would be claimable twice.
      { lease: { token: "t", workerId: "w", expiresAt: edit.createdAt } },
      { state: "retryable" },
      { state: "conflicted" },
    ];
    for (const patch of cases) {
      expect(inspectStoredOfflineEdit({ ...structuredClone(edit), ...patch })).toEqual({
        status: "invalid",
        reason: "corrupt-record",
      });
    }
    expect(inspectStoredOfflineEdit(undefined)).toEqual({ status: "invalid", reason: "corrupt-record" });
    expect(inspectStoredOfflineEdit([])).toEqual({ status: "invalid", reason: "corrupt-record" });
  });

  it("refuses a credential-shaped persisted partition identity", async () => {
    const [edit] = await storedEdits(1);
    expect(inspectStoredOfflineEdit({ ...structuredClone(edit), sourceId: "layers?token=abc" })).toEqual({
      status: "invalid",
      reason: "credential-screened",
    });
    expect(inspectStoredOfflineEdit({ ...structuredClone(edit), idempotencyKey: "signature" })).toEqual({
      status: "invalid",
      reason: "credential-screened",
    });
  });

  it("validates metadata and tombstone rows on the same terms", async () => {
    const [edit] = await storedEdits(1);
    const [metadata] = planOfflineEditQueueRecovery({
      edits: [{ key: edit.id, value: structuredClone(edit) }],
      metadata: [],
      tombstones: [],
    }).putMetadata;
    expect(inspectStoredOfflineEditMetadata(structuredClone(metadata))).toEqual({ status: "valid", record: metadata });
    expect(inspectStoredOfflineEditMetadata({ ...structuredClone(metadata), state: "nope" })).toEqual({
      status: "invalid",
      reason: "corrupt-record",
    });
    expect(inspectStoredOfflineEditMetadata({ ...structuredClone(metadata), sourceId: "s?token=x" })).toEqual({
      status: "invalid",
      reason: "credential-screened",
    });

    const tombstone = {
      id: edit.id,
      requestFingerprint: edit.requestFingerprint,
      authorizationScopeDigest: edit.authorizationScopeDigest,
      sourceId: edit.sourceId,
      prunedAt: edit.createdAt,
      terminalState: "applied" as const,
    };
    expect(inspectStoredOfflineEditTombstone(tombstone)).toEqual({ status: "valid", record: tombstone });
    expect(inspectStoredOfflineEditTombstone({ ...tombstone, terminalState: "pending" })).toEqual({
      status: "invalid",
      reason: "corrupt-record",
    });
  });
});

describe("offline edit queue recovery planning", () => {
  it("plans nothing at all for a healthy database", async () => {
    const edits = await storedEdits(3);
    const plan = planOfflineEditQueueRecovery(rows(edits));
    expect(plan.deleteEditKeys).toEqual([]);
    expect(plan.deleteMetadataKeys).toEqual([]);
    expect(plan.deleteTombstoneKeys).toEqual([]);
    expect(plan.putMetadata).toEqual([]);
    expect(plan.report).toMatchObject({
      kind: "honua.offline-edit-queue-recovery",
      version: 1,
      operation: "open",
      inspectedRecords: 6,
      discardedRecords: 0,
      repairedRecords: 0,
    });
  });

  it("discards a foreign-version record and keeps every other edit in the partition", async () => {
    const edits = await storedEdits(3);
    const [foreign, ...survivors] = edits;
    const healthy = rows(edits);
    const plan = planOfflineEditQueueRecovery({
      ...healthy,
      edits: [damaged(foreign, { version: "0.9" }), ...healthy.edits.slice(1)],
    });
    expect(plan.deleteEditKeys).toEqual([foreign.id]);
    // The index row for the discarded edit goes with it; the survivors' rows
    // are untouched, so their order, lease, and state outcomes do not move.
    expect(plan.deleteMetadataKeys).toEqual([foreign.id]);
    expect(plan.putMetadata).toEqual([]);
    expect(plan.report.discardedRecords).toBe(2);
    expect(plan.report.discardedByReason).toEqual({
      "foreign-version": 1,
      "corrupt-record": 0,
      "credential-screened": 0,
      "orphaned-metadata": 1,
    });
    for (const survivor of survivors) {
      expect(plan.deleteEditKeys).not.toContain(survivor.id);
    }
  });

  it("discards a corrupt record and a credential-shaped record with separate reasons", async () => {
    const edits = await storedEdits(3);
    const healthy = rows(edits);
    const plan = planOfflineEditQueueRecovery({
      ...healthy,
      edits: [
        damaged(edits[0], { audit: "not-an-array" }),
        damaged(edits[1], { sourceId: "incidents?token=abc" }),
        healthy.edits[2],
      ],
    });
    expect(plan.deleteEditKeys).toEqual([edits[0].id, edits[1].id]);
    expect(plan.report.discardedByReason).toMatchObject({
      "corrupt-record": 1,
      "credential-screened": 1,
      "orphaned-metadata": 2,
    });
  });

  it("refuses a record stored under a key other than its own id", async () => {
    const edits = await storedEdits(2);
    const healthy = rows(edits);
    const plan = planOfflineEditQueueRecovery({
      ...healthy,
      edits: [{ key: edits[1].id, value: structuredClone(edits[0]) }, healthy.edits[1]],
    });
    expect(plan.deleteEditKeys).toEqual([edits[1].id]);
    expect(plan.report.discardedByReason["corrupt-record"]).toBe(1);
  });

  it("reconciles the metadata relationship in both directions", async () => {
    const edits = await storedEdits(3);
    const canonical = canonicalMetadata(edits);
    const orphanId = `sha256:${"b".repeat(64)}`;
    const plan = planOfflineEditQueueRecovery({
      ...rows(edits),
      // First edit's index row is missing entirely; second's disagrees with the
      // edit; a third row points at an edit that no longer exists.
      metadata: [
        { key: canonical[1].id, value: { ...structuredClone(canonical[1]), state: "applied" } },
        { key: orphanId, value: { ...structuredClone(canonical[0]), id: orphanId } },
      ],
    });
    expect(plan.deleteMetadataKeys).toEqual([orphanId]);
    expect(plan.deleteEditKeys).toEqual([]);
    expect(plan.putMetadata.map((row) => row.id).sort()).toEqual([edits[0].id, edits[1].id, edits[2].id].sort());
    expect(plan.putMetadata.every((row) => row.state === "pending")).toBe(true);
    expect(plan.report).toMatchObject({
      discardedRecords: 1,
      repairedRecords: 3,
      discardedByReason: { "orphaned-metadata": 1 },
      repairedByReason: { "restored-metadata": 3 },
    });
  });

  it("preserves a valid tombstone and discards an unreadable one", async () => {
    const edits = await storedEdits(1);
    const healthy = rows(edits);
    const valid = {
      key: `sha256:${"c".repeat(64)}`,
      value: {
        id: `sha256:${"c".repeat(64)}`,
        requestFingerprint: `sha256:${"d".repeat(64)}`,
        authorizationScopeDigest: AUTHORIZATION_SCOPE,
        sourceId: "incidents",
        prunedAt: "2026-08-04T00:00:00.000Z",
        terminalState: "applied",
      },
    };
    const broken = { key: `sha256:${"e".repeat(64)}`, value: { id: `sha256:${"e".repeat(64)}` } };
    const plan = planOfflineEditQueueRecovery({ ...healthy, tombstones: [valid, broken] });
    expect(plan.deleteTombstoneKeys).toEqual([broken.key]);
    expect(plan.report.discardedByReason["corrupt-record"]).toBe(1);
  });

  it("fails closed with a typed error past the record ceiling", async () => {
    const edits = await storedEdits(3);
    let caught: unknown;
    try {
      planOfflineEditQueueRecovery(rows(edits), { maxRecords: 2 });
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({ name: "HonuaOfflineEditQueueError", code: "queue-limit-exceeded" });
  });

  it("fails closed with a typed error past the byte ceiling", async () => {
    const edits = await storedEdits(3);
    let caught: unknown;
    try {
      planOfflineEditQueueRecovery(rows(edits), { maxBytes: 16 });
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({ name: "HonuaOfflineEditQueueError", code: "queue-limit-exceeded" });
  });

  it("reports counts and a stable reason without echoing any edit payload", async () => {
    const edits = await storedEdits(2);
    const healthy = rows(edits);
    const plan = planOfflineEditQueueRecovery({
      ...healthy,
      edits: [damaged(edits[0], { version: "0.9" }), healthy.edits[1]],
    });
    const serialized = JSON.stringify(serializeHonuaError(plan.report.error));
    expect(plan.report.error).toMatchObject({
      name: "HonuaOfflineEditQueueError",
      code: "record-unreadable",
      sdkCode: "offline.replica-sync.validation",
    });
    expect(serialized).not.toContain(SECRET_ATTRIBUTE);
    expect(JSON.stringify(plan.report.discardedByReason)).not.toContain(SECRET_ATTRIBUTE);
    expect(Object.isFrozen(plan.report)).toBe(true);
  });

  it("keeps the report's error a routable offline envelope", async () => {
    const edits = await storedEdits(1);
    const healthy = rows(edits);
    const plan = planOfflineEditQueueRecovery({ ...healthy, metadata: [] });
    const error = plan.report.error as HonuaOfflineEditQueueError;
    expect(serializeHonuaError(error)).toMatchObject({ code: "offline.replica-sync.validation" });
    expect(error.message).toContain("repaired 1");
  });
});
