import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  HONUA_OFFLINE_CONFLICT_RESOLUTION_KIND,
  HONUA_OFFLINE_CONFLICT_RESOLUTION_VERSION,
  HonuaOfflineConflictAdjudicationError,
  HonuaOfflineEditQueueError,
  OFFLINE_REPLAY_CONFLICT_POLICIES,
  type OfflineEditConflictResolutionChoice,
  type OfflineEditQueue,
  type OfflineEditReplayAcknowledgement,
  type OfflineEditReplayRequest,
  type OfflineFeatureEdit,
  type OfflineQueuedEdit,
  type OfflineReplayConflictPolicyRuleV1,
  type OfflineReplaySyncConflictProjectedV1,
  type OfflineReplaySyncConflictProjectionV1,
  classifyOfflineReplayConflictPolicy,
  createLocalFirstStatus,
  createMemoryOfflineEditQueue,
  inspectStoredOfflineEdit,
  isHonuaOfflineConflictAdjudicationError,
  projectOfflineReplaySyncConflict,
  recordOfflineConflictResolution,
  replayOfflineEditPass,
} from "../src/offline/index.js";
import {
  type ConflictResolutionChoice,
  type DisconnectedReplica,
  type ReplicaConflictPolicy,
  type SyncConflictDetail,
  createFixtureReplicaSyncTransport,
  createHonuaReplicaSync,
} from "../src/replica-sync/index.js";

const AUTHORIZATION_SCOPE = `sha256:${"a".repeat(64)}` as const;
const PARTITION = { authorizationScopeDigest: AUTHORIZATION_SCOPE, sourceId: "incidents" } as const;
const REPLICA = { replicaId: "replica-field-crew-7", datasetId: "public-safety" } as const;
const PASS_OPTIONS = { ...PARTITION, workerId: "replay-worker", limit: 100, leaseDurationMs: 60_000 } as const;
const NOW = "2026-08-01T10:00:00.000Z";
const CONFLICT_ID = "server-conflict-1";

/**
 * The queue-side choice vocabulary is a subset of the shipped contract's, not a
 * parallel spelling. Every literal here must inhabit both unions, so the
 * declaration fails to compile if the two ever diverge — which is the whole
 * point of the slice.
 */
const LOCAL_CHOICES: ReadonlyArray<OfflineEditConflictResolutionChoice & ConflictResolutionChoice> = [
  "accept-client",
  "accept-server",
  "discard",
];

function queue(now: string = NOW): OfflineEditQueue {
  let lease = 0;
  return createMemoryOfflineEditQueue({
    now: () => new Date(now),
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

function fieldEdit(): OfflineFeatureEdit {
  return { operation: "update", featureId: "incident-1", attributes: { status: "closed" } };
}

function conflictingTransport(conflictId = CONFLICT_ID, serverGeneration = "server-gen-42") {
  return (request: OfflineEditReplayRequest): OfflineEditReplayAcknowledgement => ({
    kind: "conflicted",
    ...identity(request),
    conflictId,
    serverGeneration,
  });
}

/** One conflicted queued edit, produced by a real replay pass. */
async function conflicted(
  options: { readonly policy?: ReplicaConflictPolicy; readonly conflictId?: string } = {},
): Promise<{ readonly store: OfflineEditQueue; readonly edit: OfflineQueuedEdit }> {
  const store = queue();
  await store.enqueue({ ...PARTITION, idempotencyKey: "close-incident-1", edit: fieldEdit() });
  await replayOfflineEditPass(store, conflictingTransport(options.conflictId), {
    ...PASS_OPTIONS,
    ...(options.policy === undefined ? {} : { conflictPolicy: options.policy }),
  });
  const [edit] = await store.list(PARTITION);
  if (!edit) throw new Error("The queue did not retain the edit.");
  return { store, edit };
}

function projected(value: OfflineReplaySyncConflictProjectionV1 | undefined): OfflineReplaySyncConflictProjectedV1 {
  if (value?.outcome !== "projected") throw new Error(`Expected a projection, got ${value?.outcome ?? "nothing"}.`);
  return value;
}

/** Rows of the first markdown table in `text` whose first cell names a policy. */
function policyTableRows(text: string): ReadonlyArray<readonly string[]> {
  const rows: Array<readonly string[]> = [];
  for (const line of text.split("\n")) {
    const trimmed = line
      .trim()
      .replace(/^\*\s?/, "")
      .trim();
    if (!trimmed.startsWith("|")) continue;
    const cells = trimmed
      .split("|")
      .slice(1, -1)
      .map((cell) => cell.trim().replaceAll("`", ""));
    if (cells.length === 4 && Object.hasOwn(OFFLINE_REPLAY_CONFLICT_POLICIES, cells[0] ?? "")) rows.push(cells);
  }
  return rows;
}

describe("replica conflict policy classification", () => {
  it("classifies every shipped policy exactly once", () => {
    const policies: ReadonlyArray<ReplicaConflictPolicy> = ["server-wins", "client-wins", "manual", "last-writer-wins"];
    expect(Object.keys(OFFLINE_REPLAY_CONFLICT_POLICIES).sort()).toEqual([...policies].sort());
    for (const policy of policies) {
      const rule = classifyOfflineReplayConflictPolicy(policy);
      expect(rule?.policy).toBe(policy);
    }
    expect(classifyOfflineReplayConflictPolicy("merge-everything")).toBeUndefined();
    expect(Object.isFrozen(OFFLINE_REPLAY_CONFLICT_POLICIES)).toBe(true);
    // Every choice a policy can record is a choice a reviewer could have made.
    for (const rule of Object.values(OFFLINE_REPLAY_CONFLICT_POLICIES) as OfflineReplayConflictPolicyRuleV1[]) {
      if (rule.choice !== undefined) expect(LOCAL_CHOICES).toContain(rule.choice);
    }
  });

  it("splits the union on whether the outcome follows from queue-side state alone", () => {
    expect(OFFLINE_REPLAY_CONFLICT_POLICIES).toEqual({
      manual: {
        policy: "manual",
        disposition: "locally-honoured",
        action: "retain-for-review",
        reason: "queue-side-outcome",
      },
      "server-wins": {
        policy: "server-wins",
        disposition: "locally-honoured",
        action: "discard-local-edit",
        reason: "queue-side-outcome",
        choice: "accept-server",
      },
      "client-wins": {
        policy: "client-wins",
        disposition: "server-adjudicated",
        action: "refuse",
        reason: "needs-server-override",
      },
      "last-writer-wins": {
        policy: "last-writer-wins",
        disposition: "server-adjudicated",
        action: "refuse",
        reason: "needs-remote-edit-time",
      },
    });
    // Only a locally-honoured policy may name a resolution the SDK records on
    // its own; a refused one must not carry a choice that could be applied.
    for (const rule of Object.values(OFFLINE_REPLAY_CONFLICT_POLICIES) as OfflineReplayConflictPolicyRuleV1[]) {
      expect(rule.choice === undefined).toBe(rule.action !== "discard-local-edit");
      expect(rule.action === "refuse").toBe(rule.disposition === "server-adjudicated");
    }
  });

  it("agrees with the guide and with the contract's own documentation", () => {
    const expected = (Object.values(OFFLINE_REPLAY_CONFLICT_POLICIES) as OfflineReplayConflictPolicyRuleV1[])
      .map((rule) => [rule.policy, rule.disposition, rule.action, rule.reason].join(" | "))
      .sort();
    for (const path of ["docs/offline-regions.md", "src/replica-sync/types.ts"]) {
      const rows = policyTableRows(readFileSync(path, "utf8"));
      expect(rows.map((cells) => cells.join(" | ")).sort(), `${path} policy table`).toEqual(expected);
    }
  });
});

describe("replay pass conflict policy", () => {
  it("refuses a server-adjudicated policy by name before it claims anything", async () => {
    for (const policy of ["client-wins", "last-writer-wins"] as const) {
      const store = queue();
      await store.enqueue({ ...PARTITION, idempotencyKey: `key-${policy}`, edit: fieldEdit() });
      let invoked = 0;
      const attempt = replayOfflineEditPass(
        store,
        (request) => {
          invoked += 1;
          return conflictingTransport()(request);
        },
        { ...PASS_OPTIONS, conflictPolicy: policy },
      );

      await expect(attempt).rejects.toBeInstanceOf(HonuaOfflineConflictAdjudicationError);
      const error = await attempt.catch((thrown: unknown) => thrown);
      expect(isHonuaOfflineConflictAdjudicationError(error)).toBe(true);
      const refusal = error as HonuaOfflineConflictAdjudicationError;
      expect(refusal.code).toBe("server-adjudicated-policy");
      expect(refusal.policy).toBe(policy);
      expect(refusal.message).toContain(policy);
      expect(refusal.path).toBe("options.conflictPolicy");
      // Nothing was downgraded and nothing was attempted.
      expect(invoked).toBe(0);
      expect((await store.list(PARTITION))[0]?.state).toBe("pending");
    }
  });

  it("rejects a policy value outside the shipped union as a malformed argument", async () => {
    const store = queue();
    await expect(
      replayOfflineEditPass(store, conflictingTransport(), {
        ...PASS_OPTIONS,
        conflictPolicy: "whatever-wins" as ReplicaConflictPolicy,
      }),
    ).rejects.toBeInstanceOf(HonuaOfflineEditQueueError);
  });

  it("retains conflicts for review under manual, exactly as an omitted policy does", async () => {
    const store = queue();
    await store.enqueue({ ...PARTITION, idempotencyKey: "close-incident-1", edit: fieldEdit() });
    const receipt = await replayOfflineEditPass(store, conflictingTransport(), {
      ...PASS_OPTIONS,
      replica: REPLICA,
      conflictPolicy: "manual",
    });

    expect(receipt.conflictedCount).toBe(1);
    expect(receipt.outcomes[0]?.conflictPolicy).toEqual({ policy: "manual", outcome: "retained-for-review" });
    expect(projected(receipt.outcomes[0]?.syncConflict).conflict.status).toBe("pending");
    const [edit] = await store.list(PARTITION);
    expect(edit?.state).toBe("conflicted");
    expect(edit?.conflictResolution).toBeUndefined();
  });

  it("discards the losing local edit under server-wins and says so in the receipt", async () => {
    const store = queue();
    await store.enqueue({ ...PARTITION, idempotencyKey: "close-incident-1", edit: fieldEdit() });
    const receipt = await replayOfflineEditPass(store, conflictingTransport(), {
      ...PASS_OPTIONS,
      replica: REPLICA,
      conflictPolicy: "server-wins",
    });

    expect(receipt.conflictedCount).toBe(1);
    expect(receipt.outcomes[0]?.conflictPolicy).toEqual({ policy: "server-wins", outcome: "discarded-local-edit" });

    const [edit] = await store.list(PARTITION);
    expect(edit?.state).toBe("cancelled");
    expect(edit?.conflict).toBeUndefined();
    expect(edit?.cancellation?.reasonCode).toBe("conflict-resolved:accept-server");
    expect(edit?.conflictResolution).toEqual({
      conflictId: CONFLICT_ID,
      detectedAt: NOW,
      serverGeneration: "server-gen-42",
      choice: "accept-server",
      disposition: "discarded",
      acknowledgement: "unacknowledged-by-server",
      resolvedAt: NOW,
    });
    // The projection is of the resolved record, so the status is what the
    // policy actually did rather than what it was about to do.
    const projection = projected(receipt.outcomes[0]?.syncConflict);
    expect(projection.conflict.status).toBe("discarded");
    expect(projection.localResolution).toMatchObject({
      choice: "accept-server",
      disposition: "discarded",
      acknowledgement: "unacknowledged-by-server",
    });
    // The server's own acknowledgement record stays unavailable: a local choice
    // is not a server commit.
    expect(projection.unavailable).toContainEqual({ member: "resolution", reason: "server-owned" });
  });

  it("leaves receipts unchanged when no policy is declared", async () => {
    const store = queue();
    await store.enqueue({ ...PARTITION, idempotencyKey: "close-incident-1", edit: fieldEdit() });
    const receipt = await replayOfflineEditPass(store, conflictingTransport(), { ...PASS_OPTIONS, replica: REPLICA });
    expect(receipt.outcomes[0]?.conflictPolicy).toBeUndefined();
    expect((await store.list(PARTITION))[0]?.state).toBe("conflicted");
  });
});

describe("recorded conflict resolutions", () => {
  it("requeues the edit for another attempt when the client's edit stands", async () => {
    const { store, edit } = await conflicted();
    const receipt = await recordOfflineConflictResolution(store, {
      ...PARTITION,
      editId: edit.id,
      resolution: {
        conflictId: CONFLICT_ID,
        choice: "accept-client",
        resolvedBy: { id: "reviewer-7", displayName: "Field Lead", kind: "user" },
        note: "Local status is authoritative.",
      },
    });

    expect(receipt).toEqual({
      kind: HONUA_OFFLINE_CONFLICT_RESOLUTION_KIND,
      version: HONUA_OFFLINE_CONFLICT_RESOLUTION_VERSION,
      editId: edit.id,
      conflictId: CONFLICT_ID,
      choice: "accept-client",
      disposition: "requeued",
      acknowledgement: "unacknowledged-by-server",
      resolvedAt: NOW,
      state: "pending",
    });

    const [stored] = await store.list(PARTITION);
    expect(stored?.state).toBe("pending");
    expect(stored?.conflict).toBeUndefined();
    // Identity only: a SyncActor's display name and kind are presentation.
    expect(stored?.conflictResolution?.resolvedBy).toBe("reviewer-7");
    expect(JSON.stringify(stored)).not.toContain("Field Lead");
  });

  it("abandons the edit for both server-side choices", async () => {
    for (const choice of LOCAL_CHOICES.filter((value) => value !== "accept-client")) {
      const { store, edit } = await conflicted();
      const receipt = await recordOfflineConflictResolution(store, {
        ...PARTITION,
        editId: edit.id,
        resolution: { conflictId: CONFLICT_ID, choice },
      });
      expect(receipt).toMatchObject({ choice, disposition: "discarded", state: "cancelled" });
      const [stored] = await store.list(PARTITION);
      expect(stored?.state).toBe("cancelled");
      expect(stored?.cancellation?.reasonCode).toBe(`conflict-resolved:${choice}`);
    }
  });

  it("lands the closure in the edit's audit history", async () => {
    const { store, edit } = await conflicted();
    await recordOfflineConflictResolution(store, {
      ...PARTITION,
      editId: edit.id,
      resolution: { conflictId: CONFLICT_ID, choice: "accept-server" },
    });

    const [stored] = await store.list(PARTITION);
    const kinds = stored?.audit.map((event) => event.kind);
    expect(kinds).toEqual(["enqueued", "claimed", "conflicted", "conflict-resolved"]);
    expect(stored?.audit.at(-1)).toEqual({
      sequence: 4,
      kind: "conflict-resolved",
      at: NOW,
      attempt: 1,
      conflictId: CONFLICT_ID,
      resolutionChoice: "accept-server",
    });
  });

  it("does not re-surface a discarded conflict on a later pass or status", async () => {
    const { store, edit } = await conflicted();
    await recordOfflineConflictResolution(store, {
      ...PARTITION,
      editId: edit.id,
      resolution: { conflictId: CONFLICT_ID, choice: "discard" },
    });

    let invoked = 0;
    const later = await replayOfflineEditPass(
      store,
      (request) => {
        invoked += 1;
        return conflictingTransport("server-conflict-2")(request);
      },
      { ...PASS_OPTIONS, replica: REPLICA },
    );
    expect(invoked).toBe(0);
    expect(later.claimedCount).toBe(0);
    expect(later.conflictedCount).toBe(0);

    const status = createLocalFirstStatus({
      connectivity: "online",
      now: new Date(NOW),
      edits: await store.list(PARTITION),
      editCounts: await store.countByState(PARTITION),
      replica: REPLICA,
    });
    expect(status.writes.conflictedCount).toBe(0);
    expect(status.writes.conflictedEditIds).toEqual([]);
    expect(status.writes.syncConflicts).toEqual([]);
    expect(status.state).not.toBe("conflicted");
  });

  it("re-delivers a requeued edit without re-surfacing the closed conflict", async () => {
    const { store, edit } = await conflicted();
    await recordOfflineConflictResolution(store, {
      ...PARTITION,
      editId: edit.id,
      resolution: { conflictId: CONFLICT_ID, choice: "accept-client" },
    });

    const later = await replayOfflineEditPass(
      store,
      (request): OfflineEditReplayAcknowledgement => ({
        kind: "applied",
        ...identity(request),
        serverOperationId: "op-1",
      }),
      { ...PASS_OPTIONS, replica: REPLICA },
    );
    expect(later.appliedCount).toBe(1);
    expect(later.conflictedCount).toBe(0);
    expect(later.outcomes.every((outcome) => outcome.syncConflict === undefined)).toBe(true);

    const [stored] = await store.list(PARTITION);
    expect(stored?.state).toBe("applied");
    // The closure stays in the record's history; it is not re-opened.
    expect(stored?.conflict).toBeUndefined();
    expect(stored?.conflictResolution?.conflictId).toBe(CONFLICT_ID);
  });

  it("opens a new conflict rather than reviving the closed one when a requeued edit conflicts again", async () => {
    const { store, edit } = await conflicted();
    await recordOfflineConflictResolution(store, {
      ...PARTITION,
      editId: edit.id,
      resolution: { conflictId: CONFLICT_ID, choice: "accept-client" },
    });
    const later = await replayOfflineEditPass(store, conflictingTransport("server-conflict-2", "server-gen-43"), {
      ...PASS_OPTIONS,
      replica: REPLICA,
    });

    expect(projected(later.outcomes[0]?.syncConflict).conflict).toMatchObject({
      id: "server-conflict-2",
      status: "pending",
      serverGen: "server-gen-43",
    });
    const [stored] = await store.list(PARTITION);
    expect(stored?.state).toBe("conflicted");
    expect(stored?.conflict?.conflictId).toBe("server-conflict-2");
    // A record is conflicted or resolved, never both.
    expect(stored?.conflictResolution).toBeUndefined();
    expect(stored?.audit.map((event) => event.kind)).toEqual([
      "enqueued",
      "claimed",
      "conflicted",
      "conflict-resolved",
      "claimed",
      "conflicted",
    ]);
  });

  it("refuses a merge, and any merged content, by name", async () => {
    const { store, edit } = await conflicted();
    const cases: ReadonlyArray<Record<string, unknown>> = [
      { conflictId: CONFLICT_ID, choice: "merge", mergedAttributes: { status: "contained" } },
      { conflictId: CONFLICT_ID, choice: "merge" },
      { conflictId: CONFLICT_ID, choice: "accept-client", mergedAttributes: { status: "contained" } },
      { conflictId: CONFLICT_ID, choice: "accept-server", mergedGeometry: { type: "Point", coordinates: [0, 0] } },
    ];
    for (const resolution of cases) {
      const attempt = recordOfflineConflictResolution(store, {
        ...PARTITION,
        editId: edit.id,
        resolution: resolution as never,
      });
      await expect(attempt).rejects.toBeInstanceOf(HonuaOfflineConflictAdjudicationError);
      const error = (await attempt.catch((thrown: unknown) => thrown)) as HonuaOfflineConflictAdjudicationError;
      expect(error.code).toBe("server-adjudicated-resolution");
      expect(error.choice).toBe("merge");
    }
    // Nothing was recorded, so the conflict is still open for a real review.
    expect((await store.list(PARTITION))[0]?.state).toBe("conflicted");
  });

  it("refuses a resolution that names another conflict, or an edit that has none", async () => {
    const { store, edit } = await conflicted();
    await expect(
      recordOfflineConflictResolution(store, {
        ...PARTITION,
        editId: edit.id,
        resolution: { conflictId: "some-other-conflict", choice: "discard" },
      }),
    ).rejects.toThrowError(/does not match/);

    await recordOfflineConflictResolution(store, {
      ...PARTITION,
      editId: edit.id,
      resolution: { conflictId: CONFLICT_ID, choice: "discard" },
    });
    // The second review of the same conflict finds nothing left to close.
    await expect(
      recordOfflineConflictResolution(store, {
        ...PARTITION,
        editId: edit.id,
        resolution: { conflictId: CONFLICT_ID, choice: "discard" },
      }),
    ).rejects.toThrowError(/conflicted/);
  });

  it("refuses an unknown edit and an unknown partition", async () => {
    const { store, edit } = await conflicted();
    await expect(
      recordOfflineConflictResolution(store, {
        ...PARTITION,
        sourceId: "another-source",
        editId: edit.id,
        resolution: { conflictId: CONFLICT_ID, choice: "discard" },
      }),
    ).rejects.toBeInstanceOf(HonuaOfflineEditQueueError);
  });
});

describe("recorded conflict resolutions under hostile input", () => {
  async function refuses(resolution: unknown): Promise<void> {
    const { store, edit } = await conflicted();
    await expect(
      recordOfflineConflictResolution(store, { ...PARTITION, editId: edit.id, resolution: resolution as never }),
    ).rejects.toBeInstanceOf(HonuaOfflineEditQueueError);
    expect((await store.list(PARTITION))[0]?.state).toBe("conflicted");
  }

  it("refuses credential-shaped reviewer identities and notes", async () => {
    await refuses({ conflictId: CONFLICT_ID, choice: "discard", resolvedBy: { id: "authorization=Bearer abc123" } });
    await refuses({
      conflictId: CONFLICT_ID,
      choice: "discard",
      resolvedBy: { id: "https://tenant.example.test/portal?token=abc123" },
    });
    await refuses({
      conflictId: CONFLICT_ID,
      choice: "discard",
      note: "https://tenant.example.test/arcgis/rest?token=abc123",
    });
    await refuses({ conflictId: CONFLICT_ID, choice: "discard", note: "api_key=super-secret-token" });
  });

  it("refuses undeclared members, unsafe prototypes, and non-data properties", async () => {
    await refuses({ conflictId: CONFLICT_ID, choice: "discard", leaseToken: "lease-1" });
    await refuses({ conflictId: CONFLICT_ID, choice: "discard", endpoint: "https://tenant.example.test" });
    await refuses(Object.assign(Object.create({ polluted: true }), { conflictId: CONFLICT_ID, choice: "discard" }));
    await refuses(
      Object.defineProperty({ conflictId: CONFLICT_ID }, "choice", { get: () => "discard", enumerable: true }),
    );
    await refuses({ conflictId: CONFLICT_ID, choice: "ACCEPT-SERVER" });
    await refuses({ conflictId: CONFLICT_ID, choice: "discard", resolvedBy: { id: "reviewer-7", role: "admin" } });
    await refuses({ conflictId: "  padded  ", choice: "discard" });
  });

  it("leaks no credential, endpoint, lease token, or payload value into what it persists or projects", async () => {
    const store = queue();
    await store.enqueue({
      ...PARTITION,
      idempotencyKey: "close-incident-1",
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
    const passReceipt = await replayOfflineEditPass(store, conflictingTransport(), {
      ...PASS_OPTIONS,
      replica: REPLICA,
      conflictPolicy: "server-wins",
    });
    const [stored] = await store.list(PARTITION);
    if (!stored) throw new Error("The queue did not retain the edit.");

    const receipt = JSON.stringify(passReceipt);
    const projection = JSON.stringify(projectOfflineReplaySyncConflict({ edit: stored, replica: REPLICA }));
    const resolution = JSON.stringify(stored.conflictResolution);
    for (const serialized of [receipt, projection, resolution]) {
      for (const secret of [
        "Bearer",
        "super-secret-token",
        "example.test",
        "token=abc123",
        "coordinates",
        "-157.85",
        AUTHORIZATION_SCOPE,
        stored.requestFingerprint,
        stored.idempotencyKey,
        "lease-",
      ]) {
        expect(serialized).not.toContain(secret);
      }
    }
  });

  it("refuses a persisted record that is both conflicted and resolved, or self-contradictory", async () => {
    const { store, edit } = await conflicted();
    const resolved = await store.resolveConflict(edit.id, PARTITION, { conflictId: CONFLICT_ID, choice: "discard" });
    expect(inspectStoredOfflineEdit(resolved).status).toBe("valid");

    const mutate = (patch: Record<string, unknown>): unknown =>
      JSON.parse(JSON.stringify({ ...resolved, ...patch })) as unknown;

    // Conflicted and resolved at once.
    expect(inspectStoredOfflineEdit(mutate({ state: "conflicted", conflict: edit.conflict }))).toEqual({
      status: "invalid",
      reason: "corrupt-record",
    });
    // A disposition that disagrees with its choice.
    expect(
      inspectStoredOfflineEdit(
        mutate({ conflictResolution: { ...resolved.conflictResolution, disposition: "requeued" } }),
      ),
    ).toEqual({ status: "invalid", reason: "corrupt-record" });
    // A resolution claiming a server acknowledged it.
    expect(
      inspectStoredOfflineEdit(
        mutate({ conflictResolution: { ...resolved.conflictResolution, acknowledgement: "acknowledged" } }),
      ),
    ).toEqual({ status: "invalid", reason: "corrupt-record" });
    // Credential-shaped reviewer material written by something else.
    expect(
      inspectStoredOfflineEdit(
        mutate({ conflictResolution: { ...resolved.conflictResolution, note: "token=abc123&password=hunter2" } }),
      ),
    ).toEqual({ status: "invalid", reason: "credential-screened" });
    expect(
      inspectStoredOfflineEdit(
        mutate({
          conflictResolution: { ...resolved.conflictResolution, resolvedBy: "https://tenant.example.test/?token=x" },
        }),
      ),
    ).toEqual({ status: "invalid", reason: "credential-screened" });
  });

  it("refuses a projection of a resolution this build cannot read", async () => {
    const { store, edit } = await conflicted();
    const resolved = await store.resolveConflict(edit.id, PARTITION, { conflictId: CONFLICT_ID, choice: "discard" });
    const withUndeclared = {
      ...resolved,
      conflictResolution: { ...resolved.conflictResolution, leaseToken: "lease-1" },
    } as unknown as OfflineQueuedEdit;
    expect(projectOfflineReplaySyncConflict({ edit: withUndeclared, replica: REPLICA })).toEqual({
      kind: expect.any(String),
      version: expect.any(String),
      outcome: "refused",
      reason: "unreadable-edit",
      path: "input.edit.conflictResolution.leaseToken",
      editId: resolved.id,
    });
  });
});

describe("offline conflict resolution conformance against the fixture replica-sync transport", () => {
  const FULL_CAPABILITIES = {
    sync: true,
    createReplica: true,
    synchronizeReplica: true,
    conflictReview: true,
    conflictResolution: true,
    conflictPolicies: ["server-wins", "client-wins", "manual"],
    directions: ["bidirectional", "upload", "download"],
  } as const;

  function completeWithServerHalf(projection: OfflineReplaySyncConflictProjectedV1): SyncConflictDetail {
    return {
      ...projection.conflict,
      serverOperation: "update",
      fieldConflictCount: 1,
      hasGeometryConflict: false,
      base: { operation: "update" },
      serverState: { operation: "update", editedAt: "2026-08-01T09:59:00.000Z" },
      fieldConflicts: [
        { field: "status", baseValue: "open", clientValue: "closed", serverValue: "escalated", diverged: true },
      ],
      resolutionOptions: [
        { choice: "accept-client", available: true },
        { choice: "accept-server", available: true },
      ],
    };
  }

  /** The replica the conflict is attributed to, registered `manual` so its own
   * declared policy is one a replay pass can honour. */
  const REGISTERED_REPLICA: DisconnectedReplica = {
    id: REPLICA.replicaId,
    datasetId: REPLICA.datasetId,
    sourceId: PARTITION.sourceId,
    state: "active",
    direction: "bidirectional",
    conflictPolicy: "manual",
    createdAt: "2026-07-31T10:00:00.000Z",
    status: { inProgress: false, openConflicts: 1 },
  };

  it("projects, lists, resolves, and records the closure back against the queued edit", async () => {
    const { store, edit } = await conflicted({ policy: REGISTERED_REPLICA.conflictPolicy });
    const projection = projected(projectOfflineReplaySyncConflict({ edit, replica: REPLICA }));
    const sync = createHonuaReplicaSync({
      transport: createFixtureReplicaSyncTransport({
        now: () => new Date("2026-08-01T11:00:00.000Z"),
        seed: {
          capabilities: { "public-safety": FULL_CAPABILITIES },
          replicas: [REGISTERED_REPLICA],
          conflicts: [completeWithServerHalf(projection)],
        },
      }),
    });

    const listed = await sync.listConflicts({ replicaId: REPLICA.replicaId });
    const summary = listed.items[0];
    if (!summary) throw new Error("The review surface did not list the replayed conflict.");
    expect(summary.id).toBe(CONFLICT_ID);
    expect(summary.status).toBe("pending");

    // The reviewer's decision, in the contract's own shape, handed to both
    // surfaces unchanged: no application-invented mapping anywhere.
    const decision = { conflictId: summary.id, choice: "accept-server", resolvedBy: { id: "reviewer-7" } } as const;
    const serverRecord = await sync.resolveConflict(decision);
    expect(serverRecord).toMatchObject({ conflictId: CONFLICT_ID, choice: "accept-server", status: "resolved" });

    const receipt = await recordOfflineConflictResolution(store, {
      ...PARTITION,
      editId: edit.id,
      resolution: decision,
    });
    expect(receipt.conflictId).toBe(serverRecord.conflictId);
    expect(receipt.choice).toBe(serverRecord.choice);
    // The two vocabularies agree on identity and choice, and disagree — on
    // purpose — about who has acknowledged it.
    expect(receipt.acknowledgement).toBe("unacknowledged-by-server");

    const [stored] = await store.list(PARTITION);
    if (!stored) throw new Error("The queue did not retain the edit.");
    const closed = projected(projectOfflineReplaySyncConflict({ edit: stored, replica: REPLICA }));
    expect(closed.conflict).toMatchObject({ id: CONFLICT_ID, kind: "replica-sync", status: "discarded" });
    expect(closed.conflict.status).not.toBe("resolved");
    expect(closed.localResolution).toEqual({
      choice: "accept-server",
      disposition: "discarded",
      acknowledgement: "unacknowledged-by-server",
      resolvedAt: NOW,
      resolvedBy: { id: "reviewer-7" },
    });
    // The closed conflict is still addressable in the review surface's own
    // vocabulary, so both halves describe one event.
    const fetched = await sync.getConflict(closed.conflict.id);
    expect(fetched.id).toBe(closed.conflict.id);
    expect(fetched.serverGen).toBe(closed.conflict.serverGen);
  });
});
