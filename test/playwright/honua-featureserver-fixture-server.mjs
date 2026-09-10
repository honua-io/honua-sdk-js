/**
 * A minimal, protocol-faithful GeoServices `FeatureServer` HTTP server
 * standing in for "a real Honua service" (issue #1662). It speaks the exact
 * wire shape `HonuaClient`'s REST transport (`src/core/geoservices.ts`)
 * sends and expects: `?f=json` layer metadata, `/query` with `where`,
 * `resultOffset`/`resultRecordCount` paging, `returnCountOnly`, and
 * `/applyEdits`. Unlike the synthetic in-memory fixtures under
 * `test/fixtures/esri-real-sample-*`, every request this server answers is a
 * genuine HTTP round trip over a real TCP socket, not an in-process call.
 *
 * Auth: every endpoint requires `Authorization: Bearer valid-token`. A
 * missing or wrong token gets HTTP 200 with the GeoServices `{error:{code:498}}`
 * envelope — the documented invalid/expired-token shape `toGeoServicesError`
 * (`src/core/request-pipeline.ts`) converts into a `HonuaHttpError` with
 * `statusCode === 498` — so the exact auth-refresh-and-retry path
 * `src/core/errors.ts`'s own JSDoc example demonstrates is exercised for
 * real, against a real network response, not mocked at the `fetch` layer.
 */

import http from "node:http";

const SERVICE_ID = "parcels";
const LAYER_ID = 0;
const VALID_TOKEN = "valid-token";

const FIELDS = [
  { name: "OBJECTID", type: "esriFieldTypeOID", alias: "OBJECTID", nullable: false, editable: false },
  { name: "STATUS", type: "esriFieldTypeString", alias: "Status", nullable: true, editable: true, length: 32 },
  { name: "NAME", type: "esriFieldTypeString", alias: "Name", nullable: true, editable: true, length: 128 },
  { name: "PRIORITY", type: "esriFieldTypeInteger", alias: "Priority", nullable: true, editable: true },
];

function seedFeatures() {
  return [
    { attributes: { OBJECTID: 1, STATUS: "active", NAME: "Hydrant A", PRIORITY: 1 } },
    { attributes: { OBJECTID: 2, STATUS: "active", NAME: "Hydrant B", PRIORITY: 2 } },
    { attributes: { OBJECTID: 3, STATUS: "active", NAME: "Hydrant C", PRIORITY: 1 } },
    { attributes: { OBJECTID: 4, STATUS: "closed", NAME: "Hydrant D", PRIORITY: 3 } },
    { attributes: { OBJECTID: 5, STATUS: "closed", NAME: "Hydrant E", PRIORITY: 2 } },
  ];
}

// Supports exactly the where-clause shapes this fixture's app issues:
// "1=1" and "FIELD = 'value'" (single equality, string literal).
function evaluateWhere(where, attributes) {
  const clause = (where ?? "1=1").trim();
  if (clause === "1=1" || clause === "") return true;
  const match = clause.match(/^(\w+)\s*=\s*'([^']*)'$/);
  if (!match) throw new Error(`fixture server: unsupported WHERE clause "${clause}"`);
  const [, field, value] = match;
  return String(attributes[field]) === value;
}

function errorEnvelope(code, message) {
  return { error: { code, message } };
}

function isAuthorized(req) {
  return req.headers.authorization === `Bearer ${VALID_TOKEN}`;
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Starts the fixture FeatureServer on an ephemeral loopback port. `state`
 * exposes the live feature list plus request counters the spec asserts on
 * (auth failures observed, edits applied) without reaching into HTTP.
 */
export async function startHonuaFeatureServerFixture() {
  const state = {
    features: seedFeatures(),
    nextObjectId: 6,
    requestLog: [],
    unauthorizedCount: 0,
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    state.requestLog.push({ method: req.method, pathname: url.pathname });

    // The app page is served from a different origin than this fixture
    // FeatureServer, and `Authorization` is never a CORS-safelisted header,
    // so a real browser preflights every authenticated request. Handling
    // that for real (rather than proxying same-origin) is what makes this a
    // genuine cross-origin "real Honua service" round trip.
    res.setHeader("Access-Control-Allow-Origin", req.headers.origin ?? "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const servicePrefix = `/rest/services/${SERVICE_ID}/FeatureServer/${LAYER_ID}`;
    if (!url.pathname.startsWith(servicePrefix)) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify(errorEnvelope(404, "Not found")));
      return;
    }

    if (!isAuthorized(req)) {
      state.unauthorizedCount += 1;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(errorEnvelope(498, "Invalid Token.")));
      return;
    }

    const suffix = url.pathname.slice(servicePrefix.length);

    if (suffix === "" && url.searchParams.get("f") === "json") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: LAYER_ID,
          name: SERVICE_ID,
          type: "Feature Layer",
          geometryType: "esriGeometryPoint",
          objectIdField: "OBJECTID",
          fields: FIELDS,
        }),
      );
      return;
    }

    if (suffix === "/query") {
      let matches;
      try {
        matches = state.features.filter((feature) => evaluateWhere(url.searchParams.get("where"), feature.attributes));
      } catch (error) {
        console.error("fixture server: rejected WHERE clause", error);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(errorEnvelope(400, "Invalid WHERE clause.")));
        return;
      }

      if (url.searchParams.get("returnCountOnly") === "true") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ count: matches.length }));
        return;
      }

      const offset = Number.parseInt(url.searchParams.get("resultOffset") ?? "0", 10);
      const recordCountParam = url.searchParams.get("resultRecordCount");
      const recordCount = recordCountParam === null ? matches.length : Number.parseInt(recordCountParam, 10);
      const page = matches.slice(offset, offset + recordCount);

      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          objectIdFieldName: "OBJECTID",
          geometryType: "esriGeometryPoint",
          spatialReference: { wkid: 4326 },
          fields: FIELDS,
          features: page,
          exceededTransferLimit: offset + page.length < matches.length,
        }),
      );
      return;
    }

    if (suffix === "/applyEdits" && req.method === "POST") {
      const body = await readBody(req);
      const params = new URLSearchParams(body);
      const adds = params.has("adds") ? JSON.parse(params.get("adds")) : [];
      const addResults = adds.map((add) => {
        const objectId = state.nextObjectId++;
        state.features.push({ attributes: { ...add.attributes, OBJECTID: objectId } });
        return { objectId, success: true };
      });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ addResults, updateResults: [], deleteResults: [] }));
      return;
    }

    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify(errorEnvelope(404, "Not found")));
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to bind Honua FeatureServer fixture.");
  }

  return {
    url: `http://127.0.0.1:${address.port}`,
    state,
    validToken: VALID_TOKEN,
    close: () => new Promise((resolve) => server.close(() => resolve(undefined))),
  };
}
