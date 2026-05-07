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

    it("returns ImageServer metadata", async () => {
      await runWithDiagnostics(context, "client.imageService().metadata", async () => {
        const metadata = await image.metadata();
        expect(metadata).toBeDefined();
        expect(metadata.serviceDescription ?? imageServiceId).toBeTruthy();
      });
    });
  });
}
