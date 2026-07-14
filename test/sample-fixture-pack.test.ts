import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

import type { FormatsPlugin } from "ajv-formats";
import { Ajv2020 } from "ajv/dist/2020.js";
import { afterEach, describe, expect, it } from "vitest";

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
      expect(() => validateFixturePackDirectory(root)).not.toThrow();
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
    updateJson(path.join(licenseRoot, "manifest.json"), (manifest) => {
      manifest.license.attribution = "Changed without explicit acceptance";
    });
    expect(() => validateFixturePackDirectory(licenseRoot)).toThrow(/metadata fingerprint/i);
    const reviewed = validateFixturePackDirectory(licenseRoot, { allowMetadataChanges: true });
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
  });

  it("rejects symlinks, oversized files, traversal references, and manifest/data identity drift", () => {
    const symlinkRoot = temporaryPack("first-map");
    fs.symlinkSync(path.join(symlinkRoot, "features.json"), path.join(symlinkRoot, "linked.json"));
    expect(() => validateFixturePackDirectory(symlinkRoot, { allowMetadataChanges: true })).toThrow(/regular files/i);

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

    const fieldRoot = temporaryPack("first-map");
    updateJson(path.join(fieldRoot, "features.json"), (features) => {
      features.features[1].attributes.OBJECTID = 1;
    });
    expect(() =>
      validateFixturePackDirectory(fieldRoot, { allowChecksumChanges: true, allowMetadataChanges: true }),
    ).toThrow(/OBJECTID.*unique/i);

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

    const framed = fixtureResponseHeaders(
      { contentType: "application/json; charset=utf-8", contentLength: 4 },
      { "content-type": "text/html", "content-length": 999 },
    );
    expect(framed["content-type"]).toBe("application/json; charset=utf-8");
    expect(framed["content-length"]).toBe(4);
  });
});
