import crypto from "node:crypto";

import {
  canonicalJson,
  compareRfc3339Instants,
  hasAsciiControlCharacters,
  parseRfc3339Instant,
} from "../determinism.mjs";
import { fixtureHeaders, fixtureResponseHeaders, sendJson, sendText } from "../http.mjs";

const SERVICE_ROOT = "/rest/services/natural-earth/FeatureServer/0";
const OGC_ROOT = "/ogc/features";
const OGC_COLLECTION_ID = "operations-areas";
const OGC_COLLECTION_ROOT = `${OGC_ROOT}/collections/${OGC_COLLECTION_ID}`;
const OGC_ITEMS_ROOT = `${OGC_COLLECTION_ROOT}/items`;
const OGC_CRS84 = "http://www.opengis.net/def/crs/OGC/1.3/CRS84";
const OGC_GEOJSON_CONTENT_TYPE = "application/geo+json; charset=utf-8";
const OGC_OPENAPI_CONTENT_TYPE = "application/vnd.oai.openapi+json;version=3.0; charset=utf-8";
const OVERFLOW_PAGE_SIZE = 2;
const MAXIMUM_IDEMPOTENCY_KEYS = 128;

function clone(value) {
  return structuredClone(value);
}

function representationEtag(representation, value) {
  const digest = crypto
    .createHash("sha256")
    .update(representation)
    .update("\0")
    .update(canonicalJson(value))
    .digest("hex")
    .slice(0, 20);
  return `"first-map-${representation}-${digest}"`;
}

function scenarioHeaders(run, representation, value) {
  if (run.scenario === "cache-hit") return { age: "12", "x-fixture-cache": "hit; fresh" };
  if (run.scenario === "cache-stale")
    return { age: "600", warning: '110 - "Response is stale"', "x-fixture-cache": "stale" };
  if (run.scenario === "cache-revalidate") {
    return { etag: representationEtag(representation, value), "x-fixture-cache": "revalidated" };
  }
  if (run.scenario === "auth-scope") {
    return { vary: "x-honua-fixture-auth-scope", "x-fixture-cache-scope": run.authScopeFingerprint };
  }
  return {};
}

function scenarioCachePolicy(run) {
  if (run.scenario === "cache-hit" || run.scenario === "cache-stale") return "private-fresh";
  if (run.scenario === "cache-revalidate") return "private-revalidate";
  return "no-store";
}

function ogcHeaders(run, representation, value) {
  return { ...scenarioHeaders(run, representation, value), "content-crs": `<${OGC_CRS84}>` };
}

function isNotModified(req, run, representation, value) {
  return (
    run.scenario === "cache-revalidate" && req.headers["if-none-match"] === representationEtag(representation, value)
  );
}

function fixtureHref(run, pathname, parameters = []) {
  const target = new URL(pathname, "http://fixture.invalid");
  target.search = "";
  for (const [name, value] of parameters) {
    if (value !== null && value !== undefined) target.searchParams.set(name, String(value));
  }
  if (run.id !== "default") target.searchParams.set("run", run.id);
  return `${target.pathname}${target.search}`;
}

function linksForRun(links, run) {
  return links.map((link) => {
    const target = new URL(link.href, "http://fixture.invalid");
    const parameters = [...target.searchParams.entries()].filter(([name]) => name !== "run");
    return { ...link, href: fixtureHref(run, target.pathname, parameters) };
  });
}

function linkedDocument(value, run) {
  const response = clone(value);
  if (Array.isArray(response.links)) response.links = linksForRun(response.links, run);
  return response;
}

function metadataQuerySupported(run) {
  return run.scenario !== "unsupported";
}

function layerForRun(layer, run) {
  const response = clone(layer);
  if (!metadataQuerySupported(run)) {
    response.capabilities = "None";
    delete response.advancedQueryCapabilities;
  }
  if (run.scenario === "overflow") response.maxRecordCount = OVERFLOW_PAGE_SIZE;
  return response;
}

function conformanceForRun(conformance, run) {
  const response = clone(conformance);
  if (!metadataQuerySupported(run)) {
    response.conformsTo = response.conformsTo.filter((value) => !value.includes("ogcapi-features-1"));
  }
  return response;
}

function apiDefinitionForRun(definition, run) {
  const response = clone(definition);
  if (!metadataQuerySupported(run)) {
    delete response.paths["/collections/{collectionId}/items"];
    delete response.paths["/collections/{collectionId}/items/{featureId}"];
  }
  return response;
}

function collectionForRun(collection, run) {
  const response = linkedDocument(collection, run);
  if (!metadataQuerySupported(run)) response.links = response.links.filter((link) => link.rel !== "items");
  if (run.scenario === "overflow") response["x-honua-fixture-page-limit"] = OVERFLOW_PAGE_SIZE;
  return response;
}

function applyFeatureOverrides(response, run) {
  response.features = response.features.map((feature) => ({
    ...feature,
    attributes: {
      ...feature.attributes,
      ...(run.state.featureOverrides.get(feature.attributes.OBJECTID) ?? {}),
    },
  }));
  if (run.scenario === "empty") response.features = [];
  if (run.scenario === "schema-drift") {
    response.fields = response.fields.filter((field) => field.name !== "OBJECTID");
    response.fields.push({ name: "OBJECTID", type: "esriFieldTypeString", alias: "Drifted identifier" });
    response.schemaRevision = "drift-v2";
  }
  return response;
}

function applyOgcFeatureOverrides(response, run) {
  response.features = response.features.map((feature) => ({
    ...feature,
    properties: {
      ...feature.properties,
      ...(run.state.featureOverrides.get(feature.properties.OBJECTID) ?? {}),
    },
  }));
  if (run.scenario === "empty") response.features = [];
  if (run.scenario === "schema-drift") {
    response.features = response.features.map((feature) => ({
      ...feature,
      properties: { ...feature.properties, OBJECTID: String(feature.properties.OBJECTID) },
    }));
    response.schemaRevision = "drift-v2";
  }
  response.timeStamp = run.clock.iso();
  return response;
}

function decimalParameter(url, name, fallback, maximum) {
  const value = url.searchParams.get(name);
  if (value === null) return fallback;
  if (!/^(0|[1-9]\d*)$/.test(value)) {
    throw Object.assign(new Error(`${name} must be a non-negative decimal integer.`), { status: 400 });
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > maximum) {
    throw Object.assign(new Error(`${name} exceeds the fixture limit.`), { status: 400 });
  }
  return parsed;
}

function assertEditBody(body) {
  const allowed = new Set(["objectId", "expectedRevision", "idempotencyKey", "attributes"]);
  if (!body || typeof body !== "object" || Object.keys(body).some((key) => !allowed.has(key))) {
    throw Object.assign(new Error("Feature edit body contains unsupported fields."), { status: 400 });
  }
  if (!Number.isSafeInteger(body.expectedRevision) || body.expectedRevision < 0) {
    throw Object.assign(new Error("expectedRevision must be a non-negative safe integer."), { status: 400 });
  }
  if (!body.attributes || typeof body.attributes !== "object" || Array.isArray(body.attributes)) {
    throw Object.assign(new Error("attributes must be a JSON object."), { status: 400 });
  }
  if (!Number.isSafeInteger(body.objectId)) {
    throw Object.assign(new Error("objectId must be a safe integer."), { status: 400 });
  }
  if (
    typeof body.idempotencyKey !== "string" ||
    body.idempotencyKey.length < 1 ||
    body.idempotencyKey.length > 128 ||
    hasAsciiControlCharacters(body.idempotencyKey)
  ) {
    throw Object.assign(new Error("idempotencyKey must be a bounded printable string."), { status: 400 });
  }
  const attributeNames = Object.keys(body.attributes);
  if (attributeNames.length < 1 || attributeNames.some((name) => !["STATUS", "CATEGORY"].includes(name))) {
    throw Object.assign(new Error("Only STATUS and CATEGORY can be edited in the isolated fixture record."), {
      status: 400,
    });
  }
  for (const value of Object.values(body.attributes)) {
    if (typeof value !== "string" || value.length < 1 || value.length > 128 || hasAsciiControlCharacters(value)) {
      throw Object.assign(new Error("Edited attributes must be bounded printable strings."), { status: 400 });
    }
  }
}

function paginatedResponse(run, url, baseline) {
  if (
    url.searchParams.getAll("cursor").length > 1 ||
    url.searchParams.getAll("resultOffset").length > 1 ||
    url.searchParams.getAll("resultRecordCount").length > 1
  ) {
    throw Object.assign(new Error("Pagination parameters may appear only once."), { status: 400 });
  }
  const requestedCursor = url.searchParams.get("cursor");
  if (requestedCursor !== null && url.searchParams.has("resultOffset")) {
    throw Object.assign(new Error("cursor and resultOffset are mutually exclusive."), { status: 400 });
  }
  let offset = decimalParameter(url, "resultOffset", 0, 10_000);
  if (requestedCursor !== null) {
    if (!run.state.issuedPageCursors.has(requestedCursor)) {
      return {
        status: 410,
        body: { error: { code: "FIXTURE_STALE_CURSOR", message: "Cursor was not issued for this run." } },
      };
    }
    const [cursorRun, cursorOffset, generation] = requestedCursor.split(":");
    if (cursorRun !== run.id || generation !== run.state.cursorGeneration || !/^\d+$/.test(cursorOffset ?? "")) {
      return {
        status: 410,
        body: { error: { code: "FIXTURE_STALE_CURSOR", message: "Cursor is stale or belongs to another run." } },
      };
    }
    offset = Number(cursorOffset);
    if (!Number.isSafeInteger(offset) || offset > 10_000) {
      return { status: 410, body: { error: { code: "FIXTURE_STALE_CURSOR", message: "Cursor offset is invalid." } } };
    }
  }
  const limit = decimalParameter(url, "resultRecordCount", 1, 2);
  if (limit < 1) throw Object.assign(new Error("resultRecordCount must be greater than zero."), { status: 400 });
  const features = baseline.features.slice(offset, offset + limit);
  const nextOffset = offset + features.length;
  const hasMore = nextOffset < baseline.features.length;
  const nextCursor = hasMore ? `${run.id}:${nextOffset}:${run.state.cursorGeneration}` : null;
  if (nextCursor) {
    run.state.issuedPageCursors.add(nextCursor);
    if (run.state.issuedPageCursors.size > 128) {
      run.state.issuedPageCursors.delete(run.state.issuedPageCursors.values().next().value);
    }
  }
  return {
    status: 200,
    body: {
      ...baseline,
      features,
      exceededTransferLimit: hasMore,
      nextCursor,
    },
  };
}

function overflowGeoServicesResponse(url, baseline) {
  const offset = decimalParameter(url, "resultOffset", 0, 10_000);
  const requested = decimalParameter(url, "resultRecordCount", OVERFLOW_PAGE_SIZE, 10_000);
  if (requested < 1) throw Object.assign(new Error("resultRecordCount must be greater than zero."), { status: 400 });
  const features = baseline.features.slice(offset, offset + Math.min(requested, OVERFLOW_PAGE_SIZE));
  return {
    ...baseline,
    features,
    exceededTransferLimit: offset + features.length < baseline.features.length,
  };
}

function geoServicesResponse(url, baseline) {
  if (url.searchParams.getAll("resultOffset").length > 1 || url.searchParams.getAll("resultRecordCount").length > 1) {
    throw Object.assign(new Error("GeoServices pagination parameters may appear only once."), { status: 400 });
  }
  const offset = decimalParameter(url, "resultOffset", 0, 10_000);
  const requested = decimalParameter(url, "resultRecordCount", 25, 25);
  if (requested < 1) throw Object.assign(new Error("resultRecordCount must be greater than zero."), { status: 400 });
  const features = baseline.features.slice(offset, offset + requested);
  return {
    ...baseline,
    features,
    exceededTransferLimit: offset + features.length < baseline.features.length,
  };
}

function filterGeoServicesResponse(url, baseline) {
  if (url.searchParams.getAll("where").length > 1) {
    throw Object.assign(new Error("GeoServices where may appear only once."), { status: 400 });
  }
  const where = url.searchParams.get("where")?.trim();
  if (!where || /^\(?\s*1\s*=\s*1\s*\)?$/i.test(where)) return baseline;
  const comparison = /^(STATUS|CATEGORY)\s*=\s*'((?:''|[^'])*)'$/i.exec(where);
  if (!comparison) {
    throw Object.assign(new Error("The fixture supports bounded STATUS or CATEGORY equality filters."), { status: 400 });
  }
  const field = comparison[1].toUpperCase();
  const value = comparison[2].replaceAll("''", "'");
  return {
    ...baseline,
    features: baseline.features.filter((feature) => feature.attributes?.[field] === value),
  };
}

function assertOgcQueryParameters(url, allowedNames, description) {
  const allowed = new Set(allowedNames);
  for (const name of new Set(url.searchParams.keys())) {
    if (!allowed.has(name)) {
      throw Object.assign(new Error(`Unsupported ${description} query parameter: ${name}.`), { status: 400 });
    }
    if (url.searchParams.getAll(name).length !== 1) {
      throw Object.assign(new Error(`${description} query parameter ${name} may appear only once.`), { status: 400 });
    }
  }
}

function assertOgcResponseFormat(url, formats, description) {
  const format = url.searchParams.get("f");
  if (format !== null && !formats.includes(format)) {
    throw Object.assign(new Error(`${description} f must be one of: ${formats.join(", ")}.`), { status: 400 });
  }
}

function ogcLimitParameter(url, fallback) {
  const value = url.searchParams.get("limit");
  if (value === null) return fallback;
  if (!/^[1-9]\d*$/.test(value)) {
    throw Object.assign(new Error("limit must be a positive decimal integer."), { status: 400 });
  }
  return Number(BigInt(value) > 1_000n ? 1_000n : BigInt(value));
}

function parseOgcBbox(value) {
  if (value === null) return null;
  const parts = value.split(",");
  const decimal = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
  if (![4, 6].includes(parts.length) || parts.some((part) => !decimal.test(part))) {
    throw Object.assign(new Error("bbox must contain exactly four or six comma-separated numbers."), {
      status: 400,
    });
  }
  const bbox = parts.map((part) => Number(part));
  if (!bbox.every(Number.isFinite)) {
    throw Object.assign(new Error("bbox values must be finite numbers."), { status: 400 });
  }
  const [west, south, third, fourth, fifth, sixth] = bbox;
  const east = bbox.length === 4 ? third : fourth;
  const north = bbox.length === 4 ? fourth : fifth;
  if (
    west < -180 ||
    west > 180 ||
    east < -180 ||
    east > 180 ||
    south < -90 ||
    south > 90 ||
    north < -90 ||
    north > 90
  ) {
    throw Object.assign(new Error("bbox longitude and latitude values must be within CRS84 bounds."), {
      status: 400,
    });
  }
  if (south > north || (bbox.length === 6 && third > sixth)) {
    throw Object.assign(new Error("bbox minimum values must not exceed maximum values."), { status: 400 });
  }
  return { west, south, east, north };
}

function parseRfc3339(value) {
  const parsed = parseRfc3339Instant(value);
  if (parsed === undefined) {
    throw Object.assign(new Error("datetime values must be RFC 3339 instants."), { status: 400 });
  }
  return parsed;
}

function validateGeoServicesQuery(run, url) {
  if (
    url.searchParams.getAll("cursor").length > 1 ||
    url.searchParams.getAll("resultOffset").length > 1 ||
    url.searchParams.getAll("resultRecordCount").length > 1
  ) {
    throw Object.assign(new Error("GeoServices pagination parameters may appear only once."), { status: 400 });
  }
  const requestedCursor = url.searchParams.get("cursor");
  if (requestedCursor !== null && url.searchParams.has("resultOffset")) {
    throw Object.assign(new Error("cursor and resultOffset are mutually exclusive."), { status: 400 });
  }
  if (run.scenario !== "paginated" && requestedCursor !== null) {
    throw Object.assign(new Error("This scenario does not issue page cursors."), { status: 400 });
  }
  if (requestedCursor !== null) {
    if (!run.state.issuedPageCursors.has(requestedCursor)) {
      throw Object.assign(new Error("Cursor was not issued for this run."), { status: 410 });
    }
    const [cursorRun, cursorOffset, generation] = requestedCursor.split(":");
    const offset = Number(cursorOffset);
    if (
      cursorRun !== run.id ||
      generation !== run.state.cursorGeneration ||
      !/^\d+$/.test(cursorOffset ?? "") ||
      !Number.isSafeInteger(offset) ||
      offset > 10_000
    ) {
      throw Object.assign(new Error("Cursor is stale or belongs to another run."), { status: 410 });
    }
  } else {
    decimalParameter(url, "resultOffset", 0, 10_000);
  }
  const maximum = run.scenario === "paginated" ? 2 : run.scenario === "overflow" ? 10_000 : 25;
  const fallback = run.scenario === "paginated" ? 1 : run.scenario === "overflow" ? OVERFLOW_PAGE_SIZE : 25;
  if (decimalParameter(url, "resultRecordCount", fallback, maximum) < 1) {
    throw Object.assign(new Error("resultRecordCount must be greater than zero."), { status: 400 });
  }
}

function validateOgcDatetime(value) {
  if (value === null) return;
  const parts = value.split("/");
  if (parts.length === 1) {
    parseRfc3339(parts[0]);
    return;
  }
  const isOpen = (part) => part === "" || part === "..";
  if (parts.length !== 2 || parts.every(isOpen)) {
    throw Object.assign(new Error("datetime must be an RFC 3339 instant or interval."), { status: 400 });
  }
  const [start, end] = parts;
  if (!isOpen(start)) parseRfc3339(start);
  if (!isOpen(end)) parseRfc3339(end);
  if (!isOpen(start) && !isOpen(end) && compareRfc3339Instants(start, end) > 0) {
    throw Object.assign(new Error("datetime interval start must not exceed its end."), { status: 400 });
  }
}

function featureExtent(feature) {
  const extent = [
    Number.POSITIVE_INFINITY,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
  ];
  function visit(value) {
    if (!Array.isArray(value)) return;
    if (value.length >= 2 && typeof value[0] === "number" && typeof value[1] === "number") {
      extent[0] = Math.min(extent[0], value[0]);
      extent[1] = Math.min(extent[1], value[1]);
      extent[2] = Math.max(extent[2], value[0]);
      extent[3] = Math.max(extent[3], value[1]);
      return;
    }
    for (const entry of value) visit(entry);
  }
  visit(feature.geometry?.coordinates);
  return extent;
}

function intersectsBbox(feature, bbox) {
  if (bbox === null) return true;
  const [featureWest, featureSouth, featureEast, featureNorth] = featureExtent(feature);
  const longitudeIntersects =
    bbox.west <= bbox.east
      ? featureEast >= bbox.west && featureWest <= bbox.east
      : featureEast >= bbox.west || featureWest <= bbox.east;
  return longitudeIntersects && featureNorth >= bbox.south && featureSouth <= bbox.north;
}

function ogcItemsPage(run, url, baseline) {
  assertOgcQueryParameters(url, ["bbox", "crs", "datetime", "f", "limit", "offset", "run"], "OGC items");
  assertOgcResponseFormat(url, ["json", "geojson"], "OGC items");
  const formatValue = url.searchParams.get("f");
  const bboxValue = url.searchParams.get("bbox");
  const datetimeValue = url.searchParams.get("datetime");
  const bbox = parseOgcBbox(bboxValue);
  validateOgcDatetime(datetimeValue);
  const offset = decimalParameter(url, "offset", 0, 10_000);
  const defaultLimit = run.scenario === "paginated" ? 1 : run.scenario === "overflow" ? OVERFLOW_PAGE_SIZE : 1_000;
  const requested = ogcLimitParameter(url, defaultLimit);
  const scenarioLimit = ["paginated", "overflow"].includes(run.scenario) ? OVERFLOW_PAGE_SIZE : 1_000;
  const limit = Math.min(requested, scenarioLimit);
  const matchedFeatures = baseline.features.filter((feature) => intersectsBbox(feature, bbox));
  const features = matchedFeatures.slice(offset, offset + limit);
  const nextOffset = offset + features.length;
  const hasMore = nextOffset < matchedFeatures.length;
  const selection = [
    ["bbox", bboxValue],
    ["datetime", datetimeValue],
    ["f", formatValue],
    ["limit", limit],
    ["offset", offset],
  ];
  const links = [
    {
      href: fixtureHref(run, OGC_ITEMS_ROOT, selection),
      rel: "self",
      type: "application/geo+json",
      title: "Collection items",
    },
    ...linksForRun(
      baseline.links.filter((link) => !["self", "next"].includes(link.rel)),
      run,
    ),
  ];
  if (hasMore) {
    links.push({
      href: fixtureHref(
        run,
        OGC_ITEMS_ROOT,
        selection.map(([name, value]) => [name, name === "offset" ? nextOffset : value]),
      ),
      rel: "next",
      type: "application/geo+json",
      title: "Next items page",
    });
  }
  return {
    ...baseline,
    features,
    numberMatched: matchedFeatures.length,
    numberReturned: features.length,
    links,
  };
}

function sendQueryScenarioFailure(res, run, protocol) {
  if (!metadataQuerySupported(run)) {
    sendJson(
      res,
      405,
      {
        error: {
          code: "FIXTURE_CAPABILITY_NOT_ADVERTISED",
          capability: "query",
          protocol,
          message: "Query is deliberately absent from this run's discovery metadata.",
        },
      },
      { allow: "" },
    );
    return true;
  }
  if (run.scenario === "abort") {
    sendJson(
      res,
      499,
      { error: { code: "FIXTURE_ABORT", message: "Abort before response body is deterministic." } },
      { "x-fixture-abort": "client-before-body" },
    );
    return true;
  }
  if (run.scenario === "throttled" && run.state.throttleRemaining > 0) {
    run.state.throttleRemaining -= 1;
    sendJson(res, 429, { error: { code: "FIXTURE_THROTTLED", retryable: true } }, { "retry-after": "0" });
    return true;
  }
  if (run.scenario === "stale-cursor") {
    sendJson(res, 410, { error: { code: "FIXTURE_STALE_CURSOR", message: "Cursor checkpoint expired." } });
    return true;
  }
  return false;
}

function sendGeoJson(res, status, value, extraHeaders = {}, cachePolicy = "no-store") {
  sendText(res, status, `${JSON.stringify(value)}\n`, OGC_GEOJSON_CONTENT_TYPE, extraHeaders, cachePolicy);
}

function sendScenarioJson(req, res, run, representation, value, status = 200) {
  const headers = scenarioHeaders(run, representation, value);
  const cachePolicy = scenarioCachePolicy(run);
  if (status === 200 && isNotModified(req, run, representation, value)) {
    res.writeHead(304, fixtureHeaders(headers, cachePolicy));
    res.end();
    return;
  }
  sendJson(res, status, value, headers, cachePolicy);
}

function sendScenarioOgcJson(req, res, run, representation, value, contentType = null) {
  const headers =
    contentType === OGC_GEOJSON_CONTENT_TYPE
      ? ogcHeaders(run, representation, value)
      : scenarioHeaders(run, representation, value);
  const cachePolicy = scenarioCachePolicy(run);
  if (isNotModified(req, run, representation, value)) {
    res.writeHead(304, fixtureHeaders(headers, cachePolicy));
    res.end();
    return;
  }
  if (contentType === OGC_OPENAPI_CONTENT_TYPE) {
    sendText(res, 200, `${JSON.stringify(value)}\n`, contentType, headers, cachePolicy);
    return;
  }
  if (contentType === OGC_GEOJSON_CONTENT_TYPE) {
    sendGeoJson(res, 200, value, headers, cachePolicy);
    return;
  }
  sendJson(res, 200, value, headers, cachePolicy);
}

function sendByteRange(req, res, value, extraHeaders = {}, contentType = "application/json; charset=utf-8") {
  const body = Buffer.from(`${canonicalJson(value)}\n`);
  const header = req.headers.range;
  if (!header) {
    sendText(res, 200, body, contentType, { "accept-ranges": "bytes", ...extraHeaders });
    return;
  }
  const match = /^bytes=(\d+)-(\d*)$/.exec(header);
  if (!match) {
    sendText(res, 416, "Invalid fixture byte range.", "text/plain; charset=utf-8", {
      "content-range": `bytes */${body.length}`,
    });
    return;
  }
  const start = Number(match[1]);
  const end = match[2] ? Math.min(Number(match[2]), body.length - 1) : body.length - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= body.length) {
    sendText(res, 416, "Unsatisfiable fixture byte range.", "text/plain; charset=utf-8", {
      "content-range": `bytes */${body.length}`,
    });
    return;
  }
  const selected = body.subarray(start, end + 1);
  res.writeHead(
    206,
    fixtureResponseHeaders(
      { contentLength: selected.length, contentType },
      { "accept-ranges": "bytes", "content-range": `bytes ${start}-${end}/${body.length}`, ...extraHeaders },
    ),
  );
  res.end(selected);
}

function applyFixtureEdit(run, body, editableRecordId) {
  assertEditBody(body);
  if (body.objectId !== editableRecordId) {
    return {
      status: 403,
      body: { error: { code: "FIXTURE_EDIT_BLOCKED", message: "Only the isolated fixture record is editable." } },
    };
  }
  const previous = run.state.idempotency.get(body.idempotencyKey);
  if (previous) {
    const requestFingerprint = canonicalJson(body);
    if (previous.fingerprint !== requestFingerprint) {
      return {
        status: 409,
        body: {
          error: {
            code: "FIXTURE_IDEMPOTENCY_CONFLICT",
            message: "Idempotency key was already bound to a different edit request.",
          },
        },
      };
    }
    return { status: 200, body: { ...previous.receipt, outcome: "duplicate" } };
  }
  const actualRevision = run.state.revisions.get(body.objectId);
  if (run.scenario === "edit-conflict" || body.expectedRevision !== actualRevision) {
    return {
      status: 409,
      body: { error: { code: "FIXTURE_EDIT_CONFLICT", expectedRevision: body.expectedRevision, actualRevision } },
    };
  }
  if (run.state.idempotency.size >= MAXIMUM_IDEMPOTENCY_KEYS) {
    return {
      status: 429,
      body: {
        error: {
          code: "FIXTURE_IDEMPOTENCY_CAPACITY",
          message: `Fixture runs retain at most ${MAXIMUM_IDEMPOTENCY_KEYS} idempotency keys.`,
        },
      },
    };
  }
  const editId = run.ids.next("edit");
  const revision = actualRevision + 1;
  const receipt = { editId, objectId: body.objectId, revision, applied: true, outcome: "applied" };
  run.state.revisions.set(body.objectId, revision);
  run.state.featureOverrides.set(body.objectId, clone(body.attributes));
  run.state.idempotency.set(body.idempotencyKey, {
    fingerprint: canonicalJson(body),
    receipt: clone(receipt),
  });
  return { status: 200, body: receipt };
}

export function createFirstMapHandler(pack) {
  const capabilities = pack.data[pack.manifest.schema.files.capabilities];
  const layer = pack.data[pack.manifest.schema.files.layer];
  const features = pack.data[pack.manifest.schema.files.features];
  const ogcLanding = pack.data[pack.manifest.schema.files.ogcLanding];
  const ogcApiDefinition = pack.data[pack.manifest.schema.files.ogcApiDefinition];
  const ogcConformance = pack.data[pack.manifest.schema.files.ogcConformance];
  const ogcCollection = pack.data[pack.manifest.schema.files.ogcCollection];
  const ogcItems = pack.data[pack.manifest.schema.files.ogcItems];
  const basemap = {
    version: 8,
    sources: {},
    layers: [{ id: "background", type: "background", paint: { "background-color": "#efe6d1" } }],
  };
  const editableRecordId = pack.manifest.schema.editableRecordId;

  return Object.freeze({
    id: "first-map",
    createRunState(run) {
      return {
        throttleRemaining: 1,
        cursorGeneration: run.ids.next("cursor"),
        issuedPageCursors: new Set(),
        revisions: new Map([[editableRecordId, 1]]),
        idempotency: new Map(),
        featureOverrides: new Map(),
      };
    },
    inspectRunState(run) {
      return {
        cursorGeneration: run.state.cursorGeneration,
        editCount: run.state.featureOverrides.size,
        idempotencyKeyCount: run.state.idempotency.size,
        throttleRemaining: run.state.throttleRemaining,
      };
    },
    handleAction({ action, body, run }) {
      if (action !== "edit") {
        return { status: 404, body: { error: { code: "FIXTURE_ACTION_NOT_FOUND" } } };
      }
      return applyFixtureEdit(run, body, editableRecordId);
    },
    handle({ req, res, url, run }) {
      if (req.method === "GET" && url.pathname === "/api/v1/admin/capabilities") {
        sendScenarioJson(req, res, run, "honua-capabilities", capabilities);
        return true;
      }
      if (req.method === "GET" && url.pathname === "/__honua-quickstart__/basemap-style.json") {
        sendJson(res, 200, basemap);
        return true;
      }
      if (req.method === "GET" && url.pathname === OGC_ROOT) {
        assertOgcQueryParameters(url, ["f", "run"], "OGC landing page");
        assertOgcResponseFormat(url, ["json"], "OGC landing page");
        sendScenarioOgcJson(req, res, run, "ogc-landing", linkedDocument(ogcLanding, run));
        return true;
      }
      if (req.method === "GET" && url.pathname === `${OGC_ROOT}/api`) {
        assertOgcQueryParameters(url, ["f", "run"], "OGC API definition");
        assertOgcResponseFormat(url, ["json"], "OGC API definition");
        sendScenarioOgcJson(
          req,
          res,
          run,
          "ogc-api-definition",
          apiDefinitionForRun(ogcApiDefinition, run),
          OGC_OPENAPI_CONTENT_TYPE,
        );
        return true;
      }
      if (req.method === "GET" && url.pathname === `${OGC_ROOT}/conformance`) {
        assertOgcQueryParameters(url, ["f", "run"], "OGC conformance");
        assertOgcResponseFormat(url, ["json"], "OGC conformance");
        sendScenarioOgcJson(req, res, run, "ogc-conformance", conformanceForRun(ogcConformance, run));
        return true;
      }
      if (req.method === "GET" && url.pathname === `${OGC_ROOT}/collections`) {
        assertOgcQueryParameters(url, ["f", "run"], "OGC collections");
        assertOgcResponseFormat(url, ["json"], "OGC collections");
        const response = {
          collections: [collectionForRun(ogcCollection, run)],
          links: [
            {
              href: fixtureHref(run, `${OGC_ROOT}/collections`),
              rel: "self",
              type: "application/json",
              title: "Feature collections",
            },
          ],
        };
        sendScenarioOgcJson(req, res, run, "ogc-collections", response);
        return true;
      }
      if (req.method === "GET" && url.pathname === OGC_COLLECTION_ROOT) {
        assertOgcQueryParameters(url, ["f", "run"], "OGC collection");
        assertOgcResponseFormat(url, ["json"], "OGC collection");
        sendScenarioOgcJson(req, res, run, "ogc-collection", collectionForRun(ogcCollection, run));
        return true;
      }
      if (req.method === "GET" && url.pathname === OGC_ITEMS_ROOT) {
        const response = ogcItemsPage(run, url, applyOgcFeatureOverrides(clone(ogcItems), run));
        if (sendQueryScenarioFailure(res, run, "ogc-features")) return true;
        if (run.scenario === "range") {
          sendByteRange(req, res, response, ogcHeaders(run, "ogc-items", response), OGC_GEOJSON_CONTENT_TYPE);
          return true;
        }
        sendScenarioOgcJson(req, res, run, "ogc-items", response, OGC_GEOJSON_CONTENT_TYPE);
        return true;
      }
      const ogcItemMatch = new RegExp(`^${OGC_ITEMS_ROOT}/([^/]+)$`).exec(url.pathname);
      if (req.method === "GET" && ogcItemMatch) {
        assertOgcQueryParameters(url, ["f", "run"], "OGC feature");
        assertOgcResponseFormat(url, ["json", "geojson"], "OGC feature");
        const featureId = ogcItemMatch[1];
        const numericFeatureId = Number(featureId);
        if (!/^[1-9]\d*$/.test(featureId) || !Number.isSafeInteger(numericFeatureId)) {
          sendJson(res, 400, { error: { code: "FIXTURE_INVALID_FEATURE_ID" } });
          return true;
        }
        if (sendQueryScenarioFailure(res, run, "ogc-features")) return true;
        const response = applyOgcFeatureOverrides(clone(ogcItems), run);
        const candidate = response.features.find((feature) => feature.id === numericFeatureId);
        if (!candidate) {
          sendJson(res, 404, { error: { code: "FIXTURE_FEATURE_NOT_FOUND" } });
          return true;
        }
        const feature = {
          ...candidate,
          links: [
            {
              href: fixtureHref(run, `${OGC_ITEMS_ROOT}/${featureId}`),
              rel: "self",
              type: "application/geo+json",
              title: "This feature",
            },
            {
              href: fixtureHref(run, OGC_COLLECTION_ROOT),
              rel: "collection",
              type: "application/json",
              title: "Collection metadata",
            },
          ],
        };
        sendScenarioOgcJson(req, res, run, "ogc-feature", feature, OGC_GEOJSON_CONTENT_TYPE);
        return true;
      }
      if (req.method === "GET" && url.pathname === SERVICE_ROOT) {
        sendScenarioJson(req, res, run, "geoservices-layer", layerForRun(layer, run));
        return true;
      }
      if (url.pathname === OGC_ROOT || url.pathname.startsWith(`${OGC_ROOT}/`)) {
        sendJson(res, 404, { error: { code: "FIXTURE_OGC_ROUTE_NOT_FOUND" } });
        return true;
      }
      if (url.pathname !== `${SERVICE_ROOT}/query` || req.method !== "GET") return false;

      validateGeoServicesQuery(run, url);
      if (sendQueryScenarioFailure(res, run, "geoservices-feature-service")) return true;

      const response = filterGeoServicesResponse(url, applyFeatureOverrides(clone(features), run));
      if (run.scenario === "paginated") {
        const page = paginatedResponse(run, url, response);
        sendScenarioJson(req, res, run, "geoservices-query", page.body, page.status);
        return true;
      }
      if (run.scenario === "overflow") {
        sendScenarioJson(req, res, run, "geoservices-query", overflowGeoServicesResponse(url, response));
        return true;
      }
      const pagedResponse = geoServicesResponse(url, response);
      if (run.scenario === "range") {
        sendByteRange(req, res, pagedResponse, scenarioHeaders(run, "geoservices-query", pagedResponse));
        return true;
      }
      sendScenarioJson(req, res, run, "geoservices-query", pagedResponse);
      return true;
    },
  });
}
