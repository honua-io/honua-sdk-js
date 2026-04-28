/**
 * GeoServices ImageServer integration coverage.
 *
 * The Honua Server exposes an ImageServer surface, but the public
 * `HonuaClient` API surfaces ImageServer through the lower-level
 * `client.request(...)` escape hatch and the
 * `HonuaImageService` runtime helper rather than through a first-party
 * `client.imageService(...)` method like FeatureServer / MapServer
 * have. The integration lane scopes itself to public-API tests only,
 * so this file marks the surface as a documented gap until that
 * dedicated entry point lands. Track the gap in honua-sdk-js#39.
 *
 * @module
 */

import { expect, it } from "vitest";
import { skippedIntegrationSuite } from "../harness.js";

const REASON = "no first-party client.imageService() entry point yet (tracked by honua-sdk-js#39)";

skippedIntegrationSuite("ImageServer", "image-server", REASON, () => {
  it.skip("renders an ImageServer export when the public surface lands", () => {
    expect(true).toBe(true);
  });
});
