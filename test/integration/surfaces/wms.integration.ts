/**
 * WMS 1.3 integration coverage. Reads capabilities first so the test
 * can pick a layer name that the server actually advertises rather than
 * hard-coding one from the seed catalog.
 *
 * @module
 */

import { expect, it } from "vitest";
import { integrationSuite, runWithDiagnostics } from "../harness.js";

integrationSuite("WMS", "wms", ({ client, context, config }) => {
  const wms = client.wms(config.serviceId);

  it("reads service capabilities", async () => {
    const capabilities = await runWithDiagnostics(context, "client.wms().capabilities", () => wms.capabilities());
    expect(capabilities.version.length).toBeGreaterThan(0);
    expect(capabilities.layers.length).toBeGreaterThan(0);
  });

  it("renders a GetMap image for the first advertised layer", async () => {
    const capabilities = await runWithDiagnostics(context, "client.wms().capabilities", () => wms.capabilities());
    const advertised = capabilities.layers.find((layer) => typeof layer.name === "string" && layer.name.length > 0);
    if (!advertised?.name) {
      return; // Server advertised only group layers — skip render.
    }
    const image = await runWithDiagnostics(context, "client.wms().map", () =>
      wms.map({
        layers: [advertised.name],
        bbox: [-180, -85, 180, 85],
        crs: "EPSG:4326",
        width: 256,
        height: 256,
        format: "image/png",
        transparent: true,
      }),
    );
    expect(image.contentType.startsWith("image/")).toBe(true);
    expect(image.bytes.byteLength).toBeGreaterThan(0);
  });
});
