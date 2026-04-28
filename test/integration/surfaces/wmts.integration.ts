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
    const capabilities = await runWithDiagnostics(context, "client.wmts().capabilities", () => wmts.capabilities());
    expect(capabilities.layers.length).toBeGreaterThan(0);
    expect(capabilities.tileMatrixSets.length).toBeGreaterThan(0);
  });

  it("fetches a tile at zoom 0,0,0 when capabilities advertise a layer", async () => {
    const capabilities = await runWithDiagnostics(context, "client.wmts().capabilities", () => wmts.capabilities());
    const advertisedLayer = capabilities.layers.find((layer) => typeof layer.identifier === "string");
    if (!advertisedLayer?.identifier) {
      return;
    }
    const advertisedMatrixSet = advertisedLayer.tileMatrixSetIds[0] ?? capabilities.tileMatrixSets[0]?.identifier;
    if (!advertisedMatrixSet) {
      return;
    }
    const tile = await runWithDiagnostics(context, "client.wmts().tile", () =>
      wmts.tile({
        layer: advertisedLayer.identifier,
        tileMatrixSet: advertisedMatrixSet,
        tileMatrix: 0,
        tileRow: 0,
        tileCol: 0,
        format: "image/png",
        mode: "rest",
      }),
    );
    expect(tile.contentType.length).toBeGreaterThan(0);
    expect(tile.bytes).toBeInstanceOf(Uint8Array);
  });
});
