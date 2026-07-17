import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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

function qualificationReceipts(
  sampleId: string,
  window: { observedAt: string; expiresAt: string } = {
    observedAt: "2026-07-16T12:00:00.000Z",
    expiresAt: "2026-07-23T12:00:00.000Z",
  },
): QualificationEvidenceInventory["samples"][number]["receipts"] {
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
  const runRoot = `samples/evidence/${sampleId}/runs/11111111-1111-4111-8111-111111111111`;
  return gates.map((gate) => ({
    gate,
    sdkMode: gate === "packed-build" ? "packed" : "source",
    sourceRevision: "a".repeat(40),
    sourceDigest: "b".repeat(64),
    runRoot,
    observedAt: window.observedAt,
    expiresAt: window.expiresAt,
    path: `samples/evidence/${sampleId}/receipts/${gate}.v1.json`,
    sha256: "c".repeat(64),
    artifact: {
      kind: `${gate}-report`,
      path: `${runRoot}/artifacts/${gate}.json`,
      bytes: 100,
      sha256: "d".repeat(64),
    },
  }));
}

async function promotedFirstMap(window?: { observedAt: string; expiresAt: string }) {
  const inputs = await canonicalInputs();
  const catalog = structuredClone(inputs.catalog);
  const journey = catalog.goldenJourneys.find((candidate: { id: string }) => candidate.id === "first-map");
  const sample = catalog.samples.find((candidate: { id: string }) => candidate.id === journey.candidateSampleId);
  journey.status = "qualified";
  sample.track = "golden";
  sample.validationProfile = "golden-browser";
  const qualificationEvidence: QualificationEvidenceInventory = {
    format: "honua.sdk.sample-qualification-evidence.v1",
    schemaVersion: 1,
    samples: [{ sampleId: sample.id, receipts: qualificationReceipts(sample.id, window) }],
  };
  return {
    ...inputs,
    catalog,
    sample,
    qualificationEvidence,
    matrix: generateCapabilitySampleMatrix(catalog, inputs.packageJson, inputs.supportTruth, qualificationEvidence),
  };
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
    expect(matrix.evidenceBindings).toEqual([]);
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
    expect(matrix.evidenceBindings).toHaveLength(1);
    expect(matrix.evidenceBindings[0]).toMatchObject({
      sampleId: sample.id,
      source: { path: sample.sourcePath, receipts: expect.any(Array) },
      packed: { gate: "packed-build", sdkMode: "packed" },
    });
    expect(matrix.protocolOperations.find((cell) => cell.id === "grpc:query:honua-facade:native")?.coverage.state).toBe(
      "qualified",
    );
    expect(
      matrix.protocolOperations.find((cell) => cell.id === "geoservices-feature-service:query:protocol-adapter:native")
        ?.coverage.state,
    ).toBe("partial");

    const sourceOnly = structuredClone(qualificationEvidence);
    sourceOnly.samples[0].receipts.find((receipt) => receipt.gate === "packed-build")!.sdkMode = "source";
    expect(() => generateCapabilitySampleMatrix(catalog, inputs.packageJson, inputs.supportTruth, sourceOnly)).toThrow(
      "packed-mode packed-build receipt",
    );

    const packedOnly = structuredClone(qualificationEvidence);
    for (const receipt of packedOnly.samples[0].receipts) receipt.sdkMode = "packed";
    expect(() => generateCapabilitySampleMatrix(catalog, inputs.packageJson, inputs.supportTruth, packedOnly)).toThrow(
      "requires source-mode receipts",
    );
  });

  it("rejects fixture-backed orphan, stale, and overstated evidence joins before publication", async () => {
    const adversaries = await readJson("samples/contract/v2/fixtures/capability-sample-matrix.adversarial.json");
    expect(adversaries).toMatchObject({
      format: "honua.sdk.capability-sample-matrix-adversaries.v1",
      schemaVersion: 1,
    });
    expect(adversaries.cases.map((entry: { kind: string }) => entry.kind)).toEqual([
      "orphan-binding",
      "stale-receipts",
      "overstated-protocol-join",
    ]);

    const stale = adversaries.cases.find((entry: { kind: string }) => entry.kind === "stale-receipts");
    const promoted = await promotedFirstMap({ observedAt: stale.observedAt, expiresAt: stale.expiresAt });

    const orphan = adversaries.cases.find((entry: { kind: string }) => entry.kind === "orphan-binding");
    const orphanMatrix = structuredClone(promoted.matrix);
    orphanMatrix.evidenceBindings.push({
      ...structuredClone(orphanMatrix.evidenceBindings[0]),
      id: orphan.bindingId,
      sampleId: orphan.sampleId,
    });
    await expect(validateCapabilitySampleMatrix(orphanMatrix)).rejects.toThrow(orphan.expectedFailure);

    await expect(validateCapabilitySampleMatrix(promoted.matrix)).rejects.toThrow(stale.expectedFailure);

    const overstated = adversaries.cases.find((entry: { kind: string }) => entry.kind === "overstated-protocol-join");
    const overstatedMatrix = structuredClone(promoted.matrix);
    const target = overstatedMatrix.protocolOperations.find((cell: { id: string }) => cell.id === overstated.targetId);
    const qualified = overstatedMatrix.protocolOperations.find(
      (cell: { id: string }) => cell.id === overstated.qualifiedCoverageSourceId,
    );
    if (!target || !qualified) throw new Error("adversarial protocol coverage fixture references an unknown cell");
    target.coverage = structuredClone(qualified.coverage);
    await expect(validateCapabilitySampleMatrix(overstatedMatrix)).rejects.toThrow(overstated.expectedFailure);
  });

  it("rejects orphan qualification evidence roots when the catalog claims zero qualified samples", async () => {
    const inputs = await canonicalInputs();
    const receiptRoot = await mkdtemp(path.join(os.tmpdir(), "honua-matrix-orphan-"));
    try {
      await mkdir(path.join(receiptRoot, "missing-sample"));
      await expect(collectQualificationEvidence(inputs.catalog, { receiptRoot })).rejects.toThrow(
        "qualification evidence root has orphan or missing entries",
      );
    } finally {
      await rm(receiptRoot, { recursive: true, force: true });
    }
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
