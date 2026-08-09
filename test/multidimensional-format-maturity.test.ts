import fs from "node:fs";

import addFormats from "ajv-formats";
import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";

const descriptorPath = new URL("../config/multidimensional-format-maturity.v1.json", import.meta.url);
const schemaPath = new URL("../config/multidimensional-format-maturity.schema.json", import.meta.url);
const descriptor = JSON.parse(fs.readFileSync(descriptorPath, "utf8"));
const schema = JSON.parse(fs.readFileSync(schemaPath, "utf8"));
const ajv = new Ajv2020.default({ allErrors: true, strict: true });
addFormats.default(ajv);
const validate = ajv.compile(schema);

const evidenceSurfaces = [
  "admin-registration",
  "metadata-conversion-to-zarr",
  "versioned-variable-dimension-http",
  "bounded-subset-http",
  "worker-driver-image",
  "live-fixture",
  "live-canary",
  "sdk-adapter",
];
const blockerIds = [
  "server-versioned-metadata-http",
  "server-bounded-subset-http",
  "worker-driver-image-matrix",
  "pinned-live-format-fixtures",
  "deployed-live-canary",
  "sdk-adapter-contract",
];

function expectValid(value: unknown): void {
  const valid = validate(value);
  if (!valid) throw new Error(`maturity schema failed: ${JSON.stringify(validate.errors)}`);
  expect(valid).toBe(true);
}

function cloneDescriptor(): typeof descriptor {
  return structuredClone(descriptor);
}

describe("internal multidimensional format maturity contract", () => {
  it("validates the closed descriptor and rejects public-surface mutations", () => {
    expectValid(descriptor);

    const extraProperty = cloneDescriptor();
    extraProperty.unreviewed = true;
    expect(validate(extraProperty)).toBe(false);

    const publicExport = cloneDescriptor();
    publicExport.policy.publicSdkExport = true;
    expect(validate(publicExport)).toBe(false);

    const runnableSample = cloneDescriptor();
    runnableSample.policy.runnableSample = true;
    expect(validate(runnableSample)).toBe(false);
  });

  it("tracks NetCDF4 and HDF5 separately across the complete evidence surface", () => {
    expect(descriptor.trackedFormats.map((format: { id: string }) => format.id)).toEqual(["netcdf4", "hdf5"]);
    for (const format of descriptor.trackedFormats) {
      expect(format.role).toBe("maturity-track");
      expect(format.evidence.map((entry: { surface: string }) => entry.surface)).toEqual(evidenceSurfaces);
      expect(format.evidence.find((entry: { surface: string }) => entry.surface === "admin-registration")?.state).toBe(
        "verified-source",
      );
      expect(
        format.evidence.find((entry: { surface: string }) => entry.surface === "metadata-conversion-to-zarr")?.state,
      ).toBe("build-optional");
      for (const surface of [
        "versioned-variable-dimension-http",
        "bounded-subset-http",
        "live-fixture",
        "live-canary",
        "sdk-adapter",
      ]) {
        const entry = format.evidence.find((candidate: { surface: string }) => candidate.surface === surface);
        expect(entry).toMatchObject({ state: "missing", releaseBlocking: true });
      }
    }
    expect(
      descriptor.trackedFormats[0].evidence.find(
        (entry: { surface: string }) => entry.surface === "worker-driver-image",
      ).state,
    ).toBe("build-optional");
    expect(
      descriptor.trackedFormats[1].evidence.find(
        (entry: { surface: string }) => entry.surface === "worker-driver-image",
      ).state,
    ).toBe("missing");
  });

  it("pins every evidence reference and keeps GRIB reference-only", () => {
    const { serverCommit, references } = descriptor.sourceOfTruth;
    expect(serverCommit).toMatch(/^[a-f0-9]{40}$/);
    const ids = new Set(references.map((reference: { id: string }) => reference.id));
    expect(ids.size).toBe(references.length);
    for (const reference of references) {
      expect(reference.url).toContain(`/blob/${serverCommit}/`);
      expect(reference.url).not.toContain("/blob/trunk/");
    }
    for (const format of descriptor.trackedFormats) {
      for (const entry of format.evidence) {
        for (const reference of entry.evidenceRefs) expect(ids.has(reference)).toBe(true);
      }
    }
    expect(descriptor.referenceOnlyFormats).toEqual([expect.objectContaining({ id: "grib", role: "reference-only" })]);
  });

  it("keeps all release blockers explicit and curriculum ordered behind them", () => {
    expect(descriptor.releaseBlockers.map((blocker: { id: string }) => blocker.id)).toEqual(blockerIds);
    expect(descriptor.curriculum.currentState).toBe("architecture-only");
    expect(descriptor.curriculum.futureSequence.map((phase: { order: number }) => phase.order)).toEqual([1, 2, 3, 4]);
    const knownBlockers = new Set(blockerIds);
    for (const phase of descriptor.curriculum.futureSequence) {
      for (const criterion of phase.entryCriteria) expect(knownBlockers.has(criterion)).toBe(true);
    }
  });

  it("adds no public export, support truth, coverage claim, or runnable sample", () => {
    const packageJson = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    const publicSurface = fs.readFileSync(new URL("../config/public-surface.json", import.meta.url), "utf8");
    const supportManifest = fs.readFileSync(new URL("../config/support-manifest.v1.json", import.meta.url), "utf8");
    const coverage = fs.readFileSync(new URL("../config/sdk-coverage.v1.json", import.meta.url), "utf8");
    const exampleNames = fs.readdirSync(new URL("../examples", import.meta.url));

    expect(Object.keys(packageJson.exports)).not.toEqual(
      expect.arrayContaining(["./netcdf", "./hdf5", "./multidimensional"]),
    );
    for (const governedPublicText of [publicSurface, supportManifest, coverage]) {
      expect(governedPublicText).not.toMatch(/netcdf|hdf5|multidimensional-format-maturity/iu);
    }
    expect(exampleNames).not.toEqual(expect.arrayContaining(["netcdf", "hdf5", "multidimensional"]));
  });

  it("keeps architecture guidance searchable and aligned to every blocker", () => {
    const guide = fs.readFileSync(new URL("../docs/multidimensional-format-maturity.md", import.meta.url), "utf8");
    for (const blocker of blockerIds) expect(guide).toContain(`\`${blocker}\``);
    expect(guide).toContain("GRIB/GRIB2 is reference-only");
    expect(guide).toContain("no public export");
    expect(guide).toContain("full-file download");
  });
});
