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

  it("reads service capabilities [cert:wms/capabilities#positive] [cert:wms/capabilities#metadata] [cert:wms/capabilities#media-schema]", async () => {
    await runWithDiagnostics(context, "client.wms().capabilities", async () => {
      const capabilities = await wms.capabilities();
      expect(capabilities.version.length).toBeGreaterThan(0);
      expect(capabilities.layers.length).toBeGreaterThan(0);
    });
  });

  it("renders a GetMap image for the first advertised layer [cert:wms/get-map#positive] [cert:wms/get-map#media-schema]", async ({ skip }) => {
    const capabilities = await runWithDiagnostics(context, "client.wms().capabilities", async () => {
      const r = await wms.capabilities();
      expect(r.version.length).toBeGreaterThan(0);
      return r;
    });
    const advertised = capabilities.layers.find((layer) => typeof layer.name === "string" && layer.name.length > 0);
    if (!advertised?.name) {
      skip(); // Server advertised only group layers.
      return;
    }
    await runWithDiagnostics(context, "client.wms().map", async () => {
      const image = await wms.map({
        layers: [advertised.name],
        bbox: [-180, -85, 180, 85],
        crs: "EPSG:4326",
        width: 256,
        height: 256,
        format: "image/png",
        transparent: true,
      });
      expect(image.contentType.startsWith("image/")).toBe(true);
      expect(image.bytes.byteLength).toBeGreaterThan(0);
    });
  });
});
