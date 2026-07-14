import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { canonicalJson, hasAsciiControlCharacters, parseRfc3339Instant } from "./determinism.mjs";
import { FIXTURE_RUN_ID_PATTERN_SOURCE } from "./identifiers.mjs";

const MAXIMUM_DATA_FILES = 16;
const MAXIMUM_FILE_BYTES = 2 * 1024 * 1024;
const MAXIMUM_PACK_BYTES = 8 * 1024 * 1024;
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

function validateManifestShape(manifest) {
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

function validateFirstMap(manifest, data) {
  const features = data[manifest.schema.files.features];
  const layer = data[manifest.schema.files.layer];
  const ogcLanding = data[manifest.schema.files.ogcLanding];
  const ogcApiDefinition = data[manifest.schema.files.ogcApiDefinition];
  const ogcConformance = data[manifest.schema.files.ogcConformance];
  const ogcCollection = data[manifest.schema.files.ogcCollection];
  const ogcItems = data[manifest.schema.files.ogcItems];
  if (!features || !layer || !ogcLanding || !ogcApiDefinition || !ogcConformance || !ogcCollection || !ogcItems) {
    throw new Error("First Map fixture is missing a GeoServices or OGC API Features projection file.");
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

function validateIncidentOperations(manifest, data) {
  const snapshot = data[manifest.schema.files.snapshot];
  const events = data[manifest.schema.files.events];
  if (!snapshot || !events) throw new Error("Incident Operations fixture is missing snapshot or event data.");
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
  validateManifestShape(manifest);
  if (revision !== "v1" || manifest.fixturePackVersion !== "honua.fixture-pack/v1") {
    throw new Error("Fixture pack protocol version does not match its directory revision.");
  }
  if (manifest.identity?.id !== packId || manifest.identity?.revision !== revision) {
    throw new Error("Fixture manifest identity does not match its directory id/revision.");
  }
  if (!/^\d+\.\d+\.\d+$/.test(manifest.identity?.version ?? "")) {
    throw new Error("Fixture identity version must be SemVer.");
  }
  if (manifest.integrity?.algorithm !== "sha256") throw new Error("Fixture integrity algorithm must be sha256.");
  if (!manifest.provenance?.source || !manifest.provenance?.retrievedAt || !manifest.provenance?.refreshCommand) {
    throw new Error("Fixture provenance source, retrieval time, and refresh command are required.");
  }
  if (parseRfc3339Instant(manifest.provenance.retrievedAt) === undefined)
    throw new Error("Fixture retrievedAt must be a timestamp.");
  if (!manifest.license?.spdx || !manifest.license?.attribution || manifest.license.redistributionAllowed !== true) {
    throw new Error("Fixture license, attribution, and redistribution permission are required.");
  }
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
  let totalBytes = 0;
  for (const name of sorted(actualNames)) {
    const filePath = path.join(resolvedRoot, name);
    const bytes = readBoundedRegularFile(
      filePath,
      MAXIMUM_FILE_BYTES,
      `Fixture data file ${name}`,
      `Fixture data file exceeds 2 MiB: ${name}`,
    );
    totalBytes += bytes.byteLength;
    if (totalBytes > MAXIMUM_PACK_BYTES) throw new Error("Fixture pack exceeds 8 MiB.");
    const actual = sha256(bytes);
    actualChecksums[name] = actual;
    if (manifest.integrity.files[name] !== actual) {
      checksumChanges.push({ name, before: manifest.integrity.files[name], after: actual });
    }
    data[name] = JSON.parse(bytes.toString("utf8"));
  }
  if (checksumChanges.length > 0 && !allowChecksumChanges) throw new Error("Fixture data checksum mismatch.");

  if (packId === "first-map") validateFirstMap(manifest, data);
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
    root: resolvedRoot,
    manifestPath,
    manifest: deepFreeze(structuredClone(manifest)),
    data: deepFreeze(structuredClone(data)),
    actualChecksums,
    checksumChanges,
    hashes,
    metadataChanges,
    metadataChanged,
  };
}
