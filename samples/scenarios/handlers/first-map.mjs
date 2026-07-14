import { canonicalJson, hasAsciiControlCharacters } from "../determinism.mjs";
import { fixtureHeaders, fixtureResponseHeaders, sendJson, sendText } from "../http.mjs";

const SERVICE_ROOT = "/rest/services/natural-earth/FeatureServer/0";
const MAXIMUM_IDEMPOTENCY_KEYS = 128;

function clone(value) {
  return structuredClone(value);
}

function scenarioHeaders(run) {
  if (run.scenario === "cache-hit") return { age: "12", "x-fixture-cache": "hit; fresh" };
  if (run.scenario === "cache-stale")
    return { age: "600", warning: '110 - "Response is stale"', "x-fixture-cache": "stale" };
  if (run.scenario === "cache-revalidate") return { etag: '"fixture-first-map-v1"', "x-fixture-cache": "revalidated" };
  if (run.scenario === "auth-scope") {
    return { vary: "x-honua-fixture-auth-scope", "x-fixture-cache-scope": run.authScopeFingerprint };
  }
  return {};
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

function sendByteRange(req, res, value) {
  const body = Buffer.from(`${canonicalJson(value)}\n`);
  const header = req.headers.range;
  if (!header) {
    sendText(res, 200, body, "application/json; charset=utf-8", { "accept-ranges": "bytes" });
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
      { contentLength: selected.length, contentType: "application/json; charset=utf-8" },
      { "accept-ranges": "bytes", "content-range": `bytes ${start}-${end}/${body.length}` },
    ),
  );
  res.end(selected);
}

export function createFirstMapHandler(pack) {
  const capabilities = pack.data[pack.manifest.schema.files.capabilities];
  const layer = pack.data[pack.manifest.schema.files.layer];
  const features = pack.data[pack.manifest.schema.files.features];
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
    handle({ req, res, url, run, body }) {
      if (req.method === "GET" && url.pathname === "/api/v1/admin/capabilities") {
        sendJson(res, 200, capabilities, scenarioHeaders(run));
        return true;
      }
      if (req.method === "GET" && url.pathname === "/__honua-quickstart__/basemap-style.json") {
        sendJson(res, 200, basemap);
        return true;
      }
      if (req.method === "GET" && url.pathname === SERVICE_ROOT) {
        sendJson(res, 200, layer, scenarioHeaders(run));
        return true;
      }
      if (url.pathname === `${SERVICE_ROOT}/applyEdits` && req.method === "POST") {
        assertEditBody(body);
        if (body.objectId !== editableRecordId) {
          sendJson(res, 403, {
            error: { code: "FIXTURE_EDIT_BLOCKED", message: "Only the isolated fixture record is editable." },
          });
          return true;
        }
        const previous = run.state.idempotency.get(body.idempotencyKey);
        if (previous) {
          const requestFingerprint = canonicalJson(body);
          if (previous.fingerprint !== requestFingerprint) {
            sendJson(res, 409, {
              error: {
                code: "FIXTURE_IDEMPOTENCY_CONFLICT",
                message: "Idempotency key was already bound to a different edit request.",
              },
            });
            return true;
          }
          sendJson(res, 200, { ...previous.receipt, outcome: "duplicate" });
          return true;
        }
        const actualRevision = run.state.revisions.get(body.objectId);
        if (run.scenario === "edit-conflict" || body.expectedRevision !== actualRevision) {
          sendJson(res, 409, {
            error: { code: "FIXTURE_EDIT_CONFLICT", expectedRevision: body.expectedRevision, actualRevision },
          });
          return true;
        }
        if (run.state.idempotency.size >= MAXIMUM_IDEMPOTENCY_KEYS) {
          sendJson(res, 429, {
            error: {
              code: "FIXTURE_IDEMPOTENCY_CAPACITY",
              message: `Fixture runs retain at most ${MAXIMUM_IDEMPOTENCY_KEYS} idempotency keys.`,
            },
          });
          return true;
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
        sendJson(res, 200, receipt);
        return true;
      }
      if (url.pathname !== `${SERVICE_ROOT}/query` || req.method !== "GET") return false;

      if (run.scenario === "unsupported") {
        sendJson(res, 501, { error: { code: "FIXTURE_UNSUPPORTED", capability: "query", protocol: "geoservices" } });
        return true;
      }
      if (run.scenario === "abort") {
        sendJson(
          res,
          499,
          { error: { code: "FIXTURE_ABORT", message: "Abort before response body is deterministic." } },
          {
            "x-fixture-abort": "client-before-body",
          },
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
      if (run.scenario !== "paginated" && url.searchParams.has("cursor")) {
        sendJson(res, 400, {
          error: { code: "FIXTURE_INVALID_CURSOR_BINDING", message: "This scenario does not issue page cursors." },
        });
        return true;
      }

      const response = clone(features);
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
      if (run.scenario === "paginated") {
        const page = paginatedResponse(run, url, response);
        sendJson(res, page.status, page.body, scenarioHeaders(run));
        return true;
      }
      if (run.scenario === "range") {
        sendByteRange(req, res, response);
        return true;
      }
      if (run.scenario === "cache-revalidate" && req.headers["if-none-match"] === '"fixture-first-map-v1"') {
        res.writeHead(304, fixtureHeaders(scenarioHeaders(run)));
        res.end();
        return true;
      }
      sendJson(res, 200, response, scenarioHeaders(run));
      return true;
    },
  });
}
