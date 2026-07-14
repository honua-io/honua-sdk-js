import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { performance } from "node:perf_hooks";

import { SCENARIO_NAMES } from "./catalog.mjs";
import { fingerprint } from "./determinism.mjs";
import { loadFixturePack } from "./fixture-pack.mjs";
import { createFirstMapHandler } from "./handlers/first-map.mjs";
import { createIncidentOperationsHandler } from "./handlers/incident-operations.mjs";
import { fixtureHeaders, readJsonBody, sendJson, sendText, serveStaticFile } from "./http.mjs";
import { createRunRegistry } from "./run-registry.mjs";

export const HARNESS_CI_BUDGET = Object.freeze({ startupMs: 2_000, resetMs: 100 });

const HANDLERS = Object.freeze({
  "first-map": createFirstMapHandler,
  "incident-operations": createIncidentOperationsHandler,
});

function invalidNetworkRequest(req, port) {
  const target = req.url ?? "/";
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(target) || target.startsWith("//"))
    return "Absolute-form request targets are blocked.";
  const rawPath = target.split("?", 1)[0];
  try {
    const decoded = decodeURIComponent(rawPath);
    const decodedTwice = decodeURIComponent(decoded);
    if (decoded.split(/[\\/]/).includes("..") || decodedTwice.split(/[\\/]/).includes("..")) {
      return "Path traversal request targets are blocked.";
    }
  } catch {
    // Route/static decoders return a request-shape 400 without exposing internals.
  }
  if (req.method === "CONNECT") return "HTTP CONNECT is blocked.";
  if (req.headers.forwarded || req.headers["x-forwarded-host"] || req.headers["x-forwarded-proto"]) {
    return "Forwarded requests are blocked.";
  }
  const fetchSite = req.headers["sec-fetch-site"];
  if (Array.isArray(fetchSite) || (fetchSite !== undefined && fetchSite !== "same-origin" && fetchSite !== "none")) {
    return "Cross-site browser requests are blocked by Fetch Metadata policy.";
  }
  const host = req.headers.host;
  const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);
  if (!host || !allowedHosts.has(host.toLowerCase())) return "Only this loopback fixture authority is allowed.";
  const origin = req.headers.origin;
  if (origin) {
    let originUrl;
    try {
      originUrl = new URL(origin);
    } catch {
      return "Invalid request Origin.";
    }
    const allowedOrigins = new Set([...allowedHosts].map((authority) => `http://${authority}`));
    if (!allowedOrigins.has(origin) || originUrl.origin !== origin || originUrl.pathname !== "/") {
      return "Cross-origin fixture requests are blocked.";
    }
  }
  return undefined;
}

function selectRunId(req, url, fallback) {
  const header = req.headers["x-honua-fixture-run"];
  if (Array.isArray(header)) throw Object.assign(new Error("Only one fixture run header is allowed."), { status: 400 });
  const query = url.searchParams.get("run");
  if (header && query && header !== query) {
    throw Object.assign(new Error("Fixture run header and query parameter conflict."), { status: 400 });
  }
  return header ?? query ?? fallback;
}

function assertClosedBody(body, { required = [], optional = [] }) {
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(body)) {
    if (!allowed.has(key)) throw Object.assign(new Error(`Unexpected request field: ${key}`), { status: 400 });
  }
  for (const key of required) {
    if (!Object.hasOwn(body, key)) throw Object.assign(new Error(`Missing request field: ${key}`), { status: 400 });
  }
}

function decodePathSegment(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    throw Object.assign(new Error("Malformed fixture admin path encoding."), { status: 400 });
  }
}

function selectAuthScope(req) {
  const header = req.headers["x-honua-fixture-auth-scope"];
  if (Array.isArray(header))
    throw Object.assign(new Error("Only one fixture auth-scope header is allowed."), { status: 400 });
  return header ?? "public";
}

function routeId(pathname) {
  if (pathname === "/__fixture__/ready") return "fixture-ready";
  if (pathname === "/__fixture__/runs") return "fixture-runs";
  const fixtureAction = /^\/__fixture__\/runs\/[^/]+\/actions\/([a-z0-9-]{1,40})$/.exec(pathname);
  if (fixtureAction) return `fixture-action-${fixtureAction[1]}`;
  if (/^\/__fixture__\/runs\/[^/]+\/reset$/.test(pathname)) return "fixture-run-reset";
  if (/^\/__fixture__\/runs\/[^/]+\/requests$/.test(pathname)) return "fixture-run-requests";
  if (/^\/__fixture__\/runs\/[^/]+(?:\/.*)?$/.test(pathname)) return "fixture-run-operation";
  if (pathname === "/api/v1/admin/capabilities") return "honua-capabilities";
  if (pathname === "/__honua-quickstart__/basemap-style.json") return "first-map-basemap";
  if (pathname === "/rest/services/natural-earth/FeatureServer/0") return "first-map-layer";
  if (pathname === "/rest/services/natural-earth/FeatureServer/0/query") return "first-map-query";
  if (pathname === "/rest/services/natural-earth/FeatureServer/0/applyEdits") return "first-map-edits";
  if (pathname === "/api/v1/streaming/features/capabilities") return "incident-capabilities";
  if (pathname === "/api/v1/streaming/features") return "incident-stream";
  if (pathname === "/api/v1/incidents") return "incident-snapshot";
  if (/\.[A-Za-z0-9]{1,10}$/.test(pathname)) return "static-asset";
  if (pathname === "/" || !path.posix.extname(pathname)) return "sample-app-route";
  return "unknown-route";
}

function requestLogInput(req, url) {
  return {
    method: req.method ?? "GET",
    routeId: routeId(url.pathname),
    queryNames: [...new Set([...url.searchParams.keys()])].sort(),
  };
}

async function routeAdmin({ req, res, url, registry, handler, sampleId }) {
  if (req.method === "GET" && url.pathname === "/__fixture__/ready") {
    sendJson(res, 200, {
      ready: true,
      sampleId,
      activeRuns: registry.size(),
      scenarios: SCENARIO_NAMES,
      budgets: HARNESS_CI_BUDGET,
      network: "loopback-only",
    });
    return true;
  }
  if (req.method === "POST" && url.pathname === "/__fixture__/runs") {
    const body = await readJsonBody(req);
    assertClosedBody(body, { required: ["id"], optional: ["scenario", "authScope", "seed"] });
    const run = registry.create({
      id: body.id,
      scenario: body.scenario,
      authScope: body.authScope,
      seed: body.seed,
    });
    sendJson(res, 201, registry.snapshot(run));
    return true;
  }
  const match = /^\/__fixture__\/runs\/([^/]+)(?:\/(.*))?$/.exec(url.pathname);
  if (!match) return false;
  const run = registry.get(decodePathSegment(match[1]));
  registry.authorize(run, selectAuthScope(req));
  const operation = match[2] ?? "";
  registry.record(run, requestLogInput(req, url));

  if (req.method === "GET" && operation === "") {
    sendJson(res, 200, registry.snapshot(run));
    return true;
  }
  if (req.method === "GET" && operation === "requests") {
    sendJson(res, 200, { runId: run.id, requests: run.requests });
    return true;
  }
  if (req.method === "DELETE" && operation === "") {
    await registry.remove(run.id);
    res.writeHead(204, fixtureHeaders());
    res.end();
    return true;
  }
  if (req.method === "POST" && operation === "reset") {
    const body = await readJsonBody(req);
    assertClosedBody(body, {});
    const started = performance.now();
    const reset = await registry.reset(run);
    const elapsedMs = performance.now() - started;
    if (elapsedMs > HARNESS_CI_BUDGET.resetMs) {
      throw Object.assign(new Error(`Fixture reset exceeded ${HARNESS_CI_BUDGET.resetMs}ms CI budget.`), {
        status: 503,
      });
    }
    sendJson(res, 200, { ...registry.snapshot(reset), reset: true });
    return true;
  }
  if (req.method === "POST" && operation === "clock") {
    const body = await readJsonBody(req);
    assertClosedBody(body, { required: ["advanceMs"] });
    if (!Number.isSafeInteger(body.advanceMs) || body.advanceMs < 0 || body.advanceMs > 86_400_000) {
      throw Object.assign(new Error("advanceMs must be an integer between 0 and 86400000."), { status: 400 });
    }
    const clock = await registry.mutate(run, () => run.clock.advance(body.advanceMs));
    sendJson(res, 200, { runId: run.id, clock: new Date(clock).toISOString() });
    return true;
  }
  const actionMatch = /^actions\/([a-z0-9-]+)$/.exec(operation);
  if (req.method === "POST" && actionMatch && handler.handleAction) {
    const body = await readJsonBody(req);
    const result = await registry.mutate(run, () => handler.handleAction({ action: actionMatch[1], body, run }));
    sendJson(res, result.status, result.body);
    return true;
  }
  sendJson(res, 404, { error: { code: "FIXTURE_ADMIN_ROUTE_NOT_FOUND" } });
  return true;
}

export async function startSampleFixtureHarness({
  sampleId,
  fixturePackId = sampleId,
  fixturePackVersion = "v1",
  staticRoot,
  defaultRunId = "default",
  defaultScenario = "happy",
  maximumRuns = 16,
  runTtlMs = 300_000,
  registryNow,
  handlerOverride,
} = {}) {
  if (!Object.hasOwn(HANDLERS, sampleId)) throw new Error(`Unsupported fixture sample: ${sampleId}`);
  if (staticRoot !== undefined) {
    const stat = fs.lstatSync(staticRoot);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Fixture staticRoot must be a real directory.");
  }
  const started = performance.now();
  const pack = loadFixturePack(fixturePackId, fixturePackVersion);
  if (pack.manifest.identity.id !== sampleId) {
    throw new Error(
      `Fixture pack ${pack.manifest.identity.id} is incompatible with sample ${sampleId}; their identities must match.`,
    );
  }
  const handler = handlerOverride ?? HANDLERS[sampleId](pack);
  if (!handler || typeof handler.createRunState !== "function" || typeof handler.handle !== "function") {
    throw new Error("Fixture handler must implement createRunState() and handle().");
  }
  const registry = createRunRegistry({
    handler,
    defaultRunId,
    defaultScenario,
    maximumRuns,
    runTtlMs,
    now: registryNow,
  });
  const sockets = new Set();
  let port = 0;
  let closePromise;

  const server = http.createServer(async (req, res) => {
    res.sendDate = false;
    try {
      const networkError = invalidNetworkRequest(req, port);
      if (networkError) {
        sendJson(res, 403, { error: { code: "FIXTURE_NETWORK_BLOCKED", message: networkError } });
        return;
      }
      const target = req.url ?? "/";
      const url = new URL(target, `http://127.0.0.1:${port}`);
      if (await routeAdmin({ req, res, url, registry, handler, sampleId })) return;

      const run = registry.get(selectRunId(req, url, defaultRunId));
      registry.authorize(run, selectAuthScope(req));
      registry.record(run, requestLogInput(req, url));
      let body;
      if (!["GET", "HEAD"].includes(req.method ?? "GET")) body = await readJsonBody(req);
      const handled = await registry.mutate(run, () => handler.handle({ req, res, url, run, registry, body }));
      if (handled) return;
      if (req.method === "GET" && serveStaticFile(res, staticRoot && path.resolve(staticRoot), url.pathname)) return;
      if (url.pathname === "/favicon.ico") {
        res.writeHead(204, fixtureHeaders());
        res.end();
        return;
      }
      sendText(res, 404, "Not found");
    } catch (error) {
      if (res.headersSent) {
        if (!res.writableEnded) res.destroy(error);
        return;
      }
      const status = error.status ?? 500;
      sendJson(res, status, {
        error: {
          code: status < 500 ? "FIXTURE_REQUEST_REJECTED" : "FIXTURE_INTERNAL_ERROR",
          message: status < 500 && error instanceof Error ? error.message : "Fixture request failed.",
        },
      });
    }
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  server.maxHeadersCount = 64;
  server.headersTimeout = 5_000;
  server.requestTimeout = 5_000;
  server.keepAliveTimeout = 1_000;
  server.maxRequestsPerSocket = 100;
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture harness failed to bind a loopback port.");
  port = address.port;
  const startupElapsedMs = performance.now() - started;
  if (startupElapsedMs > HARNESS_CI_BUDGET.startupMs) {
    registry.close();
    await new Promise((resolve) => server.close(resolve));
    throw new Error(`Fixture startup exceeded ${HARNESS_CI_BUDGET.startupMs}ms CI budget.`);
  }
  const origin = `http://127.0.0.1:${port}`;

  return Object.freeze({
    server,
    origin,
    url: origin,
    defaultRunId,
    readinessUrl: `${origin}/__fixture__/ready`,
    startupElapsedMs,
    async close() {
      if (closePromise) return closePromise;
      closePromise = (async () => {
        const disposalErrors = registry.close();
        const closed = new Promise((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve(undefined))),
        );
        server.closeAllConnections?.();
        for (const socket of sockets) socket.destroy();
        const timeout = new Promise((_, reject) => {
          const timer = setTimeout(() => reject(new Error("Fixture server close exceeded 1000ms.")), 1_000);
          timer.unref?.();
        });
        await Promise.race([closed, timeout]);
        for (const socket of sockets) socket.destroy();
        sockets.clear();
        if (server.listening || sockets.size > 0) throw new Error("Fixture server did not release all resources.");
        if (disposalErrors.length > 0) {
          throw new AggregateError(
            disposalErrors.map((entry) => new Error(`${entry.runId}:${entry.reason}: fixture disposal failed`)),
            "Fixture harness closed with contained run-disposal failures.",
          );
        }
      })();
      return closePromise;
    },
    inspect() {
      return { activeRuns: registry.size(), socketCount: sockets.size, authorityFingerprint: fingerprint(origin) };
    },
  });
}
