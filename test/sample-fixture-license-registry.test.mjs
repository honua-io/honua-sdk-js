import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

import { loadFixturePack } from "../samples/scenarios/fixture-pack.mjs";
import {
  assertRegisteredFixtureLicense,
  fixtureLicenseRecord,
} from "../samples/scenarios/fixture-license-registry.mjs";
import { validateFixturePackDirectory } from "../samples/scenarios/fixture-validation.mjs";
import { canonicalizeTigerPolygon } from "../scripts/refresh-first-map-tiger-v2.mjs";

function ringArea(ring) {
  let area = 0;
  for (let index = 0; index < ring.length - 1; index += 1) {
    area += ring[index][0] * ring[index + 1][1] - ring[index + 1][0] * ring[index][1];
  }
  return area / 2;
}

function copyV2Pack() {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "honua-first-map-v2-"));
  const root = path.join(temporary, "first-map", "v2");
  fs.mkdirSync(path.dirname(root), { recursive: true });
  fs.cpSync(path.resolve("samples/fixtures/first-map/v2"), root, { recursive: true });
  return { temporary, root };
}

function padJsonFile(filePath, targetBytes) {
  const current = fs.statSync(filePath).size;
  if (current > targetBytes) throw new Error(`${filePath} already exceeds its test target.`);
  fs.appendFileSync(filePath, Buffer.alloc(targetBytes - current, 0x20));
}

test("fixture license registry accepts only its two exact records", () => {
  for (const expression of ["Apache-2.0", "LicenseRef-US-Government-Work"]) {
    const record = fixtureLicenseRecord(expression);
    assert.equal(assertRegisteredFixtureLicense(record), record);
    assert.throws(() => assertRegisteredFixtureLicense({ ...record, termsUrl: "https://example.test/override" }), /exact/);
    assert.throws(() => assertRegisteredFixtureLicense({ ...record, shareAlikeRequired: true }), /exact/);
  }
  for (const expression of ["NOASSERTION", "MIT", "ODbL-1.0", "LicenseRef-Anything"]) {
    assert.throws(() => fixtureLicenseRecord(expression), /not registered/);
  }
});

test("TIGER canonicalization retains holes in both exact projections", () => {
  const fixture = JSON.parse(fs.readFileSync("test/fixtures/first-map/tiger-polygon-with-hole.json", "utf8"));
  assert.equal(fixture.sourceCrs, "EPSG:4269");
  const multiPolygon = canonicalizeTigerPolygon(fixture.rings);
  assert.equal(multiPolygon.length, 1);
  assert.equal(multiPolygon[0].length, 2);
  assert.ok(ringArea(multiPolygon[0][0]) > 0, "GeoJSON exterior must be counterclockwise");
  assert.ok(ringArea(multiPolygon[0][1]) < 0, "GeoJSON hole must be clockwise");
  const esriRings = multiPolygon.flat().map((ring) => [...ring].reverse());
  assert.deepEqual(
    esriRings.map((ring) => [...ring].reverse()),
    multiPolygon.flat(),
  );
});

test("v2 schema and validator bind the governed TIGER fixture", () => {
  const pack = loadFixturePack("first-map", "v2");
  assert.equal(pack.manifest.schema.featureCount, 48);
  assert.equal(pack.manifest.schema.selectedRecordId, 1);
  assert.equal(pack.manifest.license.expression, "LicenseRef-US-Government-Work");
  const items = pack.data[pack.manifest.schema.files.ogcItems];
  assert.deepEqual(
    items.features.map((feature) => feature.properties.GEOID),
    [...items.features.map((feature) => feature.properties.GEOID)].sort(),
  );
  assert.ok(items.features.every((feature) => feature.geometry.type === "MultiPolygon"));
  assert.ok(items.features.some((feature) => feature.geometry.coordinates.length > 1));
  assert.ok(items.features.some((feature) => feature.geometry.coordinates.some((polygon) => polygon.length > 1)));

  const schema = JSON.parse(fs.readFileSync("samples/fixtures/manifest.v2.schema.json", "utf8"));
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  assert.equal(ajv.compile(schema)(pack.manifest), true, JSON.stringify(ajv.errors));
});

test("v2 semantic parity rejects a projection-only geometry change", () => {
  const { temporary, root } = copyV2Pack();
  try {
    const itemsPath = path.join(root, "ogc-items.json");
    const items = JSON.parse(fs.readFileSync(itemsPath, "utf8"));
    items.features[0].geometry.coordinates[0][0][0][0] += 0.0000001;
    fs.writeFileSync(itemsPath, `${JSON.stringify(items, null, 2)}\n`);
    assert.throws(
      () => validateFixturePackDirectory(root, { allowChecksumChanges: true }),
      /rings must be closed|geometry drifted|extent does not match|canonical dataset/i,
    );
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("v2 rejects a data file one byte over its fixed 4 MiB ceiling", () => {
  const { temporary, root } = copyV2Pack();
  try {
    padJsonFile(path.join(root, "features.json"), 4 * 1024 * 1024 + 1);
    assert.throws(
      () => validateFixturePackDirectory(root, { allowChecksumChanges: true }),
      /exceeds 4 MiB: features\.json/,
    );
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("v2 rejects a pack one byte over its fixed 16 MiB ceiling", () => {
  const { temporary, root } = copyV2Pack();
  try {
    const names = [
      "capabilities.json",
      "features.json",
      "layer.json",
      "ogc-api-definition.json",
      "ogc-collection.json",
    ];
    let remaining = 16 * 1024 * 1024 + 1;
    for (const name of names) {
      const filePath = path.join(root, name);
      const current = fs.statSync(filePath).size;
      const target = Math.min(4 * 1024 * 1024, remaining);
      if (target > current) padJsonFile(filePath, target);
      remaining -= Math.max(current, target);
    }
    assert.ok(remaining <= 0, "test setup must cross the pack ceiling");
    assert.throws(
      () => validateFixturePackDirectory(root, { allowChecksumChanges: true }),
      /exceeds 16 MiB/,
    );
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});
