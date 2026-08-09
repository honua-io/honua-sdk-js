import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { canonicalJson, hasAsciiControlCharacters, parseRfc3339Instant } from "./determinism.mjs";
import { assertRegisteredFixtureLicense } from "./fixture-license-registry.mjs";
import { FIXTURE_RUN_ID_PATTERN_SOURCE } from "./identifiers.mjs";

const MAXIMUM_DATA_FILES = 16;
const MAXIMUM_V1_FILE_BYTES = 2 * 1024 * 1024;
const MAXIMUM_V1_PACK_BYTES = 8 * 1024 * 1024;
const MAXIMUM_V2_FILE_BYTES = 4 * 1024 * 1024;
const MAXIMUM_V2_PACK_BYTES = 16 * 1024 * 1024;
const READ_ONLY_NO_FOLLOW = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0);

function sameStableFile(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function readBoundedRegularFile(
  filePath,
  maximumBytes,
  description,
  limitMessage = `${description} exceeds ${maximumBytes} bytes.`,
) {
  const before = fs.lstatSync(filePath, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink()) throw new Error(`${description} must be a regular file.`);
  if (before.size > BigInt(maximumBytes)) throw new Error(limitMessage);

  let descriptor;
  try {
    descriptor = fs.openSync(filePath, READ_ONLY_NO_FOLLOW);
  } catch (error) {
    if (error?.code === "ELOOP") throw new Error(`${description} changed to a symlink while it was being opened.`);
    throw error;
  }
  try {
    const opened = fs.fstatSync(descriptor, { bigint: true });
    if (!opened.isFile() || !sameStableFile(before, opened)) {
      throw new Error(`${description} changed while it was being opened.`);
    }
    const chunks = [];
    let total = 0;
    while (true) {
      const remaining = maximumBytes + 1 - total;
      if (remaining <= 0) throw new Error(limitMessage);
      const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, remaining));
      const bytesRead = fs.readSync(descriptor, buffer, 0, buffer.byteLength, total);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > maximumBytes) throw new Error(limitMessage);
      chunks.push(buffer.subarray(0, bytesRead));
    }
    const completed = fs.fstatSync(descriptor, { bigint: true });
    const pathAfterRead = fs.lstatSync(filePath, { bigint: true });
    if (
      !sameStableFile(opened, completed) ||
      completed.size !== BigInt(total) ||
      !sameStableFile(completed, pathAfterRead) ||
      fs.realpathSync(filePath) !== filePath
    ) {
      throw new Error(`${description} changed while it was being read.`);
    }
    return Buffer.concat(chunks, total);
  } finally {
    fs.closeSync(descriptor);
  }
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function sorted(values) {
  return [...values].sort();
}

function sameValues(left, right) {
  return JSON.stringify(sorted(left)) === JSON.stringify(sorted(right));
}

function semanticHashes(manifest) {
  const { integrity: _integrity, ...semantics } = manifest;
  return {
    combined: sha256(canonicalJson(semantics)),
    license: sha256(canonicalJson(manifest.license)),
    provenance: sha256(canonicalJson(manifest.provenance)),
  };
}

function extentFromPositions(positions) {
  let extent = [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY];
  function visit(value) {
    if (!Array.isArray(value) || value.length === 0) {
      throw new Error("Fixture coordinate arrays must be non-empty.");
    }
    if (value.some((entry) => typeof entry === "number")) {
      if (value.length !== 2 || !value.every((entry) => typeof entry === "number" && Number.isFinite(entry))) {
        throw new Error("Fixture positions must contain exactly two finite numbers.");
      }
      const [x, y] = value;
      extent = [Math.min(extent[0], x), Math.min(extent[1], y), Math.max(extent[2], x), Math.max(extent[3], y)];
      return;
    }
    for (const entry of value) visit(entry);
  }
  visit(positions);
  if (!extent.every(Number.isFinite)) throw new Error("Fixture data does not contain a finite coordinate extent.");
  return extent;
}

function assertJsonEqual(actual, expected, message) {
  if (canonicalJson(actual) !== canonicalJson(expected)) throw new Error(message);
}

function assertPlainRecord(value, message) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(message);
}

function assertExactKeys(value, allowed, required, description) {
  assertPlainRecord(value, `${description} must be an object.`);
  for (const key of Object.keys(value))
    if (!allowed.includes(key)) throw new Error(`${description} has unknown field ${key}.`);
  for (const key of required) if (!Object.hasOwn(value, key)) throw new Error(`${description} is missing ${key}.`);
}

function assertBoundedString(value, description, maximum = 1024) {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum || hasAsciiControlCharacters(value)) {
    throw new Error(`${description} must be a bounded printable string.`);
  }
}

function validateCoordinateEncoding(encoding, description) {
  assertExactKeys(encoding, ["format", "axes", "order"], ["format", "axes", "order"], description);
  if (!["Esri JSON", "GeoJSON", "GeoJSON-compatible positions"].includes(encoding.format)) {
    throw new Error(`${description} format is unsupported.`);
  }
  if (!Array.isArray(encoding.axes) || encoding.axes.length !== 2) {
    throw new Error(`${description} axes are invalid.`);
  }
  encoding.axes.forEach((axis) => assertBoundedString(axis, `${description} axis`, 32));
  if (encoding.order !== "xy") throw new Error(`${description} order must be xy.`);
}

function validateManifestShapeV1(manifest) {
  assertExactKeys(
    manifest,
    ["fixturePackVersion", "identity", "schema", "provenance", "license", "freshness", "integrity"],
    ["fixturePackVersion", "identity", "schema", "provenance", "license", "freshness", "integrity"],
    "Fixture manifest",
  );
  if (manifest.fixturePackVersion !== "honua.fixture-pack/v1")
    throw new Error("Only fixture manifest v1 is supported.");
  assertExactKeys(
    manifest.identity,
    ["id", "version", "revision", "title"],
    ["id", "version", "revision", "title"],
    "Fixture identity",
  );
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(manifest.identity.id)) throw new Error("Fixture identity id is invalid.");
  if (!/^\d+\.\d+\.\d+$/.test(manifest.identity.version) || manifest.identity.revision !== "v1") {
    throw new Error("Fixture identity version/revision is invalid.");
  }
  assertBoundedString(manifest.identity.title, "Fixture title", 160);
  assertExactKeys(
    manifest.schema,
    [
      "protocols",
      "geometryType",
      "authorityCrs",
      "coordinateEncoding",
      "projections",
      "extent",
      "featureCount",
      "editableRecordId",
      "eventCount",
      "eventExtentPolicy",
      "files",
    ],
    ["protocols", "geometryType", "authorityCrs", "coordinateEncoding", "extent", "featureCount", "files"],
    "Fixture schema",
  );
  const protocols = new Set([
    "honua-capabilities-v1",
    "esri-geoservices-feature-server",
    "ogc-api-features-1.0",
    "server-sent-events",
    "honua-realtime-feature-events",
  ]);
  if (
    !Array.isArray(manifest.schema.protocols) ||
    manifest.schema.protocols.length < 1 ||
    manifest.schema.protocols.length > 8
  ) {
    throw new Error("Fixture schema protocols are invalid.");
  }
  assertUnique(manifest.schema.protocols, "Fixture schema protocols must be unique.");
  if (manifest.schema.protocols.some((protocol) => !protocols.has(protocol)))
    throw new Error("Fixture schema protocol is unsupported.");
  if (!["Point", "Polygon"].includes(manifest.schema.geometryType))
    throw new Error("Fixture geometryType is unsupported.");
  if (!["EPSG:4326", "OGC:CRS84"].includes(manifest.schema.authorityCrs))
    throw new Error("Fixture authorityCrs is unsupported.");
  validateCoordinateEncoding(manifest.schema.coordinateEncoding, "Fixture coordinate encoding");
  if (manifest.schema.projections !== undefined) {
    if (
      !Array.isArray(manifest.schema.projections) ||
      manifest.schema.projections.length < 1 ||
      manifest.schema.projections.length > 8
    ) {
      throw new Error("Fixture schema projections are invalid.");
    }
    const projectionProtocols = [];
    for (const [index, projection] of manifest.schema.projections.entries()) {
      const description = `Fixture projection ${index}`;
      assertExactKeys(
        projection,
        ["protocol", "crs", "coordinateEncoding"],
        ["protocol", "crs", "coordinateEncoding"],
        description,
      );
      if (!protocols.has(projection.protocol) || !manifest.schema.protocols.includes(projection.protocol)) {
        throw new Error(`${description} protocol must be declared by the fixture schema.`);
      }
      if (!["EPSG:4326", "OGC:CRS84"].includes(projection.crs)) {
        throw new Error(`${description} CRS is unsupported.`);
      }
      validateCoordinateEncoding(projection.coordinateEncoding, `${description} coordinate encoding`);
      projectionProtocols.push(projection.protocol);
    }
    assertUnique(projectionProtocols, "Fixture projection protocols must be unique.");
  }
  if (
    !Array.isArray(manifest.schema.extent) ||
    manifest.schema.extent.length !== 4 ||
    !manifest.schema.extent.every(Number.isFinite)
  ) {
    throw new Error("Fixture extent is invalid.");
  }
  if (
    !Number.isSafeInteger(manifest.schema.featureCount) ||
    manifest.schema.featureCount < 0 ||
    manifest.schema.featureCount > 100_000
  ) {
    throw new Error("Fixture featureCount is invalid.");
  }
  if (
    manifest.schema.editableRecordId !== undefined &&
    (!Number.isSafeInteger(manifest.schema.editableRecordId) || manifest.schema.editableRecordId < 1)
  ) {
    throw new Error("Fixture editableRecordId is invalid.");
  }
  if (
    manifest.schema.eventCount !== undefined &&
    (!Number.isSafeInteger(manifest.schema.eventCount) ||
      manifest.schema.eventCount < 0 ||
      manifest.schema.eventCount > 100_000)
  ) {
    throw new Error("Fixture eventCount is invalid.");
  }
  assertPlainRecord(manifest.schema.files, "Fixture schema files must be an object.");
  const schemaFileNames = Object.values(manifest.schema.files);
  if (schemaFileNames.length < 1 || schemaFileNames.length > MAXIMUM_DATA_FILES)
    throw new Error("Fixture schema file count is invalid.");
  for (const name of schemaFileNames) {
    if (typeof name !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(name)) {
      throw new Error("Fixture schema file name is invalid.");
    }
  }

  assertExactKeys(
    manifest.provenance,
    ["source", "retrievedAt", "transformation", "refreshCommand"],
    ["source", "retrievedAt", "transformation", "refreshCommand"],
    "Fixture provenance",
  );
  assertBoundedString(manifest.provenance.source, "Fixture provenance source", 512);
  assertBoundedString(manifest.provenance.transformation, "Fixture provenance transformation", 1024);
  assertBoundedString(manifest.provenance.refreshCommand, "Fixture provenance refresh command", 512);
  if (parseRfc3339Instant(manifest.provenance.retrievedAt) === undefined)
    throw new Error("Fixture provenance time is invalid.");
  assertExactKeys(
    manifest.license,
    ["spdx", "attribution", "redistributionAllowed"],
    ["spdx", "attribution", "redistributionAllowed"],
    "Fixture license",
  );
  if (manifest.license.spdx !== "Apache-2.0" || manifest.license.redistributionAllowed !== true) {
    throw new Error("Fixture license is unsupported.");
  }
  assertBoundedString(manifest.license.attribution, "Fixture attribution", 1024);
  assertExactKeys(
    manifest.freshness,
    ["policy", "asOf", "refreshAfterDays"],
    ["policy", "asOf", "refreshAfterDays"],
    "Fixture freshness",
  );
  if (manifest.freshness.policy !== "immutable" || manifest.freshness.refreshAfterDays !== null) {
    throw new Error("Fixture freshness policy is unsupported.");
  }
  if (parseRfc3339Instant(manifest.freshness.asOf) === undefined) throw new Error("Fixture freshness time is invalid.");
  assertExactKeys(
    manifest.integrity,
    ["algorithm", "canonicalization", "metadataFingerprint", "metadataComponents", "files"],
    ["algorithm", "canonicalization", "metadataFingerprint", "metadataComponents", "files"],
    "Fixture integrity",
  );
  if (manifest.integrity.algorithm !== "sha256") throw new Error("Fixture integrity algorithm is unsupported.");
  assertBoundedString(manifest.integrity.canonicalization, "Fixture canonicalization", 1024);
  if (!/^[a-f0-9]{64}$/.test(manifest.integrity.metadataFingerprint))
    throw new Error("Fixture metadata fingerprint is invalid.");
  assertExactKeys(
    manifest.integrity.metadataComponents,
    ["license", "provenance"],
    ["license", "provenance"],
    "Fixture metadata components",
  );
  for (const hash of Object.values(manifest.integrity.metadataComponents)) {
    if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error("Fixture metadata component hash is invalid.");
  }
  assertPlainRecord(manifest.integrity.files, "Fixture integrity files must be an object.");
  for (const hash of Object.values(manifest.integrity.files)) {
    if (typeof hash !== "string" || !/^[a-f0-9]{64}$/.test(hash)) throw new Error("Fixture file checksum is invalid.");
  }
}

function assertSha256(value, description) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
    throw new Error(`${description} must be a lowercase SHA-256 digest.`);
  }
}

function validateManifestShapeV2(manifest) {
  assertExactKeys(
    manifest,
    ["fixturePackVersion", "identity", "schema", "provenance", "license", "freshness", "integrity"],
    ["fixturePackVersion", "identity", "schema", "provenance", "license", "freshness", "integrity"],
    "Fixture manifest",
  );
  if (manifest.fixturePackVersion !== "honua.fixture-pack/v2") throw new Error("Fixture manifest is not v2.");
  assertExactKeys(
    manifest.identity,
    ["id", "version", "revision", "title"],
    ["id", "version", "revision", "title"],
    "Fixture identity",
  );
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(manifest.identity.id)) throw new Error("Fixture identity id is invalid.");
  if (!/^\d+\.\d+\.\d+$/.test(manifest.identity.version) || manifest.identity.revision !== "v2") {
    throw new Error("Fixture identity version/revision is invalid.");
  }
  assertBoundedString(manifest.identity.title, "Fixture title", 160);
  assertExactKeys(
    manifest.schema,
    [
      "protocols",
      "geometryType",
      "authorityCrs",
      "coordinateEncoding",
      "projections",
      "extent",
      "featureCount",
      "selectedRecordId",
      "files",
    ],
    [
      "protocols",
      "geometryType",
      "authorityCrs",
      "coordinateEncoding",
      "projections",
      "extent",
      "featureCount",
      "selectedRecordId",
      "files",
    ],
    "Fixture schema",
  );
  if (!Array.isArray(manifest.schema.protocols) || manifest.schema.protocols.length !== 3) {
    throw new Error("Fixture schema protocols are invalid.");
  }
  assertUnique(manifest.schema.protocols, "Fixture schema protocols must be unique.");
  if (manifest.schema.geometryType !== "MultiPolygon" || manifest.schema.authorityCrs !== "EPSG:4326") {
    throw new Error("Fixture v2 geometry or authority CRS is unsupported.");
  }
  validateCoordinateEncoding(manifest.schema.coordinateEncoding, "Fixture coordinate encoding");
  if (!Array.isArray(manifest.schema.projections) || manifest.schema.projections.length !== 2) {
    throw new Error("Fixture schema projections are invalid.");
  }
  for (const [index, projection] of manifest.schema.projections.entries()) {
    assertExactKeys(
      projection,
      ["protocol", "crs", "coordinateEncoding"],
      ["protocol", "crs", "coordinateEncoding"],
      `Fixture projection ${index}`,
    );
    validateCoordinateEncoding(projection.coordinateEncoding, `Fixture projection ${index} coordinate encoding`);
  }
  if (
    !Array.isArray(manifest.schema.extent) ||
    manifest.schema.extent.length !== 4 ||
    !manifest.schema.extent.every(Number.isFinite)
  ) {
    throw new Error("Fixture extent is invalid.");
  }
  if (
    manifest.schema.featureCount !== 48 ||
    !Number.isSafeInteger(manifest.schema.selectedRecordId) ||
    manifest.schema.selectedRecordId < 1 ||
    manifest.schema.selectedRecordId > 48
  ) {
    throw new Error("Fixture v2 count or selectedRecordId is invalid.");
  }
  assertPlainRecord(manifest.schema.files, "Fixture schema files must be an object.");
  if (Object.values(manifest.schema.files).length !== 8)
    throw new Error("Fixture v2 must declare exactly eight files.");
  for (const name of Object.values(manifest.schema.files)) {
    if (typeof name !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(name)) {
      throw new Error("Fixture schema file name is invalid.");
    }
  }

  assertExactKeys(
    manifest.provenance,
    [
      "sourceUrl",
      "sourceSha256",
      "sourceBytes",
      "retrievedAt",
      "sourceVintage",
      "selection",
      "transformation",
      "toolchain",
      "refreshCommand",
    ],
    [
      "sourceUrl",
      "sourceSha256",
      "sourceBytes",
      "retrievedAt",
      "sourceVintage",
      "selection",
      "transformation",
      "toolchain",
      "refreshCommand",
    ],
    "Fixture provenance",
  );
  if (typeof manifest.provenance.sourceUrl !== "string" || !manifest.provenance.sourceUrl.startsWith("https://")) {
    throw new Error("Fixture provenance sourceUrl must be HTTPS.");
  }
  assertSha256(manifest.provenance.sourceSha256, "Fixture source digest");
  if (!Number.isSafeInteger(manifest.provenance.sourceBytes) || manifest.provenance.sourceBytes < 1) {
    throw new Error("Fixture source byte length is invalid.");
  }
  if (
    parseRfc3339Instant(manifest.provenance.retrievedAt) === undefined ||
    !/^\d{4}-\d{2}-\d{2}$/.test(manifest.provenance.sourceVintage)
  ) {
    throw new Error("Fixture provenance dates are invalid.");
  }
  assertExactKeys(
    manifest.provenance.selection,
    ["field", "equals", "sort"],
    ["field", "equals", "sort"],
    "Fixture provenance selection",
  );
  assertExactKeys(
    manifest.provenance.transformation,
    [
      "id",
      "sourceCrs",
      "targetCrs",
      "coordinatePrecision",
      "geometryNormalization",
      "attributeSelection",
      "objectIdAssignment",
    ],
    [
      "id",
      "sourceCrs",
      "targetCrs",
      "coordinatePrecision",
      "geometryNormalization",
      "attributeSelection",
      "objectIdAssignment",
    ],
    "Fixture provenance transformation",
  );
  assertBoundedString(manifest.provenance.transformation.geometryNormalization, "Geometry normalization", 1024);
  assertExactKeys(
    manifest.provenance.toolchain,
    ["node", "projection", "archive", "parser"],
    ["node", "projection", "archive", "parser"],
    "Fixture provenance toolchain",
  );
  for (const [name, value] of Object.entries(manifest.provenance.toolchain)) {
    assertBoundedString(value, `Fixture toolchain ${name}`, 160);
  }
  assertBoundedString(manifest.provenance.refreshCommand, "Fixture refresh command", 512);
  assertRegisteredFixtureLicense(manifest.license);

  assertExactKeys(
    manifest.freshness,
    ["policy", "asOf", "refreshAfterDays"],
    ["policy", "asOf", "refreshAfterDays"],
    "Fixture freshness",
  );
  if (
    manifest.freshness.policy !== "immutable" ||
    manifest.freshness.refreshAfterDays !== null ||
    parseRfc3339Instant(manifest.freshness.asOf) === undefined
  ) {
    throw new Error("Fixture freshness is invalid.");
  }
  assertExactKeys(
    manifest.integrity,
    ["algorithm", "canonicalization", "canonicalDatasetSha256", "metadataFingerprint", "metadataComponents", "files"],
    ["algorithm", "canonicalization", "canonicalDatasetSha256", "metadataFingerprint", "metadataComponents", "files"],
    "Fixture integrity",
  );
  if (manifest.integrity.algorithm !== "sha256") throw new Error("Fixture integrity algorithm is unsupported.");
  assertBoundedString(manifest.integrity.canonicalization, "Fixture canonicalization", 1024);
  assertSha256(manifest.integrity.canonicalDatasetSha256, "Fixture canonical dataset digest");
  assertSha256(manifest.integrity.metadataFingerprint, "Fixture metadata fingerprint");
  assertExactKeys(
    manifest.integrity.metadataComponents,
    ["license", "provenance"],
    ["license", "provenance"],
    "Fixture metadata components",
  );
  for (const hash of Object.values(manifest.integrity.metadataComponents))
    assertSha256(hash, "Fixture metadata digest");
  assertPlainRecord(manifest.integrity.files, "Fixture integrity files must be an object.");
  for (const hash of Object.values(manifest.integrity.files)) assertSha256(hash, "Fixture file digest");
}

function assertUnique(values, message) {
  if (new Set(values).size !== values.length) throw new Error(message);
}

function linkHref(links, relation, description) {
  if (!Array.isArray(links)) throw new Error(`${description} links must be an array.`);
  const matches = links.filter((link) => link?.rel === relation && typeof link.href === "string");
  if (matches.length !== 1) throw new Error(`${description} must advertise exactly one ${relation} link.`);
  return matches[0].href;
}

function assertIncidentFeature(feature, description) {
  const required = [
    "id",
    "title",
    "type",
    "severity",
    "status",
    "assignedTo",
    "updatedAt",
    "reportedAt",
    "coordinate",
    "etaMinutes",
    "affectedAssets",
    "summary",
    "relatedRecords",
    "attachments",
  ];
  assertExactKeys(feature, [...required, "revision", "safeDemoRecord"], required, description);
  for (const name of ["id", "title", "type", "assignedTo", "summary"]) {
    assertBoundedString(feature[name], `${description}.${name}`, name === "summary" ? 1024 : 160);
  }
  if (!["critical", "high", "medium", "low"].includes(feature.severity))
    throw new Error(`${description}.severity is invalid.`);
  if (!["open", "assigned", "monitoring", "resolved"].includes(feature.status))
    throw new Error(`${description}.status is invalid.`);
  if (
    typeof feature.updatedAt !== "string" ||
    typeof feature.reportedAt !== "string" ||
    parseRfc3339Instant(feature.updatedAt) === undefined ||
    parseRfc3339Instant(feature.reportedAt) === undefined
  ) {
    throw new Error(`${description} timestamps are invalid.`);
  }
  if (
    !Array.isArray(feature.coordinate) ||
    feature.coordinate.length !== 2 ||
    !feature.coordinate.every(Number.isFinite)
  ) {
    throw new Error(`${description}.coordinate must be a finite position.`);
  }
  if (
    !Number.isSafeInteger(feature.etaMinutes) ||
    feature.etaMinutes < 0 ||
    !Number.isSafeInteger(feature.affectedAssets) ||
    feature.affectedAssets < 0
  ) {
    throw new Error(`${description} metrics must be non-negative safe integers.`);
  }
  if (!Array.isArray(feature.relatedRecords) || !Array.isArray(feature.attachments)) {
    throw new Error(`${description} relations and attachments must be arrays.`);
  }
  for (const [index, related] of feature.relatedRecords.entries()) {
    assertExactKeys(
      related,
      ["id", "label", "status"],
      ["id", "label", "status"],
      `${description}.relatedRecords[${index}]`,
    );
    for (const name of ["id", "label", "status"])
      assertBoundedString(related[name], `${description}.relatedRecords[${index}].${name}`, 160);
  }
  for (const [index, attachment] of feature.attachments.entries()) {
    assertExactKeys(attachment, ["id", "name", "kind"], ["id", "name", "kind"], `${description}.attachments[${index}]`);
    for (const name of ["id", "name", "kind"])
      assertBoundedString(attachment[name], `${description}.attachments[${index}].${name}`, 160);
  }
  if (feature.revision !== undefined && (!Number.isSafeInteger(feature.revision) || feature.revision < 1)) {
    throw new Error(`${description}.revision must be a positive safe integer.`);
  }
  if (feature.safeDemoRecord !== undefined && feature.safeDemoRecord !== true) {
    throw new Error(`${description}.safeDemoRecord may only be the boolean true.`);
  }
  if (feature.safeDemoRecord === true && feature.revision === undefined) {
    throw new Error(`${description} safe demo records require a revision.`);
  }
}

function validateIncidentChanges(changes, description) {
  assertPlainRecord(changes, `${description} must be an object.`);
  const names = Object.keys(changes);
  if (names.length < 1) throw new Error(`${description} must contain at least one change.`);
  const allowed = new Set(["severity", "status", "assignedTo", "etaMinutes", "affectedAssets", "summary"]);
  for (const name of names) {
    if (!allowed.has(name)) throw new Error(`${description} has unsupported field ${name}.`);
  }
  if (Object.hasOwn(changes, "severity") && !["critical", "high", "medium", "low"].includes(changes.severity)) {
    throw new Error(`${description}.severity is invalid.`);
  }
  if (Object.hasOwn(changes, "status") && !["open", "assigned", "monitoring", "resolved"].includes(changes.status)) {
    throw new Error(`${description}.status is invalid.`);
  }
  for (const name of ["assignedTo", "summary"]) {
    if (Object.hasOwn(changes, name))
      assertBoundedString(changes[name], `${description}.${name}`, name === "summary" ? 1024 : 160);
  }
  for (const name of ["etaMinutes", "affectedAssets"]) {
    if (Object.hasOwn(changes, name) && (!Number.isSafeInteger(changes[name]) || changes[name] < 0)) {
      throw new Error(`${description}.${name} must be a non-negative safe integer.`);
    }
  }
}

function validateFirstMapV1(manifest, data) {
  const expectedFileRoles = [
    "capabilities",
    "features",
    "layer",
    "ogcApiDefinition",
    "ogcCollection",
    "ogcConformance",
    "ogcItems",
    "ogcLanding",
  ];
  if (!sameValues(Object.keys(manifest.schema.files), expectedFileRoles)) {
    throw new Error("First Map fixture logical file roles are incomplete or unsupported.");
  }
  const capabilities = data[manifest.schema.files.capabilities];
  const features = data[manifest.schema.files.features];
  const layer = data[manifest.schema.files.layer];
  const ogcLanding = data[manifest.schema.files.ogcLanding];
  const ogcApiDefinition = data[manifest.schema.files.ogcApiDefinition];
  const ogcConformance = data[manifest.schema.files.ogcConformance];
  const ogcCollection = data[manifest.schema.files.ogcCollection];
  const ogcItems = data[manifest.schema.files.ogcItems];
  if (
    !capabilities ||
    !features ||
    !layer ||
    !ogcLanding ||
    !ogcApiDefinition ||
    !ogcConformance ||
    !ogcCollection ||
    !ogcItems
  ) {
    throw new Error("First Map fixture is missing a GeoServices or OGC API Features projection file.");
  }
  if (manifest.schema.geometryType !== "Polygon") {
    throw new Error("First Map manifest geometryType must be Polygon.");
  }
  if (
    !sameValues(manifest.schema.protocols, [
      "honua-capabilities-v1",
      "esri-geoservices-feature-server",
      "ogc-api-features-1.0",
    ])
  ) {
    throw new Error("First Map must declare both GeoServices and OGC API Features projections.");
  }
  assertJsonEqual(
    capabilities,
    {
      success: true,
      data: {
        metadataApiVersions: ["honua.io/v1alpha1"],
        resourceKinds: ["Layer"],
        compatibility: {
          serverVersion: "1.2.0",
          releaseChannel: "stable",
          controlPlaneApi: { major: 1, basePath: "/api/v1/admin", deprecated: false },
          metadataSchemas: [{ version: "honua.io/v1alpha1", deprecated: false }],
          features: {
            metadataResources: true,
            manifestExport: true,
            manifestApply: true,
            manifestDryRun: true,
            manifestPrune: true,
          },
        },
      },
    },
    "First Map capabilities projection is incompatible with the immutable v1 baseline.",
  );
  if (features.features.length !== manifest.schema.featureCount)
    throw new Error("First Map featureCount does not match payload.");
  if (features.spatialReference?.wkid !== 4326 || manifest.schema.authorityCrs !== "EPSG:4326") {
    throw new Error("First Map authority CRS must match the Esri spatial reference.");
  }
  assertJsonEqual(
    manifest.schema.coordinateEncoding,
    { format: "Esri JSON", axes: ["x-longitude", "y-latitude"], order: "xy" },
    "First Map must declare Esri x/y encoding separately from its authority CRS.",
  );
  assertJsonEqual(
    manifest.schema.projections,
    [
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
    ],
    "First Map must declare protocol-specific CRS and coordinate encodings.",
  );
  const extent = extentFromPositions(features.features.map((feature) => feature.geometry?.rings));
  assertJsonEqual(extent, manifest.schema.extent, "First Map extent does not match feature coordinates.");
  assertJsonEqual(
    [layer.extent.xmin, layer.extent.ymin, layer.extent.xmax, layer.extent.ymax],
    manifest.schema.extent,
    "First Map layer extent does not match manifest extent.",
  );
  if (features.geometryType !== "esriGeometryPolygon" || layer.geometryType !== "esriGeometryPolygon") {
    throw new Error("First Map payload and layer must both declare polygon geometry.");
  }
  if (layer.extent.spatialReference?.wkid !== 4326) throw new Error("First Map layer extent CRS must be EPSG:4326.");
  if (layer.capabilities !== "Query")
    throw new Error("First Map baseline GeoServices layer must advertise Query only.");
  if (!Number.isSafeInteger(layer.maxRecordCount) || layer.maxRecordCount < manifest.schema.featureCount) {
    throw new Error("First Map baseline GeoServices layer record bound is invalid.");
  }
  if (
    layer.advancedQueryCapabilities?.supportsPagination !== true ||
    layer.advancedQueryCapabilities.supportsReturningQueryExtent !== false ||
    layer.advancedQueryCapabilities.supportsStatistics !== false
  ) {
    throw new Error("First Map baseline GeoServices query capability metadata is incomplete.");
  }
  if (!Array.isArray(features.fields) || !Array.isArray(layer.fields)) {
    throw new Error("First Map query and layer fields must be arrays.");
  }
  const queryFieldDefinitions = features.fields.map((field) => ({ name: field.name, type: field.type }));
  const layerFieldDefinitions = layer.fields.map((field) => ({ name: field.name, type: field.type }));
  const fieldNames = queryFieldDefinitions.map((field) => field.name);
  const layerFieldNames = layerFieldDefinitions.map((field) => field.name);
  assertUnique(fieldNames, "First Map query field names must be unique.");
  assertUnique(layerFieldNames, "First Map layer field names must be unique.");
  assertJsonEqual(features.fields, layer.fields, "First Map query and layer field declarations must match exactly.");
  if (features.objectIdFieldName !== layer.objectIdField) {
    throw new Error("First Map query and layer object ID fields must match.");
  }
  const objectIdFields = queryFieldDefinitions.filter((field) => field.type === "esriFieldTypeOID");
  if (objectIdFields.length !== 1 || objectIdFields[0].name !== features.objectIdFieldName) {
    throw new Error("First Map must declare exactly one matching object ID field.");
  }
  const objectIdFieldName = features.objectIdFieldName;
  const objectIds = [];
  for (const [index, feature] of features.features.entries()) {
    assertPlainRecord(feature.attributes, `First Map feature ${index} attributes are invalid.`);
    if (!sameValues(Object.keys(feature.attributes), fieldNames)) {
      throw new Error(`First Map feature ${index} attributes must exactly match the declared fields.`);
    }
    if (!Array.isArray(feature.geometry?.rings) || feature.geometry.rings.length < 1) {
      throw new Error(`First Map feature ${index} must contain polygon rings.`);
    }
    for (const ring of feature.geometry.rings) {
      if (!Array.isArray(ring) || ring.length < 4) throw new Error(`First Map feature ${index} ring is invalid.`);
      assertJsonEqual(ring[0], ring.at(-1), `First Map feature ${index} ring must be closed.`);
    }
    for (const field of features.fields) {
      if (!Object.hasOwn(feature.attributes, field.name))
        throw new Error(`First Map feature ${index} is missing ${field.name}.`);
      const value = feature.attributes[field.name];
      if (field.type === "esriFieldTypeOID" && !Number.isSafeInteger(value))
        throw new Error("First Map OID must be an integer.");
      if (field.type === "esriFieldTypeString" && typeof value !== "string")
        throw new Error("First Map string field is invalid.");
    }
    objectIds.push(feature.attributes[objectIdFieldName]);
  }
  assertUnique(objectIds, "First Map object ID values must be unique.");
  if (!objectIds.includes(manifest.schema.editableRecordId)) {
    throw new Error("First Map editableRecordId must identify a fixture feature.");
  }

  const expectedProvenance = {
    source: manifest.provenance.source,
    retrievedAt: manifest.provenance.retrievedAt,
  };
  if (layer.copyrightText !== manifest.license.attribution) {
    throw new Error("First Map GeoServices attribution must match the fixture manifest.");
  }
  assertJsonEqual(
    layer.provenance,
    expectedProvenance,
    "First Map GeoServices provenance must match the fixture manifest.",
  );
  for (const [description, metadata] of [
    ["landing page", ogcLanding],
    ["collection", ogcCollection],
    ["items response", ogcItems],
  ]) {
    if (metadata.attribution !== manifest.license.attribution) {
      throw new Error(`First Map OGC ${description} attribution must match the fixture manifest.`);
    }
    assertJsonEqual(
      metadata.provenance,
      expectedProvenance,
      `First Map OGC ${description} provenance must match the fixture manifest.`,
    );
  }

  if (linkHref(ogcLanding.links, "self", "First Map OGC landing page") !== "/ogc/features") {
    throw new Error("First Map OGC landing self link is invalid.");
  }
  if (linkHref(ogcLanding.links, "conformance", "First Map OGC landing page") !== "/ogc/features/conformance") {
    throw new Error("First Map OGC landing conformance link is invalid.");
  }
  if (linkHref(ogcLanding.links, "data", "First Map OGC landing page") !== "/ogc/features/collections") {
    throw new Error("First Map OGC landing data link is invalid.");
  }
  if (linkHref(ogcLanding.links, "service-desc", "First Map OGC landing page") !== "/ogc/features/api") {
    throw new Error("First Map OGC landing service description link is invalid.");
  }
  if (
    !sameValues(ogcConformance.conformsTo, [
      "http://www.opengis.net/spec/ogcapi-features-1/1.0/conf/core",
      "http://www.opengis.net/spec/ogcapi-features-1/1.0/conf/geojson",
    ])
  ) {
    throw new Error("First Map OGC baseline conformance must truthfully advertise Features Core and GeoJSON.");
  }
  if (ogcApiDefinition.openapi !== "3.0.3" || ogcApiDefinition.servers?.[0]?.url !== "/ogc/features") {
    throw new Error("First Map OGC API definition must be a bounded OpenAPI 3.0 service description.");
  }
  const expectedApiPaths = [
    "/",
    "/api",
    "/collections",
    "/collections/{collectionId}",
    "/collections/{collectionId}/items",
    "/collections/{collectionId}/items/{featureId}",
    "/conformance",
  ];
  if (!sameValues(Object.keys(ogcApiDefinition.paths ?? {}), expectedApiPaths)) {
    throw new Error("First Map OGC API definition paths must exactly match implemented routes.");
  }
  const itemParameters = ogcApiDefinition.paths["/collections/{collectionId}/items"].get?.parameters;
  if (!Array.isArray(itemParameters)) throw new Error("First Map OGC items parameters must be declared.");
  if (
    !sameValues(
      itemParameters.map((parameter) => parameter.name),
      ["collectionId", "f", "limit", "bbox", "datetime", "offset", "run"],
    )
  ) {
    throw new Error("First Map OGC API definition must declare exactly the supported items parameters.");
  }
  if (itemParameters.find((parameter) => parameter.name === "offset")?.["x-honua-fixture-extension"] !== true) {
    throw new Error("First Map OGC offset parameter must be marked as a fixture extension.");
  }
  const limitParameter = itemParameters.find((parameter) => parameter.name === "limit");
  if (
    limitParameter?.style !== "form" ||
    limitParameter.explode !== false ||
    limitParameter.schema?.maximum !== 1_000 ||
    limitParameter.schema.default !== 1_000
  ) {
    throw new Error("First Map OGC limit parameter must declare its baseline default and maximum.");
  }
  const bboxParameter = itemParameters.find((parameter) => parameter.name === "bbox");
  const bboxAlternatives = bboxParameter?.schema?.oneOf;
  if (
    bboxParameter?.style !== "form" ||
    bboxParameter.explode !== false ||
    bboxParameter.schema?.type !== "array" ||
    bboxParameter.schema.items?.type !== "number" ||
    !Array.isArray(bboxAlternatives) ||
    !sameValues(
      bboxAlternatives.map((alternative) => `${alternative.minItems}:${alternative.maxItems}`),
      ["4:4", "6:6"],
    )
  ) {
    throw new Error("First Map OGC bbox parameter must declare exactly four or six coordinates.");
  }
  const datetimeParameter = itemParameters.find((parameter) => parameter.name === "datetime");
  if (datetimeParameter?.style !== "form" || datetimeParameter.explode !== false) {
    throw new Error("First Map OGC datetime parameter serialization is invalid.");
  }
  for (const pathName of expectedApiPaths) {
    const parameters = ogcApiDefinition.paths[pathName].get?.parameters;
    const runParameters = parameters?.filter((parameter) => parameter.name === "run") ?? [];
    if (
      runParameters.length !== 1 ||
      runParameters[0]["x-honua-fixture-extension"] !== true ||
      runParameters[0].schema?.pattern !== FIXTURE_RUN_ID_PATTERN_SOURCE
    ) {
      throw new Error(`First Map OGC API path ${pathName} must declare the fixture run selector.`);
    }
    const formatParameters = parameters?.filter((parameter) => parameter.name === "f") ?? [];
    if (formatParameters.length !== 1 || formatParameters[0]["x-honua-fixture-extension"] !== true) {
      throw new Error(`First Map OGC API path ${pathName} must declare its response-format extension.`);
    }
  }
  const landingParameters = ogcApiDefinition.paths["/"].get?.parameters ?? [];
  if (
    !sameValues(
      landingParameters.map((parameter) => parameter.name),
      ["f", "run"],
    )
  ) {
    throw new Error("First Map OGC landing page parameters must exactly match the handler.");
  }

  const crs84 = "http://www.opengis.net/def/crs/OGC/1.3/CRS84";
  if (ogcCollection.id !== "operations-areas" || ogcCollection.title !== layer.name) {
    throw new Error("First Map OGC collection identity must match the GeoServices layer.");
  }
  if (ogcCollection.itemType !== "feature") throw new Error("First Map OGC collection itemType must be feature.");
  assertJsonEqual(ogcCollection.crs, [crs84], "First Map OGC collection CRS must be CRS84.");
  assertJsonEqual(
    ogcCollection.extent,
    { spatial: { bbox: [manifest.schema.extent], crs: crs84 } },
    "First Map OGC collection extent must match the canonical fixture extent.",
  );
  if (
    linkHref(ogcCollection.links, "items", "First Map OGC collection") !==
    "/ogc/features/collections/operations-areas/items"
  ) {
    throw new Error("First Map OGC collection items link is invalid.");
  }

  if (ogcItems.type !== "FeatureCollection" || !Array.isArray(ogcItems.features)) {
    throw new Error("First Map OGC items payload must be a FeatureCollection.");
  }
  if (
    ogcItems.features.length !== manifest.schema.featureCount ||
    ogcItems.numberMatched !== manifest.schema.featureCount ||
    ogcItems.numberReturned !== manifest.schema.featureCount
  ) {
    throw new Error("First Map OGC item counts must match the canonical feature count.");
  }
  assertJsonEqual(
    extentFromPositions(ogcItems.features.map((feature) => feature.geometry?.coordinates)),
    manifest.schema.extent,
    "First Map OGC item extent must match the canonical fixture extent.",
  );
  for (const [index, feature] of features.features.entries()) {
    const projected = ogcItems.features[index];
    if (projected?.type !== "Feature" || projected.geometry?.type !== "Polygon") {
      throw new Error(`First Map OGC feature ${index} must be a polygon Feature.`);
    }
    const objectId = feature.attributes[objectIdFieldName];
    if (projected.id !== objectId) throw new Error(`First Map OGC feature ${index} identity drifted.`);
    assertJsonEqual(
      projected.properties,
      feature.attributes,
      `First Map OGC feature ${index} properties drifted from GeoServices.`,
    );
    assertJsonEqual(
      projected.geometry.coordinates,
      feature.geometry.rings.map((ring) => [...ring].reverse()),
      `First Map OGC feature ${index} geometry drifted from GeoServices.`,
    );
  }
}

function ringArea(ring) {
  let area = 0;
  for (let index = 0; index < ring.length - 1; index += 1) {
    area += ring[index][0] * ring[index + 1][1] - ring[index + 1][0] * ring[index][1];
  }
  return area / 2;
}

function validateFirstMapV2(manifest, data) {
  const roles = [
    "capabilities",
    "features",
    "layer",
    "ogcApiDefinition",
    "ogcCollection",
    "ogcConformance",
    "ogcItems",
    "ogcLanding",
  ];
  if (!sameValues(Object.keys(manifest.schema.files), roles)) {
    throw new Error("First Map v2 fixture logical file roles are incomplete or unsupported.");
  }
  const capabilities = data[manifest.schema.files.capabilities];
  const features = data[manifest.schema.files.features];
  const layer = data[manifest.schema.files.layer];
  const api = data[manifest.schema.files.ogcApiDefinition];
  const collection = data[manifest.schema.files.ogcCollection];
  const conformance = data[manifest.schema.files.ogcConformance];
  const items = data[manifest.schema.files.ogcItems];
  const landing = data[manifest.schema.files.ogcLanding];
  if (!capabilities?.success || !features || !layer || !api || !collection || !conformance || !items || !landing) {
    throw new Error("First Map v2 is missing a required projection.");
  }
  assertJsonEqual(
    manifest.schema.protocols,
    ["honua-capabilities-v1", "esri-geoservices-feature-server", "ogc-api-features-1.0"],
    "First Map v2 protocols are invalid.",
  );
  assertJsonEqual(
    manifest.schema.projections,
    [
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
    ],
    "First Map v2 projections are invalid.",
  );
  const expectedProvenance = {
    sourceUrl: "https://www2.census.gov/geo/tiger/TIGER2025/TRACT/tl_2025_15_tract.zip",
    sourceSha256: "92b736e066555d55afa795f9dd5944edccd26a97fa70bd1066bf09c7661c5900",
    sourceBytes: 1_772_413,
    retrievedAt: "2026-08-08T00:00:00.000Z",
    sourceVintage: "2025-01-01",
    selection: { field: "COUNTYFP", equals: "009", sort: "GEOID" },
    transformation: {
      id: "honua-tiger-shapefile-v1",
      sourceCrs: "EPSG:4269",
      targetCrs: "EPSG:4326",
      coordinatePrecision: 7,
      geometryNormalization:
        "Retain every source ring without simplification; transform NAD83 to WGS84 with proj4; round to 7 decimals; group rings by containment; enforce RFC 7946 orientation; rotate and sort rings and polygons canonically.",
      attributeSelection: ["GEOID", "NAME", "NAMELSAD", "ALAND", "AWATER"],
      objectIdAssignment: "1-based index after ascending GEOID sort",
    },
    toolchain: {
      node: "20.19.0 (.nvmrc)",
      projection: "proj4@2.20.9 (package-lock.json)",
      archive: "node:zlib inflateRawSync",
      parser: "scripts/refresh-first-map-tiger-v2.mjs",
    },
    refreshCommand: "npm run samples:fixtures:first-map-v2:write",
  };
  assertJsonEqual(manifest.provenance, expectedProvenance, "First Map v2 provenance is not the pinned job.");
  if (manifest.license.expression !== "LicenseRef-US-Government-Work") {
    throw new Error("First Map v2 must use the registered U.S. government-work record.");
  }

  const expectedFields = [
    { name: "OBJECTID", type: "esriFieldTypeOID", alias: "OBJECTID" },
    { name: "GEOID", type: "esriFieldTypeString", alias: "Census tract GEOID", length: 11 },
    { name: "NAME", type: "esriFieldTypeString", alias: "Census tract name", length: 7 },
    { name: "NAMELSAD", type: "esriFieldTypeString", alias: "Legal/statistical area description", length: 100 },
    { name: "ALAND", type: "esriFieldTypeDouble", alias: "Land area (square meters)" },
    { name: "AWATER", type: "esriFieldTypeDouble", alias: "Water area (square meters)" },
  ];
  assertJsonEqual(features.fields, expectedFields, "First Map v2 query fields are invalid.");
  assertJsonEqual(layer.fields, expectedFields, "First Map v2 layer fields drifted.");
  if (
    features.objectIdFieldName !== "OBJECTID" ||
    layer.objectIdField !== "OBJECTID" ||
    features.geometryType !== "esriGeometryPolygon" ||
    layer.geometryType !== "esriGeometryPolygon" ||
    features.spatialReference?.wkid !== 4326 ||
    layer.extent?.spatialReference?.wkid !== 4326 ||
    layer.capabilities !== "Query"
  ) {
    throw new Error("First Map v2 GeoServices metadata is invalid.");
  }
  if (
    features.features.length !== 48 ||
    items.features?.length !== 48 ||
    items.numberMatched !== 48 ||
    items.numberReturned !== 48
  ) {
    throw new Error("First Map v2 must contain exactly 48 features in both projections.");
  }
  const geoids = [];
  for (const [index, esriFeature] of features.features.entries()) {
    const ogcFeature = items.features[index];
    const attributes = esriFeature.attributes;
    if (attributes.OBJECTID !== index + 1 || ogcFeature?.id !== index + 1 || ogcFeature?.type !== "Feature") {
      throw new Error(`First Map v2 feature ${index} identity drifted.`);
    }
    if (
      !/^15\d{9}$/.test(attributes.GEOID) ||
      typeof attributes.NAME !== "string" ||
      typeof attributes.NAMELSAD !== "string" ||
      !Number.isSafeInteger(attributes.ALAND) ||
      !Number.isSafeInteger(attributes.AWATER)
    ) {
      throw new Error(`First Map v2 feature ${index} attributes are invalid.`);
    }
    geoids.push(attributes.GEOID);
    assertJsonEqual(ogcFeature.properties, attributes, `First Map v2 feature ${index} properties drifted.`);
    if (
      ogcFeature.geometry?.type !== "MultiPolygon" ||
      !Array.isArray(ogcFeature.geometry.coordinates) ||
      ogcFeature.geometry.coordinates.length < 1
    ) {
      throw new Error(`First Map v2 feature ${index} must be a nonempty MultiPolygon.`);
    }
    const expectedRings = [];
    for (const [polygonIndex, polygon] of ogcFeature.geometry.coordinates.entries()) {
      if (!Array.isArray(polygon) || polygon.length < 1) throw new Error("First Map v2 polygons must contain rings.");
      for (const [ringIndex, ring] of polygon.entries()) {
        if (!Array.isArray(ring) || ring.length < 4) throw new Error("First Map v2 rings must contain four positions.");
        assertJsonEqual(ring[0], ring.at(-1), "First Map v2 rings must be closed.");
        const area = ringArea(ring);
        if (area === 0 || (ringIndex === 0 ? area < 0 : area > 0)) {
          throw new Error(`First Map v2 polygon ${polygonIndex} violates RFC 7946 ring orientation.`);
        }
        expectedRings.push([...ring].reverse());
      }
    }
    assertJsonEqual(esriFeature.geometry?.rings, expectedRings, `First Map v2 feature ${index} geometry drifted.`);
  }
  assertJsonEqual(geoids, [...geoids].sort(), "First Map v2 GEOIDs must be sorted.");
  assertUnique(geoids, "First Map v2 GEOIDs must be unique.");
  if (!features.features.some((feature) => feature.attributes.OBJECTID === manifest.schema.selectedRecordId)) {
    throw new Error("First Map v2 selectedRecordId must identify a feature.");
  }
  const extent = extentFromPositions(items.features.map((feature) => feature.geometry.coordinates));
  assertJsonEqual(extent, manifest.schema.extent, "First Map v2 extent does not match canonical coordinates.");
  assertJsonEqual(
    [layer.extent.xmin, layer.extent.ymin, layer.extent.xmax, layer.extent.ymax],
    manifest.schema.extent,
    "First Map v2 layer extent drifted.",
  );
  const datasetHash = sha256(canonicalJson({ type: "FeatureCollection", features: items.features }));
  if (datasetHash !== manifest.integrity.canonicalDatasetSha256) {
    throw new Error("First Map v2 canonical dataset digest drifted.");
  }

  const projectedProvenance = {
    sourceUrl: manifest.provenance.sourceUrl,
    sourceSha256: manifest.provenance.sourceSha256,
    retrievedAt: manifest.provenance.retrievedAt,
    selection: manifest.provenance.selection,
  };
  for (const [description, metadata] of [
    ["GeoServices layer", layer],
    ["OGC landing page", landing],
    ["OGC collection", collection],
    ["OGC items", items],
  ]) {
    const attribution = description === "GeoServices layer" ? metadata.copyrightText : metadata.attribution;
    if (attribution !== manifest.license.citation) throw new Error(`${description} citation drifted.`);
    assertJsonEqual(metadata.license, manifest.license, `${description} license drifted.`);
    assertJsonEqual(metadata.provenance, projectedProvenance, `${description} provenance drifted.`);
    if (
      description !== "GeoServices layer" &&
      linkHref(metadata.links, "license", description) !== manifest.license.termsUrl
    ) {
      throw new Error(`${description} license link drifted.`);
    }
  }
  const collectionId = "maui-census-tracts-2025";
  if (collection.id !== collectionId || collection.title !== layer.name || collection.itemType !== "feature") {
    throw new Error("First Map v2 collection identity drifted.");
  }
  if (
    linkHref(collection.links, "items", "First Map v2 collection") !== `/ogc/features/collections/${collectionId}/items`
  ) {
    throw new Error("First Map v2 collection items link drifted.");
  }
  if (api.openapi !== "3.0.3" || api.servers?.[0]?.url !== "/ogc/features") {
    throw new Error("First Map v2 API definition is invalid.");
  }
  const collectionParameters = api.paths?.["/collections/{collectionId}"]?.get?.parameters;
  const collectionEnum = collectionParameters?.find((parameter) => parameter.name === "collectionId")?.schema?.enum;
  if (!sameValues(collectionEnum ?? [], [collectionId])) throw new Error("First Map v2 API collection enum drifted.");
  if (
    !sameValues(conformance.conformsTo ?? [], [
      "http://www.opengis.net/spec/ogcapi-features-1/1.0/conf/core",
      "http://www.opengis.net/spec/ogcapi-features-1/1.0/conf/geojson",
    ])
  ) {
    throw new Error("First Map v2 OGC conformance drifted.");
  }
}

function validateIncidentOperations(manifest, data) {
  if (!sameValues(Object.keys(manifest.schema.files), ["events", "snapshot"])) {
    throw new Error("Incident Operations fixture logical file roles are incomplete or unsupported.");
  }
  const snapshot = data[manifest.schema.files.snapshot];
  const events = data[manifest.schema.files.events];
  if (!snapshot || !events) throw new Error("Incident Operations fixture is missing snapshot or event data.");
  if (manifest.schema.geometryType !== "Point") {
    throw new Error("Incident Operations manifest geometryType must be Point.");
  }
  if (!sameValues(manifest.schema.protocols, ["server-sent-events", "honua-realtime-feature-events"])) {
    throw new Error("Incident Operations must declare exactly its supported realtime protocols.");
  }
  if (snapshot.features.length !== manifest.schema.featureCount) {
    throw new Error("Incident Operations featureCount does not match payload.");
  }
  if (events.steps.length !== manifest.schema.eventCount) {
    throw new Error("Incident Operations eventCount does not match payload.");
  }
  if (manifest.schema.authorityCrs !== "OGC:CRS84") {
    throw new Error("Incident Operations authority CRS must be OGC:CRS84.");
  }
  assertJsonEqual(
    manifest.schema.coordinateEncoding,
    { format: "GeoJSON-compatible positions", axes: ["longitude", "latitude"], order: "xy" },
    "Incident Operations must declare longitude/latitude position encoding.",
  );
  const extent = extentFromPositions(snapshot.features.map((feature) => feature.coordinate));
  assertJsonEqual(extent, manifest.schema.extent, "Incident Operations extent does not match snapshot coordinates.");
  if (manifest.schema.eventExtentPolicy !== "within-declared-extent") {
    throw new Error("Incident event extent policy must constrain created features to the declared extent.");
  }
  const ids = snapshot.features.map((feature) => feature.id);
  assertUnique(ids, "Incident feature ids must be unique.");
  for (const [index, feature] of snapshot.features.entries())
    assertIncidentFeature(feature, `Incident feature ${index}`);
  const safeDemoRecords = snapshot.features.filter((feature) => feature.safeDemoRecord === true);
  if (safeDemoRecords.length !== 1 || safeDemoRecords[0].id !== "DEMO-EDIT-0001") {
    throw new Error("Incident Operations must contain exactly one intended safe demo record.");
  }
  const [xmin, ymin, xmax, ymax] = manifest.schema.extent;
  const knownIds = new Set(ids);
  for (const [index, step] of events.steps.entries()) {
    assertExactKeys(
      step,
      ["label", "kind", "id", "eventTime", "feature", "changes"],
      ["label", "kind", "id", "eventTime"],
      `Incident step ${index}`,
    );
    if (!["upsert", "delete"].includes(step.kind)) throw new Error(`Incident step ${index} kind is invalid.`);
    assertBoundedString(step.label, `Incident step ${index}.label`, 160);
    assertBoundedString(step.id, `Incident step ${index}.id`, 64);
    if (typeof step.eventTime !== "string" || parseRfc3339Instant(step.eventTime) === undefined) {
      throw new Error("Incident eventTime values must be valid timestamps.");
    }
    if (step.kind === "delete") {
      if (!knownIds.has(step.id) || Object.hasOwn(step, "feature") || Object.hasOwn(step, "changes")) {
        throw new Error(`Incident delete step ${index} is invalid.`);
      }
      knownIds.delete(step.id);
      continue;
    }
    const hasFeature = Object.hasOwn(step, "feature");
    const hasChanges = Object.hasOwn(step, "changes");
    if (hasFeature === hasChanges)
      throw new Error(`Incident upsert step ${index} must contain exactly one feature or changes object.`);
    if (hasFeature) {
      assertIncidentFeature(step.feature, `Incident step ${index} feature`);
      if (step.feature.id !== step.id) throw new Error(`Incident step ${index} id does not match its feature.`);
      if (step.feature.safeDemoRecord !== undefined || step.feature.revision !== undefined) {
        throw new Error(`Incident step ${index} cannot introduce another editable demo record.`);
      }
      const [x, y] = step.feature.coordinate;
      if (x < xmin || x > xmax || y < ymin || y > ymax)
        throw new Error(`Incident step ${index} creates data outside the declared extent.`);
      knownIds.add(step.id);
    } else {
      if (!knownIds.has(step.id)) throw new Error(`Incident step ${index} updates an unknown feature.`);
      validateIncidentChanges(step.changes, `Incident step ${index} changes`);
    }
  }
}

function deepFreeze(value, seen = new WeakSet()) {
  if (!value || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

export function validateFixturePackDirectory(
  root,
  { allowChecksumChanges = false, allowMetadataChanges = false } = {},
) {
  const resolvedRoot = path.resolve(root);
  const canonicalRoot = fs.realpathSync(resolvedRoot);
  if (canonicalRoot !== resolvedRoot) {
    throw new Error("Fixture pack root and its fixture-tree ancestors must be canonical real directories.");
  }
  for (const [directory, description] of [
    [resolvedRoot, "Fixture pack root"],
    [path.dirname(resolvedRoot), "Fixture pack id directory"],
    [path.dirname(path.dirname(resolvedRoot)), "Fixture root directory"],
  ]) {
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error(`${description} must be a real directory.`);
    }
  }
  const packId = path.basename(path.dirname(resolvedRoot));
  const revision = path.basename(resolvedRoot);
  const rootStat = fs.lstatSync(resolvedRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink())
    throw new Error("Fixture pack root must be a real directory.");
  const manifestPath = path.join(resolvedRoot, "manifest.json");
  const manifestBytes = readBoundedRegularFile(
    manifestPath,
    128 * 1024,
    "Fixture manifest",
    "Fixture manifest exceeds 128 KiB.",
  );
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  if (manifest.fixturePackVersion === "honua.fixture-pack/v1") validateManifestShapeV1(manifest);
  else if (manifest.fixturePackVersion === "honua.fixture-pack/v2") validateManifestShapeV2(manifest);
  else throw new Error("Unsupported fixture manifest version.");
  const expectedRevision = manifest.fixturePackVersion === "honua.fixture-pack/v1" ? "v1" : "v2";
  if (revision !== expectedRevision) {
    throw new Error("Fixture pack protocol version does not match its directory revision.");
  }
  if (manifest.identity?.id !== packId || manifest.identity?.revision !== revision) {
    throw new Error("Fixture manifest identity does not match its directory id/revision.");
  }
  if (!/^\d+\.\d+\.\d+$/.test(manifest.identity?.version ?? "")) {
    throw new Error("Fixture identity version must be SemVer.");
  }
  if (manifest.integrity?.algorithm !== "sha256") throw new Error("Fixture integrity algorithm must be sha256.");
  const provenanceSource = expectedRevision === "v1" ? manifest.provenance?.source : manifest.provenance?.sourceUrl;
  if (!provenanceSource || !manifest.provenance?.retrievedAt || !manifest.provenance?.refreshCommand) {
    throw new Error("Fixture provenance source, retrieval time, and refresh command are required.");
  }
  if (parseRfc3339Instant(manifest.provenance.retrievedAt) === undefined)
    throw new Error("Fixture retrievedAt must be a timestamp.");
  if (expectedRevision === "v1") {
    if (!manifest.license?.spdx || !manifest.license?.attribution || manifest.license.redistributionAllowed !== true) {
      throw new Error("Fixture license, attribution, and redistribution permission are required.");
    }
  } else assertRegisteredFixtureLicense(manifest.license);
  if (!manifest.freshness?.policy || parseRfc3339Instant(manifest.freshness.asOf) === undefined) {
    throw new Error("Fixture freshness policy and asOf timestamp are required.");
  }

  const entries = fs.readdirSync(resolvedRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isSymbolicLink() || !entry.isFile()) {
      throw new Error(`Fixture packs may contain only direct regular files: ${entry.name}`);
    }
  }
  const actualNames = entries.filter((entry) => entry.name !== "manifest.json").map((entry) => entry.name);
  if (actualNames.length > MAXIMUM_DATA_FILES) throw new Error("Fixture pack contains too many data files.");
  const integrityNames = Object.keys(manifest.integrity.files ?? {});
  const schemaNames = Object.values(manifest.schema?.files ?? {});
  for (const name of [...integrityNames, ...schemaNames]) {
    if (typeof name !== "string" || path.basename(name) !== name || name === "manifest.json") {
      throw new Error(`Unsafe or recursive fixture data path: ${String(name)}`);
    }
  }
  if (!sameValues(actualNames, integrityNames) || !sameValues(actualNames, schemaNames)) {
    throw new Error("Fixture on-disk files, integrity.files, and schema.files must be exact sets.");
  }

  const data = {};
  const actualChecksums = {};
  const checksumChanges = [];
  const maximumFileBytes = expectedRevision === "v1" ? MAXIMUM_V1_FILE_BYTES : MAXIMUM_V2_FILE_BYTES;
  const maximumPackBytes = expectedRevision === "v1" ? MAXIMUM_V1_PACK_BYTES : MAXIMUM_V2_PACK_BYTES;
  let totalBytes = 0;
  for (const name of sorted(actualNames)) {
    const filePath = path.join(resolvedRoot, name);
    const bytes = readBoundedRegularFile(
      filePath,
      maximumFileBytes,
      `Fixture data file ${name}`,
      `Fixture data file exceeds ${maximumFileBytes / (1024 * 1024)} MiB: ${name}`,
    );
    totalBytes += bytes.byteLength;
    if (totalBytes > maximumPackBytes) {
      throw new Error(`Fixture pack exceeds ${maximumPackBytes / (1024 * 1024)} MiB.`);
    }
    const actual = sha256(bytes);
    actualChecksums[name] = actual;
    if (manifest.integrity.files[name] !== actual) {
      checksumChanges.push({ name, before: manifest.integrity.files[name], after: actual });
    }
    data[name] = JSON.parse(bytes.toString("utf8"));
  }
  if (checksumChanges.length > 0 && !allowChecksumChanges) throw new Error("Fixture data checksum mismatch.");

  if (packId === "first-map" && expectedRevision === "v1") validateFirstMapV1(manifest, data);
  else if (packId === "first-map" && expectedRevision === "v2") validateFirstMapV2(manifest, data);
  else if (packId === "incident-operations") validateIncidentOperations(manifest, data);
  else throw new Error(`No semantic fixture validator is registered for ${packId}.`);

  const hashes = semanticHashes(manifest);
  const metadataChanges = {
    combined: { before: manifest.integrity.metadataFingerprint, after: hashes.combined },
    license: { before: manifest.integrity.metadataComponents?.license, after: hashes.license },
    provenance: { before: manifest.integrity.metadataComponents?.provenance, after: hashes.provenance },
  };
  const metadataChanged = Object.values(metadataChanges).some((change) => change.before !== change.after);
  if (metadataChanged && !allowMetadataChanges) throw new Error("Fixture semantic metadata fingerprint mismatch.");

  return {
    id: packId,
    version: revision,
    root: resolvedRoot,
    manifestPath,
    manifestContent: manifestBytes.toString("utf8"),
    manifest: deepFreeze(structuredClone(manifest)),
    data: deepFreeze(structuredClone(data)),
    actualChecksums,
    checksumChanges,
    hashes,
    metadataChanges,
    metadataChanged,
  };
}
