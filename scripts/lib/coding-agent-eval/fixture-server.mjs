/**
 * Deterministic multi-protocol fixture server for the coding-agent eval lane.
 *
 * Serves, from a single ephemeral 127.0.0.1 port, every endpoint the eval
 * task corpus exercises:
 *
 *  - Esri GeoServices FeatureServer (`/rest/services/EvalIncidents/...`) with
 *    an inline 5-feature incident layer honouring `where`, `outFields`,
 *    `returnCountOnly`, `resultOffset` / `resultRecordCount` paging.
 *  - Esri GeocodeServer (`/rest/services/EvalLocator/GeocodeServer/...`).
 *  - OGC API Features via the Honua facade layout
 *    (`/ogc/features/collections/eval-incidents/items`).
 *  - WFS 2.0 (`/geoserver/ows` capabilities + `/geoserver/wfs` GetFeature)
 *    replaying the recorded GeoServer fixtures under
 *    `test/fixtures/backend-agnostic/geoserver-wfs/` with DCP hrefs rewritten
 *    to this server.
 *  - STAC item search (`/stac/v1/search`) replaying the recorded Earth Search
 *    fixture.
 *  - OData v4 (`/odata/TripPin/$metadata` + `/odata/TripPin/People`) replaying
 *    the recorded TripPin fixtures.
 *
 * Everything is a pure function of committed fixture files plus the inline
 * corpus below — no network, no clock, no randomness in response bodies.
 */

import http from "node:http";
import { readFileSync } from "node:fs";
import path from "node:path";

const WFS_TYPE_NAME = "ne:ne_10m_admin_0_countries";
const UPSTREAM_WFS_HOST = "https://ahocevar.com";
const UPSTREAM_STAC_ROOT = "https://earth-search.aws.element84.com/v1";
const UPSTREAM_ODATA_ROOT = "https://services.odata.org/TripPinRESTierService";

export const EVAL_SERVICE_ID = "EvalIncidents";
export const EVAL_LAYER_ID = 0;
export const EVAL_OGC_COLLECTION_ID = "eval-incidents";
export const EVAL_LOCATOR_NAME = "EvalLocator";

const FIELDS = [
  { name: "OBJECTID", type: "esriFieldTypeOID", alias: "Object ID" },
  { name: "name", type: "esriFieldTypeString", alias: "Name" },
  { name: "priority", type: "esriFieldTypeString", alias: "Priority" },
  { name: "status", type: "esriFieldTypeString", alias: "Status" },
  { name: "magnitude", type: "esriFieldTypeInteger", alias: "Magnitude" },
];

const FEATURES = [
  { attributes: { OBJECTID: 1, name: "Harbor debris sweep", priority: "high", status: "open", magnitude: 7 }, geometry: { x: -157.8583, y: 21.3069, spatialReference: { wkid: 4326 } } },
  { attributes: { OBJECTID: 2, name: "Ridge trail washout", priority: "high", status: "open", magnitude: 9 }, geometry: { x: -157.8015, y: 21.2767, spatialReference: { wkid: 4326 } } },
  { attributes: { OBJECTID: 3, name: "Reservoir level check", priority: "medium", status: "monitoring", magnitude: 4 }, geometry: { x: -157.7395, y: 21.397, spatialReference: { wkid: 4326 } } },
  { attributes: { OBJECTID: 4, name: "Culvert inspection", priority: "low", status: "closed", magnitude: 2 }, geometry: { x: -157.9253, y: 21.3445, spatialReference: { wkid: 4326 } } },
  { attributes: { OBJECTID: 5, name: "Signage refresh", priority: "low", status: "closed", magnitude: 1 }, geometry: { x: -157.8103, y: 21.2735, spatialReference: { wkid: 4326 } } },
];

const GEOCODE_CANDIDATE = {
  address: "410 Atkinson Dr, Honolulu, Hawaii, 96814",
  location: { x: -157.842, y: 21.2905 },
  score: 100,
  attributes: { Addr_type: "PointAddress" },
};

/**
 * Evaluate a deliberately small `where` / CQL2 text subset against a feature's
 * attribute bag. Supports `1=1`, `field = 'text'`, `field = number`,
 * `field > number`, `field >= number`, `field < number`, `field <= number`,
 * and `field <> ...`. Anything else matches nothing (fail closed) so a wrong
 * clause is an observable failure, not a silent full-table scan.
 */
export function evaluateWhere(where, attributes) {
  const clause = (where ?? "").trim();
  if (clause === "" || clause === "1=1" || clause === "1 = 1") return true;
  const match = clause.match(/^(\w+)\s*(=|<>|>=|<=|>|<)\s*(?:'([^']*)'|(-?\d+(?:\.\d+)?))$/);
  if (!match) return false;
  const [, field, op, text, num] = match;
  const actual = attributes[field];
  const expected = text !== undefined ? text : Number(num);
  switch (op) {
    case "=":
      return actual === expected;
    case "<>":
      return actual !== expected;
    case ">":
      return typeof actual === "number" && actual > expected;
    case ">=":
      return typeof actual === "number" && actual >= expected;
    case "<":
      return typeof actual === "number" && actual < expected;
    case "<=":
      return typeof actual === "number" && actual <= expected;
    default:
      return false;
  }
}

function projectAttributes(attributes, outFields) {
  if (!outFields || outFields === "*" || outFields.trim() === "" || outFields.trim() === "*") return { ...attributes };
  const names = outFields.split(",").map((name) => name.trim()).filter(Boolean);
  if (names.includes("*")) return { ...attributes };
  const projected = {};
  for (const name of names) {
    if (name in attributes) projected[name] = attributes[name];
  }
  return projected;
}

function toPositiveInt(value, fallback) {
  if (value === null || value === undefined || value === "") return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function geoservicesQueryResponse(params) {
  const where = params.get("where") ?? "1=1";
  const filtered = FEATURES.filter((feature) => evaluateWhere(where, feature.attributes));
  if (params.get("returnCountOnly") === "true") {
    return { count: filtered.length };
  }
  if (params.get("returnIdsOnly") === "true") {
    return { objectIdFieldName: "OBJECTID", objectIds: filtered.map((f) => f.attributes.OBJECTID) };
  }
  const offset = toPositiveInt(params.get("resultOffset"), 0);
  const limit = toPositiveInt(params.get("resultRecordCount"), filtered.length);
  const page = filtered.slice(offset, offset + limit);
  const returnGeometry = params.get("returnGeometry") !== "false";
  const outFields = params.get("outFields");
  return {
    objectIdFieldName: "OBJECTID",
    geometryType: "esriGeometryPoint",
    spatialReference: { wkid: 4326 },
    fields: FIELDS,
    features: page.map((feature) => ({
      attributes: projectAttributes(feature.attributes, outFields),
      ...(returnGeometry ? { geometry: feature.geometry } : {}),
    })),
    exceededTransferLimit: offset + page.length < filtered.length,
  };
}

function ogcItemsResponse(params) {
  const filter = params.get("filter");
  const filtered = FEATURES.filter((feature) => evaluateWhere(filter ?? "1=1", feature.attributes));
  const offset = toPositiveInt(params.get("offset"), 0);
  const limit = toPositiveInt(params.get("limit"), filtered.length);
  const page = filtered.slice(offset, offset + limit);
  return {
    type: "FeatureCollection",
    numberMatched: filtered.length,
    numberReturned: page.length,
    features: page.map((feature) => ({
      type: "Feature",
      id: String(feature.attributes.OBJECTID),
      geometry: { type: "Point", coordinates: [feature.geometry.x, feature.geometry.y] },
      properties: { ...feature.attributes },
    })),
  };
}

function layerMetadata() {
  return {
    id: EVAL_LAYER_ID,
    name: "incidents",
    type: "Feature Layer",
    geometryType: "esriGeometryPoint",
    objectIdField: "OBJECTID",
    fields: FIELDS,
    spatialReference: { wkid: 4326 },
    extent: { xmin: -158, ymin: 21.2, xmax: -157.7, ymax: 21.45, spatialReference: { wkid: 4326 } },
    maxRecordCount: 100,
    supportsAttachments: false,
    capabilities: "Query",
    supportedQueryFormats: "JSON",
    useStandardizedQueries: true,
    advancedQueryCapabilities: {
      supportsPagination: true,
      supportsReturningQueryExtent: true,
      supportsStatistics: false,
    },
  };
}

function serviceMetadata() {
  return {
    serviceDescription: "Deterministic eval incidents FeatureServer.",
    layers: [{ id: EVAL_LAYER_ID, name: "incidents", geometryType: "esriGeometryPoint" }],
    tables: [],
    spatialReference: { wkid: 4326 },
    fullExtent: { xmin: -158, ymin: 21.2, xmax: -157.7, ymax: 21.45, spatialReference: { wkid: 4326 } },
    capabilities: "Query",
  };
}

function loadBackendAgnosticFixtures(repoRoot) {
  const root = path.join(repoRoot, "test", "fixtures", "backend-agnostic");
  return {
    wfsCapabilitiesXml: readFileSync(path.join(root, "geoserver-wfs", "capabilities.xml"), "utf8"),
    wfsGetFeatureJson: readFileSync(path.join(root, "geoserver-wfs", "getfeature-countries.json"), "utf8"),
    stacSearchJson: readFileSync(path.join(root, "earth-search-stac", "search.json"), "utf8"),
    odataMetadataXml: readFileSync(path.join(root, "odata", "trippin-metadata.xml"), "utf8"),
    odataPeopleJson: readFileSync(path.join(root, "odata", "people-page.json"), "utf8"),
  };
}

function sendJson(res, statusCode, body) {
  res.writeHead(statusCode, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
}

function sendXml(res, statusCode, body) {
  res.writeHead(statusCode, { "content-type": "application/xml; charset=utf-8", "cache-control": "no-store" });
  res.end(body);
}

/**
 * Start the eval fixture server on an ephemeral 127.0.0.1 port.
 *
 * @param {{ repoRoot: string, port?: number }} options
 * @returns {Promise<{ url: string, requests: Array<{method: string, pathname: string, search: string}>, close(): Promise<void> }>}
 */
export async function startEvalFixtureServer(options) {
  const fixtures = loadBackendAgnosticFixtures(options.repoRoot);
  const requests = [];

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const method = req.method ?? "GET";
    requests.push({ method, pathname: url.pathname, search: url.search });
    const base = localBase();

    // --- GeoServices FeatureServer -------------------------------------
    if (url.pathname === "/rest/services") {
      return sendJson(res, 200, { services: [{ name: EVAL_SERVICE_ID, type: "FeatureServer" }] });
    }
    if (url.pathname === `/rest/services/${EVAL_SERVICE_ID}/FeatureServer`) {
      return sendJson(res, 200, serviceMetadata());
    }
    if (url.pathname === `/rest/services/${EVAL_SERVICE_ID}/FeatureServer/${EVAL_LAYER_ID}`) {
      return sendJson(res, 200, layerMetadata());
    }
    if (url.pathname === `/rest/services/${EVAL_SERVICE_ID}/FeatureServer/${EVAL_LAYER_ID}/query`) {
      return sendJson(res, 200, geoservicesQueryResponse(url.searchParams));
    }

    // --- GeocodeServer ---------------------------------------------------
    const geocodeBase = `/rest/services/${EVAL_LOCATOR_NAME}/GeocodeServer`;
    if (url.pathname === `${geocodeBase}/findAddressCandidates`) {
      const singleLine = url.searchParams.get("singleLine") ?? "";
      const candidates = singleLine.toLowerCase().includes("atkinson") ? [GEOCODE_CANDIDATE] : [];
      return sendJson(res, 200, { spatialReference: { wkid: 4326 }, candidates });
    }
    if (url.pathname === `${geocodeBase}/suggest`) {
      const text = url.searchParams.get("text") ?? "";
      const suggestions = text.toLowerCase().startsWith("atk")
        ? [{ text: GEOCODE_CANDIDATE.address, magicKey: "eval:atkinson", isCollection: false }]
        : [];
      return sendJson(res, 200, { suggestions });
    }
    if (url.pathname === `${geocodeBase}/reverseGeocode`) {
      return sendJson(res, 200, {
        address: { Match_addr: GEOCODE_CANDIDATE.address },
        location: GEOCODE_CANDIDATE.location,
      });
    }

    // --- OGC API Features (Honua facade layout) --------------------------
    if (url.pathname === "/ogc/features") {
      return sendJson(res, 200, {
        title: "Eval OGC API Features facade",
        links: [
          { rel: "self", type: "application/json", href: `${base}/ogc/features` },
          { rel: "data", type: "application/json", href: `${base}/ogc/features/collections` },
          { rel: "conformance", type: "application/json", href: `${base}/ogc/features/conformance` },
        ],
      });
    }
    if (url.pathname === "/ogc/features/conformance") {
      return sendJson(res, 200, {
        conformsTo: [
          "http://www.opengis.net/spec/ogcapi-features-1/1.0/conf/core",
          "http://www.opengis.net/spec/ogcapi-features-1/1.0/conf/geojson",
        ],
      });
    }
    if (url.pathname === "/ogc/features/collections") {
      return sendJson(res, 200, {
        collections: [{ id: EVAL_OGC_COLLECTION_ID, title: "Eval incidents", itemType: "feature" }],
      });
    }
    if (url.pathname === `/ogc/features/collections/${EVAL_OGC_COLLECTION_ID}`) {
      return sendJson(res, 200, { id: EVAL_OGC_COLLECTION_ID, title: "Eval incidents", itemType: "feature" });
    }
    if (url.pathname === `/ogc/features/collections/${EVAL_OGC_COLLECTION_ID}/items`) {
      return sendJson(res, 200, ogcItemsResponse(url.searchParams));
    }

    // --- WFS 2.0 (recorded GeoServer fixtures) ---------------------------
    if (url.pathname === "/geoserver/ows" || url.pathname === "/geoserver/wfs") {
      const request = (url.searchParams.get("request") ?? "").toLowerCase();
      if (request === "getcapabilities") {
        return sendXml(res, 200, fixtures.wfsCapabilitiesXml.replaceAll(UPSTREAM_WFS_HOST, base));
      }
      if (request === "getfeature") {
        const typeNames = url.searchParams.get("typenames") ?? url.searchParams.get("typeNames") ?? url.searchParams.get("typename") ?? "";
        if (typeNames !== WFS_TYPE_NAME) {
          return sendJson(res, 400, {
            error: { code: "unknown-type-name", message: `No fixture feature type "${typeNames}".` },
          });
        }
        return sendJson(res, 200, fixtures.wfsGetFeatureJson.replaceAll(UPSTREAM_WFS_HOST, base));
      }
      return sendJson(res, 400, { error: { code: "unsupported-wfs-request", message: `request=${request}` } });
    }

    // --- STAC API (recorded Earth Search fixture) ------------------------
    if (url.pathname === "/stac/v1/search") {
      return sendJson(res, 200, fixtures.stacSearchJson.replaceAll(UPSTREAM_STAC_ROOT, `${base}/stac/v1`));
    }
    if (url.pathname === "/stac/v1") {
      return sendJson(res, 200, {
        stac_version: "1.0.0",
        type: "Catalog",
        id: "eval-stac",
        description: "Eval STAC fixture root",
        conformsTo: ["https://api.stacspec.org/v1.0.0/core", "https://api.stacspec.org/v1.0.0/item-search"],
        links: [
          { rel: "self", type: "application/json", href: `${base}/stac/v1` },
          { rel: "search", type: "application/geo+json", href: `${base}/stac/v1/search` },
        ],
      });
    }

    // --- OData v4 (recorded TripPin fixtures) ----------------------------
    if (url.pathname === "/odata/TripPin/$metadata") {
      return sendXml(res, 200, fixtures.odataMetadataXml.replaceAll(UPSTREAM_ODATA_ROOT, `${base}/odata/TripPin`));
    }
    if (url.pathname === "/odata/TripPin/People") {
      return sendJson(res, 200, fixtures.odataPeopleJson.replaceAll(UPSTREAM_ODATA_ROOT, `${base}/odata/TripPin`));
    }

    sendJson(res, 404, { error: { code: "not_found", message: `No eval fixture route for ${url.pathname}` } });
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Failed to bind eval fixture server.");
  const localBase = () => `http://127.0.0.1:${address.port}`;

  return {
    url: localBase(),
    requests,
    async close() {
      if (!server.listening) return;
      await new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}
