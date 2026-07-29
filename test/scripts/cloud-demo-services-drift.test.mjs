import assert from "node:assert/strict";
import test from "node:test";

import {
  checkCloudDemoManifestDrift,
  compareManifestBytes,
} from "../../scripts/check-cloud-demo-services-drift.mjs";

test("cloud demo manifest drift check compares response bytes exactly", async () => {
  const responseBytes = Buffer.from('{"format":"demo-services.v1"}\n');
  const result = await checkCloudDemoManifestDrift({
    manifestUrl: "https://demo.example.test/demo-services.v1.json",
    vendoredPath: new URL("../../examples/cloud-demo-services.json", import.meta.url),
    fetchImpl: async () =>
      new Response(responseBytes, {
        status: 200,
      }),
  }).catch((error) => error);

  assert.match(result.message, /differs from the published manifest/u);
});

test("cloud demo manifest drift check rejects missing configuration", async () => {
  await assert.rejects(
    checkCloudDemoManifestDrift({}),
    /HONUA_CLOUD_DEMO_MANIFEST_URL is required/u,
  );
});

test("cloud demo manifest drift check rejects non-HTTPS URLs", async () => {
  await assert.rejects(
    checkCloudDemoManifestDrift({ manifestUrl: "http://demo.example.test/demo-services.v1.json" }),
    /must use HTTPS/u,
  );
});

test("byte comparison accepts an exact vendored copy", () => {
  assert.doesNotThrow(() => compareManifestBytes(Buffer.from("manifest\n"), Buffer.from("manifest\n")));
});
