/**
 * WFS 2.0 integration coverage. Exercises the public `client.wfs(...)`
 * adapter when the target seed publishes a WFS endpoint and feature type.
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

const REASON =
  "HONUA_INTEGRATION_WFS_ENDPOINT_URL or HONUA_INTEGRATION_WFS_TYPE_NAME unset; seeded WFS feature type required";

const config = tryResolveIntegrationConfig();

if (config && (!config.wfsEndpointUrl || !config.wfsTypeName)) {
  skippedIntegrationSuite("WFS", "wfs", REASON, () => {
    it.skip("reads WFS capabilities and fetches a feature page when a feature type is configured", () => {
      expect(true).toBe(true);
    });
  });
} else {
  integrationSuite("WFS", "wfs", ({ client, context, config }) => {
    const endpointUrl = config.wfsEndpointUrl ?? "/wfs";
    const typeName = config.wfsTypeName ?? config.collectionId;
    const wfs = client.wfs(endpointUrl);

    it("returns WFS capabilities for the configured endpoint [cert:wfs/capabilities#positive] [cert:wfs/capabilities#metadata] [cert:wfs/capabilities#media-schema]", async () => {
      await runWithDiagnostics(context, "client.wfs().capabilities", async () => {
        const capabilities = await wfs.capabilities();
        expect(Array.isArray(capabilities.featureTypes)).toBe(true);
        expect(capabilities.featureTypes.map((entry) => entry.name)).toContain(typeName);
      });
    });

    it("fetches a bounded WFS feature page [cert:wfs/get-feature#positive] [cert:wfs/get-feature#media-schema]", async () => {
      await runWithDiagnostics(context, "client.wfs().featureType().getFeature", async () => {
        const result = await wfs.featureType(typeName).getFeature({ count: 1 });
        expect(result.kind).toMatch(/json|raw/);
      });
    });
  });
}
