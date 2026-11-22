import { expect, it } from "vitest";

import {
  type CreateSceneEditProposalOptions,
  applySceneEditProposal,
  createSceneEditProposal,
} from "../src/scene-workspace/scene-edit-proposal.js";

const proposalOptions = {
  proposalId: "immutable",
  sourceId: "towers",
  featureId: 1,
  operation: "update",
  geometryKind: "point",
  verticalContext: { crs: "EPSG:4326", verticalDatum: "WGS84", altitudeReference: "ellipsoidal" },
  capabilities: {
    canEdit: true,
    supportsZ: true,
    supportedGeometryKinds: ["point"],
    supportedVerticalDatums: ["WGS84"],
    supportedAltitudeReferences: ["ellipsoidal"],
    authorizationScope: ["scene:edit"],
  },
} satisfies CreateSceneEditProposalOptions;

it("captures validated placements independently of caller-owned state", async () => {
  const before = { coordinates: [1, 2, 3] as [number, number, number] };
  const after = {
    coordinates: [4, 5, 6] as [number, number, number],
    orientation: [0, 0, 90] as [number, number, number],
    attributes: { nested: { label: "original" } },
  };
  const proposal = createSceneEditProposal({ ...proposalOptions, before, after });
  before.coordinates[2] = Number.NaN;
  after.coordinates[2] = Number.NaN;
  after.orientation[2] = 180;
  after.attributes.nested.label = "mutated";
  expect(proposal.status).toBe("ready");
  const receipt = await applySceneEditProposal({
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
  const detail = receipt.reconciliationIntents.find((intent) => intent.kind === "set-detail")?.detail;
  expect(detail).toMatchObject({ attributes: { nested: { label: "original" } } });
  if (detail?.status === "ready") {
    expect(detail.attributes).not.toBe(proposal.after?.attributes);
    expect(detail.attributes?.nested).not.toBe(proposal.after?.attributes?.nested);
  }
});

it.each(["before", "after"] as const)("rejects uncloneable %s placement attributes", (placement) => {
  const proposal = createSceneEditProposal({
    ...proposalOptions,
    [placement]: { coordinates: [1, 2, 3], attributes: { callback: () => "unsupported" } },
  });
  expect(proposal.status).toBe("rejected");
  expect(proposal[placement]).toBeUndefined();
  expect(proposal.diagnostics).toEqual([
    expect.objectContaining({ code: "scene-edit-placement-not-cloneable", severity: "error" }),
  ]);
});
