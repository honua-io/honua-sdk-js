import { describe, expect, it } from "vitest";
import {
  HONUA_OFFLINE_REPLAY_SYNC_CONFLICT_KIND,
  HONUA_OFFLINE_REPLAY_SYNC_CONFLICT_VERSION,
  HonuaOfflineEditQueueError,
  OFFLINE_REPLAY_SYNC_CONFLICT_FIELD_MAP,
  type OfflineEditConflictOutcome,
  type OfflineEditConflictResolutionOutcome,
  type OfflineEditQueue,
  type OfflineEditReplayAcknowledgement,
  type OfflineEditReplayRequest,
  type OfflineFeatureEdit,
  type OfflineQueuedEdit,
  type OfflineReplaySyncConflictProjectedV1,
  type OfflineReplaySyncConflictProjectionV1,
  createLocalFirstStatus,
  createMemoryOfflineEditQueue,
  projectOfflineReplaySyncConflict,
  replayOfflineEditPass,
} from "../src/offline/index.js";
import {
  type ConflictFeatureState,
  type SyncConflictDetail,
  createFixtureReplicaSyncTransport,
  createHonuaReplicaSync,
} from "../src/replica-sync/index.js";

const AUTHORIZATION_SCOPE = `sha256:${"a".repeat(64)}` as const;
const PARTITION = { authorizationScopeDigest: AUTHORIZATION_SCOPE, sourceId: "incidents" } as const;
const REPLICA = { replicaId: "replica-field-crew-7", datasetId: "public-safety" } as const;
const PASS_OPTIONS = {
  ...PARTITION,
  workerId: "replay-worker",
  limit: 100,
  leaseDurationMs: 60_000,
} as const;
const NOW = "2026-08-01T10:00:00.000Z";

function queue(): OfflineEditQueue {
  let lease = 0;
  return createMemoryOfflineEditQueue({
    now: () => new Date(NOW),
    createLeaseToken: () => `lease-${++lease}`,
  });
}

function identity(request: OfflineEditReplayRequest) {
  return {
    editId: request.editId,
    requestFingerprint: request.requestFingerprint,
    idempotencyKey: request.idempotencyKey,
  };
}

function fieldEdit(overrides: Partial<OfflineFeatureEdit> = {}): OfflineFeatureEdit {
  return { operation: "update", featureId: "incident-1", attributes: { status: "closed" }, ...overrides };
}

/**
 * One conflicted queued edit, produced by a real replay pass rather than a
 * hand-written record, so the projection is always tested against the shape
 * the queue actually persists.
 */
async function conflictedEdit(
  options: {
    readonly edit?: OfflineFeatureEdit;
    readonly conflictId?: string;
    readonly serverGeneration?: string;
  } = {},
): Promise<{ readonly queue: OfflineEditQueue; readonly edit: OfflineQueuedEdit }> {
  const store = queue();
  await store.enqueue({ ...PARTITION, idempotencyKey: "close-incident-1", edit: options.edit ?? fieldEdit() });
  await replayOfflineEditPass(
    store,
    (request): OfflineEditReplayAcknowledgement => ({
      kind: "conflicted",
      ...identity(request),
      conflictId: options.conflictId ?? "server-conflict-1",
      ...(options.serverGeneration === undefined ? {} : { serverGeneration: options.serverGeneration }),
    }),
    PASS_OPTIONS,
  );
  const [edit] = await store.list(PARTITION);
  if (!edit) throw new Error("The queue did not retain the conflicted edit.");
  return { queue: store, edit };
}

function projected(value: OfflineReplaySyncConflictProjectionV1): OfflineReplaySyncConflictProjectedV1 {
  if (value.outcome !== "projected") throw new Error(`Expected a projection, got a ${value.reason} refusal.`);
  return value;
}

describe("offline replay sync-conflict projection", () => {
  it("projects a conflicted replay acknowledgement onto the shipped conflict contract", async () => {
    const { edit } = await conflictedEdit({ serverGeneration: "server-gen-42" });
    const projection = projectOfflineReplaySyncConflict({ edit, replica: REPLICA });

    expect(projection).toEqual({
      kind: HONUA_OFFLINE_REPLAY_SYNC_CONFLICT_KIND,
      version: HONUA_OFFLINE_REPLAY_SYNC_CONFLICT_VERSION,
      outcome: "projected",
      editId: edit.id,
      conflict: {
        id: "server-conflict-1",
        replicaId: "replica-field-crew-7",
        datasetId: "public-safety",
        sourceId: "incidents",
        featureId: "incident-1",
        kind: "replica-sync",
        status: "pending",
        clientOperation: "update",
        detectedAt: NOW,
        clientState: { operation: "update", editedAt: NOW },
        serverGen: "server-gen-42",
      },
      unavailable: expect.any(Array),
    });
    expect(Object.isFrozen(projection)).toBe(true);
    expect(Object.isFrozen(projected(projection).conflict)).toBe(true);
  });

  it("maps every offline edit operation onto its conflict-contract spelling", async () => {
    const cases = [
      { edit: { operation: "add", featureId: "incident-1", attributes: { status: "open" } }, expected: "create" },
      { edit: fieldEdit(), expected: "update" },
      { edit: { operation: "delete", featureId: "incident-1" }, expected: "delete" },
    ] as const;

    for (const testCase of cases) {
      const { edit } = await conflictedEdit({ edit: testCase.edit });
      const conflict = projected(projectOfflineReplaySyncConflict({ edit, replica: REPLICA })).conflict;
      expect(conflict.clientOperation).toBe(testCase.expected);
      expect(conflict.clientState.operation).toBe(testCase.expected);
      expect(conflict.clientState.deleted).toBe(testCase.expected === "delete" ? true : undefined);
    }
  });

  it("carries the server generation cursor and names it unavailable when the server sent none", async () => {
    const withCursor = await conflictedEdit({ serverGeneration: "server-gen-42" });
    const withCursorProjection = projected(
      projectOfflineReplaySyncConflict({ edit: withCursor.edit, replica: REPLICA }),
    );
    expect(withCursorProjection.conflict.serverGen).toBe("server-gen-42");
    expect(withCursorProjection.unavailable.map((entry) => entry.member)).not.toContain("serverGen");

    const withoutCursor = await conflictedEdit();
    const withoutCursorProjection = projected(
      projectOfflineReplaySyncConflict({ edit: withoutCursor.edit, replica: REPLICA }),
    );
    expect(withoutCursorProjection.conflict.serverGen).toBeUndefined();
    expect(withoutCursorProjection.unavailable).toContainEqual({ member: "serverGen", reason: "not-recorded" });
  });

  it("marks every server-adjudicated contract member unavailable instead of inventing one", async () => {
    const { edit } = await conflictedEdit({ serverGeneration: "server-gen-42" });
    const projection = projected(projectOfflineReplaySyncConflict({ edit, replica: REPLICA }));

    // Every required SyncConflictDetail member is either projected or named
    // unavailable. Nothing may be silently absent.
    const requiredDetailMembers: ReadonlyArray<keyof SyncConflictDetail> = [
      "id",
      "replicaId",
      "datasetId",
      "featureId",
      "kind",
      "status",
      "clientOperation",
      "serverOperation",
      "detectedAt",
      "fieldConflictCount",
      "hasGeometryConflict",
      "base",
      "clientState",
      "serverState",
      "fieldConflicts",
      "resolutionOptions",
    ];
    const unavailableMembers = new Set<string>(projection.unavailable.map((entry) => entry.member));
    const conflict = projection.conflict as Record<string, unknown>;
    for (const member of requiredDetailMembers) {
      expect(member in conflict || unavailableMembers.has(member)).toBe(true);
    }

    expect(projection.unavailable).toEqual([
      { member: "base", reason: "server-owned" },
      { member: "serverState", reason: "server-owned" },
      { member: "serverOperation", reason: "server-owned" },
      { member: "fieldConflicts", reason: "server-owned" },
      { member: "fieldConflictCount", reason: "server-owned" },
      { member: "hasGeometryConflict", reason: "server-owned" },
      { member: "geometryConflict", reason: "server-owned" },
      { member: "resolutionOptions", reason: "server-owned" },
      { member: "resolution", reason: "server-owned" },
      { member: "layerId", reason: "not-recorded" },
      { member: "client", reason: "not-recorded" },
      { member: "device", reason: "not-recorded" },
      { member: "metadata", reason: "not-recorded" },
      { member: "clientState.attributes", reason: "payload-free" },
      { member: "clientState.geometry", reason: "payload-free" },
    ]);
    // The unavailable members are absent, not present-and-empty: an empty
    // resolutionOptions array would read as "the server offers nothing".
    for (const member of unavailableMembers) {
      if (member.startsWith("clientState.")) continue;
      expect(member in conflict).toBe(false);
    }
    expect("attributes" in projection.conflict.clientState).toBe(false);
    expect("geometry" in projection.conflict.clientState).toBe(false);
  });
});

describe("offline replay sync-conflict refusals", () => {
  it("refuses every non-conflicted acknowledgement shape instead of guessing a conflict", async () => {
    const store = queue();
    for (const key of ["applied", "retryable", "pending"]) {
      await store.enqueue({ ...PARTITION, idempotencyKey: key, edit: fieldEdit() });
    }
    await replayOfflineEditPass(
      store,
      (request): OfflineEditReplayAcknowledgement | undefined => {
        if (request.idempotencyKey === "applied") {
          return { kind: "applied", ...identity(request), serverOperationId: "operation-1" };
        }
        if (request.idempotencyKey === "retryable") {
          return {
            kind: "retryable",
            ...identity(request),
            retryAt: "2026-08-01T10:05:00.000Z",
            reasonCode: "server-busy",
          };
        }
        return undefined;
      },
      { ...PASS_OPTIONS, limit: 2 },
    );

    const edits = await store.list(PARTITION);
    expect(edits).toHaveLength(3);
    for (const edit of edits) {
      expect(edit.state).not.toBe("conflicted");
      const projection = projectOfflineReplaySyncConflict({ edit, replica: REPLICA });
      expect(projection).toEqual({
        kind: HONUA_OFFLINE_REPLAY_SYNC_CONFLICT_KIND,
        version: HONUA_OFFLINE_REPLAY_SYNC_CONFLICT_VERSION,
        outcome: "refused",
        reason: "not-conflicted",
        path: "input.edit.state",
        editId: edit.id,
      });
    }
  });

  it("refuses a conflicted record with no durable conflict outcome", async () => {
    const { edit } = await conflictedEdit();
    const { conflict: _conflict, ...withoutConflict } = edit;
    expect(projectOfflineReplaySyncConflict({ edit: withoutConflict as OfflineQueuedEdit, replica: REPLICA })).toEqual({
      kind: HONUA_OFFLINE_REPLAY_SYNC_CONFLICT_KIND,
      version: HONUA_OFFLINE_REPLAY_SYNC_CONFLICT_VERSION,
      outcome: "refused",
      reason: "missing-conflict-record",
      path: "input.edit.conflict",
      editId: edit.id,
    });
  });

  it("refuses a conflict whose edit names no feature, because the contract requires one", async () => {
    const { edit } = await conflictedEdit({ edit: { operation: "add", attributes: { status: "open" } } });
    expect(edit.edit.featureId).toBeUndefined();
    expect(projectOfflineReplaySyncConflict({ edit, replica: REPLICA })).toEqual({
      kind: HONUA_OFFLINE_REPLAY_SYNC_CONFLICT_KIND,
      version: HONUA_OFFLINE_REPLAY_SYNC_CONFLICT_VERSION,
      outcome: "refused",
      reason: "unidentified-feature",
      path: "input.edit.edit.featureId",
      editId: edit.id,
    });
  });

  it.each([
    ["a non-record edit", () => "not-an-edit", undefined, "input.edit"],
    [
      "an unreadable identity",
      (edit: OfflineQueuedEdit) => ({ ...edit, id: "not-a-digest" }),
      undefined,
      "input.edit.id",
    ],
    [
      "an undeclared top-level key",
      (edit: OfflineQueuedEdit) => ({ ...edit, replicaLease: "token" }),
      true,
      "input.edit.replicaLease",
    ],
    ["an unknown state", (edit: OfflineQueuedEdit) => ({ ...edit, state: "syncing" }), true, "input.edit.state"],
    [
      "a conflict outcome on a non-conflicted record",
      (edit: OfflineQueuedEdit) => ({ ...edit, state: "pending" }),
      true,
      "input.edit.conflict",
    ],
    [
      "an undeclared conflict key",
      (edit: OfflineQueuedEdit) => ({ ...edit, conflict: { ...edit.conflict, leaseToken: "secret" } }),
      true,
      "input.edit.conflict.leaseToken",
    ],
    [
      "a malformed detection timestamp",
      (edit: OfflineQueuedEdit) => ({ ...edit, conflict: { ...edit.conflict, detectedAt: "yesterday" } }),
      true,
      "input.edit.conflict.detectedAt",
    ],
    [
      "an undeclared feature-edit key",
      (edit: OfflineQueuedEdit) => ({ ...edit, edit: { ...edit.edit, endpoint: "https://example.test" } }),
      true,
      "input.edit.edit.endpoint",
    ],
    [
      "an unknown edit operation",
      (edit: OfflineQueuedEdit) => ({ ...edit, edit: { ...edit.edit, operation: "upsert" } }),
      true,
      "input.edit.edit.operation",
    ],
    [
      "a prototype-polluted conflict record",
      (edit: OfflineQueuedEdit) => ({ ...edit, conflict: Object.create({ conflictId: "inherited" }) }),
      true,
      "input.edit.conflict",
    ],
  ])("refuses %s as unreadable", async (_label, mutate, expectsEditId, path) => {
    const { edit } = await conflictedEdit();
    const projection = projectOfflineReplaySyncConflict({
      edit: mutate(edit) as unknown as OfflineQueuedEdit,
      replica: REPLICA,
    });
    expect(projection).toMatchObject({ outcome: "refused", reason: "unreadable-edit", path });
    if (expectsEditId === true) expect(projection).toMatchObject({ editId: edit.id });
    else expect(projection).not.toHaveProperty("editId");
  });

  it.each([
    ["a missing binding", undefined, "input.replica"],
    ["a non-record binding", "replica-1", "input.replica"],
    ["an empty replica id", { replicaId: "", datasetId: "public-safety" }, "input.replica.replicaId"],
    ["an untrimmed dataset id", { replicaId: "replica-1", datasetId: " public-safety" }, "input.replica.datasetId"],
    [
      "an undeclared binding key",
      { replicaId: "replica-1", datasetId: "public-safety", token: "secret" },
      "input.replica.token",
    ],
  ])("throws on %s, because a binding is the caller's own argument", async (_label, replica, path) => {
    const { edit } = await conflictedEdit();
    expect(() => projectOfflineReplaySyncConflict({ edit, replica } as never)).toThrowError(
      expect.objectContaining({ name: "HonuaOfflineEditQueueError", code: "invalid-edit", path }),
    );
  });

  it("rejects an undeclared projection input key", async () => {
    const { edit } = await conflictedEdit();
    expect(() =>
      projectOfflineReplaySyncConflict({ edit, replica: REPLICA, resolutionOptions: [] } as never),
    ).toThrowError(HonuaOfflineEditQueueError);
  });
});

describe("offline replay sync-conflict losslessness", () => {
  /**
   * Compile-time exhaustiveness. `OfflineQueuedEdit` gaining a member — or its
   * `edit` / `conflict` sub-records gaining one — fails this literal before any
   * assertion runs, so the ledger cannot silently fall behind the record it
   * claims to account for.
   */
  const coverage: Record<
    | Exclude<keyof OfflineQueuedEdit, "edit" | "conflict" | "conflictResolution">
    | `edit.${keyof OfflineFeatureEdit}`
    | `conflict.${keyof OfflineEditConflictOutcome}`
    | `conflictResolution.${keyof OfflineEditConflictResolutionOutcome}`,
    true
  > = {
    version: true,
    id: true,
    requestFingerprint: true,
    authorizationScopeDigest: true,
    sourceId: true,
    idempotencyKey: true,
    dependencyIds: true,
    state: true,
    createdAt: true,
    updatedAt: true,
    attemptCount: true,
    lease: true,
    retry: true,
    applied: true,
    cancellation: true,
    audit: true,
    "edit.operation": true,
    "edit.featureId": true,
    "edit.attributes": true,
    "edit.geometry": true,
    "conflict.conflictId": true,
    "conflict.detectedAt": true,
    "conflict.serverGeneration": true,
    "conflictResolution.conflictId": true,
    "conflictResolution.detectedAt": true,
    "conflictResolution.serverGeneration": true,
    "conflictResolution.choice": true,
    "conflictResolution.disposition": true,
    "conflictResolution.acknowledgement": true,
    "conflictResolution.resolvedAt": true,
    "conflictResolution.resolvedBy": true,
    "conflictResolution.note": true,
  };

  it("accounts for every field of the durable record exactly once", () => {
    const sources = OFFLINE_REPLAY_SYNC_CONFLICT_FIELD_MAP.map((entry) => entry.source);
    expect(new Set(sources).size).toBe(sources.length);
    expect([...sources].sort()).toEqual(Object.keys(coverage).sort());
  });

  function publishedMembers(projection: OfflineReplaySyncConflictProjectedV1): Record<string, unknown> {
    return {
      editId: projection.editId,
      ...Object.fromEntries(Object.entries(projection.conflict).map(([key, value]) => [`conflict.${key}`, value])),
      ...Object.fromEntries(
        Object.entries(projection.conflict.clientState).map(([key, value]) => [`conflict.clientState.${key}`, value]),
      ),
      ...Object.fromEntries(
        Object.entries(projection.localResolution ?? {}).map(([key, value]) => [`localResolution.${key}`, value]),
      ),
    };
  }

  it("lands every carried and derived field on a member the projection really publishes", async () => {
    const { queue: store, edit } = await conflictedEdit({ serverGeneration: "server-gen-42" });
    const resolvedEdit = await store.resolveConflict(edit.id, PARTITION, {
      conflictId: "server-conflict-1",
      choice: "accept-client",
      resolvedBy: "reviewer-1",
      note: "Local edit stands.",
    });
    // The union of both projected shapes: an open conflict publishes the
    // conflict members, and a closed one publishes the resolution members, so
    // neither half of the ledger can point at a member nothing ever emits.
    const published: Record<string, unknown> = {
      ...publishedMembers(projected(projectOfflineReplaySyncConflict({ edit, replica: REPLICA }))),
      ...publishedMembers(projected(projectOfflineReplaySyncConflict({ edit: resolvedEdit, replica: REPLICA }))),
    };
    // `clientState.deleted` is only published for a delete, so it is allowed to
    // be absent here; every other target must exist.
    for (const entry of OFFLINE_REPLAY_SYNC_CONFLICT_FIELD_MAP) {
      if (entry.disposition !== "carried" && entry.disposition !== "derived") {
        expect(entry.targets).toEqual([]);
        continue;
      }
      expect(entry.targets.length).toBeGreaterThan(0);
      for (const target of entry.targets) {
        if (target === "conflict.clientState.deleted") continue;
        expect(published).toHaveProperty(target);
        expect(published[target]).not.toBeUndefined();
      }
    }
  });

  it("keeps the projection payload-free under hostile edit content", async () => {
    const { edit } = await conflictedEdit({
      edit: {
        operation: "update",
        featureId: "incident-1",
        attributes: {
          status: "closed",
          notes: "authorization: Bearer super-secret-token",
          endpoint: "https://tenant.example.test/arcgis/rest/services?token=abc123",
        },
        geometry: { type: "Point", coordinates: [-157.85, 21.3] },
      },
    });
    const serialized = JSON.stringify(projectOfflineReplaySyncConflict({ edit, replica: REPLICA }));
    for (const secret of ["Bearer", "super-secret-token", "example.test", "token=abc123", "coordinates", "-157.85"]) {
      expect(serialized).not.toContain(secret);
    }
    // The authorization-scope digest partitions the queue and never travels
    // with a conflict either.
    expect(serialized).not.toContain(AUTHORIZATION_SCOPE);
    expect(serialized).not.toContain(edit.requestFingerprint);
    expect(serialized).not.toContain(edit.idempotencyKey);
  });

  it("mutates nothing it is given", async () => {
    const { edit } = await conflictedEdit({ serverGeneration: "server-gen-42" });
    const before = JSON.stringify(edit);
    const first = projectOfflineReplaySyncConflict({ edit, replica: REPLICA });
    const second = projectOfflineReplaySyncConflict({ edit, replica: REPLICA });
    expect(JSON.stringify(edit)).toBe(before);
    expect(first).toEqual(second);
  });
});

describe("offline replay pass conflict projection", () => {
  it("projects only conflicted outcomes and leaves the pass unchanged without a binding", async () => {
    const store = queue();
    for (const key of ["applied", "retryable", "conflicted", "mismatched"]) {
      await store.enqueue({ ...PARTITION, idempotencyKey: key, edit: fieldEdit() });
    }

    const receipt = await replayOfflineEditPass(
      store,
      (request): OfflineEditReplayAcknowledgement => {
        if (request.idempotencyKey === "applied") {
          return { kind: "applied", ...identity(request), serverOperationId: "operation-1" };
        }
        if (request.idempotencyKey === "retryable") {
          return {
            kind: "retryable",
            ...identity(request),
            retryAt: "2026-08-01T10:05:00.000Z",
            reasonCode: "server-busy",
          };
        }
        if (request.idempotencyKey === "conflicted") {
          return {
            kind: "conflicted",
            ...identity(request),
            conflictId: "server-conflict-1",
            serverGeneration: "server-gen-42",
          };
        }
        return {
          kind: "conflicted",
          ...identity(request),
          editId: `sha256:${"b".repeat(64)}`,
          conflictId: "server-conflict-2",
        };
      },
      { ...PASS_OPTIONS, replica: REPLICA },
    );

    expect(receipt.conflictedCount).toBe(1);
    expect(receipt.unacknowledgedCount).toBe(1);
    const conflicted = receipt.outcomes.find((outcome) => outcome.outcome === "conflicted");
    expect(projected(conflicted?.syncConflict as OfflineReplaySyncConflictProjectionV1).conflict).toMatchObject({
      id: "server-conflict-1",
      replicaId: "replica-field-crew-7",
      kind: "replica-sync",
      status: "pending",
      serverGen: "server-gen-42",
    });
    for (const outcome of receipt.outcomes) {
      if (outcome.outcome === "conflicted") continue;
      expect(outcome.syncConflict).toBeUndefined();
    }
    // An identity mismatch is unacknowledged, so no conflict was recorded and
    // none is projected.
    const mismatched = receipt.outcomes.find((outcome) => outcome.reasonCode === "identity-mismatch");
    expect(mismatched?.syncConflict).toBeUndefined();
  });

  it("omits the projection entirely when no replica binding is supplied", async () => {
    const { queue: store } = await conflictedEdit();
    const edits = await store.list(PARTITION);
    expect(edits[0]?.state).toBe("conflicted");
    const receipt = await replayOfflineEditPass(store, () => undefined, PASS_OPTIONS);
    expect(receipt.outcomes.every((outcome) => outcome.syncConflict === undefined)).toBe(true);
  });

  it("refuses a malformed replica binding on the pass itself", async () => {
    const store = queue();
    await expect(
      replayOfflineEditPass(store, () => undefined, {
        ...PASS_OPTIONS,
        replica: { replicaId: "replica-1" },
      } as never),
    ).rejects.toMatchObject({ name: "HonuaOfflineEditQueueError", path: "options.replica.datasetId" });
  });

  it("reports a projection refusal beside a durable conflict rather than a rejected transition", async () => {
    const store = queue();
    await store.enqueue({
      ...PARTITION,
      idempotencyKey: "create-incident",
      edit: { operation: "add", attributes: { status: "open" } },
    });
    const receipt = await replayOfflineEditPass(
      store,
      (request): OfflineEditReplayAcknowledgement => ({
        kind: "conflicted",
        ...identity(request),
        conflictId: "server-conflict-3",
      }),
      { ...PASS_OPTIONS, replica: REPLICA },
    );

    expect(receipt.conflictedCount).toBe(1);
    expect(receipt.outcomes[0]).toMatchObject({
      outcome: "conflicted",
      syncConflict: { outcome: "refused", reason: "unidentified-feature" },
    });
    // The durable transition still happened; only the projection refused.
    const [edit] = await store.list(PARTITION);
    expect(edit?.state).toBe("conflicted");
    expect(edit?.conflict?.conflictId).toBe("server-conflict-3");
  });
});

describe("local-first status conflict projection", () => {
  it("projects the same conflicted edits it already reports, in the same order", async () => {
    const store = queue();
    for (const key of ["b-close", "a-close"]) {
      await store.enqueue({ ...PARTITION, idempotencyKey: key, edit: fieldEdit() });
    }
    await replayOfflineEditPass(
      store,
      (request): OfflineEditReplayAcknowledgement => ({
        kind: "conflicted",
        ...identity(request),
        conflictId: `conflict-${request.idempotencyKey}`,
      }),
      PASS_OPTIONS,
    );

    const edits = await store.list(PARTITION);
    const status = createLocalFirstStatus({
      connectivity: "online",
      now: new Date(NOW),
      edits,
      editCounts: await store.countByState(PARTITION),
      replica: REPLICA,
    });

    expect(status.state).toBe("conflicted");
    expect(status.writes.conflictedCount).toBe(2);
    expect(status.writes.syncConflicts).toHaveLength(2);
    expect(status.writes.syncConflicts.map((entry) => projected(entry).editId)).toEqual(
      status.writes.conflictedEditIds,
    );
    for (const entry of status.writes.syncConflicts) {
      expect(projected(entry).conflict).toMatchObject({ replicaId: "replica-field-crew-7", kind: "replica-sync" });
    }
  });

  it("stays empty when no replica binding is supplied", async () => {
    const { queue: store } = await conflictedEdit();
    const status = createLocalFirstStatus({
      connectivity: "online",
      now: new Date(NOW),
      edits: await store.list(PARTITION),
      editCounts: await store.countByState(PARTITION),
    });
    expect(status.writes.conflictedCount).toBe(1);
    expect(status.writes.syncConflicts).toEqual([]);
  });

  it("bounds the projections with the listed conflicted ids", async () => {
    const store = queue();
    for (const key of ["one", "two", "three"]) {
      await store.enqueue({ ...PARTITION, idempotencyKey: key, edit: fieldEdit() });
    }
    await replayOfflineEditPass(
      store,
      (request): OfflineEditReplayAcknowledgement => ({
        kind: "conflicted",
        ...identity(request),
        conflictId: `conflict-${request.idempotencyKey}`,
      }),
      PASS_OPTIONS,
    );
    const status = createLocalFirstStatus({
      connectivity: "online",
      now: new Date(NOW),
      edits: await store.list(PARTITION),
      editCounts: await store.countByState(PARTITION),
      replica: REPLICA,
      limits: { maxListedEditIds: 2 },
    });
    expect(status.writes.conflictedCount).toBe(3);
    expect(status.writes.conflictedEditIds).toHaveLength(2);
    expect(status.writes.syncConflicts).toHaveLength(2);
    expect(status.writes.conflictedEditIdsTruncated).toBe(true);
  });
});

describe("offline replay conflict conformance against the fixture replica-sync transport", () => {
  /**
   * Completes the projection with the members only a server can supply, which
   * is exactly the handoff this slice is designed for: the SDK contributes the
   * client half, the server contributes the half the projection named
   * unavailable, and nothing has to be re-typed in between.
   */
  function completeWithServerHalf(
    projection: OfflineReplaySyncConflictProjectedV1,
    serverState: ConflictFeatureState,
  ): SyncConflictDetail {
    return {
      ...projection.conflict,
      serverOperation: serverState.operation,
      fieldConflictCount: 1,
      hasGeometryConflict: false,
      base: { operation: "update" },
      serverState,
      fieldConflicts: [
        { field: "status", baseValue: "open", clientValue: "closed", serverValue: "escalated", diverged: true },
      ],
      resolutionOptions: [
        { choice: "accept-client", available: true },
        { choice: "accept-server", available: true },
      ],
    };
  }

  it("lists and resolves a replayed conflict through the shipped replica-sync surface", async () => {
    const { edit } = await conflictedEdit({ conflictId: "replay-conflict-1", serverGeneration: "server-gen-42" });
    const projection = projected(projectOfflineReplaySyncConflict({ edit, replica: REPLICA }));
    const detail = completeWithServerHalf(projection, { operation: "update", editedAt: "2026-08-01T09:59:00.000Z" });

    const sync = createHonuaReplicaSync({
      transport: createFixtureReplicaSyncTransport({
        now: () => new Date("2026-08-01T11:00:00.000Z"),
        seed: { capabilities: { "public-safety": FULL_CAPABILITIES }, conflicts: [detail] },
      }),
    });

    const listed = await sync.listConflicts({ datasetId: "public-safety", kinds: ["replica-sync"] });
    expect(listed.items).toHaveLength(1);
    expect(listed.items[0]).toMatchObject({
      id: "replay-conflict-1",
      replicaId: "replica-field-crew-7",
      datasetId: "public-safety",
      sourceId: "incidents",
      featureId: "incident-1",
      kind: "replica-sync",
      status: "pending",
      clientOperation: "update",
      detectedAt: NOW,
    });

    const fetched = await sync.getConflict(projection.conflict.id);
    expect(fetched.serverGen).toBe("server-gen-42");
    expect(fetched.clientState).toEqual(projection.conflict.clientState);

    const record = await sync.resolveConflict({ conflictId: projection.conflict.id, choice: "accept-client" });
    expect(record).toMatchObject({ conflictId: "replay-conflict-1", choice: "accept-client", status: "resolved" });
    await expect(sync.resolveConflict({ conflictId: projection.conflict.id, choice: "accept-server" })).rejects.toThrow(
      /already resolved/,
    );
  });
});

const FULL_CAPABILITIES = {
  sync: true,
  createReplica: true,
  synchronizeReplica: true,
  conflictReview: true,
  conflictResolution: true,
  conflictPolicies: ["server-wins", "client-wins", "manual"],
  directions: ["bidirectional", "upload", "download"],
} as const;
