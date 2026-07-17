import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

import {
  collectQualificationEvidence,
  generateCapabilitySampleMatrix,
  validateCapabilitySampleMatrix,
} from "../scripts/sample-contract.mjs";
import type { QualificationEvidenceInventory } from "../scripts/sample-contract.mjs";

const readJson = async (file: string) => JSON.parse(await readFile(file, "utf8"));

async function canonicalInputs() {
  const [catalog, packageJson, supportTruth] = await Promise.all([
    readJson("samples/catalog.v2.json"),
    readJson("package.json"),
    readJson("config/support-manifest.v1.json"),
  ]);
  const qualificationEvidence = await collectQualificationEvidence(catalog);
  return { catalog, packageJson, supportTruth, qualificationEvidence };
}

function qualificationReceipts(sampleId: string): QualificationEvidenceInventory["samples"][number]["receipts"] {
  const gates = [
    "accessibility",
    "browser",
    "console",
    "fixture",
    "live",
    "packed-build",
    "performance",
    "responsive",
    "screenshot",
  ];
  return gates.map((gate) => ({
    gate,
    sdkMode: gate === "packed-build" ? "packed" : "source",
    sourceRevision: "a".repeat(40),
    sourceDigest: "b".repeat(64),
    path: `samples/evidence/${sampleId}/receipts/${gate}.v1.json`,
    sha256: "c".repeat(64),
  }));
}

describe("capability-to-sample matrix contract", () => {
  it("keeps a compact contract fixture schema-valid with every visible gap state", async () => {
    const fixture = await readJson("samples/contract/v2/fixtures/capability-sample-matrix.fixture.json");

    await expect(validateCapabilitySampleMatrix(fixture)).resolves.toBeUndefined();
    expect(fixture.gaps.map((gap: { coverageState: string }) => gap.coverageState).sort()).toEqual([
      "experimental",
      "partial",
      "planned",
      "unsupported",
    ]);
  });

  it("deterministically projects all four authorities without inventing qualification", async () => {
    const inputs = await canonicalInputs();
    const matrix = generateCapabilitySampleMatrix(
      inputs.catalog,
      inputs.packageJson,
      inputs.supportTruth,
      inputs.qualificationEvidence,
    );

    await expect(validateCapabilitySampleMatrix(matrix, inputs)).resolves.toBeUndefined();
    expect(
      generateCapabilitySampleMatrix(
        inputs.catalog,
        inputs.packageJson,
        inputs.supportTruth,
        inputs.qualificationEvidence,
      ),
    ).toEqual(matrix);
    expect(matrix.samples).toHaveLength(34);
    expect(matrix.protocolOperations).toHaveLength(
      inputs.supportTruth.protocols.length * inputs.supportTruth.protocolOperations.length,
    );
    expect(matrix.supportClaims).toHaveLength(21);
    expect(matrix.packageEntrypoints).toHaveLength(51);
    expect(matrix.inputs.qualificationEvidence).toMatchObject({ receiptCount: 0 });
    expect(Object.values(matrix.inputs).every((input) => /^[a-f0-9]{64}$/.test(String(input.sha256)))).toBe(true);
    expect(JSON.stringify(matrix)).not.toContain("generatedAt");
    expect(matrix.samples.some((sample) => sample.qualification.state === "qualified")).toBe(false);

    expect(matrix.goldenJourneys.find((journey) => journey.id === "first-map")?.coverage.state).toBe("planned");
    expect(matrix.goldenJourneys.find((journey) => journey.id === "cloud-native-analysis")?.coverage.state).toBe(
      "experimental",
    );
    expect(
      matrix.protocolOperations.find((cell) => cell.id === "geoservices-feature-service:query:protocol-adapter:native"),
    ).toMatchObject({ supportStatus: "supported", coverage: { state: "partial" } });
    expect(matrix.protocolOperations.find((cell) => cell.id === "wms:applyEdits:default")).toMatchObject({
      supportStatus: "unsupported",
      coverage: { state: "unsupported" },
    });
    expect(matrix.packageEntrypoints.find((entrypoint) => entrypoint.subpath === "./app")).toMatchObject({
      supportStatus: "deprecated",
      replacement: "@honua/app-platform/app",
      coverage: { state: "unsupported" },
    });
    expect(new Set(matrix.gaps.map((gap) => gap.coverageState))).toEqual(
      new Set(["partial", "planned", "experimental", "unsupported"]),
    );
  });

  it("requires receipt-backed catalog promotion and keeps ambiguous protocol joins non-qualified", async () => {
    const inputs = await canonicalInputs();
    const catalog = structuredClone(inputs.catalog);
    const journey = catalog.goldenJourneys.find((candidate: { id: string }) => candidate.id === "first-map");
    const sample = catalog.samples.find((candidate: { id: string }) => candidate.id === journey.candidateSampleId);
    journey.status = "qualified";
    sample.track = "golden";
    sample.validationProfile = "golden-browser";

    expect(() =>
      generateCapabilitySampleMatrix(catalog, inputs.packageJson, inputs.supportTruth, inputs.qualificationEvidence),
    ).toThrow("qualification evidence must exactly cover catalog-qualified golden samples");

    const qualificationEvidence: QualificationEvidenceInventory = {
      format: "honua.sdk.sample-qualification-evidence.v1",
      schemaVersion: 1,
      samples: [{ sampleId: sample.id, receipts: qualificationReceipts(sample.id) }],
    };
    const matrix = generateCapabilitySampleMatrix(
      catalog,
      inputs.packageJson,
      inputs.supportTruth,
      qualificationEvidence,
    );

    expect(matrix.goldenJourneys.find((candidate) => candidate.id === "first-map")?.coverage.state).toBe("qualified");
    expect(matrix.samples.find((candidate) => candidate.id === sample.id)?.qualification).toMatchObject({
      state: "qualified",
      evidence: { sdkModes: ["packed", "source"] },
    });
    expect(matrix.protocolOperations.find((cell) => cell.id === "grpc:query:honua-facade:native")?.coverage.state).toBe(
      "qualified",
    );
    expect(
      matrix.protocolOperations.find((cell) => cell.id === "geoservices-feature-service:query:protocol-adapter:native")
        ?.coverage.state,
    ).toBe("partial");
  });

  it("rejects export, join, target, and support-claim reference drift", async () => {
    const inputs = await canonicalInputs();

    const missingExport = structuredClone(inputs.packageJson);
    delete missingExport.exports["./map"];
    expect(() =>
      generateCapabilitySampleMatrix(inputs.catalog, missingExport, inputs.supportTruth, inputs.qualificationEvidence),
    ).toThrow("package exports and support lifecycle entrypoints must match exactly");

    const escapingTarget = structuredClone(inputs.packageJson);
    escapingTarget.exports["./map"].default = "./dist/../outside.js";
    expect(() =>
      generateCapabilitySampleMatrix(inputs.catalog, escapingTarget, inputs.supportTruth, inputs.qualificationEvidence),
    ).toThrow("default export target must be a normalized dist path");

    const badEquivalent = structuredClone(inputs.supportTruth);
    badEquivalent.packageLifecycle.entrypoints.find(
      (entrypoint: { subpath: string }) => entrypoint.subpath === "./browser",
    ).apiEquivalent = "./missing";
    expect(() =>
      generateCapabilitySampleMatrix(inputs.catalog, inputs.packageJson, badEquivalent, inputs.qualificationEvidence),
    ).toThrow("./browser: unknown API-equivalent export ./missing");

    const badJoin = structuredClone(inputs.supportTruth);
    badJoin.consumerContracts.sampleCatalog.protocols.odata.supportClaimIds = ["missing-claim"];
    expect(() =>
      generateCapabilitySampleMatrix(inputs.catalog, inputs.packageJson, badJoin, inputs.qualificationEvidence),
    ).toThrow("odata: unknown catalog support-claim binding missing-claim");

    const badApiReference = structuredClone(inputs.supportTruth);
    badApiReference.supportClaims[0].api = "@honua/sdk-js/not-exported";
    expect(() =>
      generateCapabilitySampleMatrix(inputs.catalog, inputs.packageJson, badApiReference, inputs.qualificationEvidence),
    ).toThrow("API references missing package export ./not-exported");
  });
});
