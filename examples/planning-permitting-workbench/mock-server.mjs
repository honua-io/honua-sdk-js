import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createFixtureBuildEnvironment } from "../../scripts/lib/fixture-build-environment.mjs";
import { runNpmScriptSync } from "../../scripts/lib/npm-cli.mjs";

const exampleRoot = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(exampleRoot, "../..");
const distRoot = path.resolve(exampleRoot, "dist");
const servicePath = "/rest/services/Maui/Planning/FeatureServer";
const geocodePath = "/rest/services/Maui/GeocodeServer";
const generatedAt = "2026-07-16T12:00:00.000Z";

const MIME_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

const FIELDS = [
  { name: "OBJECTID", alias: "Object ID", type: "esriFieldTypeOID", nullable: false, editable: false },
  { name: "permit_no", alias: "Permit number", type: "esriFieldTypeString", length: 32, nullable: false },
  { name: "parcel_tmk", alias: "Parcel TMK", type: "esriFieldTypeString", length: 32, nullable: false },
  { name: "address", alias: "Address", type: "esriFieldTypeString", length: 120, nullable: false },
  { name: "zoning", alias: "Zoning", type: "esriFieldTypeString", length: 16, nullable: false },
  { name: "flood_zone", alias: "Flood zone", type: "esriFieldTypeString", length: 16, nullable: false },
  {
    name: "permit_type",
    alias: "Permit type",
    type: "esriFieldTypeString",
    nullable: false,
    domain: {
      type: "codedValue",
      name: "Permit type",
      codedValues: [
        { name: "Residential", code: "residential" },
        { name: "Commercial", code: "commercial" },
        { name: "Grading", code: "grading" },
        { name: "Shoreline", code: "shoreline" },
        { name: "Demolition", code: "demolition" },
      ],
    },
  },
  {
    name: "status",
    alias: "Status",
    type: "esriFieldTypeString",
    nullable: false,
    domain: {
      type: "codedValue",
      name: "Application status",
      codedValues: [
        { name: "Draft", code: "draft" },
        { name: "Intake", code: "intake" },
        { name: "Under review", code: "under-review" },
        { name: "Approved", code: "approved" },
      ],
    },
  },
  { name: "description", alias: "Description", type: "esriFieldTypeString", length: 240, nullable: false },
  {
    name: "proposed_height_ft",
    alias: "Proposed height",
    type: "esriFieldTypeDouble",
    nullable: false,
    domain: { type: "range", name: "Reviewable building height", range: [0, 60] },
  },
  { name: "version", alias: "Version", type: "esriFieldTypeInteger", nullable: true },
  {
    name: "last_edited_date",
    alias: "Last edited",
    type: "esriFieldTypeDate",
    nullable: true,
    editable: false,
  },
];

const SEED_FEATURES = [
  feature(5001, "B2026-0418", "3-7-010-031", "300 Hana Hwy, Kahului", "B-2", "AE", -156.4662, 20.8951),
  feature(5002, "B2026-0455", "3-8-001-027", "55 Vineyard St, Wailuku", "R-3", "X-shaded", -156.5072, 20.8896),
  feature(5003, "G2026-0102", "3-7-010-044", "420 Kaahumanu Ave, Kahului", "M-1", "AO", -156.4701, 20.8929),
];

const PLACES = SEED_FEATURES.map((entry) => ({
  address: entry.attributes.address,
  longitude: entry.geometry.x,
  latitude: entry.geometry.y,
  attributes: {
    ParcelTMK: entry.attributes.parcel_tmk,
    Zoning: entry.attributes.zoning,
    FloodZone: entry.attributes.flood_zone,
  },
}));

function feature(id, permitNo, parcelTmk, address, zoning, floodZone, x, y) {
  return {
    attributes: {
      OBJECTID: id,
      permit_no: permitNo,
      parcel_tmk: parcelTmk,
      address,
      zoning,
      flood_zone: floodZone,
      permit_type: permitNo.startsWith("G") ? "grading" : "commercial",
      status: "under-review",
      description: "Seeded planning application for deterministic review.",
      proposed_height_ft: 24,
      version: 3,
      last_edited_date: generatedAt,
    },
    geometry: { x, y, spatialReference: { wkid: 4326 } },
  };
}

function clone(value) {
  return structuredClone(value);
}

function createState() {
  return {
    features: new Map(SEED_FEATURES.map((entry) => [entry.attributes.OBJECTID, clone(entry)])),
    nextObjectId: 6001,
    nextAttachmentId: 9001,
    attachments: new Map(),
    requests: [],
    /**
     * One-shot deterministic update fault. Armed through
     * `POST /__fixture__/arm-update-fault` so a browser test can prove the
     * editor's retry path against a transport that really did reject the first
     * attempt and really does accept the second.
     */
    armedUpdateFault: false,
  };
}

function buildDemoIfNeeded() {
  const result = runNpmScriptSync("demo:planning-workbench:build", {
    cwd: projectRoot,
    stdio: "inherit",
    env: createFixtureBuildEnvironment(),
  });
  if (result.status !== 0) throw new Error("Failed to build the planning & permitting fixture.");
}

function layerMetadata(readonly, metadataMode) {
  return {
    currentVersion: 11.3,
    id: readonly ? 1 : 0,
    name: readonly ? "Planning applications (read-only)" : "Planning applications",
    type: "Feature Layer",
    displayField: "permit_no",
    objectIdField: "OBJECTID",
    geometryType: "esriGeometryPoint",
    capabilities: readonly ? "Query" : "Query,Create,Update,Delete",
    hasAttachments: !readonly,
    supportsStatistics: true,
    useStandardizedQueries: true,
    supportedQueryFormats: "JSON, geoJSON",
    advancedQueryCapabilities: {
      supportsPagination: true,
      supportsOrderBy: true,
      supportsReturningQueryExtent: true,
    },
    fields: metadataMode === "missing-fields" ? [] : FIELDS,
    extent: {
      xmin: -156.52,
      ymin: 20.86,
      xmax: -156.44,
      ymax: 20.92,
      spatialReference: { wkid: 4326 },
    },
  };
}

function json(res, body, status = 200, headers = {}) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...headers,
  });
  res.end(JSON.stringify(body));
}

function serveBuffer(res, buffer, filePath) {
  res.writeHead(200, {
    "content-type": MIME_TYPES[path.extname(filePath)] ?? "application/octet-stream",
    "cache-control": "no-store",
  });
  res.end(buffer);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function resolveStaticPath(pathname) {
  const requestedPath = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const absolutePath = path.resolve(distRoot, requestedPath);
  const relative = path.relative(distRoot, absolutePath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return undefined;
  return absolutePath;
}

function matchesAddress(place, query) {
  const tokens = query
    .toLowerCase()
    .split(/\s+/u)
    .map((token) => token.replace(/[^a-z0-9-]/gu, ""))
    .filter(Boolean);
  const haystack = place.address.toLowerCase();
  return tokens.every((token) => haystack.includes(token));
}

function queryFeatures(state, requestUrl) {
  const where = requestUrl.searchParams.get("where") ?? "1=1";
  const tmkMatch = /parcel_tmk\s*=\s*'((?:''|[^'])*)'/iu.exec(where);
  const targetTmk = tmkMatch?.[1]?.replaceAll("''", "'");
  const oidMatch = /OBJECTID\s*=\s*(\d{1,12})/iu.exec(where);
  const targetOid = oidMatch ? Number(oidMatch[1]) : undefined;
  let features = [...state.features.values()].filter(
    (entry) =>
      (targetTmk === undefined || entry.attributes.parcel_tmk === targetTmk) &&
      (targetOid === undefined || entry.attributes.OBJECTID === targetOid),
  );
  const geometryText = requestUrl.searchParams.get("geometry");
  if (geometryText) {
    try {
      const geometry = JSON.parse(geometryText);
      if ([geometry.xmin, geometry.ymin, geometry.xmax, geometry.ymax].every(Number.isFinite)) {
        features = features.filter(
          (entry) =>
            entry.geometry.x >= geometry.xmin &&
            entry.geometry.x <= geometry.xmax &&
            entry.geometry.y >= geometry.ymin &&
            entry.geometry.y <= geometry.ymax,
        );
      } else {
        features = [];
      }
    } catch {
      // Malformed filters never broaden fixture queries.
      features = [];
    }
  }
  const offset = Number(requestUrl.searchParams.get("resultOffset") ?? "0");
  const limit = Number(requestUrl.searchParams.get("resultRecordCount") ?? "2000");
  const page = features.slice(offset, offset + limit).map(clone);
  return {
    objectIdFieldName: "OBJECTID",
    geometryType: "esriGeometryPoint",
    spatialReference: { wkid: 4326 },
    fields: FIELDS,
    features: page,
    exceededTransferLimit: offset + page.length < features.length,
  };
}

function editOutcome(id, success, error) {
  return { objectId: id, success, ...(error ? { error } : {}) };
}

function applyEdits(state, body) {
  const params = new URLSearchParams(body.toString("utf8"));
  const parse = (name) => {
    const value = params.get(name);
    return value ? JSON.parse(value) : [];
  };
  const addResults = parse("adds").map((candidate) => {
    const id = state.nextObjectId;
    state.nextObjectId += 1;
    state.features.set(id, {
      attributes: {
        ...candidate.attributes,
        OBJECTID: id,
        version: 1,
        last_edited_date: generatedAt,
      },
      geometry: candidate.geometry,
    });
    return editOutcome(id, true);
  });
  const updateResults = parse("updates").map((candidate) => {
    const id = Number(candidate.attributes?.OBJECTID);
    if (String(candidate.attributes?.description ?? "").includes("fixture:conflict")) {
      return editOutcome(id, false, { code: 409, description: "version conflict: fixture record changed" });
    }
    if (state.armedUpdateFault) {
      state.armedUpdateFault = false;
      return editOutcome(id, false, {
        code: 503,
        description: "planning review service is temporarily unavailable; retry the same edit",
      });
    }
    const existing = state.features.get(id);
    if (!existing) return editOutcome(id, false, { code: 404, description: "planning application not found" });
    const submittedVersion = Number(candidate.attributes?.version);
    const storedVersion = Number(existing.attributes.version);
    // Optimistic concurrency: an update carrying a stale token never wins.
    if (Number.isFinite(submittedVersion) && Number.isFinite(storedVersion) && submittedVersion !== storedVersion) {
      return editOutcome(id, false, {
        code: 409,
        description: `version conflict: planning application ${id} is at version ${storedVersion}, submitted ${submittedVersion}`,
      });
    }
    state.features.set(id, {
      attributes: {
        ...existing.attributes,
        ...candidate.attributes,
        OBJECTID: id,
        version: Number(existing.attributes.version) + 1,
        last_edited_date: generatedAt,
      },
      geometry: candidate.geometry ?? existing.geometry,
    });
    return editOutcome(id, true);
  });
  const deleteResults = (params.get("deletes") ?? "")
    .split(",")
    .filter(Boolean)
    .map(Number)
    .map((id) => {
      const deleted = state.features.delete(id);
      return editOutcome(id, deleted, deleted ? undefined : { code: 404, description: "not found" });
    });
  return { addResults, updateResults, deleteResults };
}

function sanitizeQuery(searchParams) {
  const query = {};
  for (const [name, value] of searchParams) {
    query[name] = /authorization|credential|password|secret|token|api.?key/i.test(name) ? "[REDACTED]" : value;
  }
  return query;
}

async function serveApi(state, req, res, requestUrl, metadataMode) {
  const pathname = requestUrl.pathname;
  if (pathname === "/__fixture__/reset" && req.method === "POST") {
    const reset = createState();
    state.features = reset.features;
    state.nextObjectId = reset.nextObjectId;
    state.nextAttachmentId = reset.nextAttachmentId;
    state.attachments = reset.attachments;
    state.requests = [];
    state.armedUpdateFault = false;
    json(res, { reset: true, fixtureVersion: "planning-permitting.v1" });
    return true;
  }
  if (pathname === "/__fixture__/requests") {
    json(res, { requests: state.requests });
    return true;
  }
  if (pathname === "/__fixture__/state") {
    json(res, {
      featureCount: state.features.size,
      attachmentCount: [...state.attachments.values()].flat().length,
      nextObjectId: state.nextObjectId,
      armedUpdateFault: state.armedUpdateFault,
      features: [...state.features.values()].map((entry) => ({
        objectId: entry.attributes.OBJECTID,
        permit_no: entry.attributes.permit_no,
        status: entry.attributes.status,
        description: entry.attributes.description,
        proposed_height_ft: entry.attributes.proposed_height_ft,
        version: entry.attributes.version,
      })),
    });
    return true;
  }
  // Deterministic rehearsal seams. Both are server-side only: the sample never
  // fabricates a failure in the browser, it asks the fixture to behave like a
  // service that another reviewer just wrote to, or that is briefly degraded.
  if (pathname === "/__fixture__/concurrent-edit" && req.method === "POST") {
    const id = Number(requestUrl.searchParams.get("objectId"));
    const existing = state.features.get(id);
    if (!existing) {
      json(res, { error: { code: 404, message: "planning application not found" } }, 404);
      return true;
    }
    const version = Number(existing.attributes.version) + 1;
    state.features.set(id, {
      ...existing,
      attributes: {
        ...existing.attributes,
        status: "approved",
        description: "Concurrent reviewer decision recorded by the permit counter.",
        version,
        last_edited_date: generatedAt,
      },
    });
    json(res, { objectId: id, version, status: "approved" });
    return true;
  }
  if (pathname === "/__fixture__/arm-update-fault" && req.method === "POST") {
    state.armedUpdateFault = true;
    json(res, { armedUpdateFault: true });
    return true;
  }

  if (pathname === `${servicePath}/0` || pathname === `${servicePath}/1`) {
    json(res, layerMetadata(pathname.endsWith("/1"), metadataMode), 200, { etag: '"planning-permitting-v1"' });
    return true;
  }
  if (pathname === `${servicePath}/0/query` || pathname === `${servicePath}/1/query`) {
    json(res, queryFeatures(state, requestUrl));
    return true;
  }
  if (pathname === `${servicePath}/0/applyEdits` && req.method === "POST") {
    json(res, applyEdits(state, await readBody(req)));
    return true;
  }
  const addAttachment = new RegExp(`^${servicePath}/0/(\\d+)/addAttachment$`, "u").exec(pathname);
  if (addAttachment && req.method === "POST") {
    const parentId = Number(addAttachment[1]);
    const body = await readBody(req);
    if (body.toString("utf8").includes("too-large-site-plan.pdf")) {
      json(res, {
        addAttachmentResult: {
          objectId: state.nextAttachmentId,
          success: false,
          error: { code: 413, description: "site plan exceeds the fixture upload limit" },
        },
      });
      return true;
    }
    const attachmentId = state.nextAttachmentId;
    state.nextAttachmentId += 1;
    state.attachments.set(parentId, [...(state.attachments.get(parentId) ?? []), attachmentId]);
    json(res, { addAttachmentResult: editOutcome(attachmentId, true) });
    return true;
  }

  if (pathname === `${geocodePath}/findAddressCandidates`) {
    const query = requestUrl.searchParams.get("singleLine") ?? "";
    const requestedLimit = Number(requestUrl.searchParams.get("maxLocations") ?? "5");
    const limit = Number.isFinite(requestedLimit) ? Math.max(0, requestedLimit) : 5;
    const candidates = PLACES.filter((place) => matchesAddress(place, query))
      .slice(0, limit)
      .map((place) => ({
        address: place.address,
        location: { x: place.longitude, y: place.latitude },
        score: 100,
        attributes: place.attributes,
      }));
    json(res, { spatialReference: { wkid: 4326 }, candidates });
    return true;
  }

  return false;
}

export async function startPlanningWorkbenchFixtureServer({ build = true, metadataMode = "complete" } = {}) {
  if (metadataMode !== "complete" && metadataMode !== "missing-fields") {
    throw new Error("Unknown planning fixture metadata mode.");
  }
  if (build) buildDemoIfNeeded();
  const state = createState();
  const server = http.createServer(async (req, res) => {
    try {
      const requestUrl = new URL(req.url ?? "/", "http://127.0.0.1");
      state.requests.push({
        method: req.method ?? "GET",
        pathname: requestUrl.pathname,
        query: sanitizeQuery(requestUrl.searchParams),
      });
      if (requestUrl.pathname === "/favicon.ico") {
        res.writeHead(204);
        res.end();
        return;
      }
      if (await serveApi(state, req, res, requestUrl, metadataMode)) return;

      const staticPath = resolveStaticPath(requestUrl.pathname);
      if (staticPath && fs.existsSync(staticPath) && fs.statSync(staticPath).isFile()) {
        serveBuffer(res, fs.readFileSync(staticPath), staticPath);
        return;
      }
      const indexPath = path.join(distRoot, "index.html");
      if ((requestUrl.pathname === "/" || !path.extname(requestUrl.pathname)) && fs.existsSync(indexPath)) {
        serveBuffer(res, fs.readFileSync(indexPath), indexPath);
        return;
      }
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("Not found");
    } catch {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      json(res, { error: { code: 500, message: "Fixture request failed." } }, 500);
    }
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Failed to bind the planning fixture server.");
  const url = `http://127.0.0.1:${address.port}`;
  let closePromise;
  return {
    server,
    url,
    close() {
      closePromise ??= new Promise((resolve, reject) => {
        if (!server.listening) {
          resolve();
          return;
        }
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      });
      return closePromise;
    },
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { url, close } = await startPlanningWorkbenchFixtureServer();
  process.stdout.write(`planningWorkbenchMockUrl=${url}\n`);
  const shutdown = async () => {
    await close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
