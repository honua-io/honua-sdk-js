import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { inspectSampleConfiguration, validateCatalog } from "../scripts/sample-contract.mjs";

vi.setConfig({ testTimeout: 40_000 });
const readJson = async (path: string) => JSON.parse(await readFile(path, "utf8"));
function nextMinorTarget(version: string) {
  const [major, minor] = version.split(".");
  return `${major}.${Number(minor) + 1}.0`;
}

const lookAheadDays = Number.parseFloat(process.env.HONUA_SAMPLE_CONTRACT_LOOKAHEAD_DAYS ?? "0");
if (!Number.isFinite(lookAheadDays) || lookAheadDays < 0) {
  throw new Error(
    `HONUA_SAMPLE_CONTRACT_LOOKAHEAD_DAYS must be a non-negative number of days, received "${process.env.HONUA_SAMPLE_CONTRACT_LOOKAHEAD_DAYS}"`,
  );
}
const realTimeNow = new Date().toISOString();
const validationTime = {
  now: new Date(Date.parse(realTimeNow) + lookAheadDays * 24 * 60 * 60 * 1000).toISOString(),
  evidenceCurrencyNow: realTimeNow,
};

const browserPublicCredentialFixtureId = "browser-public-credential";
const browserPublicCredentialSource = "test/fixtures/sample-contract/browser-public-credential";

const browserPublicCredentialData = {
  mode: "fixture",
  authMode: "none",
  configurationStatus: "legacy-unsafe",
  configurationGap: "The named browser credential is still exposed to the page and has no approved replacement.",
  config: ["VITE_CLIENT_SECRET"],
  configClassifications: [
    {
      name: "VITE_CLIENT_SECRET",
      exposure: "browser-public",
      valueKind: "credential",
      credentialScope: "secret",
    },
  ],
  provenance: "Synthetic source fixture that reads one named environment key.",
  attribution: "Honua sample-contract fixture.",
  freshness: "Versioned with the repository.",
};

function browserPublicCredentialSample(version: string) {
  return {
    id: browserPublicCredentialFixtureId,
    title: "Browser-public credential fixture",
    summary: "Declares one named browser-public credential and reads only that environment key.",
    sourceKind: "root-example",
    track: "fixture",
    supportTier: "internal",
    lifecycle: {
      state: "rework",
      reason: "Named browser-public credential remains on a bounded rework lifecycle.",
      targetRelease: nextMinorTarget(version),
    },
    sourcePath: browserPublicCredentialSource,
    docsPath: `${browserPublicCredentialSource}/README.md`,
    capabilities: ["analysis"],
    capabilityKeys: [],
    protocols: ["geoservices"],
    renderers: ["maplibre"],
    data: browserPublicCredentialData,
    evidence: {
      fixture: { mode: "fixture", status: "planned", commands: [] },
      live: { mode: "unavailable", status: "not-applicable", commands: [] },
    },
    expectedDegradation: "The credential stays unavailable and the sample cannot be approved.",
    validationProfile: "internal-fixture",
    validation: ["npx vitest run test/sample-contract-browser-credential.test.ts"],
  };
}

async function catalogWithBrowserPublicCredential(version: string) {
  const catalog = await readJson("samples/catalog.v2.json");
  catalog.samples.push(browserPublicCredentialSample(version));
  catalog.samples.sort((left: { id: string }, right: { id: string }) => left.id.localeCompare(right.id));
  return catalog;
}

describe("synthetic browser-public credential contract", () => {
  it("reaches the browser-public credential rule from a named-key fixture", async () => {
    const packageJson = await readJson("package.json");
    await expect(inspectSampleConfiguration(browserPublicCredentialSource)).resolves.toEqual({
      names: ["VITE_CLIENT_SECRET"],
      wholeEnvironmentEscapes: [],
    });

    const legacyCatalog = await catalogWithBrowserPublicCredential(String(packageJson.version));
    const fixtureOptions = {
      ...validationTime,
      syntheticConfigurationFixtures: [browserPublicCredentialFixtureId],
      // Receipt checkout measures the worktree, not this fixture. The credential
      // rule is what this test has to prove.
      verifyCheckout: false,
    };
    await expect(validateCatalog(legacyCatalog, packageJson, validationTime)).rejects.toThrow(
      "browser-public-credential: sourceKind does not match sourcePath",
    );
    await expect(validateCatalog(legacyCatalog, packageJson, fixtureOptions)).resolves.toBeUndefined();

    const approved = structuredClone(legacyCatalog);
    const approvedSample = approved.samples.find(
      (sample: { id: string }) => sample.id === browserPublicCredentialFixtureId,
    );
    approvedSample.data.configurationStatus = "approved";
    delete approvedSample.data.configurationGap;
    await expect(validateCatalog(approved, packageJson, fixtureOptions)).rejects.toThrow(
      "browser-public-credential: browser-public credentials require legacy-unsafe status and bounded rework",
    );

    const shipped = await readJson("samples/catalog.v2.json");
    await expect(
      validateCatalog(shipped, packageJson, {
        ...validationTime,
        syntheticConfigurationFixtures: ["cesium-route-playback"],
      }),
    ).rejects.toThrow(
      "cesium-route-playback: synthetic configuration fixture source must live under test/fixtures/sample-contract/",
    );
  });
});
