#!/usr/bin/env node
/**
 * Live authorization receipt producer for issue #1692 (honua-server#3871).
 *
 * Runs against an isolated deployment of the exact candidate server image that
 * carries two protected tenants — feature layer 10 belongs to tenant-a, layer 11
 * to tenant-b, and both publish SensorThings observations into datastream 1 —
 * and a static-key OIDC issuer whose short-lived JWTs are exchanged for
 * revocable portal tokens. For every Preview authorization row it opens the real
 * transport, injects marked mutations through the product's own write paths,
 * crosses the expiry or revocation boundary, and retains every raw frame and HTTP
 * response with its receipt time.
 *
 * The receipt (`honua.realtime-preview-evidence.v2`) is what honua-server's
 * Realtime Preview Qualification validates. A row is `passed` only when every
 * assertion held on the live transcript; nothing here is synthesized, and no
 * credential is ever written to the receipt.
 */

import { createHash, createHmac, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const REALTIME_PREVIEW_EVIDENCE_FORMAT = "honua.realtime-preview-evidence.v2";
export const AUTHORIZATION_SCENARIOS = Object.freeze([
  "token-expiry",
  "token-revocation",
  "tenant-isolation",
  "tenant-scope-change",
]);
export const AUTHORIZATION_SURFACES = Object.freeze([
  Object.freeze({ surface: "feature-stream", transport: "sse" }),
  Object.freeze({ surface: "feature-stream", transport: "websocket" }),
  Object.freeze({ surface: "feature-stream", transport: "odata" }),
  Object.freeze({ surface: "sensorthings", transport: "sse" }),
  Object.freeze({ surface: "sensorthings", transport: "websocket" }),
]);
/** honua-server revalidates live credentials every second; the gate allows five. */
export const ENFORCEMENT_BOUND_MS = 5_000;
export const LIVE_AUTHORIZATION_TOPOLOGY = Object.freeze({
  tenants: Object.freeze(["tenant-a", "tenant-b"]),
  serviceId: "test_service",
  layers: Object.freeze({ "tenant-a": 10, "tenant-b": 11 }),
  datastreamId: 1,
  readerRole: "reader",
  editorRole: "editor",
});

const OWN = "tenant-a";
const FOREIGN = "tenant-b";
/** Where the candidate places a principal whose credential carries no tenant claim. */
const DEFAULT_TENANT = "public";
const SHA = /^[a-f0-9]{40}$/u;
const DIGEST = /^sha256:[a-f0-9]{64}$/u;
const POSITIVE_INTEGER = /^[1-9][0-9]*$/u;
const REQUEST_TIMEOUT_MS = 15_000;
const DELIVERY_TIMEOUT_MS = 20_000;
/** Settle time that gives a leaked or late frame the chance to arrive before a negative is read. */
const NEGATIVE_SETTLE_MS = 2_000;
const OBSERVATION_SETTLE_MS = 1_500;

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function sha256Hex(value) {
  return createHash("sha256").update(value).digest("hex");
}

function nowIso() {
  return new Date().toISOString();
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function tryJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function requiredText(env, name) {
  const value = env[name]?.trim();
  invariant(value, `${name} is required for the live authorization receipt.`);
  return value;
}

/**
 * Reads the candidate, issuer, SDK and workflow identities. Every identity the
 * qualifier binds must be immutable, so a mutable tag or a missing run id stops
 * the producer before any transport opens.
 */
export function normalizeLiveAuthorizationEnv(env = process.env, projectRoot = PROJECT_ROOT) {
  const manifest = JSON.parse(fs.readFileSync(path.join(projectRoot, "package.json"), "utf8"));
  const options = {
    baseUrl: requiredText(env, "HONUA_REALTIME_CANDIDATE_BASE_URL").replace(/\/+$/u, ""),
    adminApiKey: requiredText(env, "HONUA_REALTIME_CANDIDATE_ADMIN_API_KEY"),
    serverRevision: requiredText(env, "HONUA_REALTIME_CANDIDATE_REVISION"),
    serverImage: requiredText(env, "HONUA_REALTIME_CANDIDATE_IMAGE_DIGEST"),
    environment: requiredText(env, "HONUA_REALTIME_CANDIDATE_ENVIRONMENT"),
    deploymentFingerprint: env.HONUA_REALTIME_CANDIDATE_DEPLOYMENT_FINGERPRINT?.trim() || null,
    referer: requiredText(env, "HONUA_REALTIME_ISSUER_REFERER"),
    issuer: {
      issuer: requiredText(env, "HONUA_REALTIME_ISSUER"),
      audience: requiredText(env, "HONUA_REALTIME_ISSUER_AUDIENCE"),
      signingKey: requiredText(env, "HONUA_REALTIME_ISSUER_SIGNING_KEY"),
      clockSkewSeconds: Number(env.HONUA_REALTIME_ISSUER_CLOCK_SKEW_SECONDS ?? "0"),
    },
    tokenExpirationMinutes: Number(env.HONUA_REALTIME_TOKEN_EXPIRATION_MINUTES ?? "1"),
    sdk: {
      package: `${manifest.name}@${manifest.version}`,
      version: manifest.version,
      revision: requiredText(env, "HONUA_SAMPLE_SOURCE_REVISION"),
    },
    workflow: {
      repository: requiredText(env, "GITHUB_REPOSITORY"),
      name: requiredText(env, "GITHUB_WORKFLOW"),
      runId: requiredText(env, "GITHUB_RUN_ID"),
      runAttempt: requiredText(env, "GITHUB_RUN_ATTEMPT"),
      startedAt: requiredText(env, "HONUA_REALTIME_WORKFLOW_STARTED_AT"),
    },
  };
  invariant(SHA.test(options.serverRevision), "HONUA_REALTIME_CANDIDATE_REVISION must be a 40-character commit SHA.");
  invariant(DIGEST.test(options.serverImage), "HONUA_REALTIME_CANDIDATE_IMAGE_DIGEST must be an immutable sha256 digest.");
  invariant(SHA.test(options.sdk.revision), "HONUA_SAMPLE_SOURCE_REVISION must be a 40-character commit SHA.");
  invariant(POSITIVE_INTEGER.test(options.workflow.runId), "GITHUB_RUN_ID must be a positive integer.");
  invariant(POSITIVE_INTEGER.test(options.workflow.runAttempt), "GITHUB_RUN_ATTEMPT must be a positive integer.");
  invariant(!Number.isNaN(Date.parse(options.workflow.startedAt)), "HONUA_REALTIME_WORKFLOW_STARTED_AT must be RFC3339.");
  invariant(
    Number.isInteger(options.tokenExpirationMinutes) && options.tokenExpirationMinutes > 0,
    "HONUA_REALTIME_TOKEN_EXPIRATION_MINUTES must be a positive integer.",
  );
  invariant(
    options.issuer.clockSkewSeconds === 0,
    "The issuer must be configured with zero clock skew to qualify the five-second enforcement bound.",
  );
  return options;
}

/** HS256 relay credential the candidate's static-key OIDC verifier accepts at generateToken. */
export function mintIssuerJwt(issuer, { subject, tenant, roles, lifetimeSeconds = 900, now = Date.now() }) {
  const seconds = Math.floor(now / 1000);
  // A distinct jti per relay: the candidate refuses a replayed JWT, and two
  // issuances for one subject inside a second would otherwise be byte-identical.
  const claims = {
    iss: issuer.issuer,
    aud: issuer.audience,
    sub: subject,
    name: subject,
    roles,
    iat: seconds,
    nbf: seconds,
    exp: seconds + lifetimeSeconds,
    jti: randomBytes(12).toString("hex"),
  };
  if (tenant) claims.tenant_id = tenant;
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const unsigned = `${encode({ alg: "HS256", typ: "JWT" })}.${encode(claims)}`;
  return `${unsigned}.${createHmac("sha256", issuer.signingKey).update(unsigned).digest("base64url")}`;
}

/**
 * Fingerprint of everything that decides whether an expired or revoked
 * credential can keep a subscription alive. The signing key contributes only
 * its digest.
 */
export function issuerFingerprint({ issuer, referer, tokenExpirationMinutes, deploymentFingerprint = null }) {
  const document = {
    kind: "oidc-static-hs256-relay/portal-token",
    issuer: issuer.issuer,
    audience: issuer.audience,
    clockSkewSeconds: issuer.clockSkewSeconds,
    signingKeySha256: sha256Hex(issuer.signingKey),
    portalTokenExpirationMinutes: tokenExpirationMinutes,
    revocation: "POST /sharing/rest/oauth2/revoke",
    binding: { client: "referer", referer },
    deploymentFingerprint,
  };
  return `sha256:${sha256Hex(canonicalJson(document))}`;
}

/**
 * Decodes a raw transport outcome exactly as the server qualifier does: only a
 * typed SSE status event, a WebSocket close 1008 or an OData 401 ends
 * authorization. A reason string inside an ordinary payload does not.
 */
export function isAuthorizationTermination(raw, transport) {
  if (typeof raw !== "string") return false;
  if (transport === "odata" && /^HTTP\/(?:1\.[01]|[23](?:\.0)?) 401(?:[ \r\n]|$)/u.test(raw)) return true;
  let payload = raw;
  if (transport === "sse") {
    const lines = raw.split(/\r\n|\r|\n/u);
    const events = lines.filter((line) => line.startsWith("event:")).map((line) => line.slice(6).trim());
    if (events.length !== 1 || events[0] !== "status") return false;
    payload = lines
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).replace(/^ /u, ""))
      .join("\n");
  }
  const frame = tryJson(payload);
  if (frame === null || typeof frame !== "object" || Array.isArray(frame)) return false;
  if (transport === "sse") return frame.status === "error" && frame.code === "authorization-ended";
  if (transport === "websocket") {
    return frame.type === "close" && frame.code === 1008 && frame.reason === "authorization-ended";
  }
  return transport === "odata" && frame.status === 401;
}

/**
 * The authorization-transcript half of the server qualifier, mirrored so the
 * producer refuses to report a row whose own proof would be rejected. Returns
 * the reasons; an empty list means the transcript is admissible.
 */
export function authorizationTranscriptReasons(row, workflow) {
  const reasons = [];
  const proof = row.authorization;
  if (proof === null || typeof proof !== "object") return ["authorization transcript is missing"];
  const time = (value, label) => {
    const parsed = typeof value === "string" ? Date.parse(value) : Number.NaN;
    if (Number.isNaN(parsed)) reasons.push(`${label} is missing or not RFC3339`);
    return Number.isNaN(parsed) ? null : parsed;
  };
  if (!DIGEST.test(String(proof.issuerFingerprint ?? ""))) reasons.push("issuer fingerprint is missing");
  const distinct = (values, minimum) =>
    Array.isArray(values) &&
    values.length >= minimum &&
    values.every((item) => typeof item === "string" && item.trim()) &&
    new Set(values).size === values.length;
  if (!distinct(proof.tenantIds, 2) || proof.tenantIds.length !== 2) reasons.push("two distinct tenants are required");
  if (!distinct(proof.resourceIds, 2)) reasons.push("distinct tenant-qualified resources are required");
  if (!distinct(proof.mutationIds, 2)) reasons.push("distinct injected mutation ids are required");
  const issued = time(proof.issuedAt, "issuedAt");
  const expires = time(proof.expiresAt, "expiresAt");
  if (issued !== null && expires !== null && issued >= expires) reasons.push("token lifetime is invalid");
  const started = time(workflow.startedAt, "workflow.startedAt");
  const completed = time(workflow.completedAt, "workflow.completedAt");
  const observations = Array.isArray(proof.observations) ? proof.observations : [];
  if (observations.length < 2) reasons.push("raw transport observations are missing");
  const observed = [];
  const terminations = new Set();
  for (const observation of observations) {
    const at = time(observation?.at, "observation.at");
    if (typeof observation?.raw !== "string" || !observation.raw.trim()) {
      reasons.push("an observation lacks raw bytes");
      continue;
    }
    if (at === null) continue;
    observed.push(at);
    if (isAuthorizationTermination(observation.raw, row.transport)) terminations.add(at);
    if (started !== null && completed !== null && (at < started || at > completed)) {
      reasons.push("an observation falls outside the live workflow window");
    }
  }
  const passed = new Set(
    (Array.isArray(row.assertions) ? row.assertions : []).filter((item) => item?.passed === true).map((item) => item.id),
  );
  const required = ["no-cross-tenant-payload", "invalid-credentials-rejected"];
  if (row.scenario === "token-expiry" || row.scenario === "token-revocation") {
    required.push("old-credential-terminated", "replacement-resume");
    const boundary = row.scenario === "token-revocation" ? time(proof.revokedAt, "revokedAt") : expires;
    const terminated = time(proof.terminatedAt, "terminatedAt");
    if (row.scenario === "token-revocation" && issued !== null && boundary !== null && expires !== null) {
      if (!(issued < boundary && boundary < expires)) reasons.push("revocation must occur during the token lifetime");
      if (terminated !== null && terminated >= expires) reasons.push("revocation termination must precede expiry");
    }
    for (const [value, label] of [
      [boundary, "boundary"],
      [terminated, "termination"],
    ]) {
      if (value !== null && started !== null && completed !== null && (value < started || value > completed)) {
        reasons.push(`${label} falls outside the live workflow window`);
      }
    }
    if (terminated !== null && !terminations.has(terminated)) {
      reasons.push("terminatedAt does not match a raw authorization outcome");
    }
    const bound = proof.enforcementBoundMilliseconds;
    if (!Number.isInteger(bound) || bound <= 0 || bound > ENFORCEMENT_BOUND_MS) {
      reasons.push("enforcement bound must be positive and at most 5000 ms");
    } else if (boundary !== null && terminated !== null && !(boundary <= terminated && terminated <= boundary + bound)) {
      reasons.push("termination exceeded the declared enforcement bound");
    }
    if (
      boundary !== null &&
      (!observed.some((at) => issued !== null && issued <= at && at < boundary) || !observed.some((at) => at >= boundary))
    ) {
      reasons.push("the transcript must observe both sides of the boundary");
    }
    const reason = row.transport === "odata" ? "unauthorized" : "authorization-ended";
    if (proof.terminationReason !== reason) reasons.push("termination reason is missing or not machine-detectable");
  }
  if (row.scenario === "tenant-scope-change") required.push("changed-scope-rejected");
  const missing = required.filter((id) => !passed.has(id));
  if (missing.length > 0) reasons.push(`assertion receipts missing: ${missing.join(", ")}`);
  return reasons;
}

/** Throws when any issued credential or relay JWT appears anywhere in the receipt. */
export function assertNoRetainedCredentials(document, secrets) {
  const serialized = JSON.stringify(document);
  for (const secret of secrets) {
    invariant(typeof secret !== "string" || secret.length < 8 || !serialized.includes(secret), "A credential leaked into the receipt.");
  }
}

// ---------------------------------------------------------------------------
// Transports. Each connection pushes timestamped raw frames into a FrameStream.
// ---------------------------------------------------------------------------

class FrameStream {
  frames = [];
  ended = null;
  #waiters = new Set();

  push(frame) {
    this.frames.push(frame);
    this.#wake();
  }

  end(outcome) {
    if (this.ended === null) this.ended = outcome;
    this.#wake();
  }

  #wake() {
    for (const waiter of this.#waiters) waiter();
  }

  /** Resolves the first frame (buffered or future) matching `predicate`. */
  waitFor(predicate, timeoutMs, label) {
    return new Promise((resolve, reject) => {
      const check = () => {
        const frame = this.frames.find(predicate);
        if (frame) {
          finish();
          resolve(frame);
        } else if (this.ended !== null) {
          finish();
          reject(new Error(`${label}: the connection ended (${this.ended.kind}) before the frame arrived`));
        }
      };
      const timer = setTimeout(() => {
        finish();
        reject(new Error(`${label}: not observed within ${timeoutMs} ms`));
      }, Math.max(0, timeoutMs));
      const finish = () => {
        clearTimeout(timer);
        this.#waiters.delete(check);
      };
      this.#waiters.add(check);
      check();
    });
  }
}

function httpStatusLine(status, statusText) {
  return `HTTP/1.1 ${status} ${statusText || ""}`.trimEnd();
}

async function openSse(context, pathAndQuery) {
  const stream = new FrameStream();
  const controller = new AbortController();
  let response;
  try {
    response = await context.fetch(`${context.baseUrl}${pathAndQuery}`, {
      headers: { Accept: "text/event-stream", Referer: context.referer },
      signal: controller.signal,
    });
  } catch (error) {
    const handshake = { status: 0, at: nowIso(), raw: `transport error: ${errorMessage(error)}` };
    stream.end({ kind: "error", at: handshake.at });
    return { stream, handshake, close: () => {} };
  }
  const handshake = { status: response.status, at: nowIso(), raw: httpStatusLine(response.status, response.statusText) };
  if (response.status !== 200) {
    const body = await response.text().catch(() => "");
    handshake.raw = `${handshake.raw}\r\n\r\n${body}`;
    stream.end({ kind: "http", at: handshake.at });
    return { stream, handshake, close: () => {} };
  }
  let closing = false;
  (async () => {
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of response.body) {
      buffer += decoder.decode(chunk, { stream: true });
      let separator = buffer.search(/\r?\n\r?\n/u);
      while (separator >= 0) {
        const block = buffer.slice(0, separator);
        buffer = buffer.slice(separator).replace(/^\r?\n\r?\n/u, "");
        if (block.trim()) {
          const lines = block.split(/\r?\n/u);
          const eventName = lines.find((line) => line.startsWith("event:"))?.slice(6).trim() ?? "message";
          const data = lines
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).replace(/^ /u, ""))
            .join("\n");
          stream.push({ at: nowIso(), raw: `${block}\n\n`, eventName, json: tryJson(data) });
        }
        separator = buffer.search(/\r?\n\r?\n/u);
      }
    }
    stream.end({ kind: "eof", at: nowIso() });
  })().catch((error) => {
    stream.end({ kind: closing ? "closed" : "error", at: nowIso(), error: errorMessage(error) });
  });
  return {
    stream,
    handshake,
    close: () => {
      closing = true;
      controller.abort();
    },
  };
}

function openWebSocket(context, pathAndQuery) {
  const stream = new FrameStream();
  const url = `${context.baseUrl.replace(/^http/u, "ws")}${pathAndQuery}`;
  return new Promise((resolve) => {
    let settled = false;
    let closing = false;
    const socket = new context.WebSocket(url, { headers: { Referer: context.referer } });
    const settle = (handshake) => {
      if (settled) return;
      settled = true;
      resolve({
        stream,
        handshake,
        close: () => {
          closing = true;
          socket.terminate();
        },
      });
    };
    socket.on("unexpected-response", (request, response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        body += chunk;
      });
      response.on("end", () => {
        const at = nowIso();
        stream.end({ kind: "http", at });
        settle({ status: response.statusCode, at, raw: `${httpStatusLine(response.statusCode, response.statusMessage)}\r\n\r\n${body}` });
        request.destroy();
      });
    });
    socket.on("open", () => settle({ status: 101, at: nowIso(), raw: "HTTP/1.1 101 Switching Protocols" }));
    socket.on("message", (data) => {
      const raw = data.toString("utf8");
      stream.push({ at: nowIso(), raw, json: tryJson(raw) });
    });
    socket.on("close", (code, reason) => {
      if (closing) {
        stream.end({ kind: "closed", at: nowIso() });
        return;
      }
      const at = nowIso();
      const close = { type: "close", code, reason: reason.toString("utf8") };
      stream.push({ at, raw: JSON.stringify(close), close });
      stream.end({ kind: "close", at, code });
    });
    socket.on("error", (error) => {
      const at = nowIso();
      stream.end({ kind: "error", at, error: errorMessage(error) });
      settle({ status: 0, at, raw: `transport error: ${errorMessage(error)}` });
    });
  });
}

async function httpRequest(context, method, pathAndQuery, { headers = {}, body } = {}) {
  const response = await context.fetch(`${context.baseUrl}${pathAndQuery}`, {
    method,
    headers,
    body,
    signal: AbortSignal.timeout(context.timing.requestTimeoutMs),
  });
  const text = await response.text();
  const at = nowIso();
  return {
    status: response.status,
    at,
    text,
    json: tryJson(text),
    raw: `${httpStatusLine(response.status, response.statusText)}\r\n\r\n${text}`,
  };
}

function formBody(values) {
  return {
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(values).toString(),
  };
}

// ---------------------------------------------------------------------------
// Credentials and marked mutations through the candidate's own write paths.
// ---------------------------------------------------------------------------

async function issuePortalToken(context, { tenant, roles, subject, expirationMinutes = context.tokenExpirationMinutes }) {
  const relay = mintIssuerJwt(context.issuer, { subject, tenant, roles });
  context.secrets.add(relay);
  const form = formBody({
    username: subject,
    password: relay,
    client: "referer",
    referer: context.referer,
    expiration: String(expirationMinutes),
    f: "json",
  });
  const response = await httpRequest(context, "POST", "/sharing/rest/generateToken", {
    headers: { ...form.headers, Referer: context.referer },
    body: form.body,
  });
  invariant(
    response.status === 200 && typeof response.json?.token === "string" && Number.isFinite(response.json?.expires),
    `generateToken for ${subject} answered ${response.status}: ${response.text.slice(0, 300)}`,
  );
  context.secrets.add(response.json.token);
  return {
    token: response.json.token,
    tenant,
    issuedAt: response.at,
    expiresAt: new Date(response.json.expires).toISOString(),
  };
}

async function revokePortalToken(context, credential) {
  // The request time is the earliest instant the revocation can commit, so a
  // termination observed before the response arrives still measures from it.
  const requestedAt = nowIso();
  const form = formBody({ token: credential.token });
  const response = await httpRequest(context, "POST", "/sharing/rest/oauth2/revoke", form);
  invariant(response.status === 200, `revocation answered ${response.status}`);
  return requestedAt;
}

function editorCredential(context, tenant) {
  context.editors[tenant] ??= issuePortalToken(context, {
    tenant,
    roles: [LIVE_AUTHORIZATION_TOPOLOGY.editorRole],
    subject: `editor-${tenant}`,
    expirationMinutes: 60,
  });
  return context.editors[tenant];
}

function markerFor(context, key, label) {
  context.sequence += 1;
  return `rt-${context.runTag}-${key}-${label}-${context.sequence}`;
}

async function injectFeature(context, tenant, key, label) {
  const id = markerFor(context, key, label);
  const layerId = LIVE_AUTHORIZATION_TOPOLOGY.layers[tenant];
  const editor = await editorCredential(context, tenant);
  const features = JSON.stringify([
    { geometry: { x: -122.41, y: 37.77, spatialReference: { wkid: 4326 } }, attributes: { name: id } },
  ]);
  const form = formBody({ f: "json", features });
  const response = await httpRequest(
    context,
    "POST",
    `/rest/services/${LIVE_AUTHORIZATION_TOPOLOGY.serviceId}/FeatureServer/${layerId}/addFeatures`,
    { headers: { ...form.headers, Authorization: `Bearer ${editor.token}`, Referer: context.referer }, body: form.body },
  );
  const added = response.json?.addResults?.[0];
  invariant(response.status === 200 && added?.success === true, `addFeatures on layer ${layerId} answered ${response.status}`);
  const mutation = { id, tenant, kind: "feature", layerId, objectId: added.objectId, injectedAt: response.at };
  context.mutations.push(mutation);
  return mutation;
}

async function injectObservation(context, tenant, key, label) {
  const id = markerFor(context, key, label);
  // SensorThings ingest is admin-only by product design; the multi-tenant admin
  // role places the observation in the named tenant.
  const result = 1692 + context.sequence + ({ [OWN]: 0.25, [DEFAULT_TENANT]: 0.5 }[tenant] ?? 0.75);
  const response = await httpRequest(
    context,
    "POST",
    `/sta/v1.1/Datastreams(${LIVE_AUTHORIZATION_TOPOLOGY.datastreamId})/Observations`,
    {
      headers: { "Content-Type": "application/json", "X-API-Key": context.adminApiKey, "X-Honua-Tenant": tenant },
      body: JSON.stringify({ result }),
    },
  );
  invariant(response.status === 201 && Number.isInteger(response.json?.["@iot.id"]), `observation ingest answered ${response.status}`);
  const mutation = { id, tenant, kind: "observation", iotId: response.json["@iot.id"], result, injectedAt: response.at };
  context.mutations.push(mutation);
  return mutation;
}

// ---------------------------------------------------------------------------
// Per-surface adapters.
// ---------------------------------------------------------------------------

function featureStreamPath(tenant, token, cursor) {
  const query = new URLSearchParams({ serviceId: LIVE_AUTHORIZATION_TOPOLOGY.serviceId });
  query.set("layers", String(LIVE_AUTHORIZATION_TOPOLOGY.layers[tenant]));
  if (token) query.set("token", token);
  if (cursor !== undefined && cursor !== null) query.set("cursor", String(cursor));
  return `/api/v1/streaming/features?${query}`;
}

function observationStreamPath(token, cursor) {
  const query = new URLSearchParams({ datastreamId: String(LIVE_AUTHORIZATION_TOPOLOGY.datastreamId) });
  if (token) query.set("token", token);
  if (cursor !== undefined && cursor !== null) query.set("cursor", String(cursor));
  return `/sta/v1.1/ObservationsStream?${query}`;
}

function streamingAdapter(surface, transport) {
  const open = transport === "sse" ? openSse : openWebSocket;
  if (surface === "feature-stream") {
    return {
      surface,
      transport,
      supportsCursor: true,
      open: (context, token, { tenant = OWN, cursor } = {}) => open(context, featureStreamPath(tenant, token, cursor)),
      ready: (frame) => frame.json?.status === "subscribed",
      isData: (frame) => frame.json?.type === "feature-change",
      cursorOf: (frame) => frame.json?.cursor,
      matches: (frame, mutation) => frame.json?.type === "feature-change" && frame.json?.attributes?.name === mutation.id,
      inject: injectFeature,
      resourceId: (tenant) =>
        `${tenant}/services/${LIVE_AUTHORIZATION_TOPOLOGY.serviceId}/FeatureServer/${LIVE_AUTHORIZATION_TOPOLOGY.layers[tenant]}`,
    };
  }
  return {
    surface,
    transport,
    supportsCursor: false,
    open: (context, token, { cursor } = {}) => open(context, observationStreamPath(token, cursor)),
    ready: (frame) => frame.json?.status === "connected",
    isData: (frame) => frame.json !== undefined && frame.json !== null && "result" in frame.json,
    cursorOf: () => undefined,
    // Observation ids are not unique across tenants on the candidate, so the
    // marker is the injected result value, which is unique by construction.
    matches: (frame, mutation) => frame.json?.result === mutation.result,
    inject: injectObservation,
    resourceId: (tenant) => `${tenant}/sta/v1.1/Datastreams(${LIVE_AUTHORIZATION_TOPOLOGY.datastreamId})`,
  };
}

/** Whether a raw frame or response carries a mutation that belongs to a tenant other than `tenant`. */
function foreignMutationsIn(context, raw, tenant) {
  const json = tryJson(raw.replace(/^(?:event:.*\r?\n)?data: ?/u, ""));
  const rows = Array.isArray(json?.value) ? json.value : [json];
  return context.mutations.filter((mutation) => {
    if (mutation.tenant === tenant) return false;
    if (raw.includes(mutation.id)) return true;
    return rows.some((row) => {
      if (row === null || typeof row !== "object") return false;
      if (mutation.kind === "feature") {
        const objectId = row.objectId ?? row.ObjectId ?? row.objectid ?? row.attributes?.objectid;
        return row.layerId === mutation.layerId || (objectId === mutation.objectId && row.layerId !== LIVE_AUTHORIZATION_TOPOLOGY.layers[tenant]);
      }
      // Observation ids repeat across tenants; the injected result value is unique.
      return row.result === mutation.result;
    });
  });
}

// ---------------------------------------------------------------------------
// Row transcripts.
// ---------------------------------------------------------------------------

class RowRecorder {
  constructor(context, descriptor) {
    this.context = context;
    this.descriptor = descriptor;
    this.observations = [];
    this.tenantViews = [];
    this.assertions = new Map();
    this.mutationIds = [];
    this.proof = {};
  }

  /** Retains a connection's frames; `tenant` is whose view it is, for the cross-tenant scan. */
  connection(connection, tenant) {
    this.observations.push({ at: connection.handshake.at, raw: connection.handshake.raw });
    this.tenantViews.push({ tenant, frames: connection.stream.frames, handshake: connection.handshake });
    return connection;
  }

  response(response, tenant) {
    this.observations.push({ at: response.at, raw: response.raw });
    this.tenantViews.push({ tenant, frames: [], handshake: response });
    return response;
  }

  mutation(mutation) {
    this.mutationIds.push(mutation.id);
    return mutation;
  }

  assert(id, passed, detail) {
    const previous = this.assertions.get(id);
    if (previous && !previous.passed) return;
    this.assertions.set(id, { id, passed: Boolean(passed), detail });
  }
}

function failClosed(status) {
  return status !== 0 && status !== 101 && status !== 200;
}

/**
 * Every attempt must fail closed. The one admitted outcome that still counts is
 * `confined`: a subscription proven, with a positive control, to deliver only
 * its own tenant's data while both protected tenants were writing.
 */
async function rejectedCredentialChecks(context, recorder, attempts) {
  const outcomes = [];
  for (const attempt of attempts) {
    const outcome = await attempt.run();
    const held = failClosed(outcome.status) || outcome.confined === true;
    outcomes.push({ label: attempt.label, status: outcome.status, held, detail: outcome.detail });
    if (!held) {
      recorder.assert(
        "invalid-credentials-rejected",
        false,
        `${attempt.label} was admitted with ${outcome.status}${outcome.detail ? ` (${outcome.detail})` : ""}`,
      );
    }
  }
  recorder.assert(
    "invalid-credentials-rejected",
    outcomes.every((outcome) => outcome.held),
    outcomes.map((outcome) => `${outcome.label}: ${outcome.status}${outcome.detail ? ` ${outcome.detail}` : ""}`).join("; "),
  );
}

async function streamingAttempt(context, recorder, adapter, token, options, tenant) {
  const connection = recorder.connection(await adapter.open(context, token, options), tenant);
  if (connection.handshake.status === 101 || connection.handshake.status === 200) {
    await delay(context.timing.observationSettleMs);
    connection.close();
  }
  return { status: connection.handshake.status };
}

/**
 * A JWT without a tenant claim, relayed through generateToken. Feature layers
 * and OData refuse it outright. The candidate places such a principal in its
 * default tenant, and a default-tenant SensorThings subscription is a legitimate
 * scope, so there the proof is confinement: protected-tenant observations are
 * written first, a default-tenant observation last, and only the latter may
 * arrive.
 */
async function tenantlessAttempt(context, recorder, adapter, key, options = { tenant: OWN }) {
  const credential = await issuePortalToken(context, {
    tenant: null,
    roles: [LIVE_AUTHORIZATION_TOPOLOGY.readerRole],
    subject: "reader-tenantless",
  });
  if (adapter.surface === "feature-stream") {
    return streamingAttempt(context, recorder, adapter, credential.token, options, DEFAULT_TENANT);
  }
  const connection = recorder.connection(await adapter.open(context, credential.token, {}), DEFAULT_TENANT);
  const { status } = connection.handshake;
  if (failClosed(status)) return { status };
  try {
    await connection.stream.waitFor(adapter.ready, context.timing.deliveryTimeoutMs, "tenantless subscription ready");
    const foreign = recorder.mutation(await adapter.inject(context, FOREIGN, key, "tenantless-foreign"));
    const own = recorder.mutation(await adapter.inject(context, OWN, key, "tenantless-own"));
    const control = recorder.mutation(await adapter.inject(context, DEFAULT_TENANT, key, "tenantless-control"));
    await connection.stream.waitFor((frame) => adapter.matches(frame, control), context.timing.deliveryTimeoutMs, "default-tenant control");
    await delay(context.timing.negativeSettleMs);
    const leaked = connection.stream.frames.some((frame) => adapter.matches(frame, own) || adapter.matches(frame, foreign));
    return {
      status,
      confined: !leaked,
      detail: leaked
        ? "admitted into the default tenant and received protected-tenant observations"
        : `admitted into the default tenant '${DEFAULT_TENANT}' and confined to it`,
    };
  } catch (error) {
    return { status, confined: false, detail: errorMessage(error) };
  } finally {
    connection.close();
  }
}

async function openReady(context, recorder, adapter, token, options, tenant, label) {
  const connection = recorder.connection(await adapter.open(context, token, options), tenant);
  invariant(
    connection.handshake.status === 101 || connection.handshake.status === 200,
    `${label}: subscription refused with ${connection.handshake.status}`,
  );
  await connection.stream.waitFor(adapter.ready, context.timing.deliveryTimeoutMs, `${label} ready`);
  return connection;
}

async function streamingBoundaryScenario(context, adapter, recorder) {
  const { scenario } = recorder.descriptor;
  const key = `${adapter.surface}-${adapter.transport}-${scenario}`;
  const credential = await issuePortalToken(context, {
    tenant: OWN,
    roles: [LIVE_AUTHORIZATION_TOPOLOGY.readerRole],
    subject: `reader-${OWN}`,
  });
  Object.assign(recorder.proof, { issuedAt: credential.issuedAt, expiresAt: credential.expiresAt });
  const connection = await openReady(context, recorder, adapter, credential.token, { tenant: OWN }, OWN, "old credential");

  // Positive control: the foreign mutation is written first, so a leak would
  // arrive before the owned frame that proves delivery works.
  recorder.mutation(await adapter.inject(context, FOREIGN, key, "foreign-before"));
  const before = recorder.mutation(await adapter.inject(context, OWN, key, "before"));
  const delivered = await connection.stream.waitFor((frame) => adapter.matches(frame, before), context.timing.deliveryTimeoutMs, "pre-boundary delivery");
  const lastCursor = adapter.cursorOf(delivered);

  let boundary;
  if (scenario === "token-revocation") {
    boundary = await revokePortalToken(context, credential);
    recorder.proof.revokedAt = boundary;
  } else {
    boundary = credential.expiresAt;
    await delay(Math.max(0, Date.parse(boundary) - Date.now()));
  }
  const boundaryMs = Date.parse(boundary);
  let termination = null;
  try {
    termination = await connection.stream.waitFor(
      (frame) => isAuthorizationTermination(frame.raw, adapter.transport),
      boundaryMs + ENFORCEMENT_BOUND_MS + 3_000 - Date.now(),
      "authorization termination",
    );
  } catch (error) {
    recorder.assert("old-credential-terminated", false, errorMessage(error));
  }
  const gap = recorder.mutation(await adapter.inject(context, OWN, key, "after-boundary"));
  await delay(context.timing.negativeSettleMs);
  connection.close();
  if (termination) {
    const terminatedMs = Date.parse(termination.at);
    const lateData = connection.stream.frames.filter(
      (frame) => adapter.isData(frame) && Date.parse(frame.at) > boundaryMs + ENFORCEMENT_BOUND_MS,
    );
    Object.assign(recorder.proof, {
      terminatedAt: termination.at,
      enforcementBoundMilliseconds: ENFORCEMENT_BOUND_MS,
      terminationReason: "authorization-ended",
    });
    const withinBound = terminatedMs >= boundaryMs && terminatedMs <= boundaryMs + ENFORCEMENT_BOUND_MS;
    const beforeExpiry = scenario !== "token-revocation" || terminatedMs < Date.parse(credential.expiresAt);
    recorder.assert(
      "old-credential-terminated",
      withinBound && beforeExpiry && lateData.length === 0,
      `terminated ${terminatedMs - boundaryMs} ms after the boundary; ${lateData.length} data frame(s) after the bound`,
    );
  }

  await rejectedCredentialChecks(context, recorder, [
    {
      label: `${scenario === "token-revocation" ? "revoked" : "expired"} credential`,
      run: () => streamingAttempt(context, recorder, adapter, credential.token, { tenant: OWN, cursor: lastCursor }, OWN),
    },
    { label: "anonymous", run: () => streamingAttempt(context, recorder, adapter, null, { tenant: OWN }, OWN) },
    { label: "tenantless credential", run: () => tenantlessAttempt(context, recorder, adapter, key) },
  ]);

  const replacement = await issuePortalToken(context, {
    tenant: OWN,
    roles: [LIVE_AUTHORIZATION_TOPOLOGY.readerRole],
    subject: `reader-${OWN}`,
    expirationMinutes: 10,
  });
  if (adapter.supportsCursor) {
    const resumed = recorder.connection(await adapter.open(context, replacement.token, { tenant: OWN, cursor: lastCursor }), OWN);
    try {
      const replayed = await resumed.stream.waitFor((frame) => adapter.matches(frame, gap), context.timing.deliveryTimeoutMs, "replacement replay");
      recorder.assert(
        "replacement-resume",
        Number(adapter.cursorOf(replayed)) > Number(lastCursor) &&
          !resumed.stream.frames.some((frame) => adapter.matches(frame, before)),
        `replayed the after-boundary mutation at cursor ${adapter.cursorOf(replayed)} from last delivered cursor ${lastCursor}`,
      );
    } catch (error) {
      recorder.assert("replacement-resume", false, errorMessage(error));
    } finally {
      resumed.close();
    }
  } else {
    // SensorThings subscriptions are live-only: a cursor is refused explicitly
    // and a replacement credential resumes live delivery.
    const replay = await streamingAttempt(context, recorder, adapter, replacement.token, { cursor: 1 }, OWN);
    const resumed = await openReady(context, recorder, adapter, replacement.token, {}, OWN, "replacement");
    try {
      recorder.mutation(await adapter.inject(context, FOREIGN, key, "foreign-after"));
      const after = recorder.mutation(await adapter.inject(context, OWN, key, "replacement"));
      await resumed.stream.waitFor((frame) => adapter.matches(frame, after), context.timing.deliveryTimeoutMs, "replacement delivery");
      recorder.assert(
        "replacement-resume",
        replay.status === 400,
        `cursor replay answered ${replay.status} (live-only contract); replacement delivered the next owned observation`,
      );
    } catch (error) {
      recorder.assert("replacement-resume", false, errorMessage(error));
    } finally {
      resumed.close();
    }
  }
}

async function streamingIsolationScenario(context, adapter, recorder) {
  const key = `${adapter.surface}-${adapter.transport}-tenant-isolation`;
  const [ownCredential, foreignCredential] = await Promise.all(
    [OWN, FOREIGN].map((tenant) =>
      issuePortalToken(context, { tenant, roles: [LIVE_AUTHORIZATION_TOPOLOGY.readerRole], subject: `reader-${tenant}` }),
    ),
  );
  Object.assign(recorder.proof, { issuedAt: ownCredential.issuedAt, expiresAt: ownCredential.expiresAt });
  const ownConnection = await openReady(context, recorder, adapter, ownCredential.token, { tenant: OWN }, OWN, OWN);
  const foreignConnection = await openReady(context, recorder, adapter, foreignCredential.token, { tenant: FOREIGN }, FOREIGN, FOREIGN);
  try {
    const foreignFirst = recorder.mutation(await adapter.inject(context, FOREIGN, key, "foreign-first"));
    const ownSecond = recorder.mutation(await adapter.inject(context, OWN, key, "own-second"));
    const ownThird = recorder.mutation(await adapter.inject(context, OWN, key, "own-third"));
    const foreignFourth = recorder.mutation(await adapter.inject(context, FOREIGN, key, "foreign-fourth"));
    await Promise.all([
      ownConnection.stream.waitFor((frame) => adapter.matches(frame, ownThird), context.timing.deliveryTimeoutMs, "own delivery"),
      foreignConnection.stream.waitFor((frame) => adapter.matches(frame, foreignFourth), context.timing.deliveryTimeoutMs, "foreign delivery"),
    ]);
    recorder.assert(
      "tenant-owned-delivery",
      ownConnection.stream.frames.some((frame) => adapter.matches(frame, ownSecond)) &&
        foreignConnection.stream.frames.some((frame) => adapter.matches(frame, foreignFirst)),
      "each tenant received both of its own marked mutations",
    );
  } finally {
    await delay(context.timing.negativeSettleMs);
    ownConnection.close();
    foreignConnection.close();
  }
  const attempts = [
    { label: "anonymous", run: () => streamingAttempt(context, recorder, adapter, null, { tenant: OWN }, OWN) },
    { label: "tenantless credential", run: () => tenantlessAttempt(context, recorder, adapter, key) },
  ];
  if (adapter.surface === "feature-stream") {
    attempts.push(
      {
        label: "tenant-a credential on tenant-b layer",
        run: () => streamingAttempt(context, recorder, adapter, ownCredential.token, { tenant: FOREIGN }, OWN),
      },
      {
        label: "tenant-b credential on tenant-a layer",
        run: () => streamingAttempt(context, recorder, adapter, foreignCredential.token, { tenant: OWN }, FOREIGN),
      },
    );
  }
  await rejectedCredentialChecks(context, recorder, attempts);
}

async function streamingScopeChangeScenario(context, adapter, recorder) {
  const key = `${adapter.surface}-${adapter.transport}-tenant-scope-change`;
  const credential = await issuePortalToken(context, { tenant: OWN, roles: [LIVE_AUTHORIZATION_TOPOLOGY.readerRole], subject: `reader-${OWN}` });
  Object.assign(recorder.proof, { issuedAt: credential.issuedAt, expiresAt: credential.expiresAt });
  const connection = await openReady(context, recorder, adapter, credential.token, { tenant: OWN }, OWN, "original scope");
  const first = recorder.mutation(await adapter.inject(context, OWN, key, "original"));
  const delivered = await connection.stream.waitFor((frame) => adapter.matches(frame, first), context.timing.deliveryTimeoutMs, "original delivery");
  const lastCursor = adapter.cursorOf(delivered);
  connection.close();
  const gap = recorder.mutation(await adapter.inject(context, OWN, key, "gap"));

  const foreignCredential = await issuePortalToken(context, { tenant: FOREIGN, roles: [LIVE_AUTHORIZATION_TOPOLOGY.readerRole], subject: `reader-${FOREIGN}` });
  const unscoped = await issuePortalToken(context, { tenant: null, roles: [LIVE_AUTHORIZATION_TOPOLOGY.readerRole], subject: "reader-unscoped" });
  if (adapter.supportsCursor) {
    const changed = [];
    for (const [label, token, tenant] of [
      ["tenant-b credential", foreignCredential.token, FOREIGN],
      ["unscoped credential", unscoped.token, "unscoped"],
    ]) {
      // The changed credential presents tenant-a's subscription scope and cursor;
      // its view is the changed tenant's, so any tenant-a payload is a leak.
      const attempt = await streamingAttempt(context, recorder, adapter, token, { tenant: OWN, cursor: lastCursor }, tenant);
      changed.push(`${label}: ${attempt.status}`);
      if (!failClosed(attempt.status)) recorder.assert("changed-scope-rejected", false, `${label} reused the cursor with ${attempt.status}`);
    }
    recorder.assert("changed-scope-rejected", true, changed.join("; "));
  } else {
    // Observation subscriptions carry no cursor, so the changed scope is the
    // credential itself: tenant-b's stream must never see tenant-a's gap or
    // later observations while its own arrive.
    const foreignConnection = await openReady(context, recorder, adapter, foreignCredential.token, {}, FOREIGN, "changed scope");
    try {
      const ownLater = recorder.mutation(await adapter.inject(context, OWN, key, "after-change"));
      const foreignLater = recorder.mutation(await adapter.inject(context, FOREIGN, key, "changed-tenant"));
      await foreignConnection.stream.waitFor((frame) => adapter.matches(frame, foreignLater), context.timing.deliveryTimeoutMs, "changed-scope delivery");
      await delay(context.timing.negativeSettleMs);
      const leaked = foreignConnection.stream.frames.some((frame) => adapter.matches(frame, ownLater) || adapter.matches(frame, gap));
      const tenantless = await tenantlessAttempt(context, recorder, adapter, key);
      recorder.assert(
        "changed-scope-rejected",
        !leaked && (failClosed(tenantless.status) || tenantless.confined === true),
        `tenant-b view carried tenant-a observations: ${leaked}; tenantless credential: ${tenantless.status} ${tenantless.detail ?? ""}`.trim(),
      );
    } finally {
      foreignConnection.close();
    }
  }

  const replacement = await issuePortalToken(context, { tenant: OWN, roles: [LIVE_AUTHORIZATION_TOPOLOGY.readerRole], subject: `reader-${OWN}` });
  if (adapter.supportsCursor) {
    const resumed = recorder.connection(await adapter.open(context, replacement.token, { tenant: OWN, cursor: lastCursor }), OWN);
    try {
      await resumed.stream.waitFor((frame) => adapter.matches(frame, gap), context.timing.deliveryTimeoutMs, "same-scope replacement replay");
      recorder.assert("same-scope-replacement-resume", true, "an unchanged-scope replacement replayed the gap mutation");
    } catch (error) {
      recorder.assert("same-scope-replacement-resume", false, errorMessage(error));
    } finally {
      resumed.close();
    }
  }
  await rejectedCredentialChecks(context, recorder, [
    { label: "anonymous", run: () => streamingAttempt(context, recorder, adapter, null, { tenant: OWN }, OWN) },
  ]);
}

// OData delta polling.

function odataHeaders(context, token) {
  const headers = { Accept: "application/json", Referer: context.referer, Prefer: "odata.track-changes" };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

function relativeLink(link) {
  const url = new URL(link);
  return `${url.pathname}${url.search}`;
}

/**
 * Reads a baseline or delta through every `@odata.nextLink` page. Returns the
 * pages (all retained in the transcript) and the closing delta link, which is
 * the only link a later poll may resume from.
 */
async function odataReadPages(context, recorder, link, token, tenant) {
  const pages = [];
  let current = link;
  for (let page = 0; page < 50; page += 1) {
    const response = recorder.response(await httpRequest(context, "GET", current, { headers: odataHeaders(context, token) }), tenant);
    pages.push(response);
    if (response.status !== 200) return { pages, status: response.status, deltaLink: null, last: response };
    const next = response.json?.["@odata.nextLink"];
    if (typeof next === "string") {
      current = relativeLink(next);
      continue;
    }
    const delta = response.json?.["@odata.deltaLink"];
    return { pages, status: 200, deltaLink: typeof delta === "string" ? relativeLink(delta) : null, last: response };
  }
  throw new Error("OData paging did not reach a delta link within 50 pages");
}

async function odataBaseline(context, recorder, credential, tenant) {
  const read = await odataReadPages(
    context,
    recorder,
    `/odata/Features(${LIVE_AUTHORIZATION_TOPOLOGY.layers[tenant]})`,
    credential.token,
    tenant,
  );
  invariant(read.status === 200 && read.deltaLink, `OData baseline answered ${read.status} without a delta link`);
  return read.deltaLink;
}

function odataContains(read, mutation) {
  const pages = Array.isArray(read.pages) ? read.pages : [read];
  return pages.some((page) => Array.isArray(page.json?.value) && page.json.value.some((row) => row?.name === mutation.id));
}

/**
 * Polls a delta link until `predicate` holds for a complete read. A 200 read
 * advances to its new delta link; a non-200 read is returned to the predicate
 * as-is so a termination can be observed.
 */
async function odataPollUntil(context, recorder, link, token, tenant, predicate, label, timeoutMs = context.timing.deliveryTimeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let current = link;
  for (;;) {
    const read = await odataReadPages(context, recorder, current, token, tenant);
    if (predicate(read)) return { read, link: read.deltaLink ?? current };
    if (read.deltaLink) current = read.deltaLink;
    invariant(Date.now() < deadline, `${label}: not observed within ${timeoutMs} ms (last status ${read.status})`);
    await delay(250);
  }
}

async function odataAttempt(context, recorder, link, token, tenant) {
  const response = recorder.response(await httpRequest(context, "GET", link, { headers: odataHeaders(context, token) }), tenant);
  return { status: response.status, response };
}

async function odataBoundaryScenario(context, recorder) {
  const { scenario } = recorder.descriptor;
  const key = `feature-stream-odata-${scenario}`;
  const credential = await issuePortalToken(context, { tenant: OWN, roles: [LIVE_AUTHORIZATION_TOPOLOGY.readerRole], subject: `reader-${OWN}` });
  Object.assign(recorder.proof, { issuedAt: credential.issuedAt, expiresAt: credential.expiresAt });
  const baseline = await odataBaseline(context, recorder, credential, OWN);
  recorder.mutation(await injectFeature(context, FOREIGN, key, "foreign-before"));
  const before = recorder.mutation(await injectFeature(context, OWN, key, "before"));
  const delivered = await odataPollUntil(
    context,
    recorder,
    baseline,
    credential.token,
    OWN,
    (read) => odataContains(read, before),
    "pre-boundary delta",
  );
  const lastLink = delivered.link;

  let boundary;
  if (scenario === "token-revocation") {
    boundary = await revokePortalToken(context, credential);
    recorder.proof.revokedAt = boundary;
  } else {
    boundary = credential.expiresAt;
    await delay(Math.max(0, Date.parse(boundary) - Date.now()));
  }
  const boundaryMs = Date.parse(boundary);
  let termination = null;
  try {
    const terminal = await odataPollUntil(
      context,
      recorder,
      lastLink,
      credential.token,
      OWN,
      (read) => read.status === 401,
      "authorization termination",
      boundaryMs + ENFORCEMENT_BOUND_MS + 3_000 - Date.now(),
    );
    termination = terminal.read.last;
  } catch (error) {
    recorder.assert("old-credential-terminated", false, errorMessage(error));
  }
  if (termination) {
    const terminatedMs = Date.parse(termination.at);
    Object.assign(recorder.proof, {
      terminatedAt: termination.at,
      enforcementBoundMilliseconds: ENFORCEMENT_BOUND_MS,
      terminationReason: "unauthorized",
    });
    const beforeExpiry = scenario !== "token-revocation" || terminatedMs < Date.parse(credential.expiresAt);
    recorder.assert(
      "old-credential-terminated",
      terminatedMs >= boundaryMs && terminatedMs <= boundaryMs + ENFORCEMENT_BOUND_MS && beforeExpiry && !termination.text.includes("rt-"),
      `401 ${terminatedMs - boundaryMs} ms after the boundary`,
    );
  }
  const gap = recorder.mutation(await injectFeature(context, OWN, key, "after-boundary"));
  const unscoped = await issuePortalToken(context, { tenant: null, roles: [LIVE_AUTHORIZATION_TOPOLOGY.readerRole], subject: "reader-unscoped" });
  await rejectedCredentialChecks(context, recorder, [
    { label: "old credential after the boundary", run: () => odataAttempt(context, recorder, lastLink, credential.token, OWN) },
    { label: "anonymous", run: () => odataAttempt(context, recorder, lastLink, null, OWN) },
    { label: "unscoped credential", run: () => odataAttempt(context, recorder, lastLink, unscoped.token, "unscoped") },
  ]);
  const replacement = await issuePortalToken(context, { tenant: OWN, roles: [LIVE_AUTHORIZATION_TOPOLOGY.readerRole], subject: `reader-${OWN}`, expirationMinutes: 10 });
  try {
    const resumed = await odataPollUntil(
      context,
      recorder,
      lastLink,
      replacement.token,
      OWN,
      (response) => odataContains(response, gap),
      "replacement delta",
    );
    recorder.assert(
      "replacement-resume",
      !odataContains(resumed.read, before),
      "the replacement credential resumed the retained delta link and received the after-boundary mutation once",
    );
  } catch (error) {
    recorder.assert("replacement-resume", false, errorMessage(error));
  }
}

async function odataIsolationScenario(context, recorder) {
  const key = "feature-stream-odata-tenant-isolation";
  const [ownCredential, foreignCredential] = await Promise.all(
    [OWN, FOREIGN].map((tenant) =>
      issuePortalToken(context, { tenant, roles: [LIVE_AUTHORIZATION_TOPOLOGY.readerRole], subject: `reader-${tenant}` }),
    ),
  );
  Object.assign(recorder.proof, { issuedAt: ownCredential.issuedAt, expiresAt: ownCredential.expiresAt });
  const ownLink = await odataBaseline(context, recorder, ownCredential, OWN);
  const foreignLink = await odataBaseline(context, recorder, foreignCredential, FOREIGN);
  const foreignFirst = recorder.mutation(await injectFeature(context, FOREIGN, key, "foreign-first"));
  const ownSecond = recorder.mutation(await injectFeature(context, OWN, key, "own-second"));
  await odataPollUntil(context, recorder, ownLink, ownCredential.token, OWN, (response) => odataContains(response, ownSecond), "own delta");
  await odataPollUntil(context, recorder, foreignLink, foreignCredential.token, FOREIGN, (response) => odataContains(response, foreignFirst), "foreign delta");
  recorder.assert("tenant-owned-delivery", true, "each tenant's delta link carried its own marked mutation");
  const unscoped = await issuePortalToken(context, { tenant: null, roles: [LIVE_AUTHORIZATION_TOPOLOGY.readerRole], subject: "reader-unscoped" });
  const layer = (tenant) => `/odata/Features(${LIVE_AUTHORIZATION_TOPOLOGY.layers[tenant]})?$top=5`;
  await rejectedCredentialChecks(context, recorder, [
    { label: "anonymous", run: () => odataAttempt(context, recorder, layer(OWN), null, OWN) },
    { label: "unscoped credential", run: () => odataAttempt(context, recorder, layer(OWN), unscoped.token, "unscoped") },
    { label: "tenant-a credential on tenant-b layer", run: () => odataAttempt(context, recorder, layer(FOREIGN), ownCredential.token, OWN) },
    { label: "tenant-b credential on tenant-a layer", run: () => odataAttempt(context, recorder, layer(OWN), foreignCredential.token, FOREIGN) },
  ]);
}

async function odataScopeChangeScenario(context, recorder) {
  const key = "feature-stream-odata-tenant-scope-change";
  const credential = await issuePortalToken(context, { tenant: OWN, roles: [LIVE_AUTHORIZATION_TOPOLOGY.readerRole], subject: `reader-${OWN}` });
  Object.assign(recorder.proof, { issuedAt: credential.issuedAt, expiresAt: credential.expiresAt });
  const baseline = await odataBaseline(context, recorder, credential, OWN);
  const first = recorder.mutation(await injectFeature(context, OWN, key, "original"));
  const delivered = await odataPollUntil(context, recorder, baseline, credential.token, OWN, (read) => odataContains(read, first), "original delta");
  const lastLink = delivered.link;
  const gap = recorder.mutation(await injectFeature(context, OWN, key, "gap"));
  const foreignCredential = await issuePortalToken(context, { tenant: FOREIGN, roles: [LIVE_AUTHORIZATION_TOPOLOGY.readerRole], subject: `reader-${FOREIGN}` });
  const unscoped = await issuePortalToken(context, { tenant: null, roles: [LIVE_AUTHORIZATION_TOPOLOGY.readerRole], subject: "reader-unscoped" });
  const outcomes = [];
  for (const [label, token, tenant] of [
    ["tenant-b credential", foreignCredential.token, FOREIGN],
    ["unscoped credential", unscoped.token, "unscoped"],
  ]) {
    const attempt = await odataAttempt(context, recorder, lastLink, token, tenant);
    outcomes.push({ label, status: attempt.status, leaked: attempt.response.text.includes(gap.id) });
  }
  recorder.assert(
    "changed-scope-rejected",
    outcomes.every((outcome) => failClosed(outcome.status) && !outcome.leaked),
    outcomes.map((outcome) => `${outcome.label}: ${outcome.status}`).join("; "),
  );
  const replacement = await issuePortalToken(context, { tenant: OWN, roles: [LIVE_AUTHORIZATION_TOPOLOGY.readerRole], subject: `reader-${OWN}` });
  try {
    await odataPollUntil(context, recorder, lastLink, replacement.token, OWN, (response) => odataContains(response, gap), "same-scope replacement delta");
    recorder.assert("same-scope-replacement-resume", true, "an unchanged-scope replacement resumed the delta link");
  } catch (error) {
    recorder.assert("same-scope-replacement-resume", false, errorMessage(error));
  }
  await rejectedCredentialChecks(context, recorder, [
    { label: "anonymous", run: () => odataAttempt(context, recorder, lastLink, null, OWN) },
  ]);
}

const SCENARIO_RUNNERS = {
  "token-expiry": { streaming: streamingBoundaryScenario, odata: odataBoundaryScenario },
  "token-revocation": { streaming: streamingBoundaryScenario, odata: odataBoundaryScenario },
  "tenant-isolation": { streaming: streamingIsolationScenario, odata: odataIsolationScenario },
  "tenant-scope-change": { streaming: streamingScopeChangeScenario, odata: odataScopeChangeScenario },
};

async function runRow(context, descriptor) {
  const recorder = new RowRecorder(context, descriptor);
  const runner = SCENARIO_RUNNERS[descriptor.scenario];
  try {
    if (descriptor.transport === "odata") await runner.odata(context, recorder);
    else await runner.streaming(context, streamingAdapter(descriptor.surface, descriptor.transport), recorder);
    recorder.assert("scenario-completed", true, "every scenario step executed against the candidate");
  } catch (error) {
    recorder.assert("scenario-completed", false, errorMessage(error));
  }
  return recorder;
}

/**
 * The cross-tenant scan runs after every surface finished, so a leak of a
 * mutation injected by a concurrently running row is caught too.
 */
function finalizeRow(context, recorder, window) {
  const leaks = [];
  for (const view of recorder.tenantViews) {
    const raws = [view.handshake?.raw, ...view.frames.map((frame) => frame.raw)].filter((raw) => typeof raw === "string");
    for (const raw of raws) {
      for (const mutation of foreignMutationsIn(context, raw, view.tenant)) leaks.push(`${view.tenant} observed ${mutation.id}`);
    }
    // Every connection's frames are part of the transcript, including those
    // that arrived after the scenario read what it needed.
    for (const frame of view.frames) recorder.observations.push({ at: frame.at, raw: frame.raw });
  }
  recorder.assert(
    "no-cross-tenant-payload",
    leaks.length === 0,
    leaks.length === 0 ? "no foreign-tenant mutation appeared on any frame, replay, page or error" : leaks.slice(0, 5).join("; "),
  );
  const { descriptor } = recorder;
  const adapter = descriptor.transport === "odata" ? null : streamingAdapter(descriptor.surface, descriptor.transport);
  const resourceId = (tenant) =>
    adapter ? adapter.resourceId(tenant) : `${tenant}/odata/Features(${LIVE_AUTHORIZATION_TOPOLOGY.layers[tenant]})`;
  const observations = [...new Map(recorder.observations.map((item) => [`${item.at} ${item.raw}`, item])).values()].sort(
    (left, right) => Date.parse(left.at) - Date.parse(right.at),
  );
  const assertions = [...recorder.assertions.values()];
  const row = {
    surface: descriptor.surface,
    transport: descriptor.transport,
    scenario: descriptor.scenario,
    executed: true,
    result: assertions.every((assertion) => assertion.passed) ? "passed" : "failed",
    assertions,
    serverRevision: context.serverRevision,
    serverImage: context.serverImage,
    sdkRevision: context.sdk.revision,
    sdkPackage: context.sdk.package,
    environment: context.environment,
    runId: context.workflow.runId,
    runAttempt: context.workflow.runAttempt,
    authorization: {
      issuerFingerprint: context.issuerFingerprint,
      tenantIds: [OWN, FOREIGN],
      resourceIds: [resourceId(OWN), resourceId(FOREIGN)],
      mutationIds: [...new Set(recorder.mutationIds)],
      ...recorder.proof,
      observations,
    },
  };
  const reasons = authorizationTranscriptReasons(row, window);
  if (reasons.length > 0) {
    row.result = "failed";
    row.assertions.push({ id: "transcript-admissible", passed: false, detail: reasons.join("; ") });
  }
  return row;
}

async function verifyCandidateIdentity(context) {
  const response = await httpRequest(context, "GET", "/api/v1/streaming/features/capabilities", {
    headers: { Accept: "application/json" },
  });
  const data = response.json?.data;
  invariant(response.status === 200 && data?.enabled === true, `feature-stream capabilities answered ${response.status}`);
  invariant(
    data.deploymentRevision === context.serverRevision,
    `the deployment reports revision ${data.deploymentRevision}, not the candidate ${context.serverRevision}`,
  );
  return { deploymentRevision: data.deploymentRevision, deploymentRevisionSource: data.deploymentRevisionSource, edition: data.edition };
}

/**
 * Executes every authorization row. Surfaces run concurrently (their rows run
 * in sequence) so the expiry waits overlap; every row's frames are scanned
 * against every mutation injected during the run.
 */
export async function collectLiveAuthorizationReceipt(options) {
  const context = {
    ...options,
    fetch: options.fetch ?? globalThis.fetch,
    // Tests drive an in-process candidate on a compressed clock; the live lane
    // keeps the defaults.
    timing: {
      requestTimeoutMs: REQUEST_TIMEOUT_MS,
      deliveryTimeoutMs: DELIVERY_TIMEOUT_MS,
      negativeSettleMs: NEGATIVE_SETTLE_MS,
      observationSettleMs: OBSERVATION_SETTLE_MS,
      ...options.timing,
    },
    WebSocket: options.WebSocket ?? (await import("ws")).WebSocket,
    secrets: new Set([options.adminApiKey, options.issuer.signingKey]),
    editors: {},
    mutations: [],
    sequence: 0,
    runTag: options.runTag ?? `${options.workflow.runId}-${options.workflow.runAttempt}-${randomBytes(3).toString("hex")}`,
  };
  context.issuerFingerprint = issuerFingerprint(context);
  const observedServer = await verifyCandidateIdentity(context);
  const recorders = (
    await Promise.all(
      AUTHORIZATION_SURFACES.map(async ({ surface, transport }) => {
        const rows = [];
        for (const scenario of AUTHORIZATION_SCENARIOS) rows.push(await runRow(context, { surface, transport, scenario }));
        return rows;
      }),
    )
  ).flat();
  const completedAt = nowIso();
  const window = { startedAt: context.workflow.startedAt, completedAt };
  const rows = recorders.map((recorder) => finalizeRow(context, recorder, window));
  const receipt = {
    format: REALTIME_PREVIEW_EVIDENCE_FORMAT,
    schemaVersion: 2,
    lane: "live",
    generatedAt: completedAt,
    candidate: {
      environment: context.environment,
      deploymentFingerprint: context.deploymentFingerprint,
      topology: {
        tenants: LIVE_AUTHORIZATION_TOPOLOGY.tenants,
        serviceId: LIVE_AUTHORIZATION_TOPOLOGY.serviceId,
        layers: LIVE_AUTHORIZATION_TOPOLOGY.layers,
        datastreamId: LIVE_AUTHORIZATION_TOPOLOGY.datastreamId,
      },
    },
    server: { revision: context.serverRevision, image: context.serverImage, observed: observedServer },
    sdk: context.sdk,
    workflow: { ...context.workflow, completedAt },
    issuer: {
      fingerprint: context.issuerFingerprint,
      kind: "oidc-static-hs256-relay/portal-token",
      clockSkewSeconds: context.issuer.clockSkewSeconds,
      portalTokenExpirationMinutes: context.tokenExpirationMinutes,
      enforcementBoundMilliseconds: ENFORCEMENT_BOUND_MS,
    },
    coverage: {
      scope: "authorization",
      rows: rows.length,
      passed: rows.filter((row) => row.result === "passed").length,
      failed: rows.filter((row) => row.result !== "passed").map((row) => `${row.surface}/${row.transport}/${row.scenario}`),
    },
    rows,
  };
  assertNoRetainedCredentials(receipt, context.secrets);
  return receipt;
}

export function summarizeLiveAuthorizationReceipt(receipt) {
  const lines = [
    `format: ${receipt.format}`,
    `server: ${receipt.server?.revision} ${receipt.server?.image}`,
    `rows: ${receipt.coverage?.passed ?? 0}/${receipt.coverage?.rows ?? 0} passed`,
  ];
  for (const row of receipt.rows ?? []) {
    lines.push(`${row.result === "passed" ? "PASS" : "FAIL"} ${row.surface}/${row.transport}/${row.scenario}`);
    for (const assertion of row.assertions ?? []) {
      if (!assertion.passed) lines.push(`  - ${assertion.id}: ${assertion.detail}`);
    }
  }
  if (receipt.collectorFailure) lines.push(`collector failure: ${receipt.collectorFailure}`);
  return lines;
}

function parseArgs(argv) {
  const options = { output: "test-results/realtime-preview-evidence.json" };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--output") options.output = argv[++index] ?? "";
    else throw new Error(`Unknown live authorization receipt argument: ${argument}`);
  }
  invariant(options.output.length > 0, "--output must not be empty.");
  return options;
}

async function main() {
  const { output } = parseArgs(process.argv.slice(2));
  const target = path.resolve(PROJECT_ROOT, output);
  invariant(target.startsWith(`${PROJECT_ROOT}${path.sep}`), "The receipt output must stay inside the repository.");
  let receipt;
  try {
    receipt = await collectLiveAuthorizationReceipt(normalizeLiveAuthorizationEnv());
  } catch (error) {
    // A collector that cannot run still retains a machine-readable reason; it
    // carries no rows, so it can never qualify anything.
    receipt = {
      format: REALTIME_PREVIEW_EVIDENCE_FORMAT,
      schemaVersion: 2,
      lane: "live",
      generatedAt: nowIso(),
      collectorFailure: errorMessage(error),
      rows: [],
    };
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  for (const line of summarizeLiveAuthorizationReceipt(receipt)) process.stdout.write(`${line}\n`);
  const passedAll = !receipt.collectorFailure && receipt.rows.length > 0 && receipt.rows.every((row) => row.result === "passed");
  if (!passedAll) process.exitCode = 1;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`Live authorization receipt could not be retained: ${errorMessage(error)}\n`);
    process.exitCode = 1;
  });
}
