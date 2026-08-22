/**
 * OData v4 integration coverage. Exercises the public
 * `client.odata(...)` entity-set adapter against the configured
 * layer-scoped entity path.
 *
 * @module
 */

import { expect, it } from "vitest";
import { integrationSuite, runWithDiagnostics } from "../harness.js";

integrationSuite("OData", "odata", ({ client, context, config }) => {
  const entitySet = client.odata(config.odataEntitySet, { basePath: config.odataBasePath });

  it("reads OData metadata for the configured service root [cert:odata/metadata#positive] [cert:odata/metadata#metadata] [cert:odata/metadata#media-schema]", async () => {
    await runWithDiagnostics(context, "client.odata().metadata", async () => {
      const metadata = await entitySet.metadata();
      expect(metadata).toBeDefined();
      expect(Object.keys(metadata.entitySets).length).toBeGreaterThan(0);
    });
  });

  it("queries a bounded OData entity page [cert:odata/entity-page#positive] [cert:odata/entity-page#pagination] [cert:odata/entity-page#media-schema]", async () => {
    await runWithDiagnostics(context, "client.odata().query", async () => {
      const page = await entitySet.query({ top: 1, count: true });
      expect(Array.isArray(page.rows)).toBe(true);
    });
  });
});
