import { describe, expect, it } from "vitest";

import type { TemporalFeatureTimelineRequest } from "../src/contract/temporal.js";
import { isHonuaError } from "../src/index.js";
import type { FeatureId } from "../src/replica-sync/index.js";
import {
  createFixtureReplicaSyncTransport,
  createHonuaReplicaSync,
  defaultReplicaSyncSeed,
  isHonuaReplicaSyncError,
  isUnsupportedReplicaSyncError,
} from "../src/replica-sync/index.js";

function client() {
  return createHonuaReplicaSync({
    transport: createFixtureReplicaSyncTransport({ now: () => new Date("2026-05-29T12:00:00.000Z") }),
  });
}

describe("disconnected replica contracts", () => {
  it("lists active and expired replicas with sync status and server generation cursors", async () => {
    const sync = client();
    const page = await sync.listReplicas({ datasetId: "parcels" });

    const active = page.items.find((replica) => replica.id === "replica-active-1");
    expect(active?.state).toBe("active");
    expect(active?.conflictPolicy).toBe("manual");
    expect(active?.status.serverGen).toBe("42");
    expect(active?.status.targetServerGen).toBe("47");
    expect(active?.status.openConflicts).toBe(2);
  });

  it("represents an expired replica explicitly", async () => {
    const sync = client();
    const page = await sync.listReplicas({ states: ["expired"] });
    expect(page.items.map((replica) => replica.id)).toEqual(["replica-expired-1"]);
    expect(page.items[0]?.expiresAt).toBe("2026-04-01T08:00:00.000Z");
    expect(page.items[0]?.status.lastError).toContain("expired");
  });

  it("reads a single replica and reports replica-not-found as a typed error", async () => {
    const sync = client();
    const replica = await sync.getReplica("replica-active-1");
    expect(replica.device?.platform).toBe("android");

    await expect(sync.getReplica("missing")).rejects.toSatisfy(
      (error) => isHonuaError(error) && isHonuaReplicaSyncError(error) && error.code === "replica-not-found",
    );
  });

  it("paginates with a continuation cursor", async () => {
    const sync = client();
    const first = await sync.listReplicas({ limit: 1 });
    expect(first.items).toHaveLength(1);
    expect(first.cursor).toBeDefined();
    expect(first.totalCount).toBe(3);

    const second = await sync.listReplicas({ limit: 1, cursor: first.cursor });
    expect(second.items[0]?.id).not.toBe(first.items[0]?.id);
  });
});

describe("sync conflict review contracts", () => {
  it("lists pending and resolved conflicts as replica-sync (not version-reconcile) conflicts", async () => {
    const sync = client();
    const page = await sync.listConflicts({ replicaId: "replica-active-1" });
    const byId = new Map(page.items.map((conflict) => [conflict.id, conflict]));

    expect(byId.get("conflict-pending-1")?.status).toBe("pending");
    expect(byId.get("conflict-resolved-1")?.status).toBe("resolved");
    for (const conflict of page.items) {
      expect(conflict.kind).toBe("replica-sync");
    }
  });

  it("exposes base/client/server states, field + geometry conflicts, actor/device, and resolution options", async () => {
    const sync = client();
    const detail = await sync.getConflict("conflict-pending-1");

    expect(detail.base.attributes?.zoning).toBe("R1");
    expect(detail.clientState.attributes?.zoning).toBe("R2");
    expect(detail.serverState.attributes?.zoning).toBe("C1");
    expect(detail.fieldConflicts[0]).toMatchObject({ field: "zoning", diverged: true });
    expect(detail.geometryConflict?.changed).toBe(true);
    expect(detail.client?.id).toBe("user-amelia");
    expect(detail.device?.id).toBe("device-field-01");
    expect(detail.resolutionOptions.map((option) => option.choice)).toEqual([
      "accept-client",
      "accept-server",
      "merge",
      "discard",
    ]);
  });

  it("resolves a pending conflict and records the resolution with a new server generation", async () => {
    const sync = client();
    const record = await sync.resolveConflict({
      conflictId: "conflict-pending-1",
      choice: "accept-client",
      resolvedBy: { id: "user-reviewer" },
    });

    expect(record.status).toBe("resolved");
    expect(record.serverGen).toBe("48");

    const detail = await sync.getConflict("conflict-pending-1");
    expect(detail.status).toBe("resolved");
    expect(detail.resolution?.choice).toBe("accept-client");
  });

  it("rejects a merge resolution that omits merged data", async () => {
    const sync = client();
    await expect(sync.resolveConflict({ conflictId: "conflict-pending-1", choice: "merge" })).rejects.toSatisfy(
      (error) => isHonuaReplicaSyncError(error) && error.code === "merge-required",
    );
  });

  it("rejects re-resolving an already-resolved conflict", async () => {
    const sync = client();
    await expect(
      sync.resolveConflict({ conflictId: "conflict-resolved-1", choice: "accept-server" }),
    ).rejects.toSatisfy((error) => isHonuaReplicaSyncError(error) && error.code === "conflict-already-resolved");
  });

  it("resolves a batch and reports per-conflict failures", async () => {
    const sync = client();
    const result = await sync.resolveConflicts([
      { conflictId: "conflict-pending-1", choice: "accept-server" },
      { conflictId: "conflict-pending-2", choice: "accept-client" },
      { conflictId: "missing-conflict", choice: "discard" },
    ]);

    expect(result.records.map((record) => record.conflictId)).toEqual(["conflict-pending-1", "conflict-pending-2"]);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.conflictId).toBe("missing-conflict");
  });
});

describe("unsupported capabilities are explicit", () => {
  it("advertises capabilities per dataset", async () => {
    const sync = client();
    expect(await sync.capabilities("parcels")).toMatchObject({ conflictReview: true, conflictResolution: true });
    expect(await sync.capabilities("hydrants")).toMatchObject({ conflictReview: false, conflictResolution: false });
  });

  it("surfaces unsupported conflict review so clients can hide manual review", async () => {
    const sync = client();
    let caught: unknown;
    try {
      await sync.listConflicts({ datasetId: "hydrants", replicaId: "replica-no-review-1" });
    } catch (error) {
      caught = error;
    }
    expect(isUnsupportedReplicaSyncError(caught)).toBe(true);
  });

  it("reports unsupported sync for unknown datasets", async () => {
    const sync = client();
    await expect(sync.capabilities("does-not-exist")).rejects.toSatisfy((error) =>
      isUnsupportedReplicaSyncError(error),
    );
  });
});

describe("composition with temporal history contracts (#227)", () => {
  it("uses the shared FeatureId so a conflict feeds a temporal feature timeline", async () => {
    const sync = client();
    const detail = await sync.getConflict("conflict-pending-1");

    // The conflict's featureId is the shared contract FeatureId alias, so it can
    // be handed straight to the temporal feature-timeline request without any
    // re-typing or coercion — the two contracts compose by construction.
    const featureId: FeatureId = detail.featureId;
    const timelineRequest: TemporalFeatureTimelineRequest = {
      sourceId: detail.sourceId ?? detail.datasetId,
      featureId,
    };

    expect(timelineRequest.featureId).toBe(detail.featureId);
    expect(timelineRequest.sourceId).toBe("parcels");
  });
});

describe("default seed", () => {
  it("covers every state the Console/Studio viewers prototype against", () => {
    const seed = defaultReplicaSyncSeed();
    expect(seed.replicas?.map((replica) => replica.state).sort()).toEqual(["active", "active", "expired"]);
    expect(seed.conflicts?.map((conflict) => conflict.status).sort()).toEqual(["pending", "pending", "resolved"]);
  });
});
