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

const ingestionEvidenceSurfaces = [
  "admin-registration",
  "metadata-conversion-to-zarr",
  "versioned-variable-dimension-http",
  "bounded-subset-http",
  "worker-driver-image",
  "live-fixture",
  "live-canary",
  "sdk-adapter",
];
const zarrEvidenceSurfaces = [
  "admin-registration",
  "versioned-variable-dimension-http",
  "bounded-subset-http",
  "coverage-http",
  "datacube-tile-http",
  "wcs-http",
  "version-codec-layout-contract",
  "live-fixture",
  "live-canary",
  "sdk-adapter",
];
const ingestionBlockerIds = [
  "server-versioned-metadata-http",
  "server-bounded-subset-http",
  "worker-driver-image-matrix",
  "pinned-live-format-fixtures",
  "deployed-live-canary",
  "sdk-adapter-contract",
];
const zarrBlockerIds = [
  "zarr-immutable-fixture-and-version-matrix",
  "zarr-positive-server-routes",
  "zarr-stable-version-codec-contract",
  "zarr-bounded-sdk-client",
  "zarr-sample-publication",
];

function expectValid(value: unknown): void {
  const valid = validate(value);
  if (!valid) throw new Error(`maturity schema failed: ${JSON.stringify(validate.errors)}`);
  expect(valid).toBe(true);
}

function cloneDescriptor(): typeof descriptor {
  return structuredClone(descriptor);
}

function formatById(id: string): (typeof descriptor.trackedFormats)[number] {
  const format = descriptor.trackedFormats.find((candidate: { id: string }) => candidate.id === id);
  if (!format) throw new Error(`missing tracked format: ${id}`);
  return format;
}

describe("internal multidimensional format maturity contract", () => {
  it("validates one closed descriptor and rejects public-surface mutations", () => {
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

  it("keeps client, server, and end-to-end maturity explicit per format", () => {
    expect(descriptor.trackedFormats.map((format: { id: string }) => format.id)).toEqual(["netcdf4", "hdf5", "zarr"]);
    expect(formatById("netcdf4").maturity).toMatchObject({
      client: { state: "unavailable" },
      server: { state: "metadata-only" },
      endToEnd: { state: "unavailable" },
    });
    expect(formatById("hdf5").maturity).toMatchObject({
      client: { state: "unavailable" },
      server: { state: "metadata-only" },
      endToEnd: { state: "unavailable" },
    });
    expect(formatById("zarr").maturity).toMatchObject({
      client: { state: "unavailable" },
      server: { state: "experimental" },
      endToEnd: { state: "unavailable" },
    });
  });

  it("keeps NetCDF4 and HDF5 evidence and GRIB reference-only truth unchanged", () => {
    for (const id of ["netcdf4", "hdf5"]) {
      const format = formatById(id);
      expect(format.evidence.map((entry: { surface: string }) => entry.surface)).toEqual(ingestionEvidenceSurfaces);
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
        expect(format.evidence.find((entry: { surface: string }) => entry.surface === surface)).toMatchObject({
          state: "missing",
          releaseBlocking: true,
        });
      }
    }
    expect(
      formatById("netcdf4").evidence.find((entry: { surface: string }) => entry.surface === "worker-driver-image")
        .state,
    ).toBe("build-optional");
    expect(
      formatById("hdf5").evidence.find((entry: { surface: string }) => entry.surface === "worker-driver-image").state,
    ).toBe("missing");
    expect(descriptor.referenceOnlyFormats).toEqual([expect.objectContaining({ id: "grib", role: "reference-only" })]);
  });

  it("ports Zarr server evidence, contract bounds, and missing publication gates", () => {
    const zarr = formatById("zarr");
    expect(zarr.evidence.map((entry: { surface: string }) => entry.surface)).toEqual(zarrEvidenceSurfaces);
    expect(zarr.evidence.find((entry: { surface: string }) => entry.surface === "admin-registration")?.state).toBe(
      "integration-tested",
    );
    expect(zarr.evidence.find((entry: { surface: string }) => entry.surface === "datacube-tile-http")?.state).toBe(
      "route-and-component-tested",
    );
    expect(zarr.contractLimits.versions.join(" ")).toMatch(/Zarr v2.*Zarr v3/iu);
    expect(zarr.contractLimits.codecs.join(" ")).toMatch(/zlib.*gzip.*zstd.*blosc/iu);
    expect(zarr.contractLimits.layout.join(" ")).toContain("C-order");
    expect(zarr.contractLimits.crs.join(" ")).toContain("Cross-CRS");
    expect(zarr.contractLimits.budgets.join(" ")).toMatch(/64 KiB.*4096 chunks.*256 MiB.*16 MiB.*4 MiB/iu);
    expect(zarr.publicationGates).toHaveLength(10);
    expect(zarr.publicationGates.every((gate: { state: string }) => gate.state === "missing")).toBe(true);
    expect(zarr.architecture.futureResponsibilities.map((item: { id: string }) => item.id)).toEqual([
      "metadata",
      "slice",
      "tile",
    ]);
  });

  it("pins every evidence reference to an admitted immutable server commit", () => {
    const { serverCommit, additionalServerEvidenceCommits, references } = descriptor.sourceOfTruth;
    const admittedCommits = new Set([
      serverCommit,
      ...additionalServerEvidenceCommits.map((entry: { commit: string }) => entry.commit),
    ]);
    expect(admittedCommits).toEqual(
      new Set(["61b7038e1887c98131aa217b6f0ae7869356a1f3", "639d37449fb8da5e9df4b12b7641ba4c6c5ac581"]),
    );
    const ids = new Set(references.map((reference: { id: string }) => reference.id));
    expect(ids.size).toBe(references.length);
    for (const reference of references) {
      const commit = reference.url.match(/\/blob\/([a-f0-9]{40})\//u)?.[1];
      expect(commit).toBeTruthy();
      expect(admittedCommits.has(commit)).toBe(true);
      expect(reference.url).not.toContain("/blob/trunk/");
    }
    for (const format of descriptor.trackedFormats) {
      for (const entry of format.evidence) {
        for (const reference of entry.evidenceRefs) expect(ids.has(reference)).toBe(true);
      }
    }
  });

  it("keeps release blockers explicit and curriculum ordered behind known gates", () => {
    expect(descriptor.releaseBlockers.map((blocker: { id: string }) => blocker.id)).toEqual([
      ...ingestionBlockerIds,
      ...zarrBlockerIds,
    ]);
    expect(descriptor.curriculum.currentState).toBe("architecture-only");
    expect(descriptor.curriculum.futureSequence.map((phase: { order: number }) => phase.order)).toEqual([1, 2, 3, 4]);
    const knownBlockers = new Set([...ingestionBlockerIds, ...zarrBlockerIds]);
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
      expect.arrayContaining(["./zarr", "./netcdf", "./hdf5", "./multidimensional"]),
    );
    expect(publicSurface).not.toMatch(/"\.\/(?:zarr|netcdf|hdf5|multidimensional)"/iu);
    for (const governedPublicText of [supportManifest, coverage]) {
      expect(governedPublicText).not.toMatch(/@honua\/sdk-js\/(?:zarr|netcdf|hdf5|multidimensional)/iu);
    }
    expect(exampleNames).not.toEqual(
      expect.arrayContaining(["zarr", "zarr-basic", "netcdf", "hdf5", "multidimensional"]),
    );
  });

  it("keeps architecture guidance searchable and aligned to every blocker", () => {
    const guide = fs.readFileSync(new URL("../docs/multidimensional-format-maturity.md", import.meta.url), "utf8");
    for (const blocker of [...ingestionBlockerIds, ...zarrBlockerIds])
      expect(guide).toContain(String.fromCharCode(96) + blocker + String.fromCharCode(96));
    for (const required of [
      "Zarr v2",
      "Zarr v3",
      "positive public live Zarr canary",
      "GRIB/GRIB2 is reference-only",
      "no public export",
      "full-file download",
      "Maturity-only architecture guidance",
    ]) {
      expect(guide).toContain(required);
    }
  });
});
