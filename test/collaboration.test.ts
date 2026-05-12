import { describe, expect, it, vi } from "vitest";

import {
  HonuaCollaborationError,
  createFixtureSavedMapCollaborationTransport,
  createHonuaSavedMapCollaboration,
} from "../src/collaboration/index.js";

describe("saved-map collaboration client", () => {
  it("fans out same-map session snapshots through the fixture transport", async () => {
    const transport = createFixtureSavedMapCollaborationTransport({
      now: () => new Date("2026-05-11T10:00:00.000Z"),
    });
    const client = createHonuaSavedMapCollaboration({ transport });
    const sessionA = await client.joinSavedMap({ mapId: "map-ops", participantId: "alice", displayName: "Alice" });
    const listenerA = vi.fn();
    sessionA.subscribe(listenerA);

    const sessionB = await client.joinSavedMap({ mapId: "map-ops", participantId: "bob", displayName: "Bob" });

    expect(sessionA.snapshot.participants.map((participant) => participant.id)).toEqual(["alice", "bob"]);
    expect(sessionB.snapshot.participants.map((participant) => participant.id)).toEqual(["alice", "bob"]);
    expect(listenerA).toHaveBeenCalledWith(
      expect.objectContaining({
        participants: expect.arrayContaining([expect.objectContaining({ id: "bob" })]),
      }),
      expect.objectContaining({ event: expect.objectContaining({ type: "participant-joined" }) }),
    );
  });

  it("publishes cursor and selection updates to collaborators", async () => {
    const client = createHonuaSavedMapCollaboration({
      transport: createFixtureSavedMapCollaborationTransport({
        now: () => new Date("2026-05-11T10:00:00.000Z"),
      }),
    });
    const alice = await client.joinSavedMap({ mapId: "map-ops", participantId: "alice" });
    const bob = await client.joinSavedMap({ mapId: "map-ops", participantId: "bob" });

    await alice.publishCursor({ x: 10, y: 20, sourceId: "parcels" });
    await bob.publishSelection({ ids: [7], sourceId: "parcels", mode: "replace" });

    expect(bob.snapshot.cursors.alice).toMatchObject({ x: 10, y: 20, sourceId: "parcels" });
    expect(alice.snapshot.selections.bob).toMatchObject({ ids: [7], sourceId: "parcels" });
  });

  it("returns typed feature lock conflicts and supports release/renew", async () => {
    const client = createHonuaSavedMapCollaboration({
      transport: createFixtureSavedMapCollaborationTransport({
        now: () => new Date("2026-05-11T10:00:00.000Z"),
      }),
    });
    const alice = await client.joinSavedMap({ mapId: "map-ops", participantId: "alice" });
    const bob = await client.joinSavedMap({ mapId: "map-ops", participantId: "bob" });

    const lock = await alice.claimFeatureLock({ sourceId: "parcels", featureId: "parcel-1", ttlMs: 30_000 });
    await expect(bob.claimFeatureLock({ sourceId: "parcels", featureId: "parcel-1" })).rejects.toMatchObject({
      code: "lock-held",
    });

    const renewed = await alice.renewFeatureLock({
      sourceId: "parcels",
      featureId: "parcel-1",
      token: lock.token,
      ttlMs: 60_000,
    });
    expect(renewed.expiresAt).toBe("2026-05-11T10:01:00.000Z");

    await alice.releaseFeatureLock({ sourceId: "parcels", featureId: "parcel-1", token: lock.token });
    const bobLock = await bob.claimFeatureLock({ sourceId: "parcels", featureId: "parcel-1" });
    expect(bobLock.ownerId).toBe("bob");
  });

  it("appends saved-map edit operations and replays from cursors", async () => {
    const client = createHonuaSavedMapCollaboration({
      transport: createFixtureSavedMapCollaborationTransport({
        now: () => new Date("2026-05-11T10:00:00.000Z"),
      }),
    });
    const alice = await client.joinSavedMap({ mapId: "map-ops", participantId: "alice" });
    const bob = await client.joinSavedMap({ mapId: "map-ops", participantId: "bob" });

    const first = await alice.submitOperation({
      expectedRevision: 0,
      operation: {
        kind: "update",
        target: { sourceId: "parcels", featureId: "parcel-1" },
        payload: { attributes: { status: "reviewed" } },
      },
    });
    const second = await bob.submitOperation({
      expectedRevision: 1,
      operation: {
        kind: "metadata",
        payload: { title: "Updated operations map" },
      },
    });

    expect(bob.snapshot.operations.map((operation) => operation.id)).toEqual([first.id, second.id]);
    await expect(
      bob.submitOperation({
        expectedRevision: 0,
        operation: { kind: "view", payload: { zoom: 12 } },
      }),
    ).rejects.toMatchObject({ code: "conflict" });

    const replay = await alice.replayOperations({ afterCursor: first.cursor });
    expect(replay.operations.map((operation) => operation.id)).toEqual([second.id]);
  });

  it("reconnects deterministically by replaying operations from the last cursor", async () => {
    const client = createHonuaSavedMapCollaboration({
      transport: createFixtureSavedMapCollaborationTransport({
        now: () => new Date("2026-05-11T10:00:00.000Z"),
      }),
    });
    const alice = await client.joinSavedMap({ mapId: "map-ops", participantId: "alice" });
    const bob = await client.joinSavedMap({ mapId: "map-ops", participantId: "bob" });
    const listener = vi.fn();
    alice.subscribe(listener);

    alice.disconnect();
    expect(alice.snapshot.status).toBe("stale");

    const operation = await bob.submitOperation({
      expectedRevision: 0,
      operation: {
        kind: "style",
        payload: { layerId: "incidents", paint: { "circle-color": "#e11d48" } },
      },
    });

    expect(alice.snapshot.operations).toHaveLength(0);

    const replay = await alice.reconnect();

    expect(replay?.operations.map((candidate) => candidate.id)).toEqual([operation.id]);
    expect(alice.snapshot.status).toBe("live");
    expect(alice.snapshot.operations.map((candidate) => candidate.id)).toEqual([operation.id]);
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ status: "reconnecting" }), undefined);
  });

  it("surfaces deterministic resync and stale cursor errors", async () => {
    const transport = createFixtureSavedMapCollaborationTransport({
      now: () => new Date("2026-05-11T10:00:00.000Z"),
    });
    const client = createHonuaSavedMapCollaboration({ transport });
    const alice = await client.joinSavedMap({ mapId: "map-ops", participantId: "alice" });
    const listener = vi.fn();
    alice.subscribe(listener);

    transport.markResyncRequired("map-ops", "Server pruned the collaboration backlog.");

    expect(alice.snapshot.status).toBe("error");
    expect(alice.snapshot.error).toMatchObject({
      code: "resync-required",
      resyncRequired: true,
    });
    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({ status: "error" }),
      expect.objectContaining({ event: expect.objectContaining({ type: "error" }) }),
    );
    await expect(alice.replayOperations({ afterSequence: 0 })).rejects.toBeInstanceOf(HonuaCollaborationError);
    await expect(alice.replayOperations({ afterCursor: "fixture:999" })).rejects.toMatchObject({
      code: "resync-required",
    });
  });
});
