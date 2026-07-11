import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

import {
  buildBrowserArtifactManifest,
  generateSiteProjection,
  generatedOutputDrift,
  generatedOutputs,
  validateCatalog,
  validateEvidenceEnvelope,
  verifyBrowserArtifactManifest,
} from "../scripts/sample-contract.mjs";

const readJson = async (path: string) => JSON.parse(await readFile(path, "utf8"));
const execFileAsync = promisify(execFile);

describe("sample publication contract", () => {
  it("covers every SDK example and all 21 legacy site routes", async () => {
    const catalog = await readJson("samples/catalog.v1.json");
    const packageJson = await readJson("package.json");

    await expect(validateCatalog(catalog, packageJson)).resolves.toBeUndefined();
    expect(catalog.samples).toHaveLength(27);
    expect(catalog.siteMappings).toHaveLength(21);
    expect(generateSiteProjection(catalog, packageJson).routes).toHaveLength(21);
  });

  it("derives release versions without catalog edits and still detects semantic drift", async () => {
    const catalog = await readJson("samples/catalog.v1.json");
    const packageJson = await readJson("package.json");
    const currentOutputs = await generatedOutputs(catalog, packageJson);
    const bumpedPackage = { ...packageJson, version: "9.9.9" };

    await expect(validateCatalog(catalog, bumpedPackage)).resolves.toBeUndefined();
    const bumpedOutputs = await generatedOutputs(catalog, bumpedPackage);
    const bumpedProjection = JSON.parse(bumpedOutputs.get("samples/dist/honua-site-samples.v1.json")!);
    expect(bumpedProjection.catalog.version).toBe("9.9.9");
    expect(bumpedProjection.samples.find((sample: { sdk?: { version: string } }) => sample.sdk)?.sdk?.version).toBe(
      "9.9.9",
    );
    expect(generatedOutputDrift(bumpedOutputs, currentOutputs)).toEqual([]);

    const semanticDrift = new Map(currentOutputs);
    semanticDrift.set(
      "docs/generated/sample-catalog.md",
      currentOutputs.get("docs/generated/sample-catalog.md")!.replace("# SDK sample catalog", "# Stale catalog"),
    );
    expect(generatedOutputDrift(currentOutputs, semanticDrift)).toEqual(["docs/generated/sample-catalog.md"]);

    const integrityDrift = new Map(currentOutputs);
    const consumerFixture = JSON.parse(
      currentOutputs.get("samples/contract/v1/consumer-fixtures/honua-site-consumer.v1.json")!,
    );
    consumerFixture.input.sha256 = "0".repeat(64);
    integrityDrift.set(
      "samples/contract/v1/consumer-fixtures/honua-site-consumer.v1.json",
      `${JSON.stringify(consumerFixture, null, 2)}\n`,
    );
    expect(generatedOutputDrift(currentOutputs, integrityDrift)).toEqual([
      "samples/contract/v1/consumer-fixtures/honua-site-consumer.v1.json",
    ]);
    expect(generatedOutputDrift(bumpedOutputs, integrityDrift)).toEqual([
      "samples/contract/v1/consumer-fixtures/honua-site-consumer.v1.json",
    ]);
  });

  it("rejects catalog drift before projection", async () => {
    const catalog = await readJson("samples/catalog.v1.json");
    const packageJson = await readJson("package.json");
    catalog.samples[0].capabilities = ["map", "agent-planning"];

    await expect(validateCatalog(catalog, packageJson)).rejects.toThrow("must be sorted");

    const missingSdk = await readJson("samples/catalog.v1.json");
    delete missingSdk.sdk;
    await expect(validateCatalog(missingSdk, packageJson)).rejects.toThrow("catalog SDK metadata is required");
  });

  it("uses one evidence envelope for fixture, live, and unavailable lanes", async () => {
    for (const name of ["fixture", "live", "skipped"]) {
      const evidence = await readJson(`samples/contract/v1/fixtures/sample-evidence.${name}.json`);
      expect(validateEvidenceEnvelope(evidence)).toBe(evidence);
    }

    const invalid = await readJson("samples/contract/v1/fixtures/sample-evidence.skipped.json");
    invalid.reason = null;
    expect(() => validateEvidenceEnvelope(invalid)).toThrow("requires a reason");

    for (const lane of ["fixture.v1", "live-skipped.v1"]) {
      const safeAgentEvidence = await readJson(`examples/ai-spatial-app-builder/evidence/${lane}.json`);
      expect(validateEvidenceEnvelope(safeAgentEvidence)).toBe(safeAgentEvidence);
    }

    const missingSource = await readJson("examples/ai-spatial-app-builder/evidence/fixture.v1.json");
    delete missingSource.source;
    expect(() => validateEvidenceEnvelope(missingSource)).toThrow("source.provider is required");

    const invalidProvenanceTime = await readJson("examples/ai-spatial-app-builder/evidence/fixture.v1.json");
    invalidProvenanceTime.provenance.observedAt = "not-a-date";
    expect(() => validateEvidenceEnvelope(invalidProvenanceTime)).toThrow(
      "provenance.observedAt must be an RFC 3339 date-time",
    );
    invalidProvenanceTime.provenance.observedAt = "2026-07-10T18:00:00.000Z";
    invalidProvenanceTime.provenance.validAt = "2026-07-10";
    expect(() => validateEvidenceEnvelope(invalidProvenanceTime)).toThrow(
      "provenance.validAt must be null or an RFC 3339 date-time",
    );
  });

  it("records the configured live-data endpoint instead of the proposal host", async () => {
    const { stdout } = await execFileAsync(process.execPath, ["examples/ai-spatial-app-builder/live-evidence.mjs"], {
      env: {
        ...process.env,
        HONUA_AGENT_HOST_URL: "https://agent.example.test/proposals",
        HONUA_LIVE_DATA_URL: "https://data.example.test/features",
      },
    });
    const evidence = JSON.parse(stdout);
    expect(evidence.source.endpoint).toBe("https://data.example.test/features");
    expect(evidence.reason).toContain("no request was sent");
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
