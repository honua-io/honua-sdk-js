import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { buildSdkCoverage } from "../../scripts/sdk-coverage.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const crosswalk = JSON.parse(fs.readFileSync(path.join(ROOT, "config/sdk-coverage-crosswalk.v1.json"), "utf8"));

test("package bumps preserve capability introduction versions", async () => {
  const current = await buildSdkCoverage();
  const bumped = await buildSdkCoverage({
    packageJson: { name: current.doc.sdk.package, version: "9.8.7-rc.3" },
  });

  assert.equal(bumped.doc.sdk.version, "9.8.7-rc.3");
  assert.deepEqual(bumped.doc.capabilities, current.doc.capabilities);
  assert.deepEqual(
    Object.fromEntries(bumped.doc.capabilities.map(({ key, sinceVersion }) => [key, sinceVersion])),
    crosswalk.introductionVersions,
  );
});

test("introduction versions are explicit and enforced per capability", async () => {
  const key = "ai.agent-operations";
  const customCrosswalk = structuredClone(crosswalk);
  customCrosswalk.introductionVersions[key] = "1.2.3";
  const custom = await buildSdkCoverage({ crosswalk: customCrosswalk });
  assert.equal(custom.doc.capabilities.find((capability) => capability.key === key)?.sinceVersion, "1.2.3");

  delete customCrosswalk.introductionVersions[key];
  await assert.rejects(
    buildSdkCoverage({ crosswalk: customCrosswalk }),
    new RegExp(`introductionVersions is missing a valid semver for ${key}`),
  );
});
