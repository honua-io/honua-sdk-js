import { describe, expect, it } from "vitest";

import {
  createKeplerWorkspaceBridge,
  loadKeplerProcessors,
  projectArrowTableToKeplerDataset,
} from "../src/kepler/index.js";
import type { KeplerPeers, KeplerProcessors } from "../src/kepler/index.js";

const provenance = { sourceId: "arrow-source", planId: "plan-1", authorizationScope: "scope:public" } as const;
const peers: KeplerPeers = { version: "3.2.6", addDataToMap: (payload) => ({ type: "add", payload }) };
const processors: KeplerProcessors = {
  version: "3.2.6",
  processArrowTable: () => ({
    fields: [
      { name: "objectid", type: "integer" },
      { name: "observed_at", type: "timestamp" },
      { name: "value", type: "real" },
    ],
    rows: [
      [1, "2026-07-29T00:00:00.000Z", 4.5],
      [2, "2026-07-29T01:00:00.000Z", 5.25],
    ],
  }),
};

describe("Kepler Arrow processor bridge", () => {
  it("projects a processor result without GeoJSON and carries provenance", () => {
    const projection = projectArrowTableToKeplerDataset(
      { datasetId: "readings", arrowTable: { opaque: true }, provenance, rowIdentityField: "objectid" },
      processors,
    );

    expect(projection.diagnostic).toMatchObject({
      strategy: "arrow-table-processor",
      geoJsonRoundTrip: false,
      geoJsonBytes: 0,
      fidelity: "exact",
      rows: 2,
    });
    expect(projection.dataset.metadata.provenance).toMatchObject(provenance);
    expect(projection.dataset.data.rows[0]).toEqual([1, Date.parse("2026-07-29T00:00:00.000Z"), 4.5]);
  });

  it("keeps Arrow processing optional and fails clearly when not configured", () => {
    const bridge = createKeplerWorkspaceBridge({ peers });
    expect(() => bridge.openArrowTable({ datasetId: "readings", arrowTable: {}, provenance })).toThrowError(
      /@kepler\.gl\/processors/,
    );
  });

  it("rejects malformed processor rows before opening a workspace dataset", () => {
    const malformed: KeplerProcessors = {
      version: "3.2.6",
      processArrowTable: () => ({ fields: [{ name: "id", type: "integer" }], rows: [[]] }),
    };
    expect(() =>
      projectArrowTableToKeplerDataset({ datasetId: "bad", arrowTable: {}, provenance }, malformed),
    ).toThrowError(/malformed row/);
  });

  it("loads processArrowTable dynamically and reports missing exports", async () => {
    const loaded = await loadKeplerProcessors({
      version: "3.2.6",
      importModule: async () => ({ processArrowTable: processors.processArrowTable }),
    });
    expect(loaded.version).toBe("3.2.6");
    await expect(loadKeplerProcessors({ version: "3.2.6", importModule: async () => ({}) })).rejects.toThrowError(
      /processArrowTable/,
    );
  });
});
