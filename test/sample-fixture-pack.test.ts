import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

import type { FormatsPlugin } from "ajv-formats";
import { Ajv2020 } from "ajv/dist/2020.js";
import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";

import { verifyFixturePacks } from "../samples/fixtures/verify.mjs";
import {
  canonicalJson,
  fingerprint,
  fixtureHeaders,
  fixtureResponseHeaders,
  loadFixturePack,
  validateFixturePackDirectory,
} from "../samples/scenarios/index.mjs";

const temporaryRoots: string[] = [];
const projectRoot = path.resolve(import.meta.dirname, "..");
const addFormats = createRequire(import.meta.url)("ajv-formats") as FormatsPlugin;

function temporaryPack(id: "first-map" | "incident-operations"): string {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "honua-fixture-pack-"));
  temporaryRoots.push(temporary);
  const destination = path.join(temporary, id, "v1");
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.cpSync(path.join(projectRoot, "samples", "fixtures", id, "v1"), destination, { recursive: true });
  return destination;
}

function updateJson(filePath: string, update: (value: any) => void): void {
  const value = JSON.parse(fs.readFileSync(filePath, "utf8"));
  update(value);
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function introduceRefreshDrift(root: string): string {
  updateJson(path.join(root, "features.json"), (features) => {
    features.features[0].attributes.STATUS = "Reviewed refresh";
  });
  updateJson(path.join(root, "ogc-items.json"), (items) => {
    items.features[0].properties.STATUS = "Reviewed refresh";
  });
  updateJson(path.join(root, "manifest.json"), (manifest) => {
    manifest.identity.title = "Reviewed fixture refresh";
  });
  return path.dirname(path.dirname(root));
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("versioned sample fixture packs", () => {
  it("keeps the closed v1 JSON schema and runtime validator in parity", () => {
    const schema = JSON.parse(fs.readFileSync(path.join(projectRoot, "samples/fixtures/manifest.schema.json"), "utf8"));
    const ajv = new Ajv2020({ allErrors: true, strict: true });
    addFormats(ajv);
    const validate = ajv.compile(schema);
    const mutations: Array<{ name: string; update(value: any): void }> = [
      {
        name: "root unknown",
        update: (value) => {
          value.unreviewed = true;
        },
      },
      {
        name: "nested unknown",
        update: (value) => {
          value.identity.unreviewed = true;
        },
      },
      { name: "missing required", update: (value) => delete value.identity.title },
      {
        name: "control character",
        update: (value) => {
          value.identity.title = "invalid\nfixture";
        },
      },
      {
        name: "protocol overflow",
        update: (value) => {
          value.schema.protocols = Array.from({ length: 9 }, (_, index) => `p-${index}`);
        },
      },
      { name: "unknown protocol", update: (value) => value.schema.protocols.push("unknown-protocol") },
      { name: "axis overflow", update: (value) => value.schema.coordinateEncoding.axes.push("z") },
      {
        name: "projection unknown",
        update: (value) => {
          value.schema.projections = [
            {
              protocol: value.schema.protocols[0],
              crs: value.schema.authorityCrs,
              coordinateEncoding: value.schema.coordinateEncoding,
              unreviewed: true,
            },
          ];
        },
      },
      {
        name: "projection CRS",
        update: (value) => {
          value.schema.projections = [
            {
              protocol: value.schema.protocols[0],
              crs: "EPSG:3857",
              coordinateEncoding: value.schema.coordinateEncoding,
            },
          ];
        },
      },
      {
        name: "projection encoding",
        update: (value) => {
          value.schema.projections = [
            {
              protocol: value.schema.protocols[0],
              crs: value.schema.authorityCrs,
              coordinateEncoding: { format: "Mystery", axes: ["x", "y"], order: "xy" },
            },
          ];
        },
      },
      {
        name: "count overflow",
        update: (value) => {
          value.schema.featureCount = 100_001;
        },
      },
      {
        name: "unsafe data file",
        update: (value) => {
          value.schema.files[Object.keys(value.schema.files)[0]] = "invalid name.json";
        },
      },
      {
        name: "provenance unknown",
        update: (value) => {
          value.provenance.reviewed = false;
        },
      },
      {
        name: "date-only provenance time",
        update: (value) => {
          value.provenance.retrievedAt = "2026-07-13";
        },
      },
      {
        name: "license policy",
        update: (value) => {
          value.license.spdx = "LicenseRef-Unknown";
        },
      },
      {
        name: "freshness unknown",
        update: (value) => {
          value.freshness.refreshOwner = "nobody";
        },
      },
      {
        name: "freshness policy",
        update: (value) => {
          value.freshness.policy = "mutable";
        },
      },
      {
        name: "impossible freshness time",
        update: (value) => {
          value.freshness.asOf = "2026-02-31T00:00:00Z";
        },
      },
      {
        name: "bad metadata hash",
        update: (value) => {
          value.integrity.metadataFingerprint = "not-a-hash";
        },
      },
      {
        name: "metadata component unknown",
        update: (value) => {
          value.integrity.metadataComponents.other = "0".repeat(64);
        },
      },
      {
        name: "file checksum overflow",
        update: (value) => {
          value.integrity.files = Object.fromEntries(
            Array.from({ length: 17 }, (_, index) => [`file-${index}.json`, "0".repeat(64)]),
          );
        },
      },
    ];
    for (const id of ["first-map", "incident-operations"] as const) {
      const root = path.join(projectRoot, "samples", "fixtures", id, "v1");
      const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
      expect(validate(manifest), JSON.stringify(validate.errors)).toBe(true);
      const validated = validateFixturePackDirectory(root);
      expectTypeOf(validated.manifestContent).toEqualTypeOf<string>();
      expect(validated.id).toBe(id);
      expect(validated.version).toBe("v1");
      expect(JSON.parse(validated.manifestContent)).toEqual(manifest);
      for (const mutation of mutations) {
        const invalid = structuredClone(manifest);
        mutation.update(invalid);
        expect(validate(invalid), `${id}: JSON schema accepted ${mutation.name}`).toBe(false);
        const runtimeRoot = temporaryPack(id);
        fs.writeFileSync(path.join(runtimeRoot, "manifest.json"), `${JSON.stringify(invalid, null, 2)}\n`);
        expect(
          () => validateFixturePackDirectory(runtimeRoot, { allowChecksumChanges: true, allowMetadataChanges: true }),
          `${id}: runtime validator accepted ${mutation.name}`,
        ).toThrow();
      }
    }
    expect(schema.properties.fixturePackVersion.const).toBe("honua.fixture-pack/v1");
    expect(schema.properties.integrity.properties.files.maxProperties).toBe(16);
    expect(schema.properties.schema.additionalProperties).toBe(false);
  });

  it("loads checksum- and metadata-bound packs as deeply frozen graphs", () => {
    for (const id of ["first-map", "incident-operations"] as const) {
      const pack = loadFixturePack(id);
      expectTypeOf(pack.id).toEqualTypeOf<string>();
      expectTypeOf(pack.version).toEqualTypeOf<string>();
      expect(pack.id).toBe(id);
      expect(pack.version).toBe("v1");
      expect(pack.manifest.fixturePackVersion).toBe("honua.fixture-pack/v1");
      expect(pack.manifest.identity).toMatchObject({ id, revision: "v1" });
      expect(Object.isFrozen(pack.manifest.schema)).toBe(true);
      expect(Object.isFrozen(pack.data)).toBe(true);
      expect(Object.isFrozen(Object.values(pack.data)[0])).toBe(true);
      expect(() => {
        pack.manifest.schema.featureCount = 999;
      }).toThrow();
    }
  });

  it("binds the First Map GeoServices and OGC projections to identical semantics and evidence", () => {
    const pack = loadFixturePack("first-map");
    const schema = pack.manifest.schema as unknown as {
      extent: number[];
      files: Record<string, string>;
      protocols: string[];
      projections: Array<{
        protocol: string;
        crs: string;
        coordinateEncoding: { format: string; axes: string[]; order: string };
      }>;
    };
    const esri = pack.data[schema.files.features] as {
      features: Array<{ attributes: Record<string, unknown>; geometry: { rings: number[][][] } }>;
    };
    const layer = pack.data[schema.files.layer] as {
      copyrightText: string;
      provenance: Record<string, string>;
    };
    const collection = pack.data[schema.files.ogcCollection] as {
      attribution: string;
      crs: string[];
      extent: { spatial: { bbox: number[][] } };
      provenance: Record<string, string>;
    };
    const ogc = pack.data[schema.files.ogcItems] as {
      attribution: string;
      numberMatched: number;
      provenance: Record<string, string>;
      features: Array<{
        id: number;
        properties: Record<string, unknown>;
        geometry: { coordinates: number[][][] };
      }>;
    };
    const apiDefinition = pack.data[schema.files.ogcApiDefinition] as {
      paths: Record<string, { get: { parameters: Array<Record<string, unknown>> } }>;
    };

    expect(schema.protocols).toContain("ogc-api-features-1.0");
    expect(schema.projections).toEqual([
      {
        protocol: "esri-geoservices-feature-server",
        crs: "EPSG:4326",
        coordinateEncoding: { format: "Esri JSON", axes: ["x-longitude", "y-latitude"], order: "xy" },
      },
      {
        protocol: "ogc-api-features-1.0",
        crs: "OGC:CRS84",
        coordinateEncoding: { format: "GeoJSON", axes: ["longitude", "latitude"], order: "xy" },
      },
    ]);
    expect(
      apiDefinition.paths["/collections/{collectionId}/items"].get.parameters.map((parameter) => parameter.name),
    ).toEqual(["collectionId", "f", "limit", "bbox", "datetime", "offset", "run"]);
    expect(ogc.numberMatched).toBe(esri.features.length);
    expect(collection.extent.spatial.bbox).toEqual([schema.extent]);
    expect(collection.crs).toEqual(["http://www.opengis.net/def/crs/OGC/1.3/CRS84"]);
    expect(ogc.attribution).toBe(layer.copyrightText);
    expect(collection.attribution).toBe(layer.copyrightText);
    expect(ogc.provenance).toEqual(layer.provenance);
    expect(collection.provenance).toEqual(layer.provenance);
    for (const [index, feature] of esri.features.entries()) {
      expect(ogc.features[index]).toMatchObject({
        id: feature.attributes.OBJECTID,
        properties: feature.attributes,
      });
      expect(ogc.features[index].geometry.coordinates).toEqual(
        feature.geometry.rings.map((ring) => [...ring].reverse()),
      );
    }
  });

  it("keeps lossy incident provenance and the First Map sample linked to their versioned packs", () => {
    const incident = loadFixturePack("incident-operations");
    const provenance = incident.manifest.provenance as { transformation: string };
    expect(provenance.transformation).toMatch(/lossy/i);
    expect(provenance.transformation).toMatch(/relationships and attachments/i);
    expect(provenance.transformation).toMatch(/relationship updates/i);

    const quickstartReadme = fs.readFileSync(path.join(projectRoot, "examples/maplibre-quickstart/README.md"), "utf8");
    expect(quickstartReadme).toContain("../../samples/fixtures/first-map/v1");
    expect(quickstartReadme).not.toContain("../../test/fixtures/honua-quickstart-demo");
  });

  it("rejects unversioned fields, unknown versions, metadata drift, and file-set drift", () => {
    const root = temporaryPack("first-map");
    const manifestPath = path.join(root, "manifest.json");
    updateJson(manifestPath, (manifest) => {
      manifest.unreviewed = true;
    });
    expect(() => validateFixturePackDirectory(root, { allowMetadataChanges: true })).toThrow(/unknown field/i);

    updateJson(manifestPath, (manifest) => {
      delete manifest.unreviewed;
      manifest.fixturePackVersion = "honua.fixture-pack/v2";
      manifest.identity.revision = "v2";
    });
    expect(() => validateFixturePackDirectory(root, { allowMetadataChanges: true })).toThrow(/v1|version|revision/i);

    const licenseRoot = temporaryPack("first-map");
    const changedAttribution = "Changed without explicit acceptance";
    updateJson(path.join(licenseRoot, "manifest.json"), (manifest) => {
      manifest.license.attribution = changedAttribution;
    });
    updateJson(path.join(licenseRoot, "layer.json"), (layer) => {
      layer.copyrightText = changedAttribution;
    });
    for (const fileName of ["ogc-landing.json", "ogc-collection.json", "ogc-items.json"]) {
      updateJson(path.join(licenseRoot, fileName), (value) => {
        value.attribution = changedAttribution;
      });
    }
    expect(() => validateFixturePackDirectory(licenseRoot, { allowChecksumChanges: true })).toThrow(
      /metadata fingerprint/i,
    );
    const reviewed = validateFixturePackDirectory(licenseRoot, {
      allowChecksumChanges: true,
      allowMetadataChanges: true,
    });
    expect(reviewed.metadataChanges.license.before).not.toBe(reviewed.metadataChanges.license.after);

    const extraRoot = temporaryPack("first-map");
    fs.writeFileSync(path.join(extraRoot, "unlisted.json"), "{}\n");
    expect(() => validateFixturePackDirectory(extraRoot, { allowMetadataChanges: true })).toThrow(/exact sets/i);
  });

  it("persists checksum and metadata refresh approvals independently or in one preflighted batch", () => {
    const checksumFirstRoot = temporaryPack("first-map");
    const checksumFirstFixtures = introduceRefreshDrift(checksumFirstRoot);
    const preview = verifyFixturePacks({ fixturesRoot: checksumFirstFixtures });
    expect(preview.exitCode).toBe(1);
    expect(preview.report.reports[0]).toMatchObject({ wroteChecksums: false, acceptedMetadata: false });

    const checksumOnly = verifyFixturePacks({ fixturesRoot: checksumFirstFixtures, writeChecksums: true });
    expect(checksumOnly.exitCode).toBe(1);
    expect(checksumOnly.report.reports[0]).toMatchObject({ wroteChecksums: true, acceptedMetadata: false });
    const afterChecksum = validateFixturePackDirectory(checksumFirstRoot, { allowMetadataChanges: true });
    expect(afterChecksum.checksumChanges).toEqual([]);
    expect(afterChecksum.metadataChanged).toBe(true);

    const metadataSecond = verifyFixturePacks({ fixturesRoot: checksumFirstFixtures, acceptMetadata: true });
    expect(metadataSecond.exitCode).toBe(0);
    expect(metadataSecond.report.reports[0]).toMatchObject({ wroteChecksums: false, acceptedMetadata: true });
    expect(() => validateFixturePackDirectory(checksumFirstRoot)).not.toThrow();

    const metadataFirstRoot = temporaryPack("first-map");
    const metadataFirstFixtures = introduceRefreshDrift(metadataFirstRoot);
    const metadataOnly = verifyFixturePacks({ fixturesRoot: metadataFirstFixtures, acceptMetadata: true });
    expect(metadataOnly.exitCode).toBe(1);
    expect(metadataOnly.report.reports[0]).toMatchObject({ wroteChecksums: false, acceptedMetadata: true });
    const afterMetadata = validateFixturePackDirectory(metadataFirstRoot, { allowChecksumChanges: true });
    expect(afterMetadata.checksumChanges).not.toEqual([]);
    expect(afterMetadata.metadataChanged).toBe(false);
    expect(verifyFixturePacks({ fixturesRoot: metadataFirstFixtures, writeChecksums: true }).exitCode).toBe(0);
    expect(() => validateFixturePackDirectory(metadataFirstRoot)).not.toThrow();

    const combinedRoot = temporaryPack("first-map");
    const combinedFixtures = introduceRefreshDrift(combinedRoot);
    const combined = verifyFixturePacks({
      fixturesRoot: combinedFixtures,
      writeChecksums: true,
      acceptMetadata: true,
    });
    expect(combined.exitCode).toBe(0);
    expect(combined.report.reports[0]).toMatchObject({ wroteChecksums: true, acceptedMetadata: true });
    expect(() => validateFixturePackDirectory(combinedRoot)).not.toThrow();
    expect(verifyFixturePacks({ fixturesRoot: combinedFixtures }).exitCode).toBe(0);
    const refreshedManifest = fs.readFileSync(path.join(combinedRoot, "manifest.json"), "utf8");
    const formattedManifest = execFileSync(
      process.execPath,
      [
        path.join(projectRoot, "node_modules/@biomejs/biome/bin/biome"),
        "format",
        "--stdin-file-path",
        "samples/fixtures/generated-manifest.json",
      ],
      { cwd: projectRoot, encoding: "utf8", input: refreshedManifest, stdio: ["pipe", "pipe", "pipe"] },
    );
    expect(formattedManifest).toBe(refreshedManifest);
  });

  it("refreshes from descriptor-bound manifest bytes without reopening the manifest path", () => {
    const root = temporaryPack("first-map");
    const fixturesRoot = introduceRefreshDrift(root);
    const manifestPath = path.join(root, "manifest.json");
    const realReadFileSync = fs.readFileSync.bind(fs);
    const readSpy = vi.spyOn(fs, "readFileSync").mockImplementation(((file, options) => {
      if (path.resolve(String(file)) === manifestPath) throw new Error("unsafe manifest path reopen");
      return realReadFileSync(file, options as never);
    }) as typeof fs.readFileSync);
    try {
      expect(verifyFixturePacks({ fixturesRoot, writeChecksums: true, acceptMetadata: true }).exitCode).toBe(0);
    } finally {
      readSpy.mockRestore();
    }
  });

  it("fails closed when fixture data changes during refresh preflight or commit", () => {
    const preflightRoot = temporaryPack("first-map");
    const preflightFixtures = introduceRefreshDrift(preflightRoot);
    const preflightManifest = fs.readFileSync(path.join(preflightRoot, "manifest.json"), "utf8");
    const realWriteFileSync = fs.writeFileSync.bind(fs);
    let preflightInjected = false;
    const writeSpy = vi.spyOn(fs, "writeFileSync").mockImplementation(((file, data, options) => {
      realWriteFileSync(file, data, options as never);
      if (!preflightInjected && String(file).includes(".manifest-") && String(file).endsWith(".tmp")) {
        preflightInjected = true;
        const featuresPath = path.join(preflightRoot, "features.json");
        realWriteFileSync(featuresPath, `${fs.readFileSync(featuresPath, "utf8")}\n`);
      }
    }) as typeof fs.writeFileSync);
    try {
      expect(() =>
        verifyFixturePacks({
          fixturesRoot: preflightFixtures,
          writeChecksums: true,
          acceptMetadata: true,
        }),
      ).toThrow(/changed during refresh preflight/i);
    } finally {
      writeSpy.mockRestore();
    }
    expect(fs.readFileSync(path.join(preflightRoot, "manifest.json"), "utf8")).toBe(preflightManifest);
    expect(
      fs.readdirSync(preflightFixtures).some((name) => name.startsWith(".manifest-") || name.endsWith(".lock")),
    ).toBe(false);

    const commitRoot = temporaryPack("first-map");
    const commitFixtures = introduceRefreshDrift(commitRoot);
    const commitManifest = fs.readFileSync(path.join(commitRoot, "manifest.json"), "utf8");
    const realRenameSync = fs.renameSync.bind(fs);
    let commitInjected = false;
    const renameSpy = vi.spyOn(fs, "renameSync").mockImplementation((source, destination) => {
      realRenameSync(source, destination);
      if (!commitInjected && destination === path.join(commitRoot, "manifest.json")) {
        commitInjected = true;
        const featuresPath = path.join(commitRoot, "features.json");
        realWriteFileSync(featuresPath, `${fs.readFileSync(featuresPath, "utf8")}\n`);
      }
    });
    try {
      expect(() =>
        verifyFixturePacks({ fixturesRoot: commitFixtures, writeChecksums: true, acceptMetadata: true }),
      ).toThrow(/checksum|post-write integrity/i);
    } finally {
      renameSpy.mockRestore();
    }
    expect(fs.readFileSync(path.join(commitRoot, "manifest.json"), "utf8")).toBe(commitManifest);
    expect(fs.readdirSync(commitFixtures).some((name) => name.startsWith(".manifest-") || name.endsWith(".lock"))).toBe(
      false,
    );
    expect(verifyFixturePacks({ fixturesRoot: commitFixtures }).exitCode).toBe(1);
  });

  it("rolls back every applied manifest when a multi-pack refresh fails validation", () => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "honua-fixture-multi-refresh-"));
    temporaryRoots.push(temporary);
    const fixturesRoot = path.join(temporary, "fixtures");
    const roots = ["first-map", "incident-operations"].map((pack) => {
      const root = path.join(fixturesRoot, pack, "v1");
      fs.mkdirSync(path.dirname(root), { recursive: true });
      fs.cpSync(path.join(projectRoot, "samples/fixtures", pack, "v1"), root, { recursive: true });
      updateJson(path.join(root, "manifest.json"), (manifest) => {
        manifest.identity.title = `${manifest.identity.title} refresh`;
      });
      return root;
    });
    const originalManifests = new Map(
      roots.map((root) => [root, fs.readFileSync(path.join(root, "manifest.json"), "utf8")]),
    );
    const firstManifest = path.join(roots[0], "manifest.json");
    const firstData = path.join(roots[0], "features.json");
    const realRenameSync = fs.renameSync.bind(fs);
    let driftInjected = false;
    const renameSpy = vi.spyOn(fs, "renameSync").mockImplementation((source, destination) => {
      realRenameSync(source, destination);
      if (!driftInjected && destination === firstManifest) {
        driftInjected = true;
        fs.appendFileSync(firstData, "\n");
      }
    });
    try {
      expect(() => verifyFixturePacks({ fixturesRoot, acceptMetadata: true })).toThrow(
        /checksum|post-write integrity/i,
      );
    } finally {
      renameSpy.mockRestore();
    }
    for (const root of roots) {
      expect(fs.readFileSync(path.join(root, "manifest.json"), "utf8")).toBe(originalManifests.get(root));
    }
    expect(fs.readdirSync(fixturesRoot).some((name) => name.startsWith(".manifest-") || name.endsWith(".lock"))).toBe(
      false,
    );
  });

  it("rejects manifest and data growth while bounded fixture files are being read", () => {
    for (const targetName of ["manifest.json", "features.json"]) {
      const root = temporaryPack("first-map");
      const target = path.join(root, targetName);
      const targetIdentity = fs.lstatSync(target, { bigint: true });
      const realReadSync = fs.readSync.bind(fs);
      let injected = false;
      const readSpy = vi.spyOn(fs, "readSync").mockImplementation(((descriptor, buffer, offset, length, position) => {
        const bytesRead = realReadSync(descriptor, buffer, offset, length, position);
        const identity = fs.fstatSync(descriptor, { bigint: true });
        if (!injected && identity.dev === targetIdentity.dev && identity.ino === targetIdentity.ino) {
          injected = true;
          fs.appendFileSync(target, " ".repeat(targetName === "manifest.json" ? 128 * 1024 : 2 * 1024 * 1024));
        }
        return bytesRead;
      }) as typeof fs.readSync);
      try {
        expect(() =>
          validateFixturePackDirectory(root, { allowChecksumChanges: true, allowMetadataChanges: true }),
        ).toThrow(/128 KiB|2 MiB|changed while it was being read/i);
      } finally {
        readSpy.mockRestore();
      }
    }
  });

  it("rejects symlinks, oversized files, traversal references, and manifest/data identity drift", () => {
    const symlinkRoot = temporaryPack("first-map");
    fs.symlinkSync(path.join(symlinkRoot, "features.json"), path.join(symlinkRoot, "linked.json"));
    expect(() => validateFixturePackDirectory(symlinkRoot, { allowMetadataChanges: true })).toThrow(/regular files/i);

    const canonicalRoot = temporaryPack("first-map");
    expect(() => validateFixturePackDirectory(canonicalRoot)).not.toThrow();
    const aliasTemporary = fs.mkdtempSync(path.join(os.tmpdir(), "honua-fixture-ancestor-link-"));
    temporaryRoots.push(aliasTemporary);
    const aliasCanonicalRoot = path.join(aliasTemporary, "real", "fixtures", "first-map", "v1");
    fs.mkdirSync(path.dirname(aliasCanonicalRoot), { recursive: true });
    fs.cpSync(canonicalRoot, aliasCanonicalRoot, { recursive: true });
    fs.symlinkSync(path.join(aliasTemporary, "real"), path.join(aliasTemporary, "view"));
    expect(() =>
      validateFixturePackDirectory(path.join(aliasTemporary, "view", "fixtures", "first-map", "v1")),
    ).toThrow(/canonical real directories|real directory/i);

    const largeRoot = temporaryPack("first-map");
    fs.appendFileSync(path.join(largeRoot, "features.json"), " ".repeat(2 * 1024 * 1024));
    expect(() =>
      validateFixturePackDirectory(largeRoot, { allowChecksumChanges: true, allowMetadataChanges: true }),
    ).toThrow(/2 MiB/i);

    const traversalRoot = temporaryPack("first-map");
    updateJson(path.join(traversalRoot, "manifest.json"), (manifest) => {
      manifest.schema.files.features = "../features.json";
    });
    expect(() => validateFixturePackDirectory(traversalRoot, { allowMetadataChanges: true })).toThrow(
      /invalid|unsafe|exact sets/i,
    );

    const identityRoot = temporaryPack("first-map");
    updateJson(path.join(identityRoot, "manifest.json"), (manifest) => {
      manifest.identity.id = "incident-operations";
    });
    expect(() => validateFixturePackDirectory(identityRoot, { allowMetadataChanges: true })).toThrow(/directory id/i);
  });

  it("derives counts, extents, CRS/axis encoding, field consistency, ids, and event extent policy", () => {
    const missingCapabilitiesRoot = temporaryPack("first-map");
    fs.rmSync(path.join(missingCapabilitiesRoot, "capabilities.json"));
    updateJson(path.join(missingCapabilitiesRoot, "manifest.json"), (manifest) => {
      delete manifest.schema.files.capabilities;
      delete manifest.integrity.files["capabilities.json"];
    });
    expect(() =>
      validateFixturePackDirectory(missingCapabilitiesRoot, {
        allowChecksumChanges: true,
        allowMetadataChanges: true,
      }),
    ).toThrow(/logical file roles/i);

    const capabilitiesRoot = temporaryPack("first-map");
    updateJson(path.join(capabilitiesRoot, "capabilities.json"), (capabilities) => {
      capabilities.data.compatibility.serverVersion = "9.9.9";
      capabilities.data.compatibility.controlPlaneApi.major = 2;
    });
    expect(() =>
      validateFixturePackDirectory(capabilitiesRoot, {
        allowChecksumChanges: true,
        allowMetadataChanges: true,
      }),
    ).toThrow(/capabilities projection is incompatible/i);

    const firstMapGeometryRoot = temporaryPack("first-map");
    updateJson(path.join(firstMapGeometryRoot, "manifest.json"), (manifest) => {
      manifest.schema.geometryType = "Point";
    });
    expect(() =>
      validateFixturePackDirectory(firstMapGeometryRoot, {
        allowChecksumChanges: true,
        allowMetadataChanges: true,
      }),
    ).toThrow(/geometryType must be Polygon/i);

    const incidentGeometryRoot = temporaryPack("incident-operations");
    updateJson(path.join(incidentGeometryRoot, "manifest.json"), (manifest) => {
      manifest.schema.geometryType = "Polygon";
    });
    expect(() =>
      validateFixturePackDirectory(incidentGeometryRoot, {
        allowChecksumChanges: true,
        allowMetadataChanges: true,
      }),
    ).toThrow(/geometryType must be Point/i);

    const incidentProtocolRoot = temporaryPack("incident-operations");
    updateJson(path.join(incidentProtocolRoot, "manifest.json"), (manifest) => {
      manifest.schema.protocols = ["server-sent-events"];
    });
    expect(() =>
      validateFixturePackDirectory(incidentProtocolRoot, {
        allowChecksumChanges: true,
        allowMetadataChanges: true,
      }),
    ).toThrow(/exactly its supported realtime protocols/i);

    const countRoot = temporaryPack("first-map");
    updateJson(path.join(countRoot, "manifest.json"), (manifest) => {
      manifest.schema.featureCount = 4;
    });
    expect(() => validateFixturePackDirectory(countRoot, { allowMetadataChanges: true })).toThrow(/featureCount/i);

    const axisRoot = temporaryPack("first-map");
    updateJson(path.join(axisRoot, "manifest.json"), (manifest) => {
      manifest.schema.coordinateEncoding.axes = ["latitude", "longitude"];
    });
    expect(() => validateFixturePackDirectory(axisRoot, { allowMetadataChanges: true })).toThrow(/x\/y encoding/i);

    const projectionRoot = temporaryPack("first-map");
    updateJson(path.join(projectionRoot, "manifest.json"), (manifest) => {
      manifest.schema.projections[1].crs = "EPSG:4326";
    });
    expect(() => validateFixturePackDirectory(projectionRoot, { allowMetadataChanges: true })).toThrow(
      /protocol-specific CRS/i,
    );

    const apiRoot = temporaryPack("first-map");
    updateJson(path.join(apiRoot, "ogc-api-definition.json"), (definition) => {
      definition.paths["/collections/{collectionId}/items"].get.parameters = definition.paths[
        "/collections/{collectionId}/items"
      ].get.parameters.filter((parameter: { name: string }) => parameter.name !== "run");
    });
    expect(() =>
      validateFixturePackDirectory(apiRoot, { allowChecksumChanges: true, allowMetadataChanges: true }),
    ).toThrow(/supported items parameters|run selector/i);

    const fieldRoot = temporaryPack("first-map");
    updateJson(path.join(fieldRoot, "features.json"), (features) => {
      features.features[1].attributes.OBJECTID = 1;
    });
    expect(() =>
      validateFixturePackDirectory(fieldRoot, { allowChecksumChanges: true, allowMetadataChanges: true }),
    ).toThrow(/object ID.*unique/i);

    const layerFieldRoot = temporaryPack("first-map");
    updateJson(path.join(layerFieldRoot, "layer.json"), (layer) => {
      layer.fields.find((field: { name: string }) => field.name === "STATUS").type = "esriFieldTypeInteger";
    });
    expect(() =>
      validateFixturePackDirectory(layerFieldRoot, { allowChecksumChanges: true, allowMetadataChanges: true }),
    ).toThrow(/field declarations must match exactly/i);

    const layerAliasRoot = temporaryPack("first-map");
    updateJson(path.join(layerAliasRoot, "layer.json"), (layer) => {
      layer.fields.find((field: { name: string }) => field.name === "STATUS").alias = "Drifted status alias";
    });
    expect(() =>
      validateFixturePackDirectory(layerAliasRoot, { allowChecksumChanges: true, allowMetadataChanges: true }),
    ).toThrow(/field declarations must match exactly/i);

    const objectIdRoot = temporaryPack("first-map");
    updateJson(path.join(objectIdRoot, "features.json"), (features) => {
      features.objectIdFieldName = "NAME";
    });
    expect(() =>
      validateFixturePackDirectory(objectIdRoot, { allowChecksumChanges: true, allowMetadataChanges: true }),
    ).toThrow(/object ID fields must match/i);

    const extraAttributeRoot = temporaryPack("first-map");
    updateJson(path.join(extraAttributeRoot, "features.json"), (features) => {
      features.features[0].attributes.UNDECLARED = "drift";
    });
    expect(() =>
      validateFixturePackDirectory(extraAttributeRoot, { allowChecksumChanges: true, allowMetadataChanges: true }),
    ).toThrow(/attributes must exactly match/i);

    const ogcPropertyRoot = temporaryPack("first-map");
    updateJson(path.join(ogcPropertyRoot, "ogc-items.json"), (items) => {
      items.features[0].properties.STATUS = "Projection drift";
    });
    expect(() =>
      validateFixturePackDirectory(ogcPropertyRoot, { allowChecksumChanges: true, allowMetadataChanges: true }),
    ).toThrow(/properties drifted/i);

    const ogcAttributionRoot = temporaryPack("first-map");
    updateJson(path.join(ogcAttributionRoot, "ogc-collection.json"), (collection) => {
      collection.attribution = "Unreviewed attribution";
    });
    expect(() =>
      validateFixturePackDirectory(ogcAttributionRoot, { allowChecksumChanges: true, allowMetadataChanges: true }),
    ).toThrow(/attribution.*manifest/i);

    const eventRoot = temporaryPack("incident-operations");
    updateJson(path.join(eventRoot, "events.json"), (events) => {
      events.steps[1].feature.coordinate = [0, 0];
    });
    expect(() =>
      validateFixturePackDirectory(eventRoot, { allowChecksumChanges: true, allowMetadataChanges: true }),
    ).toThrow(/outside the declared extent/i);

    const threeDimensionalRoot = temporaryPack("first-map");
    updateJson(path.join(threeDimensionalRoot, "features.json"), (features) => {
      features.features[0].geometry.rings[0][0].push(100);
    });
    expect(() =>
      validateFixturePackDirectory(threeDimensionalRoot, { allowChecksumChanges: true, allowMetadataChanges: true }),
    ).toThrow(/exactly two finite numbers/i);

    const invalidChangeRoot = temporaryPack("incident-operations");
    updateJson(path.join(invalidChangeRoot, "events.json"), (events) => {
      events.steps[0].changes.severity = "catastrophic";
    });
    expect(() =>
      validateFixturePackDirectory(invalidChangeRoot, { allowChecksumChanges: true, allowMetadataChanges: true }),
    ).toThrow(/severity is invalid/i);

    const unsafeRecordRoot = temporaryPack("incident-operations");
    updateJson(path.join(unsafeRecordRoot, "snapshot.json"), (snapshot) => {
      snapshot.features[0].safeDemoRecord = true;
      snapshot.features[0].revision = "one";
    });
    expect(() =>
      validateFixturePackDirectory(unsafeRecordRoot, { allowChecksumChanges: true, allowMetadataChanges: true }),
    ).toThrow(/revision.*positive safe integer/i);

    const invalidFeatureTimeRoot = temporaryPack("incident-operations");
    updateJson(path.join(invalidFeatureTimeRoot, "snapshot.json"), (snapshot) => {
      snapshot.features[0].updatedAt = "2026-05-05";
    });
    expect(() =>
      validateFixturePackDirectory(invalidFeatureTimeRoot, {
        allowChecksumChanges: true,
        allowMetadataChanges: true,
      }),
    ).toThrow(/timestamps are invalid/i);

    const invalidEventTimeRoot = temporaryPack("incident-operations");
    updateJson(path.join(invalidEventTimeRoot, "events.json"), (events) => {
      events.steps[0].eventTime = "2026-02-31T00:00:00Z";
    });
    expect(() =>
      validateFixturePackDirectory(invalidEventTimeRoot, {
        allowChecksumChanges: true,
        allowMetadataChanges: true,
      }),
    ).toThrow(/eventTime values must be valid timestamps/i);
  });
});

describe("fixture canonicalization and response policy", () => {
  it("canonicalizes strict JSON and rejects cycles, undefined values, and non-finite numbers", () => {
    expect(canonicalJson({ z: 1, a: { y: 2, x: 3 } })).toBe('{"a":{"x":3,"y":2},"z":1}');
    expect(() => canonicalJson({ invalid: Number.NaN })).toThrow(/Non-finite/);
    expect(() => canonicalJson({ invalid: undefined })).toThrow(/Non-JSON/);
    const cyclic: any = {};
    cyclic.self = cyclic;
    expect(() => canonicalJson(cyclic)).toThrow(/Cyclic/);
    expect(() => fingerprint({} as unknown as string)).toThrow(/bounded string/);
  });

  it("does not let caller headers weaken CSP, loopback policy, cache policy, or framing", () => {
    const headers = fixtureHeaders({
      "cache-control": "public",
      "content-security-policy": "default-src *",
      "x-honua-fixture-network": "external",
      "content-type": "text/html",
      "content-length": "999",
      connection: "upgrade",
      "x-safe-extra": "kept",
    });
    expect(headers).toMatchObject({
      "cache-control": "no-store",
      "x-honua-fixture-network": "loopback-only",
      "x-safe-extra": "kept",
    });
    expect(headers["content-security-policy"]).toContain("connect-src 'self'");
    expect(headers).not.toHaveProperty("content-type");
    expect(headers).not.toHaveProperty("content-length");
    expect(headers).not.toHaveProperty("connection");
    expect(fixtureHeaders({}, "private-fresh")["cache-control"]).toBe("private, max-age=60");
    expect(fixtureHeaders({}, "private-revalidate")["cache-control"]).toBe("private, max-age=0, must-revalidate");
    expect(() => fixtureHeaders({ "cache-control": "public" }, "public" as never)).toThrow(/cache policy/i);

    const framed = fixtureResponseHeaders(
      { contentType: "application/json; charset=utf-8", contentLength: 4 },
      { "content-type": "text/html", "content-length": 999 },
    );
    expect(framed["content-type"]).toBe("application/json; charset=utf-8");
    expect(framed["content-length"]).toBe(4);
    expect(
      fixtureResponseHeaders({
        contentType: "application/vnd.oai.openapi+json;version=3.0; charset=utf-8",
      })["content-type"],
    ).toBe("application/vnd.oai.openapi+json;version=3.0; charset=utf-8");
  });
});
