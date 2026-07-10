import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

import {
  buildBrowserArtifactManifest,
  generateSiteProjection,
  validateCatalog,
  validateEvidenceEnvelope,
  verifyBrowserArtifactManifest,
} from "../scripts/sample-contract.mjs";

const readJson = async (path: string) => JSON.parse(await readFile(path, "utf8"));

describe("sample publication contract", () => {
  it("covers every SDK example and all 21 legacy site routes", async () => {
    const catalog = await readJson("samples/catalog.v1.json");
    const packageJson = await readJson("package.json");

    await expect(validateCatalog(catalog, packageJson)).resolves.toBeUndefined();
    expect(catalog.samples).toHaveLength(27);
    expect(catalog.siteMappings).toHaveLength(21);
    expect(generateSiteProjection(catalog).routes).toHaveLength(21);
  });

  it("rejects catalog drift before projection", async () => {
    const catalog = await readJson("samples/catalog.v1.json");
    const packageJson = await readJson("package.json");
    catalog.samples[0].capabilities = ["map", "agent-planning"];

    await expect(validateCatalog(catalog, packageJson)).rejects.toThrow("must be sorted");
  });

  it("uses one evidence envelope for fixture, live, and unavailable lanes", async () => {
    for (const name of ["fixture", "live", "skipped"]) {
      const evidence = await readJson(`samples/contract/v1/fixtures/sample-evidence.${name}.json`);
      expect(validateEvidenceEnvelope(evidence)).toBe(evidence);
    }

    const invalid = await readJson("samples/contract/v1/fixtures/sample-evidence.skipped.json");
    invalid.reason = null;
    expect(() => validateEvidenceEnvelope(invalid)).toThrow("requires a reason");
  });

  it("binds browser artifacts to build inputs, peers, SHA-256, and SRI", async () => {
    const manifest = await buildBrowserArtifactManifest({
      artifacts: [{ path: "test/fixtures/sample-contract/browser.js", entrypoint: "fixture" }],
      gitCommit: "1111111111111111111111111111111111111111",
    });

    expect(manifest.files[0]).toMatchObject({
      entrypoint: "fixture",
      integrity: expect.stringMatching(/^sha256-/),
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(manifest.build.inputs.length).toBeGreaterThan(250);
    expect(manifest.compatibility.peers).toHaveProperty("maplibre-gl");
    await expect(verifyBrowserArtifactManifest(manifest)).resolves.toBeUndefined();

    manifest.files[0].sha256 = "0".repeat(64);
    await expect(verifyBrowserArtifactManifest(manifest)).rejects.toThrow("SHA-256 drift");
  });
});
