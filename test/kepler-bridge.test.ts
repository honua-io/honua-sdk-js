import { describe, expect, it, vi } from "vitest";

import { createExplorationContext } from "../src/exploration/context.js";
import {
  type HonuaKeplerBridgeError,
  KEPLER_BRIDGE_CONTRACT_VERSION,
  KEPLER_COMPATIBILITY_RANGE,
  type KeplerAction,
  type KeplerPeers,
  type KeplerResultProjectionRequest,
  assertKeplerCompatibility,
  createKeplerWorkspaceBridge,
  evaluateKeplerCompatibility,
  loadKeplerPeers,
} from "../src/kepler/index.js";

const provenance = {
  sourceId: "incidents",
  schemaVersion: "schema-1",
  planId: "plan-1",
  authorizationScope: "scope:public-read",
} as const;

function peers(overrides: Partial<KeplerPeers> = {}): KeplerPeers {
  return {
    version: "3.2.6",
    addDataToMap: (payload) => ({ type: "@@kepler.gl/ADD_DATA_TO_MAP", payload }) as KeplerAction,
    removeDataset: (datasetId) => ({ type: "@@kepler.gl/REMOVE_DATASET", datasetId }) as KeplerAction,
    wrapTo: (instanceId, action) => ({ type: "@@kepler.gl/WRAP", instanceId, action }) as KeplerAction,
    ...overrides,
  };
}

function resultRequest(overrides: Partial<KeplerResultProjectionRequest> = {}): KeplerResultProjectionRequest {
  return {
    datasetId: "incidents",
    provenance,
    rowIdentityField: "objectid",
    result: {
      features: [
        { attributes: { objectid: 1, status: "open" }, geometry: { x: -122.4, y: 37.8 } },
        { attributes: { objectid: 2, status: "closed" }, geometry: { x: -122.5, y: 37.9 } },
      ],
      fields: [
        { name: "objectid", type: "esriFieldTypeOID" },
        { name: "status", type: "esriFieldTypeString" },
      ],
      exceededTransferLimit: false,
    },
    ...overrides,
  };
}

describe("kepler compatibility range", () => {
  it("declares the supported Kepler 3.x range", () => {
    expect(KEPLER_COMPATIBILITY_RANGE).toEqual({ minimum: "3.0.0", exclusiveMaximum: "4.0.0" });
  });

  it("accepts in-range versions and rejects out-of-range ones", () => {
    expect(evaluateKeplerCompatibility("3.2.6").supported).toBe(true);
    expect(evaluateKeplerCompatibility("3.0.0").supported).toBe(true);
    expect(evaluateKeplerCompatibility("2.5.5").supported).toBe(false);
    expect(evaluateKeplerCompatibility("4.0.0").supported).toBe(false);
    expect(evaluateKeplerCompatibility("not-a-version").supported).toBe(false);
  });

  it("throws with an actionable reason when asserted", () => {
    expect(() => assertKeplerCompatibility("4.1.0")).toThrowError(/outside the supported range/);
  });
});

describe("loadKeplerPeers", () => {
  it("resolves @kepler.gl/actions through an injected dynamic importer", async () => {
    const importModule = vi.fn().mockResolvedValue({
      addDataToMap: () => ({ type: "add" }),
      wrapTo: () => ({ type: "wrap" }),
      unrelated: 42,
    });

    const resolved = await loadKeplerPeers({ version: "3.2.6", importModule });

    expect(importModule).toHaveBeenCalledWith("@kepler.gl/actions");
    expect(typeof resolved.addDataToMap).toBe("function");
    expect(typeof resolved.wrapTo).toBe("function");
    expect(resolved.replaceDataInMap).toBeUndefined();
    expect(resolved.version).toBe("3.2.6");
  });

  it("reports a missing optional peer instead of failing opaquely", async () => {
    const importModule = vi.fn().mockRejectedValue(new Error("Cannot find module"));

    await expect(loadKeplerPeers({ version: "3.2.6", importModule })).rejects.toThrowError(
      /requires the optional peer "@kepler.gl\/actions"/,
    );
  });

  it("rejects an unsupported Kepler version before touching the peer", async () => {
    const importModule = vi.fn();

    await expect(loadKeplerPeers({ version: "2.0.0", importModule })).rejects.toThrowError(
      /outside the supported range/,
    );
    expect(importModule).not.toHaveBeenCalled();
  });

  it("reports a module without addDataToMap", async () => {
    await expect(loadKeplerPeers({ version: "3.2.6", importModule: async () => ({}) })).rejects.toThrowError(
      /does not export addDataToMap/,
    );
  });
});

describe("createKeplerWorkspaceBridge", () => {
  it("opens a bounded result through the reusable API and returns the addDataToMap payload", () => {
    const bridge = createKeplerWorkspaceBridge({ peers: peers() });
    const opened = bridge.openResult(resultRequest());

    expect(bridge.contractVersion).toBe(KEPLER_BRIDGE_CONTRACT_VERSION);
    expect(opened.dispatched).toBe(false);
    expect(opened.projection.diagnostic.geoJsonBytes).toBe(0);
    expect(opened.addDataToMapPayload).toEqual({
      datasets: [opened.projection.dataset],
      options: { centerMap: false, readOnly: false },
    });
    expect(bridge.datasetIds).toEqual(["incidents"]);
    expect(bridge.metrics.rows).toBe(2);
  });

  it("dispatches through an attached host, wrapping for the Kepler instance id", () => {
    const dispatched: KeplerAction[] = [];
    const bridge = createKeplerWorkspaceBridge({
      peers: peers(),
      host: { dispatch: (action) => dispatched.push(action), instanceId: "ops-replay" },
    });

    const opened = bridge.openResult(resultRequest());

    expect(opened.dispatched).toBe(true);
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]).toMatchObject({ type: "@@kepler.gl/WRAP", instanceId: "ops-replay" });
  });

  it("refuses to re-open the same dataset id", () => {
    const bridge = createKeplerWorkspaceBridge({ peers: peers() });
    bridge.openResult(resultRequest());

    expect(() => bridge.openResult(resultRequest())).toThrowError(/is already open/);
  });

  it("enforces the workspace dataset budget", () => {
    const bridge = createKeplerWorkspaceBridge({ peers: peers(), limits: { maxDatasets: 1 } });
    bridge.openResult(resultRequest());

    expect(() => bridge.openResult(resultRequest({ datasetId: "second" }))).toThrowError(/at most 1 datasets/);
  });

  it("advances tracked state across a bounded delta and materializes it for a re-dispatch", () => {
    const bridge = createKeplerWorkspaceBridge({ peers: peers() });
    bridge.openResult(resultRequest());

    const plan = bridge.reconcile("incidents", {
      type: "delta",
      upserts: [{ id: 3, attributes: { objectid: 3, status: "new" }, geometry: { x: -122.6, y: 38 } }],
      cursor: "cursor-2",
    });

    expect(plan.diagnostic.mode).toBe("bounded-delta");
    expect(bridge.datasetState("incidents").rows).toHaveLength(3);
    expect(bridge.datasetState("incidents").cursor).toBe("cursor-2");
    expect(bridge.materializeDataset("incidents").data.rows).toHaveLength(3);
    expect(bridge.materializeDataset("incidents").metadata.provenance.planId).toBe("plan-1");
  });

  it("does not advance tracked state when a rebuild is required", () => {
    const bridge = createKeplerWorkspaceBridge({ peers: peers() });
    bridge.openResult(resultRequest());

    const plan = bridge.reconcile("incidents", {
      type: "delta",
      upserts: [{ id: 3, attributes: { objectid: 3, status: "new" } }],
      planId: "plan-2",
    });

    expect(plan.diagnostic.mode).toBe("rebuild-required");
    expect(plan.diagnostic.rebuildReason).toBe("plan-identity-changed");
    expect(bridge.datasetState("incidents").rows).toHaveLength(2);
  });

  it("rejects operations against an unknown dataset", () => {
    const bridge = createKeplerWorkspaceBridge({ peers: peers() });

    try {
      bridge.datasetState("missing");
      throw new Error("expected an unknown-dataset rejection");
    } catch (error) {
      expect((error as HonuaKeplerBridgeError).code).toBe("unknown-dataset");
    }
  });

  it("closes a dataset and tells an attached host to remove it", () => {
    const dispatched: KeplerAction[] = [];
    const bridge = createKeplerWorkspaceBridge({
      peers: peers({ wrapTo: undefined }),
      host: { dispatch: (action) => dispatched.push(action) },
    });
    bridge.openResult(resultRequest());
    bridge.close("incidents");

    expect(bridge.datasetIds).toEqual([]);
    expect(dispatched.at(-1)).toEqual({ type: "@@kepler.gl/REMOVE_DATASET", datasetId: "incidents" });
  });

  it("links shared exploration state using the open dataset's source id", () => {
    const bridge = createKeplerWorkspaceBridge({ peers: peers() });
    bridge.openResult(resultRequest());
    const context = createExplorationContext({ datasetId: "ops", sourceIds: ["incidents"] });
    const sync = bridge.linkState({
      view: context.connectView({ id: "kepler", role: "map" }),
      datasetId: "incidents",
      viewportSize: { width: 800, height: 600 },
      applyToKepler: () => undefined,
    });

    sync.receiveSelection(1);

    expect(context.state.selection).toEqual([{ sourceId: "incidents", id: 1 }]);
  });

  it("redacts exported Kepler state by default", () => {
    const bridge = createKeplerWorkspaceBridge({ peers: peers() });

    const result = bridge.exportState({
      config: { mapStyle: { mapStyles: { custom: { accessToken: "pk.eyJhIjoiZXhhbXBsZSJ9" } } } },
    });

    expect(result.redacted).toBe(true);
    expect(result.redactions[0].path).toBe("config.mapStyle.mapStyles.custom.accessToken");
  });

  it("disposes linked state and releases retained rows", () => {
    const bridge = createKeplerWorkspaceBridge({ peers: peers() });
    bridge.openResult(resultRequest());
    const context = createExplorationContext({ datasetId: "ops", sourceIds: ["incidents"] });
    const sync = bridge.linkState({
      view: context.connectView({ id: "kepler", role: "map" }),
      sourceId: "incidents",
      applyToKepler: () => undefined,
    });

    bridge.dispose();

    expect(bridge.disposed).toBe(true);
    expect(sync.disposed).toBe(true);
    expect(bridge.metrics).toEqual({ datasets: 0, rows: 0, estimatedRowBytes: 0 });
    expect(() => bridge.openResult(resultRequest())).toThrowError(/is disposed/);
  });

  it("requires peers with addDataToMap", () => {
    expect(() => createKeplerWorkspaceBridge({ peers: {} as KeplerPeers })).toThrowError(/requires KeplerPeers/);
  });
});
