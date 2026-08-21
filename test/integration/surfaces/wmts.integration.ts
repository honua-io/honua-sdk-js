/**
 * WMTS 1.0 integration coverage. Reads capabilities first so tile
 * matrix sets and layer names come from the server, then fetches a
 * single tile at zoom 0 to keep the seed cost bounded.
 *
 * @module
 */

import { expect, it } from "vitest";
import { integrationSuite, runWithDiagnostics } from "../harness.js";

integrationSuite("WMTS", "wmts", ({ client, context, config }) => {
  const wmts = client.wmts(config.serviceId);

  it("reads service capabilities", async () => {
    await runWithDiagnostics(context, "client.wmts().capabilities", async () => {
      const capabilities = await wmts.capabilities();
      expect(capabilities.layers.length).toBeGreaterThan(0);
      expect(capabilities.tileMatrixSets.length).toBeGreaterThan(0);
    });
  });

  it("fetches a tile at zoom 0,0,0 when capabilities advertise a layer", async () => {
    const capabilities = await runWithDiagnostics(context, "client.wmts().capabilities", async () => {
      const r = await wmts.capabilities();
      expect(r.layers.length).toBeGreaterThan(0);
      return r;
    });
    const advertisedLayer = capabilities.layers.find((layer) => typeof layer.identifier === "string");
    if (!advertisedLayer?.identifier) {
      throw new Error("WMTS capabilities did not advertise a layer with a usable identifier");
    }
    const advertisedMatrixSet = advertisedLayer.tileMatrixSetIds[0] ?? capabilities.tileMatrixSets[0]?.identifier;
    if (!advertisedMatrixSet) {
      throw new Error("WMTS capabilities did not advertise a usable tile matrix set");
    }
    await runWithDiagnostics(context, "client.wmts().tile", async () => {
      const tile = await wmts.tile({
        layer: advertisedLayer.identifier,
        tileMatrixSet: advertisedMatrixSet,
        tileMatrix: 0,
        tileRow: 0,
        tileCol: 0,
        format: "image/png",
        mode: "rest",
      });
      expect(tile.contentType.length).toBeGreaterThan(0);
      expect(tile.bytes).toBeInstanceOf(Uint8Array);
    });
  });
});
