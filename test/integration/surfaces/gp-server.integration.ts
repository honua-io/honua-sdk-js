/**
 * GeoServices GPServer integration coverage.
 *
 * The Honua Server advertises GPServer routes, but the public
 * `HonuaClient` API does not expose a first-party
 * `client.geoprocessing(...)` entry point yet — `HonuaGeoprocessingService`
 * is registered for use by the canonical contract layer rather than as
 * a top-level client method like FeatureServer / MapServer have. The
 * integration lane scopes itself to public-API tests only, so this
 * file marks the surface as a documented gap until that dedicated
 * entry point lands. Track the gap in honua-sdk-js#39.
 *
 * @module
 */

import { expect, it } from "vitest";
import { skippedIntegrationSuite } from "../harness.js";

const REASON = "no first-party client.geoprocessing() entry point yet (tracked by honua-sdk-js#39)";

skippedIntegrationSuite("GPServer", "gp-server", REASON, () => {
  it.skip("submits a GPServer job when the public surface lands", () => {
    expect(true).toBe(true);
  });
});
