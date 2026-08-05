import { afterEach, describe, expect, it } from "vitest";

import { HonuaClient } from "../src/core/client.js";
import { HonuaCapabilityNotSupportedError } from "../src/core/errors.js";
import {
  GEOSERVICES_EDIT_ERROR_CODES,
  classifyGeoServicesEditResult,
  createFixtureReplicaSyncTransport,
  createGeoServicesReplicaSyncTransport,
  createHonuaReplicaSync,
  defaultReplicaSyncSeed,
  isHonuaReplicaSyncError,
  runReplicaSyncTransportConformance,
} from "../src/replica-sync/index.js";
import type { GeoServicesEditKind, GeoServicesEditOutcome } from "../src/replica-sync/index.js";
import {
  type GeoServicesReplicaDrift,
  type GeoServicesReplicaLoopbackOptions,
  type GeoServicesReplicaLoopbackServer,
  LOOPBACK_SERVICE_ID,
  LOOPBACK_UNSUPPORTED_SERVICE_ID,
  startGeoServicesReplicaLoopbackServer,
} from "./helpers/geoservices-replica-loopback-server.js";

const API_KEY = "sekrit-loopback-api-key";
const PENDING_CONFLICT_ID = "45c48cce2e2d7fbdea1afc51c7c6ad26";
const RESOLVED_CONFLICT_ID = "d3d9446802a44259755d38e6d163e820";
const ACTIVE_REPLICA_ID = "8f14e45fceea167a5a36dedd4bea2543";

let servers: GeoServicesReplicaLoopbackServer[] = [];

afterEach(async () => {
  await Promise.all(servers.map((server) => server.close()));
  servers = [];
});

async function loopback(options: GeoServicesReplicaLoopbackOptions = {}): Promise<GeoServicesReplicaLoopbackServer> {
  const server = await startGeoServicesReplicaLoopbackServer(options);
  servers.push(server);
  return server;
}

async function transportFor(options: GeoServicesReplicaLoopbackOptions = {}) {
  const server = await loopback(options);
  const client = new HonuaClient({ baseUrl: server.baseUrl, apiKey: API_KEY });
  return {
    server,
    transport: createGeoServicesReplicaSyncTransport({ client, serviceId: LOOPBACK_SERVICE_ID }),
  };
}

async function driftError(
  drift: GeoServicesReplicaDrift,
  act: (transport: Awaited<ReturnType<typeof transportFor>>["transport"]) => Promise<unknown>,
) {
  const { transport } = await transportFor({ drift });
  let caught: unknown;
  try {
    await act(transport);
  } catch (error) {
    caught = error;
  }
  return caught;
}

describe("GeoServices replica-sync transport conformance", () => {
  it("passes the shared ReplicaSyncTransport conformance suite", async () => {
    const server = await loopback();
    const client = new HonuaClient({ baseUrl: server.baseUrl, apiKey: API_KEY });
    const report = await runReplicaSyncTransportConformance({
      label: "geoservices",
      datasetId: LOOPBACK_SERVICE_ID,
      unsupportedDatasetId: LOOPBACK_UNSUPPORTED_SERVICE_ID,
      createTransport: () => createGeoServicesReplicaSyncTransport({ client, serviceId: LOOPBACK_SERVICE_ID }),
    });

    expect(report.cases.filter((entry) => entry.status === "failed")).toEqual([]);
    expect(report.skipped).toBe(0);
    expect(report.passed).toBe(report.total);
  });

  it("passes the SAME suite the fixture transport passes", async () => {
    // The fixture defines the reference semantics; running one suite over both
    // is what proves the two speak the same vocabulary rather than merely the
    // same TypeScript shape.
    const seed = defaultReplicaSyncSeed();
    const parcels = seed.replicas!.filter((replica) => replica.datasetId === "parcels");
    const report = await runReplicaSyncTransportConformance({
      label: "fixture",
      datasetId: "parcels",
      unsupportedDatasetId: "does-not-exist",
      createTransport: () =>
        createFixtureReplicaSyncTransport({
          now: () => new Date("2026-08-04T12:00:00.000Z"),
          seed: {
            ...seed,
            replicas: [...seed.replicas!, { ...parcels[0]!, id: "replica-active-2", name: "Parcels — East" }],
          },
        }),
    });

    expect(report.cases.filter((entry) => entry.status === "failed")).toEqual([]);
    expect(report.skipped).toBe(0);
  });
});

describe("capability gating", () => {
  it("refuses a service that does not advertise Sync with a capability error naming it", async () => {
    const { transport } = await transportFor();
    let caught: unknown;
    try {
      await transport.capabilities(LOOPBACK_UNSUPPORTED_SERVICE_ID);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(HonuaCapabilityNotSupportedError);
    expect((caught as HonuaCapabilityNotSupportedError).capability).toBe("Sync");
    expect((caught as HonuaCapabilityNotSupportedError).sourceId).toBe(LOOPBACK_UNSUPPORTED_SERVICE_ID);
  });

  it("projects the advertised sync capabilities onto the contract", async () => {
    const { transport } = await transportFor();
    const capabilities = await transport.capabilities(LOOPBACK_SERVICE_ID);

    expect(capabilities).toMatchObject({
      sync: true,
      createReplica: true,
      synchronizeReplica: true,
      conflictReview: true,
      conflictResolution: true,
    });
    expect([...capabilities.directions].sort()).toEqual(["bidirectional", "download", "upload"]);
    expect(capabilities.conflictPolicies).toContain("last-writer-wins");
  });

  it("reads a disabled experimental capability as a capability refusal, never as a missing replica", async () => {
    // The server's capability gate answers a disabled deployment with HTTP 404
    // and a problem+json body. Treating that as "replica not found" would report
    // a configuration state as data corruption.
    const { transport } = await transportFor({ capabilityDisabled: true });
    let caught: unknown;
    try {
      await transport.listReplicas();
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(HonuaCapabilityNotSupportedError);
    expect((caught as HonuaCapabilityNotSupportedError).capability).toBe("sync.offline");
    expect(isHonuaReplicaSyncError(caught)).toBe(false);
  });

  it("reports a provider without durable conflict records as unsupported review", async () => {
    const { transport } = await transportFor({ conflictReviewSupported: false });
    const capabilities = await transport.capabilities(LOOPBACK_SERVICE_ID);
    expect(capabilities.conflictReview).toBe(false);
    expect(capabilities.conflictResolution).toBe(false);
    expect(capabilities.conflictPolicies).toEqual(["last-writer-wins"]);

    await expect(transport.listConflicts({ replicaId: ACTIVE_REPLICA_ID })).rejects.toSatisfy(
      (error) => isHonuaReplicaSyncError(error) && error.code === "unsupported-conflict-review",
    );
  });

  it("refuses a filter the replica registry cannot honour instead of returning the wrong set", async () => {
    const { transport } = await transportFor();
    await expect(transport.listReplicas({ ownerId: "user-amelia" })).rejects.toBeInstanceOf(
      HonuaCapabilityNotSupportedError,
    );
  });
});

describe("replica and conflict projection", () => {
  it("projects replica listings with generation cursors and observed conflict counts", async () => {
    const { transport } = await transportFor();
    const page = await transport.listReplicas();

    const active = page.items.find((replica) => replica.id === ACTIVE_REPLICA_ID);
    expect(active?.state).toBe("active");
    expect(active?.datasetId).toBe(LOOPBACK_SERVICE_ID);
    expect(active?.status.serverGen).toBe("42");
    expect(active?.status.openConflicts).toBe(1);
    expect(active?.status.inProgress).toBe(false);
    expect(active?.conflictPolicy).toBe("last-writer-wins");
    expect(page.items.find((replica) => replica.state === "expired")).toBeDefined();
  });

  it("projects a three-way conflict detail with field divergence and geometry attribution", async () => {
    const { transport } = await transportFor();
    const detail = await transport.getConflict(PENDING_CONFLICT_ID);

    expect(detail.featureId).toBe("1024");
    expect(detail.kind).toBe("replica-sync");
    expect(detail.status).toBe("pending");
    expect(detail.serverGen).toBe("47");
    expect(detail.base.attributes?.name).toBe("base");
    expect(detail.clientState.attributes?.name).toBe("client");
    expect(detail.serverState.attributes?.name).toBe("server");
    expect(detail.fieldConflicts).toEqual([
      { field: "name", baseValue: "base", clientValue: "client", serverValue: "server", diverged: true },
    ]);
    expect(detail.fieldConflictCount).toBe(1);
    expect(detail.client?.id).toBe("field-user");
    expect(detail.device?.id).toBe("device-42");
    // An attribute conflict reports no geometry divergence.
    expect(detail.hasGeometryConflict).toBe(false);
    expect(detail.geometryConflict).toBeUndefined();
  });

  it("classifies a geometry conflict and carries the server's resolution evidence", async () => {
    const { transport } = await transportFor();
    const detail = await transport.getConflict(RESOLVED_CONFLICT_ID);

    expect(detail.hasGeometryConflict).toBe(true);
    expect(detail.geometryConflict?.changed).toBe(true);
    expect(detail.status).toBe("resolved");
    expect(detail.resolution).toMatchObject({
      conflictId: RESOLVED_CONFLICT_ID,
      choice: "accept-client",
      status: "resolved",
      serverGen: "45",
    });
    expect(detail.resolution?.resolvedBy?.id).toBe("operator-1");
  });

  it("declares merge unavailable because the resolve endpoint cannot carry a merge payload", async () => {
    const { transport } = await transportFor();
    const detail = await transport.getConflict(PENDING_CONFLICT_ID);
    const merge = detail.resolutionOptions.find((option) => option.choice === "merge");
    expect(merge?.available).toBe(false);
    expect(merge?.reason).toContain("action");
  });
});

describe("conflict resolution", () => {
  it("posts accept-client and returns the acknowledged record", async () => {
    const { transport } = await transportFor();
    const record = await transport.resolveConflict({
      conflictId: PENDING_CONFLICT_ID,
      choice: "accept-client",
      resolvedBy: { id: "user-reviewer" },
      note: "Field edit wins.",
    });

    expect(record).toMatchObject({
      conflictId: PENDING_CONFLICT_ID,
      choice: "accept-client",
      status: "resolved",
      serverGen: "48",
      note: "Field edit wins.",
    });
    expect(record.resolvedBy?.id).toBe("user-reviewer");
  });

  it("maps discard onto the server's reject-client action and records a discarded status", async () => {
    const { transport } = await transportFor();
    const record = await transport.resolveConflict({ conflictId: PENDING_CONFLICT_ID, choice: "discard" });
    expect(record.status).toBe("discarded");
    // reject-client commits no new server state, so no generation is produced.
    expect(record.serverGen).toBeUndefined();
  });

  it("refuses a merge resolution rather than silently committing the server's merge", async () => {
    const { transport } = await transportFor();
    const sync = createHonuaReplicaSync({ transport });
    await expect(
      sync.resolveConflict({
        conflictId: PENDING_CONFLICT_ID,
        choice: "merge",
        mergedAttributes: { name: "merged" },
      }),
    ).rejects.toSatisfy((error) => isHonuaReplicaSyncError(error) && error.code === "unsupported-conflict-resolution");
  });

  it("reports an already-resolved conflict as conflict-already-resolved", async () => {
    const { transport } = await transportFor();
    await expect(
      transport.resolveConflict({ conflictId: RESOLVED_CONFLICT_ID, choice: "accept-server" }),
    ).rejects.toSatisfy((error) => isHonuaReplicaSyncError(error) && error.code === "conflict-already-resolved");
  });

  it("partitions a batch into records and per-conflict failures", async () => {
    const { transport } = await transportFor();
    const result = await transport.resolveConflicts([
      { conflictId: PENDING_CONFLICT_ID, choice: "accept-server" },
      { conflictId: RESOLVED_CONFLICT_ID, choice: "accept-server" },
    ]);
    expect(result.records.map((record) => record.conflictId)).toEqual([PENDING_CONFLICT_ID]);
    expect(result.failures.map((failure) => failure.conflictId)).toEqual([RESOLVED_CONFLICT_ID]);
  });
});

describe("replica lifecycle and delta exchange", () => {
  it("creates a replica and reads back an opaque generation cursor", async () => {
    const { transport } = await transportFor();
    const created = await transport.createReplica({ replicaName: "Field crew", layers: [0, 1] });
    expect(created.replicaId).toBe("e4da3b7fbbce2345d7772b0674a318d5");
    expect(created.serverGen).toBe("50");
  });

  it("uploads edits and surfaces the inline conflict summary", async () => {
    const { transport } = await transportFor();
    const result = await transport.synchronizeReplica({
      replicaId: ACTIVE_REPLICA_ID,
      direction: "upload",
      replicaServerGen: "42",
      edits: [{ id: 0, adds: [{ attributes: { name: "field-add" } }] }],
    });

    expect(result.direction).toBe("upload");
    expect(result.serverGen).toBe("51");
    expect(result.appliedAdds).toBe(1);
    expect(result.conflicts).toEqual([
      { layerId: 0, featureId: "1024", classification: "geometry", applied: true, conflictId: PENDING_CONFLICT_ID },
    ]);
    // An upload-only sync carries no download payload.
    expect(result.edits).toBeUndefined();
  });

  it("downloads a server delta without an upload half", async () => {
    const { transport } = await transportFor();
    const result = await transport.synchronizeReplica({
      replicaId: ACTIVE_REPLICA_ID,
      direction: "download",
      replicaServerGen: "42",
    });
    expect(result.edits).toHaveLength(1);
    expect(result.appliedAdds).toBeUndefined();
    expect(result.conflicts).toEqual([]);
  });

  it("exchanges both halves in one bidirectional call", async () => {
    const { transport } = await transportFor();
    const result = await transport.synchronizeReplica({
      replicaId: ACTIVE_REPLICA_ID,
      direction: "bidirectional",
      replicaServerGen: "42",
      edits: [{ id: 0, adds: [{ attributes: { name: "field-add" } }] }],
    });
    expect(result.appliedAdds).toBe(1);
    expect(result.edits).toHaveLength(1);
  });

  it("unregisters a replica", async () => {
    const { transport } = await transportFor();
    await expect(transport.unregisterReplica(ACTIVE_REPLICA_ID)).resolves.toBeUndefined();
  });
});

describe("applyEdits per-feature conflict classification (HTTP 200)", () => {
  it("classifies every result in the HTTP-200 envelope", async () => {
    const { transport } = await transportFor();
    const results = await transport.applyEdits({ layerId: 0, updates: [], deletes: [] });

    expect(results).toEqual([
      { outcome: "applied", kind: "add", featureId: "900" },
      { outcome: "conflicted", kind: "update", featureId: "999999", code: 1002, reason: "notFound" },
      { outcome: "conflicted", kind: "update", featureId: "12", code: 1004, reason: "updateConflict" },
      { outcome: "conflicted", kind: "delete", featureId: "999999", code: 1003, reason: "deleteNotFound" },
      { outcome: "rejected", kind: "delete", featureId: "0", code: 1001, reason: "invalidObjectId" },
    ]);
  });

  it.each<[keyof typeof GEOSERVICES_EDIT_ERROR_CODES, GeoServicesEditKind, GeoServicesEditOutcome]>([
    ["genericFailure", "update", "retryable"],
    ["invalidObjectId", "delete", "rejected"],
    ["notFound", "update", "conflicted"],
    ["deleteNotFound", "delete", "conflicted"],
    ["updateConflict", "update", "conflicted"],
    ["featureLocked", "update", "retryable"],
    ["validationFailed", "add", "rejected"],
    ["notPermitted", "update", "rejected"],
    ["operationRolledBack", "add", "retryable"],
  ])("classifies %s as %s", (reason, kind, outcome) => {
    const code = GEOSERVICES_EDIT_ERROR_CODES[reason];
    const classified = classifyGeoServicesEditResult(
      { objectId: 7, success: false, error: { code, description: "" } },
      kind,
    );
    expect(classified).toEqual({ outcome, kind, featureId: "7", code, reason });
  });

  it("refuses an unpublished per-feature code instead of guessing whether it is retryable", async () => {
    const caught = await driftError("unknown-edit-code", (transport) => transport.applyEdits({ layerId: 0 }));
    expect(isHonuaReplicaSyncError(caught) && caught.code).toBe("response-drift");
    expect((caught as Error).message).toContain("error.code");
  });
});

describe("fail closed on dialect drift", () => {
  it("refuses an unknown conflict classification string", async () => {
    const caught = await driftError("conflict-classification", (transport) =>
      transport.listConflicts({ replicaId: ACTIVE_REPLICA_ID }),
    );
    expect(isHonuaReplicaSyncError(caught) && caught.code).toBe("response-drift");
    expect((caught as Error).message).toContain("conflictType");
    expect((caught as Error).message).toContain("topology");
  });

  it("refuses an unknown conflict classification ordinal on the sync response", async () => {
    const caught = await driftError("conflict-classification", (transport) =>
      transport.synchronizeReplica({ replicaId: ACTIVE_REPLICA_ID, direction: "upload", edits: [] }),
    );
    expect(isHonuaReplicaSyncError(caught) && caught.code).toBe("response-drift");
    expect((caught as Error).message).toContain("conflictType");
  });

  it("refuses an unknown conflict lifecycle status", async () => {
    const caught = await driftError("conflict-status", (transport) =>
      transport.listConflicts({ replicaId: ACTIVE_REPLICA_ID }),
    );
    expect(isHonuaReplicaSyncError(caught) && caught.code).toBe("response-drift");
    expect((caught as Error).message).toContain("quarantined");
  });

  it("refuses an unknown replica status", async () => {
    const caught = await driftError("replica-status", (transport) => transport.listReplicas());
    expect(isHonuaReplicaSyncError(caught) && caught.code).toBe("response-drift");
    expect((caught as Error).message).toContain("quiesced");
  });

  it("refuses an unknown resolution action", async () => {
    const caught = await driftError("resolution-action", (transport) => transport.getConflict(RESOLVED_CONFLICT_ID));
    expect(isHonuaReplicaSyncError(caught) && caught.code).toBe("response-drift");
    expect((caught as Error).message).toContain("resolutionAction");
  });

  it("refuses a generation cursor that cannot be read losslessly", async () => {
    // A 64-bit generation past 2^53 has already lost precision by the time it is
    // parsed; rounding it into a cursor would order edits wrongly.
    const caught = await driftError("unsafe-server-generation", (transport) =>
      transport.createReplica({ replicaName: "x", layers: [0] }),
    );
    expect(isHonuaReplicaSyncError(caught) && caught.code).toBe("response-drift");
    expect((caught as Error).message).toContain("safe integer range");
  });

  it("refuses an envelope with no data member", async () => {
    const caught = await driftError("missing-envelope-data", (transport) => transport.listReplicas());
    expect(isHonuaReplicaSyncError(caught) && caught.code).toBe("response-drift");
    expect((caught as Error).message).toContain("data");
  });
});

describe("credential discipline", () => {
  it("never places a credential on a request URL", async () => {
    const { server, transport } = await transportFor();
    await transport.listReplicas();
    await transport.getConflict(PENDING_CONFLICT_ID);
    expect(server.requests.length).toBeGreaterThan(0);
    for (const request of server.requests) {
      expect(request.url).not.toContain(API_KEY);
      expect(request.url).not.toContain("token=");
      expect(request.url).not.toContain("apiKey");
    }
  });

  it("carries no endpoint, token, or request URL into a projected conflict record", async () => {
    const { server, transport } = await transportFor();
    const detail = await transport.getConflict(PENDING_CONFLICT_ID);
    const serialized = JSON.stringify(detail);
    expect(serialized).not.toContain(API_KEY);
    expect(serialized).not.toContain(server.baseUrl);
    expect(serialized).not.toContain("http://");
    expect(serialized).not.toContain("Authorization");
  });

  it("screens a credential-shaped identifier out of the refusal it raises", async () => {
    const { transport } = await transportFor();
    let caught: unknown;
    try {
      await transport.getConflict("https://evil.example/callback?token=abc123");
    } catch (error) {
      caught = error;
    }
    expect(isHonuaReplicaSyncError(caught) && caught.code).toBe("conflict-not-found");
    expect((caught as Error).message).not.toContain("token=abc123");
    expect((caught as Error).message).toContain("withheld");
  });
});
