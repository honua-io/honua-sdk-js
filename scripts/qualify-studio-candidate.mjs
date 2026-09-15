// Replays the live acceptance criteria of honua-io/honua-sdk-js#1397 against the
// honua-server image the release platform manifest pins.
//
// Everything under test is real: the manifest-pinned server image under the
// Production startup policy with PostGIS, Redis, OAuth bearer validation and the
// Studio AI proxy; the SDK built from this checkout; MCP discovery, dispatch and
// the standalone GET /mcp notification stream. The only double is the model
// behind the proxy (scripts/studio-candidate-model-stub.mjs), which records the
// exact upstream request a provider receives and plays a fixed tool plan.
//
// The first phase runs under the image's own configuration with an admin API
// key. The end-user phase needs a bearer principal to keep an MCP session, which
// the candidate refuses while JWT replay protection is on (the
// bearer-mcp-session-continuity check records why), so that phase restarts the
// same deployment with replay protection off and the receipt declares it.
//
//   npm run build
//   node scripts/qualify-studio-candidate.mjs <platform-manifest.yaml> \
//     [--previous-image <image@digest> --previous-ref <40-char sha>] [--out <file name>]
//
// The receipt is written to test-results/ and the command exits 1 unless every
// acceptance check passes.
import assert from "node:assert/strict";
import { createHash, createHmac, generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmod, copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  HONUA_STUDIO_TOOL_FAMILY,
  HONUA_STUDIO_TOOL_METADATA_KEY,
  HONUA_STUDIO_TOOL_SETUP_VIEW,
  InMemoryStudioAiReplayStore,
  McpClient,
  StudioAiTranscriptVerifier,
  createStudioAgentSession,
} from "../dist/src/studio-agent/index.js";

// Transcribed from honua-server source, never from a server response:
// McpWorkflowViewDescriptorClassifier stamps a descriptor only when the tool is a
// StudioDraftToolBase AND a member of McpWorkflowViewCatalog.Setup at that commit.
const SETUP_CLASSIFICATION = {
  "548b7a5263da5a3f2381eb43f232687cdf92b0bf": {
    revision: "setup.v2",
    members: [
      "honua_studio_create_draft",
      "honua_studio_validate_draft",
      "honua_studio_get_draft",
      "honua_studio_update_draft",
      "honua_studio_preview_draft",
      "honua_studio_save_version",
      "honua_studio_reopen_version",
      "honua_studio_propose_publication",
    ],
  },
  "7ba422672e0c751843b17beb36e954a019cc19fb": {
    revision: "setup.v1",
    members: ["honua_studio_create_draft", "honua_studio_validate_draft", "honua_studio_propose_publication"],
  },
};

const [manifestPath, ...rest] = process.argv.slice(2);
assert.ok(manifestPath, "usage: node scripts/qualify-studio-candidate.mjs <platform-manifest.yaml> [--previous-image <ref> --previous-ref <sha>]");
const option = (name) => {
  const index = rest.indexOf(name);
  return index >= 0 ? rest[index + 1] : undefined;
};
const previousImage = option("--previous-image");
const previousRef = option("--previous-ref");
assert.equal(Boolean(previousImage), Boolean(previousRef), "--previous-image and --previous-ref go together");
const outFile = new URL(`../test-results/${option("--out") ?? "studio-candidate-replay.json"}`, import.meta.url);

const manifest = (await readFile(manifestPath, "utf8")).replaceAll("\r\n", "\n");
const serverSection = manifest.split("\n  honua-server:\n")[1]?.split(/\n  [a-z][\w-]+:\n/)[0];
assert.ok(serverSection, "manifest honua-server component missing");
const digest = serverSection.match(/^    digest: "(sha256:[a-f0-9]{64})"/m)?.[1];
const candidateRef = manifest.match(/^candidate:\n  ref: "([0-9a-f]{40})"/m)?.[1];
assert.ok(digest && candidateRef, "manifest candidate ref or server digest missing");
const expected = SETUP_CLASSIFICATION[candidateRef];
assert.ok(expected, `no transcribed setup classification for candidate ${candidateRef}; transcribe it from honua-server source first`);
const expectedPrevious = previousRef ? SETUP_CLASSIFICATION[previousRef] : undefined;
assert.ok(!previousRef || expectedPrevious, `no transcribed setup classification for previous ${previousRef}`);
const image = `ghcr.io/honua-io/honua-server@${digest}`;

const run = randomBytes(4).toString("hex");
const prefix = `sdk1397-${run}`;
// The proxy signs transcript provenance with this deployment's Ed25519 key. The SDK verifier is
// only given the key whose fingerprint is derived here, never whatever the server publishes.
const transcriptKey = generateKeyPairSync("ed25519");
const transcriptPublicKey = transcriptKey.publicKey.export({ format: "der", type: "spki" }).subarray(-32);
const transcriptSigning = {
  keyId: `${prefix}-transcript`,
  fingerprint: `sha256:${createHash("sha256").update(transcriptPublicKey).digest("hex")}`,
};
const secrets = {
  transcriptSeed: transcriptKey.privateKey.export({ format: "der", type: "pkcs8" }).subarray(-32).toString("base64"),
  admin: `Aa1!${randomBytes(18).toString("hex")}`,
  postgres: randomBytes(18).toString("hex"),
  jwt: randomBytes(32).toString("hex"),
  master: randomBytes(32).toString("hex"),
  salt: randomBytes(16).toString("base64"),
  keyring: randomBytes(16).toString("hex"),
  provider: randomBytes(16).toString("hex"),
};
const redact = (value) =>
  Object.values(secrets).reduce((text, secret) => text.replaceAll(secret, "[redacted]"), String(value));
const issuer = "https://sdk1397.honua.test";
const audience = "honua-sdk-1397";

function exec(command, args, { allowFailure = false, timeout = 180_000 } = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", timeout, windowsHide: true });
  if (!allowFailure) {
    assert.equal(result.status, 0, redact(`${command} ${args.slice(0, 2).join(" ")}: ${result.stderr || result.error}`));
  }
  return result;
}
const docker = (...args) => exec("docker", args).stdout.trim();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await sleep(250);
  }
  throw new Error(`timed out after ${timeoutMs} ms waiting for ${label}`);
}
const sorted = (names) => [...names].sort();

const receipt = {
  schema: "honua.studio-candidate-replay/v1",
  issue: "honua-io/honua-sdk-js#1397",
  generatedAt: new Date().toISOString(),
  scope:
    "manifest-pinned honua-server image, source-built SDK, scripted provider behind the real Studio AI proxy; " +
    "not an installed-client or live-model certification",
  sdkSourceSha: exec("git", ["rev-parse", "HEAD"]).stdout.trim(),
  manifestSha256: createHash("sha256").update(manifest).digest("hex"),
  candidate: { ref: candidateRef, image, expectedSetup: expected },
  ...(previousImage ? { previous: { ref: previousRef, image: previousImage, expectedSetup: expectedPrevious } } : {}),
  deploymentDeviations: [
    {
      setting: "StudioAiProxy:MaxPromptCharacters=100000",
      reason:
        "the default 32000 counts every Studio tool definition again each round; a certified setup-view map " +
        "lifecycle is refused at its seventh round (propose) with 'Request content exceeds the configured limit'",
      appliesTo: "every check",
    },
  ],
  checks: [],
};
async function check(id, criterion, body) {
  const entry = { id, criterion, verdict: "fail", evidence: {} };
  receipt.checks.push(entry);
  try {
    await body(entry.evidence);
    entry.verdict = "pass";
  } catch (error) {
    entry.diagnostic = redact(error?.stack ?? error);
  }
  console.log(`${entry.verdict.toUpperCase()} ${id}`);
  return entry.verdict === "pass";
}

// ── Principals ────────────────────────────────────────────────

function mint(claims, lifetime = 3600) {
  const now = Math.floor(Date.now() / 1000);
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const payload = { ...claims, iss: issuer, aud: audience, iat: now, nbf: now - 5, exp: now + lifetime, jti: randomUUID() };
  const input = `${encode({ alg: "HS256", typ: "JWT" })}.${encode(payload)}`;
  return `${input}.${createHmac("sha256", secrets.jwt).update(input).digest("base64url")}`;
}
/**
 * An end user signed in through the IdP: one access token reused for its lifetime,
 * as an OAuth client does, carrying the session evidence (`sid`, `auth_time`) the
 * server requires before it treats a bearer as an interactive human.
 */
function endUser(sub, roles, scope = "honua.mcp.full") {
  const claims = { sub, tid: "public", roles, scope, sid: `session-${sub}`, auth_time: Math.floor(Date.now() / 1000) - 60 };
  let token;
  return { label: sub, sub, claims, auth: { getAccessToken: async () => (token ??= mint(claims)) } };
}
const adminKey = { label: "admin-api-key", headers: { "x-api-key": secrets.admin } };

function recordingFetch(log, extraHeaders = {}) {
  return async (url, init = {}) => {
    const headers = new Headers(init.headers);
    for (const [name, value] of Object.entries(extraHeaders)) headers.set(name, value);
    let rpc;
    try {
      rpc = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
    } catch {
      rpc = undefined;
    }
    const path = new URL(String(url)).pathname;
    const entry = {
      method: init.method ?? "GET",
      path,
      rpc: rpc?.method,
      ...(rpc?.method === "initialize" ? { initializeMeta: rpc.params?._meta ?? null } : {}),
      session: headers.get("mcp-session-id") ?? undefined,
    };
    if (path.endsWith("/studio/ai/chat") && rpc) {
      entry.requestBytes = Buffer.byteLength(init.body);
      entry.promptCharacters = (rpc.system ?? "").length
        + rpc.messages.reduce((total, message) => total + (message.content ?? "").length, 0);
      entry.messages = rpc.messages.length;
    }
    log.push(entry);
    const response = await fetch(url, { ...init, headers });
    if (!response.ok) {
      entry.status = response.status;
      entry.problem = (await response.clone().text()).slice(0, 2_000);
    }
    return response;
  };
}
function mcpClientFor(actor, { view, log = [] } = {}) {
  return new McpClient({
    baseUrl,
    ...(actor.auth ? { auth: actor.auth } : {}),
    ...(view ? { workflowView: view } : {}),
    fetchImpl: recordingFetch(log, actor.headers),
  });
}
function sessionFor(actor, { log = [], ...options } = {}) {
  return createStudioAgentSession({
    baseUrl,
    ...(actor.auth ? { auth: actor.auth } : {}),
    fetchImpl: recordingFetch(log, actor.headers),
    ...options,
  });
}
async function authHeaders(actor) {
  return actor.auth ? { authorization: `Bearer ${await actor.auth.getAccessToken()}` } : { ...actor.headers };
}

function parseBody(text) {
  if (!text) return undefined;
  const trimmed = text.trim();
  const json = trimmed.startsWith("event:") || trimmed.startsWith("data:")
    ? trimmed.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("\n")
    : trimmed;
  try {
    return JSON.parse(json);
  } catch {
    return { raw: json.slice(0, 500) };
  }
}

async function attempt(client, name, args) {
  try {
    const result = await client.callTool(name, args);
    return { ok: true, structured: result.structuredContent };
  } catch (error) {
    return { ok: false, error: JSON.parse(redact(JSON.stringify({ name: error?.name, message: error?.message, ...error }))) };
  }
}
function assertDenied(outcome, label) {
  assert.equal(outcome.ok, false, `${label}: the server accepted the call`);
  assert.match(
    JSON.stringify(outcome.error),
    /permission_denied|unauthenticated|studio_authorization|scope|not authorized|not found/i,
    `${label}: failure is not a governed denial: ${JSON.stringify(outcome.error)}`,
  );
}

// ── Deployment ────────────────────────────────────────────────

const network = prefix;
const keyringVolume = `${prefix}-keyring`;
const work = await mkdtemp(join(tmpdir(), `${prefix}-`));
const appsettingsPath = join(work, "appsettings.Production.json");
const containers = new Set();
let port;
let baseUrl;
let stubUrl;

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port: chosen } = server.address();
      server.close(() => resolve(chosen));
    });
  });
}

async function setDefaultView(view) {
  const settings = JSON.parse(await readFile(appsettingsPath, "utf8"));
  settings.Mcp = { ...settings.Mcp, WorkflowViews: { ...settings.Mcp?.WorkflowViews, DefaultView: view } };
  // Rewritten in place (same inode) so the single-file bind mount observes it.
  await writeFile(appsettingsPath, JSON.stringify(settings, null, 2) + "\n");
}

function serverEnv(database, redis, extraEnv) {
  const connection = `Server=${prefix}-pg;Port=5432;Database=${database};User Id=honua;Password=${secrets.postgres};`;
  return {
    ASPNETCORE_ENVIRONMENT: "Production",
    Kestrel__Endpoints__Http__Url: "http://+:8080",
    Kestrel__Endpoints__Http__Protocols: "Http1",
    AllowedHosts: "localhost;127.0.0.1",
    HostValidation__AllowedHosts__0: "localhost",
    HostValidation__AllowedHosts__1: "127.0.0.1",
    PUBLIC_BASE_URL: `http://127.0.0.1:${port}`,
    HONUA_ADMIN_PASSWORD: secrets.admin,
    Licensing__Mode: "Disabled",
    Studio__EndUserAuthorization__Enabled: "true",
    Oidc__Enabled: "true",
    Oidc__Generic__Enabled: "true",
    Oidc__Generic__Authority: issuer,
    Oidc__Generic__ClientId: audience,
    Oidc__AdminRoles__0: "admin",
    Oidc__TokenValidation__ValidIssuers__0: issuer,
    Oidc__TokenValidation__ValidAudiences__0: audience,
    Oidc__TokenValidation__SymmetricSigningKey: secrets.jwt,
    Operations__SecretChannel__KeyRingCertificatePath: "/keyring/operation-keyring.pfx",
    Operations__SecretChannel__KeyRingCertificatePassword: secrets.keyring,
    ConnectionStrings__DefaultConnection: connection,
    ConnectionStrings__honua: connection,
    ConnectionStrings__Redis: `${redis}:6379`,
    FileStorage__Provider: "Local",
    FileStorage__LocalStorage__BasePath: "/tmp/honua-storage",
    Security__ConnectionEncryption__MasterKey: secrets.master,
    Security__ConnectionEncryption__Salt: secrets.salt,
    Mcp__ServerInitiatedStreamEnabled: "true",
    // Docker bind mounts do not reliably deliver inotify events; poll the settings file.
    DOTNET_USE_POLLING_FILE_WATCHER: "true",
    StudioAiProxy__Enabled: "true",
    StudioAiProxy__DefaultProvider: "scripted",
    StudioAiProxy__Providers__scripted__Kind: "openai",
    StudioAiProxy__Providers__scripted__Endpoint: `http://${prefix}-model:8080/v1`,
    StudioAiProxy__Providers__scripted__Model: "scripted-terminal-model",
    // Declared deviation (receipt.deploymentDeviations): the default 32000 stops the lifecycle at propose.
    StudioAiProxy__MaxPromptCharacters: "100000",
    HONUA_STUDIOAI_SCRIPTED_API_KEY: secrets.provider,
    StudioAiProxy__TranscriptSigning__KeyId: transcriptSigning.keyId,
    // The options validator requires a "://" reference while the env resolver strips only "env:",
    // so the reference env://NAME reads the variable literally named //NAME.
    StudioAiProxy__TranscriptSigning__PrivateKeyReference: "env://HONUA_STUDIO_TRANSCRIPT_SEED",
    "//HONUA_STUDIO_TRANSCRIPT_SEED": secrets.transcriptSeed,
    ...extraEnv,
  };
}

async function waitReady(name, timeoutMs = 240_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = JSON.parse(docker("inspect", name, "--format", "{{json .State}}"));
    if (!state.Running) return false;
    try {
      if ((await fetch(`${baseUrl}/healthz/ready`, { signal: AbortSignal.timeout(2_000) })).ok) return true;
    } catch {
      // Not listening yet.
    }
    await sleep(1_000);
  }
  return false;
}

const logsOf = (name) => {
  const logs = exec("docker", ["logs", name], { allowFailure: true, timeout: 30_000 });
  return redact(`${logs.stdout ?? ""}\n${logs.stderr ?? ""}`);
};

async function startServer(serverImage, name, database, redis, extraEnv = {}) {
  for (const existing of containers) {
    if (existing.includes("-server-")) exec("docker", ["rm", "-f", existing], { allowFailure: true });
  }
  const envFile = join(work, `${name}.env`);
  await writeFile(envFile, Object.entries(serverEnv(database, redis, extraEnv)).map(([k, v]) => `${k}=${v}`).join("\n") + "\n", { mode: 0o600 });
  // One retry covers PostGIS's first-boot init restart racing the server's migrations.
  for (let boot = 1; boot <= 2; boot++) {
    exec("docker", ["rm", "-f", name], { allowFailure: true });
    docker("run", "-d", "--name", name, "--network", network, "-p", `127.0.0.1:${port}:8080`,
      "--env-file", envFile, "-v", `${appsettingsPath}:/app/appsettings.Production.json:ro`,
      "-v", `${keyringVolume}:/keyring:ro`, serverImage);
    containers.add(name);
    if (await waitReady(name)) {
      return {
        container: name,
        imageId: docker("inspect", name, "--format", "{{.Image}}"),
        revision: docker("inspect", name, "--format", '{{index .Config.Labels "org.opencontainers.image.revision"}}'),
        boots: boot,
        extraEnv,
      };
    }
  }
  throw new Error(`${name} never became ready:\n${logsOf(name).slice(-6_000)}`);
}

async function adminJson(method, path, body) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { ...adminKey.headers, "content-type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, body: parseBody(await response.text()) };
}

async function provisionRole(name, permissions) {
  const created = await adminJson("POST", "/api/v1/admin/roles", { name, description: "honua-sdk-js#1397 candidate replay" });
  assert.equal(created.status, 201, `create role ${name}: ${JSON.stringify(created.body)}`);
  const roleId = created.body.data.roleId;
  const granted = await adminJson("PUT", `/api/v1/admin/roles/${roleId}/permissions`, { permissions });
  assert.ok(granted.status >= 200 && granted.status < 300, `grant ${name}: ${granted.status} ${JSON.stringify(granted.body)}`);
  return { name, roleId, permissions };
}

const sql = (statement) =>
  exec("docker", ["exec", `${prefix}-pg`, "psql", "-U", "honua", "-d", "honua", "-At", "-v", "ON_ERROR_STOP=1", "-c", statement]).stdout.trim();

async function rawMcp(actor, method, params, { view } = {}) {
  const client = mcpClientFor(actor, { view });
  await client.initialize();
  const response = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-session-id": client.sessionId,
      ...(await authHeaders(actor)),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: randomUUID(), method, params }),
  });
  return { http: response.status, body: parseBody(await response.text()) };
}

async function putPlan(plan) {
  const response = await fetch(`${stubUrl}/plan`, { method: "PUT", body: JSON.stringify(plan) });
  assert.equal(response.status, 204, "stub plan rejected");
}
async function captured() {
  return (await fetch(`${stubUrl}/captured`)).json();
}

// The contract StudioAiToolDefinition.BuildProviderDescription appends for provider APIs
// without first-class annotation/output-schema fields.
function providerContract(description, label) {
  const marker = `${label} (JSON): `;
  const start = description.indexOf(marker);
  if (start < 0) return undefined;
  const tail = description.slice(start + marker.length);
  const [json] = label === "Tool annotations" ? tail.split(/\r?\n\r?\nExpected structured output schema \(JSON\): /) : [tail];
  return JSON.parse(json.trim());
}

// ── The map the terminal session composes (independent literal expectations) ──

const expectedPoint = {
  type: "Feature",
  id: 7,
  properties: { name: "Honolulu", elevation: null },
  geometry: { type: "Point", coordinates: [-157.8583, 21.3069] },
};
const initialBody = (packageKey) => ({
  mapPackageId: packageKey,
  format: "honua_map_package.v1",
  status: "Draft",
  createdAt: "2026-09-15T00:00:00Z",
  mapSpec: {
    version: 8,
    sources: { places: { type: "geojson", data: { type: "FeatureCollection", features: [expectedPoint] } } },
    layers: [{ id: "places", type: "circle", source: "places" }],
  },
  view: { center: [-157.8583, 21.3069], zoom: 7, crs: "EPSG:4326" },
  layers: [],
  widgets: [],
  controls: [],
  interactions: [],
});
const mutatedView = { center: [-157.8167, 21.2833], zoom: 11, crs: "EPSG:4326" };
const mutatedLayers = [{ id: "places", title: "Honolulu places", visible: true }];

function lifecyclePlan(packageKey) {
  const saved = (field) => `$honua_studio_save_version.${field}`;
  return [
    { tool: "honua_studio_create_draft", args: { packageKey, family: "map", schemaVersion: "1.0", body: initialBody(packageKey) } },
    { tool: "honua_studio_update_draft",
      args: { packageKey, schemaVersion: "1.0", body: { ...initialBody(packageKey), view: mutatedView, layers: mutatedLayers } } },
    { tool: "honua_studio_validate_draft", args: {} },
    { tool: "honua_studio_get_draft", args: {} },
    { tool: "honua_studio_save_version", args: { changeNote: "honua-sdk-js#1397 candidate replay" } },
    { tool: "honua_studio_reopen_version", args: { itemId: saved("itemId"), versionId: saved("versionId") } },
    { tool: "honua_studio_propose_publication", args: {
      itemId: saved("itemId"), versionId: saved("versionId"), contentHash: saved("contentHash"),
      route: `/studio/${packageKey}`, visibility: "personal", note: "honua-sdk-js#1397 candidate replay" } },
  ];
}

async function discoveryCheck(actor, suffix, setupDescriptors) {
  return check(`default-session-classified-discovery:${suffix}`, "AC1", async (evidence) => {
    const log = [];
    const session = sessionFor(actor, { log });
    const report = await session.refreshTools();
    assert.equal(report.errorMessage, undefined, report.errorMessage);
    evidence.report = report;
    assert.deepEqual(sorted(report.routed), sorted(expected.members), "routed set differs from the transcribed setup classification");
    assert.ok(JSON.stringify(report.classification).includes(expected.revision), "report does not carry the setup revision");
    assert.ok(report.rejected.some((entry) => entry.name === "honua_list_capabilities"), "unclassified setup neighbour was not refused");
    const initializes = log.filter((entry) => entry.rpc === "initialize");
    assert.deepEqual(initializes.map((entry) => entry.initializeMeta), [{ "honua.io/workflow-view": HONUA_STUDIO_TOOL_SETUP_VIEW }]);

    session.reconnect();
    const again = await session.refreshTools();
    assert.equal(again.errorMessage, undefined, again.errorMessage);
    assert.deepEqual(sorted(again.routed), sorted(expected.members), "reconnect changed the routed set");
    assert.equal(log.filter((entry) => entry.rpc === "initialize").length, 2, "reconnect did not open a new MCP session");
    session.close();

    const full = await mcpClientFor(actor, { view: "full" }).listAllTools();
    const classified = full.tools.filter((tool) => tool._meta?.[HONUA_STUDIO_TOOL_METADATA_KEY]?.family === HONUA_STUDIO_TOOL_FAMILY);
    assert.deepEqual(sorted(classified.map((tool) => tool.name)), sorted(expected.members), "full catalog classification differs");
    evidence.fullCatalog = {
      descriptors: full.tools.length,
      classified: classified.map((tool) => ({ name: tool.name, classification: tool._meta[HONUA_STUDIO_TOOL_METADATA_KEY] })),
      unclassifiedStudioNamed: full.tools.map((tool) => tool.name).filter((name) => name.startsWith("honua_studio_") && !expected.members.includes(name)),
    };
    const setup = await mcpClientFor(actor, { view: HONUA_STUDIO_TOOL_SETUP_VIEW }).listAllTools();
    for (const tool of setup.tools) setupDescriptors.set(tool.name, tool);
    evidence.setupView = { pages: setup.pages, names: setup.tools.map((tool) => tool.name) };
  });
}

async function certifiedTurnOptions(actor, evidence) {
  const response = await fetch(`${baseUrl}/api/v1/studio/ai/capabilities`, { headers: await authHeaders(actor) });
  const manifest = parseBody(await response.text())?.data?.transcriptSigning;
  assert.equal(response.status, 200, `capabilities: ${response.status}`);
  evidence.transcriptSigning = manifest;
  const key = manifest?.keys?.find((candidate) => candidate.keyId === transcriptSigning.keyId);
  assert.equal(key?.fingerprint, transcriptSigning.fingerprint, "published signing key differs from the deployed key");
  return {
    certification: { candidateId: digest, releaseId: "2026.1", endpointIdentity: baseUrl, actionId: "studio.setup", runNonce: randomUUID() },
    transcriptVerifier: new StudioAiTranscriptVerifier({
      manifest: { ...manifest, keys: [key] },
      replayStore: new InMemoryStudioAiReplayStore(),
    }),
  };
}

// The SDK verifier's canonical form (sorted keys, undefined members dropped, JSON.stringify leaves).
function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).filter((key) => value[key] !== undefined).sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

/** Certified options whose verifier also records where a rejected signed request departs from the SDK's. */
async function recordingCertifiedTurnOptions(actor, evidence) {
  const options = await certifiedTurnOptions(actor, evidence);
  const inner = options.transcriptVerifier;
  return {
    ...options,
    transcriptVerifier: {
      async verify(provenance, request, events) {
        const verification = await inner.verify(provenance, request, events);
        if (!verification.ok) {
          const transcript = JSON.parse(Buffer.from(provenance.canonicalTranscript, "base64").toString("utf8"));
          const eventsFailed = verification.reason === "terminal-events-mismatch";
          const signedValue = JSON.parse(Buffer.from(String(eventsFailed ? transcript.providerEvents : transcript.request), "base64").toString("utf8"));
          // Both sides in the same canonical representation, so only value differences remain.
          const signed = canonicalJson(signedValue);
          const local = canonicalJson(eventsFailed ? events : request);
          let offset = 0;
          while (offset < Math.min(signed.length, local.length) && signed[offset] === local[offset]) offset++;
          evidence.verifierRejection = {
            reason: verification.reason,
            compared: eventsFailed ? "providerEvents" : "request",
            signedLength: signed.length,
            sdkLength: local.length,
            firstDifferenceAt: offset,
            signedContext: signed.slice(Math.max(0, offset - 120), offset + 120),
            sdkContext: local.slice(Math.max(0, offset - 120), offset + 120),
            ...(eventsFailed ? {
              signedEventTypes: signedValue.map((event) => event.type),
              sdkEventTypes: events.map((event) => event.type),
            } : {}),
          };
        }
        return verification;
      },
    },
  };
}

function collectValues(value, into = {}) {
  if (Array.isArray(value)) {
    for (const entry of value) collectValues(entry, into);
  } else if (value && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      if (typeof entry === "string" || typeof entry === "number") into[key] = entry;
      collectValues(entry, into);
    }
  }
  return into;
}

// The same draft shape StudioAgentSession recognises: a top-level or nested `draft` record.
function draftOf(structured) {
  if (typeof structured?.draftId === "string" && typeof structured.generation === "number") return structured;
  const nested = structured?.draft;
  return typeof nested?.draftId === "string" && typeof nested.generation === "number" ? nested : undefined;
}

/**
 * Plays the plan as model-selected actions through a certified StudioAgentSession turn
 * (mode "model"), or as a terminal MCP client issuing the same calls and binding the draft
 * identity and generation the way the session does (mode "mcp").
 */
async function playPlan(actor, plan, mode, evidence) {
  const log = [];
  evidence.mode = mode;
  if (mode === "model") {
    await putPlan(plan);
    const terminal = sessionFor(actor, {
      log,
      baseUrl: `${baseUrl}/api`,
      mcpClient: mcpClientFor(actor, { view: HONUA_STUDIO_TOOL_SETUP_VIEW, log }),
      provider: "scripted",
      system: "Scripted qualification turn.",
      maxToolRounds: plan.length + 2,
      ...(await recordingCertifiedTurnOptions(actor, evidence)),
    });
    const turn = await terminal.chat("Create the Honolulu map, move its view, validate, save, reopen and submit it for publication.");
    terminal.close();
    evidence.turn = { status: turn.status, rounds: turn.rounds, text: turn.text, errorMessage: turn.errorMessage };
    evidence.chatRequests = log.filter((entry) => entry.path.endsWith("/studio/ai/chat"));
    // Recorded before any assertion so a turn that stops mid-plan still shows what it dispatched.
    evidence.partialDispatch = turn.toolCalls.map((call) => {
      const content = JSON.parse(call.content);
      return { tool: call.toolName, ok: call.ok, errorMessage: call.errorMessage,
        contentKeys: Object.keys(content), payloadKeys: Object.keys(content.result ?? content.draft ?? {}) };
    });
    evidence.providerPlanErrors = (await captured()).filter((entry) => entry.planError).map((entry) => entry.planError);
    assert.equal(turn.status, "completed", `turn ${turn.status}: ${turn.errorMessage ?? turn.text}`);
    return {
      log,
      calls: turn.toolCalls.map((call) => ({
        tool: call.toolName, plane: call.plane, ok: call.ok, errorMessage: call.errorMessage, payload: JSON.parse(call.content),
      })),
    };
  }
  const client = mcpClientFor(actor, { view: HONUA_STUDIO_TOOL_SETUP_VIEW, log });
  const values = {};
  const resolve = (value) => {
    if (typeof value === "string" && value.startsWith("$")) {
      const [tool, field] = value.slice(1).split(".");
      assert.ok(values[tool]?.[field] !== undefined, `no earlier result carried ${value}`);
      return values[tool][field];
    }
    if (Array.isArray(value)) return value.map(resolve);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, resolve(entry)]));
    return value;
  };
  let binding;
  const calls = [];
  for (const step of plan) {
    const args = resolve(step.args);
    if (binding) Object.assign(args, { draftId: args.draftId ?? binding.draftId, generation: binding.generation });
    const outcome = await attempt(client, step.tool, args);
    const draft = draftOf(outcome.structured);
    if (draft) binding = { draftId: draft.draftId, generation: draft.generation };
    values[step.tool] = collectValues(outcome.structured);
    calls.push({ tool: step.tool, plane: "composition", ok: outcome.ok, errorMessage: outcome.error?.message,
      payload: draft ? { status: "ok", draft } : { status: "ok", result: outcome.structured } });
    if (!outcome.ok) break;
  }
  return { log, calls };
}

async function lifecycleChecks(actor, suffix, setupDescriptors, mode = "model") {
  const packageKey = `sdk1397-${suffix}-${run}`;
  const plan = lifecyclePlan(packageKey);
  const lifecycle = { actor, packageKey };
  await check(`terminal-session-lifecycle:${suffix}`, "AC4", async (evidence) => {
    const { log, calls } = await playPlan(actor, plan, mode, evidence);
    evidence.dispatched = calls.map(({ tool, plane, ok, errorMessage }) => ({ tool, plane, ok, errorMessage }));
    assert.deepEqual(calls.map((call) => call.tool), plan.map((step) => step.tool), "dispatched calls differ from the plan");
    for (const call of calls) assert.ok(call.ok && call.plane === "composition", `${call.tool}: ${call.errorMessage}`);
    const payload = (name) => calls.find((call) => call.tool === name).payload;

    const created = payload("honua_studio_create_draft").draft;
    assert.equal(created.family, "map");
    assert.deepEqual(created.envelope.body.view, initialBody(packageKey).view);
    const updated = payload("honua_studio_update_draft").draft;
    assert.equal(updated.draftId, created.draftId);
    assert.equal(updated.generation, created.generation + 1, "update did not advance the generation by one");
    const validatedPayload = payload("honua_studio_validate_draft");
    const validated = validatedPayload.result ?? validatedPayload.draft;
    assert.equal(validated.status ?? validated.validation?.status, "valid");
    const read = payload("honua_studio_get_draft").draft;
    for (const body of [updated.envelope.body, read.envelope.body]) {
      assert.deepEqual(body.view, mutatedView, "view is not the literal value written");
      assert.deepEqual(body.mapSpec.sources.places.data.features, [expectedPoint], "ordinates, identity or null elevation changed");
      assert.equal(body.format, "honua_map_package.v1");
      assert.deepEqual(body.layers.map((layer) => [layer.id, layer.title, layer.visible]), [["places", "Honolulu places", true]]);
    }
    const saved = payload("honua_studio_save_version").result.version;
    assert.ok(saved.itemId && saved.versionId && saved.contentHash, `save returned no version identity: ${JSON.stringify(saved)}`);
    const reopened = payload("honua_studio_reopen_version").draft;
    assert.equal(reopened.baseVersionId, saved.versionId, "reopen did not bind the saved version");
    assert.deepEqual(reopened.envelope.body.view, mutatedView);
    assert.deepEqual(reopened.envelope.body.mapSpec.sources.places.data.features, [expectedPoint]);
    const proposed = payload("honua_studio_propose_publication").result;
    assert.equal(proposed.status, "AwaitingApproval");
    assert.equal(proposed.proposalUri, `honua://proposals/${proposed.proposalId}`);
    // Recorded before the status reads so the RBAC negatives can still target this lifecycle.
    Object.assign(lifecycle, { created, updated, saved, reopened, proposed });

    const version = await fetch(`${baseUrl}/api/v1/studio/content-items/${saved.itemId}/versions/${saved.versionId}`, {
      headers: await authHeaders(actor),
    });
    const versionBody = parseBody(await version.text())?.data;
    assert.equal(version.status, 200, "saved version is not readable by its owner");
    assert.equal(versionBody.contentHash, saved.contentHash, "stored version hash differs from the save response");
    assert.deepEqual(versionBody.envelope.body.view, mutatedView);

    const polls = [];
    for (let poll = 0; poll < 3; poll++) {
      const status = await rawMcp(actor, "resources/read", { uri: proposed.proposalUri });
      const text = status.body?.result?.contents?.[0]?.text;
      polls.push({ http: status.http, error: status.body?.error, record: text ? JSON.parse(text) : undefined });
      await sleep(500);
    }
    for (const poll of polls) assert.ok(poll.record, `owner could not poll proposal status: ${JSON.stringify(poll)}`);
    const pointer = sql(`SELECT coalesce(published_version_id::text, 'null') || '|' || current_version_id FROM honua.studio_content_items WHERE item_id = '${saved.itemId}'`);
    assert.equal(pointer, `null|${saved.versionId}`, "publication pointer moved without approval");

    evidence.values = {
      draftId: created.draftId,
      ownerId: created.ownerId,
      generations: { created: created.generation, updated: updated.generation, reopened: reopened.generation },
      itemId: saved.itemId,
      versionId: saved.versionId,
      contentHash: saved.contentHash,
      reopenedDraftId: reopened.draftId,
      proposalId: proposed.proposalId,
      publicationPointer: pointer,
      polls,
    };
    evidence.requests = log.map(({ method, path, rpc }) => ({ method, path, rpc }));
  });

  if (mode === "model") await check(`proxy-forwards-annotations-and-output-schema:${suffix}`, "AC2", async (evidence) => {
    const requests = await captured();
    // Every provider round the proxy served is checked; a turn stopped by provenance still delivered its first round.
    assert.ok(requests.length >= 1, "the provider saw no request");
    let withAnnotations = 0;
    let withOutputSchema = 0;
    for (const [index, request] of requests.entries()) {
      assert.ok(request.authorization, "proxy did not authenticate to the provider");
      const tools = request.body.tools ?? [];
      assert.deepEqual(sorted(tools.map((tool) => tool.function.name)), sorted(expected.members), `request ${index}: advertised tools differ`);
      for (const tool of tools) {
        const descriptor = setupDescriptors.get(tool.function.name);
        assert.deepEqual(tool.function.parameters, descriptor.inputSchema, `${tool.function.name}: input schema changed`);
        assert.ok(tool.function.description.startsWith(descriptor.description ?? ""), `${tool.function.name}: description changed`);
        assert.deepEqual(providerContract(tool.function.description, "Tool annotations"), descriptor.annotations,
          `${tool.function.name}: annotations did not reach the provider verbatim`);
        assert.deepEqual(providerContract(tool.function.description, "Expected structured output schema"), descriptor.outputSchema,
          `${tool.function.name}: output schema did not reach the provider verbatim`);
        if (index === 0) {
          withAnnotations += descriptor.annotations ? 1 : 0;
          withOutputSchema += descriptor.outputSchema ? 1 : 0;
        }
      }
    }
    assert.ok(withAnnotations > 0 && withOutputSchema > 0, "no routed descriptor carried annotations and output schema; the check would be vacuous");
    evidence.providerRequests = requests.map((request) => ({
      model: request.body.model,
      roles: request.body.messages.map((message) => message.role),
      tools: request.body.tools?.map((tool) => tool.function.name),
      orphanToolResults: request.orphanToolResults,
    }));
    evidence.firstRequestTools = requests[0].body.tools;
    evidence.descriptorsWithAnnotations = withAnnotations;
    evidence.descriptorsWithOutputSchema = withOutputSchema;
  });
  return lifecycle;
}

try {
  // ── Boot ────────────────────────────────────────────────────
  port = await freePort();
  baseUrl = `http://127.0.0.1:${port}`;
  docker("network", "create", network);
  docker("volume", "create", keyringVolume);
  exec("docker", ["run", "--rm", "-v", `${keyringVolume}:/keyring`, "-e", `KEYRING_PASSWORD=${secrets.keyring}`,
    "--entrypoint", "/bin/sh", "alpine/openssl:latest", "-c",
    "set -e; openssl req -x509 -newkey rsa:2048 -nodes -days 1 -keyout /tmp/k.key -out /tmp/k.crt -subj /CN=sdk1397 >/dev/null 2>&1; " +
      "openssl pkcs12 -export -out /keyring/operation-keyring.pfx -inkey /tmp/k.key -in /tmp/k.crt -passout env:KEYRING_PASSWORD; " +
      "chmod 444 /keyring/operation-keyring.pfx"]);

  const settingsCopy = docker("create", image);
  try {
    docker("cp", `${settingsCopy}:/app/appsettings.Production.json`, appsettingsPath);
  } finally {
    exec("docker", ["rm", settingsCopy], { allowFailure: true });
  }
  await setDefaultView("default");
  await chmod(appsettingsPath, 0o644);

  const pg = `${prefix}-pg`;
  docker("run", "-d", "--name", pg, "--network", network, "-e", "POSTGRES_USER=honua", "-e", `POSTGRES_PASSWORD=${secrets.postgres}`,
    "-e", "POSTGRES_DB=honua", "-e", "POSTGIS_GDAL_ENABLED_DRIVERS=ENABLE_ALL", "postgis/postgis:16-3.4");
  containers.add(pg);
  // A socket probe passes during the image's init restart; wait for the init to finish and TCP to answer.
  await waitFor(() => logsOf(pg).includes("PostgreSQL init process complete"), 120_000, "PostGIS init");
  await waitFor(() => exec("docker", ["exec", pg, "pg_isready", "-h", "127.0.0.1", "-U", "honua", "-d", "honua"], { allowFailure: true }).status === 0, 60_000, "PostGIS TCP");
  sql("CREATE DATABASE honua_previous");
  for (const database of ["honua", "honua_previous"]) {
    exec("docker", ["exec", pg, "psql", "-U", "honua", "-d", database, "-v", "ON_ERROR_STOP=1", "-c",
      "CREATE EXTENSION IF NOT EXISTS postgis; CREATE EXTENSION IF NOT EXISTS postgis_raster;"]);
  }
  for (const redis of [`${prefix}-redis-current`, `${prefix}-redis-previous`]) {
    docker("run", "-d", "--name", redis, "--network", network, "redis:7.4-alpine");
    containers.add(redis);
  }

  const model = `${prefix}-model`;
  await copyFile(fileURLToPath(new URL("./studio-candidate-model-stub.mjs", import.meta.url)), join(work, "stub.mjs"));
  await chmod(join(work, "stub.mjs"), 0o644);
  docker("run", "-d", "--name", model, "--network", network, "-p", "127.0.0.1::8080",
    "-v", `${join(work, "stub.mjs")}:/stub.mjs:ro`, "node:22-alpine", "node", "/stub.mjs");
  containers.add(model);
  stubUrl = `http://${docker("port", model, "8080/tcp").split("\n")[0]}`;
  await waitFor(async () => (await fetch(`${stubUrl}/captured`).catch(() => undefined))?.ok === true, 30_000, "model stub");

  const current = `${prefix}-server-current`;
  receipt.candidate.running = await startServer(image, current, "honua", `${prefix}-redis-current`);
  receipt.candidate.running.imageMatchesManifest = receipt.candidate.running.imageId === docker("image", "inspect", image, "--format", "{{.Id}}");
  assert.ok(receipt.candidate.running.imageMatchesManifest, "running image is not the manifest digest");
  assert.equal(receipt.candidate.running.revision, candidateRef, "image revision label differs from the manifest candidate ref");

  const author = await provisionRole(`sdk1397-author-${run}`, [{ service: "StudioDraft", layer: "*", operation: "*" }]);
  const composer = await provisionRole(`sdk1397-composer-${run}`,
    ["Discover", "Read", "Create", "Update", "Execute"].map((operation) => ({ service: "StudioDraft", layer: "*", operation })));
  receipt.principals = {
    roles: [author, composer],
    tokens: "HS256 from this deployment's issuer/audience/signing key; tid=public; sid+auth_time session evidence; one token per principal",
  };
  const alice = endUser(`sdk1397-alice-${run}`, [author.name]);
  const aliceReadOnly = endUser(alice.sub, [author.name], "honua.mcp.read");
  const bob = endUser(`sdk1397-bob-${run}`, [author.name]);
  const carol = endUser(`sdk1397-carol-${run}`, []);
  const dan = endUser(`sdk1397-dan-${run}`, [composer.name]);
  const setupDescriptors = new Map();

  // ── Phase 1: the image's own configuration ──────────────────

  // Server finding, not an SDK criterion: every bearer request is replay-registered by jti,
  // and an MCP session is bound to the SHA-256 of the exact bearer credential.
  await check("bearer-mcp-session-continuity", "finding (honua-server)", async (evidence) => {
    const claims = { ...alice.claims };
    const first = mint(claims);
    const client = new McpClient({ baseUrl, auth: { getAccessToken: async () => first }, workflowView: HONUA_STUDIO_TOOL_SETUP_VIEW });
    await client.initialize();
    const listWith = async (token) => {
      const response = await fetch(`${baseUrl}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream",
          "mcp-session-id": client.sessionId, authorization: `Bearer ${token}` },
        body: JSON.stringify({ jsonrpc: "2.0", id: randomUUID(), method: "tools/list", params: {} }),
      });
      const body = parseBody(await response.text());
      return { http: response.status, wwwAuthenticate: response.headers.get("www-authenticate"), error: body?.error,
        tools: body?.result?.tools?.length };
    };
    evidence.initialized = Boolean(client.sessionId);
    evidence.sameTokenSecondRequest = await listWith(first);
    evidence.freshTokenSameSession = await listWith(mint(claims));
    evidence.serverLog = logsOf(current).split("\n").filter((line) => /replay|principal/i.test(line)).slice(-6);
    assert.ok(evidence.sameTokenSecondRequest.tools || evidence.freshTokenSameSession.tools,
      "a bearer principal cannot make a second request on its own MCP session under the default token-replay protection");
  });

  await discoveryCheck(adminKey, "admin-api-key", setupDescriptors);
  await lifecycleChecks(adminKey, "admin-api-key-model", setupDescriptors, "model");
  await lifecycleChecks(adminKey, "admin-api-key-mcp", setupDescriptors, "mcp");

  // AC3 + AC5: listChanged over the real push channel changes the set without a reconnect.
  await check("list-changed-push-changes-discovered-set", "AC3, AC5", async (evidence) => {
    const log = [];
    const events = [];
    const watchClient = mcpClientFor(adminKey, { log });
    const watcher = sessionFor(adminKey, {
      log,
      baseUrl: `${baseUrl}/api`,
      mcpClient: watchClient,
      watchToolListChanged: true,
      onEvent: (event) => {
        if (event.type === "toolWatch") events.push({ at: Date.now(), type: event.type, status: event.status, detail: event.detail });
        if (event.type === "toolDiscovery") events.push({ at: Date.now(), type: event.type, routed: event.report.routed, errorMessage: event.report.errorMessage });
      },
    });
    try {
      const initial = await watcher.refreshTools();
      assert.equal(initial.errorMessage, undefined, initial.errorMessage);
      assert.deepEqual(initial.routed, [], "server default view already routes Studio members");
      await waitFor(() => events.some((event) => event.status === "open"), 30_000, `GET /mcp stream open (events: ${JSON.stringify(events)})`);
      const sessionId = watchClient.sessionId;
      const initializes = () => log.filter((entry) => entry.rpc === "initialize").length;
      const lists = () => log.filter((entry) => entry.rpc === "tools/list").length;
      const initializeCount = initializes();

      const phases = [];
      for (const [view, members] of [[HONUA_STUDIO_TOOL_SETUP_VIEW, expected.members], ["default", []]]) {
        const listsBefore = lists();
        const startedAt = Date.now();
        await setDefaultView(view);
        await waitFor(
          () => events.some((event) => event.type === "toolDiscovery" && event.at > startedAt
            && JSON.stringify(sorted(event.routed)) === JSON.stringify(sorted(members))),
          120_000,
          `discovered set to become [${members.join(", ")}] after DefaultView=${view}`,
        );
        phases.push({ serverDefaultView: view, routed: [...watcher.compositionTools], secondsToRefresh: (Date.now() - startedAt) / 1000,
          toolsListCallsTriggered: lists() - listsBefore });
        assert.ok(lists() > listsBefore, "no tools/list followed the notification");
      }
      assert.equal(initializes(), initializeCount, "the refresh reconnected instead of reusing the session");
      assert.equal(watchClient.sessionId, sessionId, "the MCP session changed");
      evidence.phases = phases;
      evidence.mcpSession = { reused: true, initializeCalls: initializeCount };
      evidence.streamEvents = events.filter((event) => event.type === "toolWatch");
      evidence.serverBroadcastLogLines = logsOf(current).split("\n").filter((line) => line.includes("list_changed")).slice(-10);
    } finally {
      watcher.close();
      await setDefaultView("default");
    }
  });

  // AC5: a server release adds/removes Studio members; reconnect observes it.
  if (previousImage) {
    await check("release-swap-reconnect-changes-discovered-set", "AC5", async (evidence) => {
      const log = [];
      const session = sessionFor(adminKey, { log });
      const steps = [];
      const observe = async (label, members) => {
        const report = await session.refreshTools();
        assert.equal(report.errorMessage, undefined, `${label}: ${report.errorMessage}`);
        assert.deepEqual(sorted(report.routed), sorted(members), `${label}: routed set differs`);
        steps.push({ label, routed: report.routed, classification: report.classification });
      };
      await observe(`candidate ${candidateRef.slice(0, 7)}`, expected.members);
      evidence.previousRunning = await startServer(previousImage, `${prefix}-server-previous`, "honua_previous", `${prefix}-redis-previous`);
      assert.equal(evidence.previousRunning.revision, previousRef, "previous image revision label differs");
      session.reconnect();
      await observe(`previous ${previousRef.slice(0, 7)} after reconnect`, expectedPrevious.members);
      receipt.candidate.running = await startServer(image, current, "honua", `${prefix}-redis-current`);
      session.reconnect();
      await observe(`candidate ${candidateRef.slice(0, 7)} after reconnect`, expected.members);
      session.close();
      evidence.steps = steps;
      evidence.removedByDowngrade = expected.members.filter((name) => !expectedPrevious.members.includes(name));
      evidence.initializeCalls = log.filter((entry) => entry.rpc === "initialize").length;
    });
  }

  // ── Phase 2: end users (declared deviation) ─────────────────
  const deviation = { Oidc__TokenValidation__EnableTokenReplayProtection: "false" };
  receipt.deploymentDeviations.push({
    setting: "Oidc:TokenValidation:EnableTokenReplayProtection=false",
    reason: "the candidate rejects every second request of a bearer MCP session under the default (see bearer-mcp-session-continuity)",
    appliesTo: "checks suffixed :end-user-bearer and rbac-distinct-principal-negatives",
  });
  receipt.candidate.running = await startServer(image, current, "honua", `${prefix}-redis-current`, deviation);

  await discoveryCheck(alice, "end-user-bearer", setupDescriptors);
  // Finding, not an SDK criterion: StudioAgentSession dispatches a model-selected action only with
  // certified, verified transcript provenance, and the proxy forbids certification to non-admins.
  await check("end-user-model-turn-dispatch", "finding (honua-sdk-js / honua-server)", async (evidence) => {
    const attemptTurn = async (options) => {
      await putPlan([{ tool: "honua_studio_validate_draft", args: { draftId: randomUUID() } }]);
      const session = sessionFor(alice, {
        baseUrl: `${baseUrl}/api`, mcpClient: mcpClientFor(alice, { view: HONUA_STUDIO_TOOL_SETUP_VIEW }),
        provider: "scripted", system: "Scripted qualification turn.", maxToolRounds: 2, ...options,
      });
      const turn = await session.chat("Validate the draft.");
      session.close();
      return { status: turn.status, errorMessage: turn.errorMessage, toolCalls: turn.toolCalls.length };
    };
    evidence.uncertified = await attemptTurn({});
    evidence.certified = await attemptTurn(await certifiedTurnOptions(alice, evidence));
    assert.ok(evidence.uncertified.toolCalls > 0 || evidence.certified.toolCalls > 0,
      "an interactive end user's model-selected Studio action cannot dispatch: the SDK requires certified provenance and the proxy forbids certification to non-admin callers");
  });

  const aliceLifecycle = await lifecycleChecks(alice, "end-user-bearer", setupDescriptors, "mcp");

  await check("rbac-distinct-principal-negatives", "AC6", async (evidence) => {
    assert.ok(aliceLifecycle.reopened, "no end-user lifecycle draft to attack; the end-user AC4 check did not complete");
    const discovery = {};
    for (const actor of [bob, carol, dan, aliceReadOnly]) {
      const session = sessionFor(actor);
      const report = await session.refreshTools();
      session.close();
      assert.equal(report.errorMessage, undefined, `${actor.label}: ${report.errorMessage}`);
      assert.ok(report.routed.every((name) => expected.members.includes(name)), `${actor.label}: discovery widened beyond the classified set`);
      discovery[`${actor.label} (${actor.claims.scope}, roles ${JSON.stringify(actor.claims.roles)})`] = report.routed;
    }
    evidence.discoveryByPrincipal = discovery;
    const anonymous = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call",
        params: { name: "honua_studio_create_draft", arguments: { packageKey: "anonymous", family: "map", schemaVersion: "1.0" } } }),
    });
    const anonymousBody = parseBody(await anonymous.text());
    evidence.anonymousInvoke = { http: anonymous.status, error: anonymousBody?.error, isError: anonymousBody?.result?.isError };
    assert.ok(anonymous.status >= 400 || anonymousBody?.error || anonymousBody?.result?.isError, "anonymous create_draft was accepted");

    const draft = aliceLifecycle.reopened;
    const packageKey = aliceLifecycle.packageKey;
    const before = sql(`SELECT generation || '|' || owner_id FROM honua.studio_package_drafts WHERE draft_id = '${draft.draftId}'`);
    const client = (actor) => mcpClientFor(actor, { view: HONUA_STUDIO_TOOL_SETUP_VIEW });
    const outcomes = {
      otherOwnerRead: await attempt(client(bob), "honua_studio_get_draft", { draftId: draft.draftId }),
      otherOwnerUpdate: await attempt(client(bob), "honua_studio_update_draft",
        { draftId: draft.draftId, generation: draft.generation, packageKey, schemaVersion: "1.0", body: initialBody(packageKey) }),
      otherOwnerSave: await attempt(client(bob), "honua_studio_save_version", { draftId: draft.draftId, generation: draft.generation }),
      readOnlyScopeUpdate: await attempt(client(aliceReadOnly), "honua_studio_update_draft",
        { draftId: draft.draftId, generation: draft.generation, packageKey, schemaVersion: "1.0", body: initialBody(packageKey) }),
      noGrantCreate: await attempt(client(carol), "honua_studio_create_draft",
        { packageKey: `sdk1397-carol-${run}`, family: "map", schemaVersion: "1.0", body: initialBody(`sdk1397-carol-${run}`) }),
    };
    for (const label of ["otherOwnerRead", "otherOwnerUpdate", "otherOwnerSave", "readOnlyScopeUpdate", "noGrantCreate"]) {
      assertDenied(outcomes[label], label);
    }

    const danClient = client(dan);
    const danKey = `sdk1397-dan-${run}`;
    const danCreated = await attempt(danClient, "honua_studio_create_draft",
      { packageKey: danKey, family: "map", schemaVersion: "1.0", body: initialBody(danKey) });
    assert.ok(danCreated.ok, `a principal holding StudioDraft Create could not create its own draft: ${JSON.stringify(danCreated.error)}`);
    const danSaved = await attempt(danClient, "honua_studio_save_version",
      { draftId: danCreated.structured.draftId, generation: danCreated.structured.generation });
    assert.ok(danSaved.ok, `owner save failed: ${JSON.stringify(danSaved.error)}`);
    outcomes.noPublishGrantPropose = await attempt(danClient, "honua_studio_propose_publication", {
      itemId: danSaved.structured.version.itemId,
      versionId: danSaved.structured.version.versionId,
      contentHash: danSaved.structured.version.contentHash,
      route: `/studio/${danKey}`,
      visibility: "personal",
    });
    assertDenied(outcomes.noPublishGrantPropose, "noPublishGrantPropose");

    const bobPoll = await rawMcp(bob, "resources/read", { uri: aliceLifecycle.proposed.proposalUri });
    outcomes.otherPrincipalProposalPoll = { http: bobPoll.http, error: bobPoll.body?.error, contents: bobPoll.body?.result?.contents?.length };
    assert.ok(bobPoll.body?.error && !bobPoll.body?.result, "another principal read the owner's publication proposal");

    for (const [label, outcome] of Object.entries(outcomes)) {
      assert.doesNotMatch(JSON.stringify(outcome), /Honolulu places/, `${label}: denial disclosed draft content`);
    }

    const after = sql(`SELECT generation || '|' || owner_id FROM honua.studio_package_drafts WHERE draft_id = '${draft.draftId}'`);
    assert.equal(after, before, "denied calls changed the durable draft");
    evidence.outcomes = outcomes;
    evidence.durableDraft = { before, after };
  });

  const acceptance = receipt.checks.filter((entry) => entry.criterion.startsWith("AC"));
  receipt.status = acceptance.every((entry) => entry.verdict === "pass") ? "passed" : "failed";
  receipt.findings = receipt.checks.filter((entry) => !entry.criterion.startsWith("AC") && entry.verdict === "fail").map((entry) => entry.id);
} catch (error) {
  receipt.status = "failed";
  receipt.diagnostic = redact(error?.stack ?? error);
} finally {
  if (receipt.status !== "passed") {
    receipt.serverLogs = {};
    for (const name of containers) {
      if (name.includes("-server-")) receipt.serverLogs[name] = logsOf(name).slice(-8_000);
    }
  }
  for (const name of containers) exec("docker", ["rm", "-f", name], { allowFailure: true, timeout: 60_000 });
  exec("docker", ["network", "rm", network], { allowFailure: true });
  exec("docker", ["volume", "rm", keyringVolume], { allowFailure: true });
  await rm(work, { recursive: true, force: true });
  await writeFile(outFile, redact(JSON.stringify(receipt, null, 2)) + "\n");
  console.log(JSON.stringify({ status: receipt.status, findings: receipt.findings, checks: receipt.checks.map(({ id, verdict }) => ({ id, verdict })), diagnostic: receipt.diagnostic }, null, 2));
  process.exitCode = receipt.status === "passed" ? 0 : 1;
}
