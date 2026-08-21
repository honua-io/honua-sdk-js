/**
 * GeoServices ImageServer integration coverage.
 *
 * Exercises the public `client.imageService(...)` entry point when the
 * target seed advertises a raster service. Most shared test seeds expose
 * vector services only, so the surface is recorded as skipped unless
 * `HONUA_INTEGRATION_IMAGE_SERVICE_ID` names a seeded ImageServer.
 *
 * @module
 */

import { expect, it } from "vitest";
import {
  integrationSuite,
  runWithDiagnostics,
  skippedIntegrationSuite,
  tryResolveIntegrationConfig,
} from "../harness.js";

const REASON = "HONUA_INTEGRATION_IMAGE_SERVICE_ID unset; seeded ImageServer required for live raster coverage";

const config = tryResolveIntegrationConfig();

if (config && !config.imageServiceId) {
  skippedIntegrationSuite("ImageServer", "image-server", REASON, () => {
    it.skip("reads ImageServer metadata when a seeded raster service is configured", () => {
      expect(true).toBe(true);
    });
  });
} else {
  integrationSuite("ImageServer", "image-server", ({ client, context, config }) => {
    const imageServiceId = config.imageServiceId ?? config.serviceId;
    const image = client.imageService(imageServiceId);

    it("returns ImageServer metadata [cert:imageserver/metadata#positive] [cert:imageserver/metadata#metadata] [cert:imageserver/metadata#media-schema]", async () => {
      await runWithDiagnostics(context, "client.imageService().metadata", async () => {
        const metadata = await image.metadata();
        expect(metadata).toBeDefined();
        expect(metadata.serviceDescription ?? imageServiceId).toBeTruthy();
      });
    });

    it("exports the seeded raster image [cert:imageserver/export-image#positive] [cert:imageserver/export-image#media-schema]", async () => {
      await runWithDiagnostics(context, "client.imageService().exportImage", async () => {
        const exported = await image.exportImage({
          bbox: [-122.5, 37.7, -122.35, 37.84],
          size: [256, 256],
          bboxSr: 4326,
          imageSr: 4326,
          format: "png",
        });
        expect(exported).toBeDefined();
        expect(exported.href).toBeTypeOf("string");
        expect(exported.href?.length).toBeGreaterThan(0);
        expect(exported.width).toBe(256);
        expect(exported.height).toBe(256);
        expect(exported.extent).toBeDefined();
        expect([
          exported.extent?.xmin,
          exported.extent?.ymin,
          exported.extent?.xmax,
          exported.extent?.ymax,
        ].every((coordinate) => typeof coordinate === "number" && Number.isFinite(coordinate))).toBe(true);

        const headers: Record<string, string> = {};
        if (config.apiKey) headers["X-API-Key"] = config.apiKey;
        if (config.bearerToken) headers.Authorization = `Bearer ${config.bearerToken}`;
        const targetUrl = new URL(config.baseUrl);
        const assetUrl = new URL(exported.href!, targetUrl);
        expect(["http:", "https:"]).toContain(assetUrl.protocol);
        expect(assetUrl.origin).toBe(targetUrl.origin);
        const assetResponse = await fetch(assetUrl, { headers, redirect: "error" });
        expect(assetResponse.ok).toBe(true);
        expect(assetResponse.headers.get("content-type")?.split(";", 1)[0]).toBe("image/png");

        const png = new Uint8Array(await assetResponse.arrayBuffer());
        expect(Array.from(png.subarray(0, 8))).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
        expect(png.length).toBeGreaterThanOrEqual(24);
        const header = new DataView(png.buffer, png.byteOffset, png.byteLength);
        expect(header.getUint32(16)).toBe(256);
        expect(header.getUint32(20)).toBe(256);
      });
    });
  });
}
