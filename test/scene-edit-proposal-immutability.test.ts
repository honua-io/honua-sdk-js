import { expect, it } from "vitest";

import { applySceneEditProposal, createSceneEditProposal } from "../src/scene-workspace/scene-edit-proposal.js";

it("captures validated placements independently of caller-owned state", async () => {
  const before = { coordinates: [1, 2, 3] as [number, number, number] };
  const after = {
    coordinates: [4, 5, 6] as [number, number, number],
    orientation: [0, 0, 90] as [number, number, number],
    attributes: { nested: { label: "original" } },
  };
  const proposal = createSceneEditProposal({
    proposalId: "immutable",
    sourceId: "towers",
    featureId: 1,
    operation: "update",
    geometryKind: "point",
    before,
    after,
    verticalContext: { crs: "EPSG:4326", verticalDatum: "WGS84", altitudeReference: "ellipsoidal" },
    capabilities: {
      canEdit: true,
      supportsZ: true,
      supportedGeometryKinds: ["point"],
      supportedVerticalDatums: ["WGS84"],
      supportedAltitudeReferences: ["ellipsoidal"],
      authorizationScope: ["scene:edit"],
    },
  });
  before.coordinates[2] = Number.NaN;
  after.coordinates[2] = Number.NaN;
  after.orientation[2] = 180;
  after.attributes.nested.label = "mutated";
  expect(proposal.status).toBe("ready");
  await applySceneEditProposal({
    proposal,
    execute: async (captured) => {
      expect(captured.before?.coordinates).toEqual([1, 2, 3]);
      expect(captured.after?.coordinates).toEqual([4, 5, 6]);
      expect(captured.after?.orientation).toEqual([0, 0, 90]);
      expect(captured.after?.attributes).toEqual({ nested: { label: "original" } });
      expect(Object.isFrozen(captured.after?.coordinates)).toBe(true);
      return { receiptId: "saved" };
    },
  });
});
