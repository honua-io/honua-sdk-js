#!/usr/bin/env node
// Portable map artifact lifecycle receipt against the exact candidate (#1426).
//
// Drives one canonical honua_map_package.v1 fixture through the governed
// lifecycle on a deployment made by scripts/map-artifact-candidate-deployment.sh,
// using only installed client bytes:
//
//   terminal  @honua/sdk-js McpClient from an isolated registry install (MCP)
//   JS        @honua/sdk-js HonuaStudioLifecycleClient from the same install
//   CLI       the installed `honua` binary
//   Studio    honua-studio's own StudioLifecycleClient at a pinned revision
//
// Every check asserts values computed here, independently of the server:
// fixture ordinates, zoom, style references, generations, pointer identities,
// principal separation and rendered pixels. A failed check is recorded with its
// diagnostic and the run continues where later checks do not depend on it; the
// receipt verdict is `qualified` only when every check passes.
//
// usage: node scripts/map-artifact-lifecycle-receipt.mjs \
//          --descriptor <deployment.json> --signing-key-file <file> \
//          --consumer <installed consumer dir> --studio-client <dir> --studio-revision <sha40> \
//          --output test-results/<name>.json
import assert from "node:assert/strict";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { countInkPixels, decodePng } from "./lib/png-pixels.mjs";
import { renderMapStyle } from "./lib/render-map-artifact.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, index, all) => {
  if (value.startsWith("--")) pairs.push([value.slice(2), all[index + 1]]);
  return pairs;
}, []));
for (const required of ["descriptor", "signing-key-file", "consumer", "studio-client", "studio-revision", "output"]) {
  assert.ok(args[required], `--${required} is required`);
}
const output = resolve(args.output);
assert.ok(!relative(repoRoot, output).startsWith(".."), "--output must stay inside the repository");
assert.match(args["studio-revision"], /^[0-9a-f]{40}$/, "--studio-revision must be a 40-character commit SHA");

const descriptor = JSON.parse(readFileSync(args.descriptor, "utf8"));
const baseUrl = descriptor.baseUrl;
const signingKey = readFileSync(args["signing-key-file"], "utf8").trim();
const adminKey = readFileSync(descriptor.adminKeyFile, "utf8").trim();
const consumer = resolve(args.consumer);
const consumerRequire = createRequire(join(consumer, "package.json"));
const installed = async (specifier) => import(pathToFileURL(consumerRequire.resolve(specifier)).href);
const { McpClient } = await installed("@honua/sdk-js/studio-agent");
const { createHonuaStudioLifecycleClient } = await installed("@honua/sdk-js/studio");
const { HonuaClient } = await installed("@honua/sdk-js");
const { validateMapPackage, exportMapPackage, importMapPackage, applyStyleRefs } = await installed("@honua/sdk-js/runtime");
// playwright-core is CommonJS; its ESM namespace carries the API on `default`.
const playwrightModule = await installed("playwright-core");
const playwright = playwrightModule.chromium ? playwrightModule : playwrightModule.default;
const { StudioLifecycleClient } = await import(pathToFileURL(join(resolve(args["studio-client"]), "lifecycle-client.ts")).href);

const redactions = [signingKey, adminKey];
const redact = (value) => redactions.reduce((text, secret) => text.replaceAll(secret, "[redacted]"), String(value));
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
/** Key-sorted JSON: the versioned canonical projection two clients are compared through. */
const canonical = (value) => JSON.stringify(value, (_key, inner) => inner && typeof inner === "object" && !Array.isArray(inner)
  ? Object.fromEntries(Object.entries(inner).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
  : inner);

// ---------------------------------------------------------------------------
// Principals: one static-key issuer, distinct subjects, tenants and scopes.
// ---------------------------------------------------------------------------
const FULL_SCOPES = "honua.mcp.discover honua.mcp.read honua.mcp.create honua.mcp.update honua.mcp.publish honua.mcp.rollback";
const PRINCIPALS = {
  author: { sub: "map-author", roles: ["admin"], tenant: "public", scope: FULL_SCOPES },
  approver: { sub: "map-approver", roles: ["admin"], tenant: "public", scope: FULL_SCOPES },
  // Same subject as the author but a token without the publish scope.
  narrowedAuthor: { sub: "map-author", roles: ["admin"], tenant: "public", scope: "honua.mcp.discover honua.mcp.read honua.mcp.create honua.mcp.update" },
  // A tenant member with no administrative role.
  viewer: { sub: "map-viewer", roles: [], tenant: "public", scope: "honua.mcp.discover honua.mcp.read" },
  // An administrator of a different tenant.
  foreignAdmin: { sub: "map-foreign-admin", roles: ["admin"], tenant: "tenant-b", scope: FULL_SCOPES },
};
const tokens = new Map();
function tokenFor(name) {
  if (!tokens.has(name)) {
    const { sub, roles, tenant, scope } = PRINCIPALS[name];
    const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const now = Math.floor(Date.now() / 1000);
    const unsigned = `${encode({ alg: "HS256", typ: "JWT" })}.${encode({
      iss: descriptor.issuer, aud: descriptor.audience, sub, name: sub, jti: randomUUID(),
      iat: now, nbf: now, exp: now + 1800, roles, tenant_id: tenant, scope,
    })}`;
    const token = `${unsigned}.${createHmac("sha256", signingKey).update(unsigned).digest("base64url")}`;
    tokens.set(name, token);
    redactions.push(token);
  }
  return tokens.get(name);
}
const bearerFetch = (name) => (url, init = {}) => fetch(url, {
  ...init, headers: { ...Object.fromEntries(new Headers(init.headers)), authorization: `Bearer ${tokenFor(name)}` },
});
const mcpFor = (name) => new McpClient({ baseUrl, apiPath: "", fetchImpl: bearerFetch(name) });
const sdkFor = (name) => createHonuaStudioLifecycleClient({ client: new HonuaClient({ baseUrl, bearerToken: tokenFor(name) }) });
// Studio's client appends `/v1/studio` to its base, which defaults to the same-origin `/api`.
const studioFor = (name) => new StudioLifecycleClient({ baseUrl: `${baseUrl}/api`, auth: { getAccessToken: async () => tokenFor(name) } });
async function rest(name, method, path, body) {
  const response = await bearerFetch(name)(`${baseUrl}${path}`, {
    method, headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(90_000),
  });
  const bytes = Buffer.from(await response.arrayBuffer());
  const text = bytes.toString("utf8");
  let json;
  try { json = JSON.parse(text); } catch { json = undefined; }
  return { status: response.status, bytes, text, json };
}
async function tool(client, name, argumentsValue) {
  let result;
  try {
    result = await client.callTool(name, argumentsValue);
  } catch (error) {
    // The installed McpClient raises a tool-level refusal as McpToolError;
    // transport failures keep propagating.
    if (error?.name !== "McpToolError") throw error;
    return { isError: true, content: undefined, text: redact(error.message) };
  }
  return { isError: result.isError === true, content: result.structuredContent, text: result.content?.map((part) => part.text).join("\n") };
}
async function rejects(promise) {
  try {
    const value = await promise;
    return { rejected: false, value };
  } catch (error) {
    return { rejected: true, message: redact(error.message), status: error.status ?? error.response?.status };
  }
}

// ---------------------------------------------------------------------------
// Receipt bookkeeping.
// ---------------------------------------------------------------------------
const receipt = {
  schema: "honua.map-artifact-lifecycle-receipt/v1",
  issue: "honua-io/honua-sdk-js#1426",
  generatedAt: new Date().toISOString(),
  candidate: {
    image: descriptor.image, digest: descriptor.digest, revision: descriptor.revision,
    imageRevisionLabel: descriptor.imageRevisionLabel, deploymentFingerprint: descriptor.fingerprint,
    defaultsChanged: descriptor.defaultsChanged,
  },
  clients: {},
  checks: [],
  findings: [],
};
const state = {};
async function check(id, criterion, body, { requires = [] } = {}) {
  const missing = requires.filter((key) => state[key] === undefined);
  if (missing.length > 0) {
    receipt.checks.push({ id, criterion, verdict: "blocked", diagnostic: `prerequisite(s) not established: ${missing.join(", ")}` });
    return;
  }
  const evidence = {};
  try {
    await body(evidence);
    receipt.checks.push({ id, criterion, verdict: "pass", evidence });
  } catch (error) {
    receipt.checks.push({ id, criterion, verdict: "fail", evidence, diagnostic: redact(error.stack ?? error.message) });
  }
}

// ---------------------------------------------------------------------------
// Independent expectations.
// ---------------------------------------------------------------------------
const fixturePath = join(repoRoot, "test/fixtures/map-artifact/honolulu-places.map-package.v1.json");
const fixtureBytes = readFileSync(fixturePath);
const fixture = JSON.parse(fixtureBytes.toString("utf8"));
const runKey = `map-artifact-${randomUUID().slice(0, 8)}`;
const EXPECTED = {
  layer: { id: "places", type: "circle", sourceId: "places", title: "Honolulu places" },
  styleRef: "places-status",
  restyleRef: "places-status-dark",
  view: { center: [-157.8583, 21.3069], zoom: 9, crs: "EPSG:4326" },
  route: `/maps/${runKey}`,
  visibility: "public",
};

// ---------------------------------------------------------------------------
// Client identity.
// ---------------------------------------------------------------------------
await check("installed-client-identity", "AC5", async (evidence) => {
  const lock = JSON.parse(readFileSync(join(consumer, "package-lock.json"), "utf8"));
  const entry = lock.packages["node_modules/@honua/sdk-js"];
  assert.ok(entry?.resolved?.startsWith("https://registry.npmjs.org/"), "the SDK must come from the registry, not a workspace or tarball");
  assert.match(entry.integrity, /^sha512-/);
  const studioFiles = ["lifecycle-client.ts", "lifecycle-errors.ts", "lifecycle-types.ts"].map((file) => ({
    file: `src/lifecycle/${file}`, sha256: sha256(readFileSync(join(resolve(args["studio-client"]), file))),
  }));
  const cli = spawnSync(join(consumer, "node_modules/.bin/honua"), ["--help"], { encoding: "utf8", timeout: 30_000 });
  assert.equal(cli.status, 0, "the installed honua CLI must run");
  receipt.clients = {
    sdk: { package: "@honua/sdk-js", version: entry.version, integrity: entry.integrity, resolved: entry.resolved },
    cli: { bin: "honua", package: "@honua/sdk-js", version: entry.version },
    studio: { repository: "honua-io/honua-studio", revision: args["studio-revision"], files: studioFiles,
      note: "self-hosted Studio's lifecycle client module, loaded with Node type stripping; the Studio bundle itself is not an npm artifact" },
    node: process.version,
  };
  Object.assign(evidence, receipt.clients);
});

await check("candidate-readiness", "AC5", async (evidence) => {
  const ready = await fetch(`${baseUrl}/healthz/ready`, { signal: AbortSignal.timeout(10_000) });
  assert.equal(ready.status, 200);
  assert.equal(descriptor.imageRevisionLabel, descriptor.revision);
  evidence.ready = ready.status;
});

// ---------------------------------------------------------------------------
// Portable artifact (installed SDK, no server).
// ---------------------------------------------------------------------------
await check("portable-fixture-valid-and-export-roundtrip", "AC2", async (evidence) => {
  const validation = validateMapPackage(fixture);
  assert.equal(validation.valid, true, JSON.stringify(validation.diagnostics));
  const exported = exportMapPackage(fixture);
  const imported = importMapPackage(JSON.parse(JSON.stringify(exported)));
  assert.equal(canonical(imported.mapPackage), canonical(fixture));
  assert.equal(exportMapPackage(fixture).fingerprint, exported.fingerprint, "export fingerprint must be deterministic");
  evidence.fixtureSha256 = sha256(fixtureBytes);
  evidence.exportFingerprint = exported.fingerprint;
  state.fixtureValid = true;
});

// ---------------------------------------------------------------------------
// Terminal: create, style, view, concurrency, validate, preview.
// ---------------------------------------------------------------------------
const author = mcpFor("author");
await check("server-accepts-sdk-canonical-artifact", "AC2", async (evidence) => {
  // The SDK's own canonical showcase artifact, valid against
  // schemas/honua-map-package.v1.json, must be admissible as a map draft body.
  const showcase = JSON.parse(readFileSync(join(repoRoot, "examples/runtime-parity-showcase/fixtures/map-package.json"), "utf8"));
  assert.equal(validateMapPackage(showcase).valid, true);
  const created = await tool(author, "honua_studio_create_draft", { packageKey: `${runKey}-showcase`, family: "map", schemaVersion: "1.0", body: showcase });
  assert.equal(created.isError, false, created.text);
  evidence.validation = created.content.validation;
  assert.equal(created.content.validation.status, "valid", `the server rejects the SDK canonical artifact: ${JSON.stringify(created.content.validation.diagnostics)}`);
}, { requires: ["fixtureValid"] });

await check("terminal-create-draft", "AC1", async (evidence) => {
  const created = await tool(author, "honua_studio_create_draft", { packageKey: runKey, family: "map", schemaVersion: "1.0", body: fixture });
  assert.equal(created.isError, false, created.text);
  const draft = created.content;
  assert.equal(draft.family, "map");
  assert.equal(draft.generation, 1);
  assert.equal(draft.validation.status, "valid", JSON.stringify(draft.validation.diagnostics));
  assert.equal(canonical(draft.envelope.body), canonical(fixture), "the server must persist the portable body unchanged");
  assert.match(draft.operation.auditId, /\S/);
  assert.match(draft.operation.correlationId, /\S/);
  assert.equal(draft.operation.tenantId, "public");
  assert.equal(draft.ownerId, draft.createdBy);
  evidence.generation = draft.generation;
  evidence.ownerBinding = draft.ownerId.replace(descriptor.issuer, "<issuer>").replace(encodeURIComponent(descriptor.issuer), "<issuer>");
  state.draftId = draft.draftId;
  state.itemId = draft.itemId;
  state.generation = draft.generation;
}, { requires: ["fixtureValid"] });

await check("terminal-style-and-view", "AC1", async (evidence) => {
  let result = await tool(author, "honua_studio_add_layer", { draftId: state.draftId, generation: state.generation, layer: EXPECTED.layer });
  assert.equal(result.isError, false, result.text);
  assert.equal(result.content.generation, state.generation + 1);
  result = await tool(author, "honua_studio_set_layer_style", { draftId: state.draftId, generation: result.content.generation, layerId: "places", styleRef: EXPECTED.styleRef });
  assert.equal(result.isError, false, result.text);
  result = await tool(author, "honua_studio_set_view", { draftId: state.draftId, generation: result.content.generation, view: EXPECTED.view });
  assert.equal(result.isError, false, result.text);
  const body = result.content.envelope.body;
  assert.equal(result.content.generation, 4);
  assert.deepEqual(body.layers.find((layer) => layer.id === "places"), { ...EXPECTED.layer, visible: true, styleRef: EXPECTED.styleRef });
  assert.deepEqual(body.view, EXPECTED.view);
  assert.equal(result.content.validation.status, "valid", JSON.stringify(result.content.validation.diagnostics));
  // Everything the fixture carried survives composition untouched.
  const { layers: _layers, view: _view, ...rest } = body;
  const { layers: _fixtureLayers, view: _fixtureView, ...fixtureRest } = fixture;
  assert.equal(canonical(rest), canonical(fixtureRest));
  evidence.generation = result.content.generation;
  evidence.view = body.view;
  evidence.layer = body.layers.find((layer) => layer.id === "places");
  state.generation = result.content.generation;
  state.composedBody = body;
}, { requires: ["draftId"] });

await check("terminal-stale-generation-fails-closed", "AC4", async (evidence) => {
  const stale = await tool(author, "honua_studio_set_view", { draftId: state.draftId, generation: state.generation - 1, view: { ...EXPECTED.view, zoom: 3 } });
  assert.equal(stale.isError, true, "a stale generation must be refused");
  const current = await tool(author, "honua_studio_get_draft", { draftId: state.draftId });
  assert.equal(current.isError, false, current.text);
  assert.equal(current.content.generation, state.generation);
  assert.deepEqual(current.content.envelope.body.view, EXPECTED.view);
  evidence.refusal = stale.text?.slice(0, 300);
}, { requires: ["composedBody"] });

async function itemPointers(name) {
  const response = await rest(name, "GET", `/api/v1/studio/content-items?limit=100&searchTerm=${encodeURIComponent(runKey)}`);
  assert.equal(response.status, 200, response.text.slice(0, 300));
  return response.json.data.items.find((item) => item.itemId === state.itemId);
}

await check("terminal-validate-and-preview-is-not-persisted", "AC1 AC3", async (evidence) => {
  const validation = await tool(author, "honua_studio_validate_draft", { draftId: state.draftId });
  assert.equal(validation.isError, false, validation.text);
  assert.equal(validation.content.status, "valid");
  const preview = await tool(author, "honua_studio_preview_draft", { draftId: state.draftId });
  assert.equal(preview.isError, false, preview.text);
  for (const field of ["versionId", "contentHash", "publicationUrl", "activeUrl", "publishedVersionId", "proposalId"]) {
    assert.equal(field in preview.content, false, `a preview must not carry ${field}`);
  }
  const item = await itemPointers("author");
  assert.equal(item?.publishedVersionId ?? null, null, "preview must not publish");
  assert.equal(item?.currentVersionId ?? null, null, "preview must not persist a version");
  evidence.preview = preview.content;
  evidence.itemState = item?.state ?? "(not listed before first save)";
}, { requires: ["composedBody"] });

// ---------------------------------------------------------------------------
// Save, pixels, immutability, reopen.
// ---------------------------------------------------------------------------
await check("terminal-save-immutable-version", "AC1", async (evidence) => {
  const saved = await tool(author, "honua_studio_save_version", { draftId: state.draftId, generation: state.generation });
  assert.equal(saved.isError, false, saved.text);
  const version = saved.content.version;
  assert.equal(version.versionNumber, 1);
  assert.match(version.contentHash, /^[0-9a-f]{64}$/);
  assert.equal(canonical(version.envelope.body), canonical(state.composedBody));
  assert.equal(saved.content.operation.status, "Completed");
  const item = await itemPointers("author");
  assert.equal(item.currentVersionId, version.versionId);
  assert.equal(item.publishedVersionId ?? null, null, "saving must not publish");
  evidence.versionNumber = version.versionNumber;
  evidence.itemState = item.state;
  state.v1 = { versionId: version.versionId, contentHash: version.contentHash, body: version.envelope.body };
}, { requires: ["composedBody"] });

await check("rendered-pixels-of-saved-version", "AC1", async (evidence) => {
  const response = await rest("author", "POST", `/api/v1/studio/map/${state.itemId}/export?format=png&versionId=${state.v1.versionId}`);
  assert.equal(response.status, 200, response.text.slice(0, 300));
  const png = decodePng(response.bytes);
  const page = countInkPixels(png);
  // The page chrome is two hairline rules; a rendered map frame with the
  // fixture's features and the styled circle layer must add ink beyond them.
  const body = countInkPixels(png, { box: [0, Math.round(png.height * 0.12), png.width, Math.round(png.height * 0.95)] });
  evidence.png = { width: png.width, height: png.height, sha256: sha256(response.bytes), pageInk: page.ink, bodyInk: body.ink, dominant: body.dominant };
  writeFileSync(output.replace(/\.json$/, ".saved-version.png"), response.bytes);
  assert.ok(body.ink > 500, `the exported map page body has ${body.ink} non-background pixels; the map, its features and style did not render`);
}, { requires: ["v1"] });

/** The saved body rendered through the installed SDK's style composition and MapLibre. */
async function renderSavedBody(body, label) {
  const binding = body.layers.find((layer) => layer.id === EXPECTED.layer.id)?.styleRef;
  const bound = body.styleRefs.find((ref) => ref.styleId === binding);
  assert.ok(bound, `composition layer ${EXPECTED.layer.id} must bind one of the artifact's styleRefs (bound: ${binding})`);
  const style = await applyStyleRefs(structuredClone(body.mapSpec), { ...body, styleRefs: [bound] });
  const { png, renderer, maplibreVersion } = await renderMapStyle({
    playwright, maplibreDistDir: join(dirname(consumerRequire.resolve("maplibre-gl/package.json")), "dist"),
    style, center: body.view.center, zoom: body.view.zoom,
  });
  writeFileSync(output.replace(/\.json$/, `.${label}.png`), png);
  return { raster: decodePng(png), bound, renderer, maplibreVersion, pngSha256: sha256(png) };
}
const hex = (value) => [1, 3, 5].map((offset) => Number.parseInt(value.slice(offset, offset + 2), 16));
function pixelAt({ width, rgba }, x, y) {
  const i = (y * width + x) * 4;
  return [rgba[i], rgba[i + 1], rgba[i + 2], rgba[i + 3]];
}
const near = (actual, expected, tolerance = 6) => expected.every((channel, index) => Math.abs(actual[index] - channel) <= tolerance);

await check("renderer-pixels-of-saved-artifact", "AC1", async (evidence) => {
  const { raster, bound, renderer, maplibreVersion, pngSha256 } = await renderSavedBody(state.v1.body, "saved-version.maplibre");
  // Independent oracle: the view centres the only feature, so the centre pixel
  // is the bound style's circle fill; the corners are outside the 12 px circle.
  const expectedFill = hex(bound.body[EXPECTED.layer.id].paint["circle-color"]);
  const centre = pixelAt(raster, raster.width >> 1, raster.height >> 1);
  const corner = pixelAt(raster, 4, 4);
  const ink = countInkPixels(raster, { background: [255, 255, 255] });
  evidence.renderer = renderer;
  evidence.maplibreVersion = maplibreVersion;
  evidence.pngSha256 = pngSha256;
  evidence.boundStyle = bound.styleId;
  evidence.centre = centre;
  evidence.expectedFill = expectedFill;
  evidence.corner = corner;
  evidence.inkPixels = ink.ink;
  assert.ok(near(centre, expectedFill), `centre pixel ${centre} is not the bound circle-color ${expectedFill}`);
  assert.equal(near(corner, expectedFill), false, "the corner must not carry the feature fill");
  // A 12 px radius circle (plus stroke) covers roughly pi * 14^2 pixels.
  assert.ok(ink.ink > 300 && ink.ink < 2000, `ink ${ink.ink} is not one styled point`);
  state.v1Render = { centre };
}, { requires: ["v1"] });

await check("saved-version-is-immutable", "AC1", async (evidence) => {
  const draft = await tool(author, "honua_studio_get_draft", { draftId: state.draftId });
  assert.equal(draft.isError, false, draft.text);
  const edit = await tool(author, "honua_studio_set_layer_visibility", { draftId: state.draftId, generation: draft.content.generation, layerId: "places", visible: false });
  assert.equal(edit.isError, false, edit.text);
  assert.equal(edit.content.envelope.body.layers.find((layer) => layer.id === "places").visible, false);
  evidence.draftEditedAfterSave = `generation ${draft.content.generation} -> ${edit.content.generation}`;
  const version = await rest("author", "GET", `/api/v1/studio/content-items/${state.itemId}/versions/${state.v1.versionId}`);
  assert.equal(version.status, 200, version.text.slice(0, 300));
  assert.equal(version.json.data.contentHash, state.v1.contentHash);
  assert.equal(canonical(version.json.data.envelope.body), canonical(state.v1.body));
}, { requires: ["v1"] });

await check("terminal-reopen-version", "AC1", async (evidence) => {
  const reopened = await tool(author, "honua_studio_reopen_version", { itemId: state.itemId, versionId: state.v1.versionId });
  assert.equal(reopened.isError, false, reopened.text);
  assert.equal(reopened.content.baseVersionId, state.v1.versionId);
  assert.equal(reopened.content.generation, 1);
  assert.notEqual(reopened.content.draftId, state.draftId);
  assert.equal(canonical(reopened.content.envelope.body), canonical(state.v1.body));
  evidence.baseVersionBound = true;
  state.reopenedDraftId = reopened.content.draftId;
}, { requires: ["v1"] });

// ---------------------------------------------------------------------------
// Cross-client round trip of the same saved version.
// ---------------------------------------------------------------------------
await check("js-sdk-reads-same-version", "AC2", async (evidence) => {
  const version = await sdkFor("author").contentVersions.get(state.itemId, state.v1.versionId);
  assert.equal(version.contentHash, state.v1.contentHash);
  assert.equal(canonical(version.envelope.body), canonical(state.v1.body));
  evidence.canonicalBodySha256 = sha256(canonical(version.envelope.body));
  state.jsCanonical = evidence.canonicalBodySha256;
}, { requires: ["v1"] });

await check("studio-client-reads-and-reopens-same-version", "AC2", async (evidence) => {
  const studio = studioFor("author");
  const version = await studio.getVersion(state.itemId, state.v1.versionId);
  assert.equal(version.contentHash, state.v1.contentHash);
  assert.equal(canonical(version.envelope.body), canonical(state.v1.body));
  const reopened = await studio.reopenVersion(state.itemId, state.v1.versionId);
  assert.equal(reopened.baseVersionId, state.v1.versionId);
  assert.equal(canonical(reopened.envelope.body), canonical(state.v1.body));
  evidence.canonicalBodySha256 = sha256(canonical(version.envelope.body));
  assert.equal(evidence.canonicalBodySha256, state.jsCanonical);
}, { requires: ["v1", "jsCanonical"] });

await check("mcp-js-studio-byte-identical-version-payload", "AC2", async (evidence) => {
  const viaJs = await rest("author", "GET", `/api/v1/studio/content-items/${state.itemId}/versions/${state.v1.versionId}`);
  const viaStudio = await studioFor("author").getVersion(state.itemId, state.v1.versionId);
  const serverBody = JSON.stringify(viaJs.json.data.envelope.body);
  assert.equal(JSON.stringify(viaStudio.envelope.body), serverBody, "Studio must see the exact server bytes of the body");
  assert.equal(JSON.stringify(state.v1.body), serverBody, "MCP save must return the exact server bytes of the body");
  evidence.bodyBytesSha256 = sha256(serverBody);
}, { requires: ["v1"] });

await check("cli-publishes-portable-artifact", "AC2", async (evidence) => {
  const packageFile = join(mkdtempSync(join(tmpdir(), "map-artifact-cli-")), "package.json");
  writeFileSync(packageFile, JSON.stringify(state.v1.body));
  const env = { ...process.env, HONUA_BASE_URL: baseUrl, HONUA_API_KEY: adminKey, HONUA_CONFIG_HOME: dirname(packageFile) };
  const run = spawnSync(join(consumer, "node_modules/.bin/honua"), ["map", "publish", runKey, "--package", `@${packageFile}`, "--yes", "--json"],
    { encoding: "utf8", timeout: 60_000, env });
  evidence.exitCode = run.status;
  evidence.output = redact(`${run.stdout}${run.stderr}`).slice(0, 600);
  evidence.lifecycleVerbs = "the installed CLI has no Studio draft/version/proposal verbs; `map publish` targets the control-plane package API";
  assert.equal(run.status, 0, "the installed CLI must publish the saved portable artifact");
  assert.doesNotMatch(evidence.output, /failed with HTTP/);
}, { requires: ["v1"] });

// ---------------------------------------------------------------------------
// Governed publication: proposal, negatives, approval, final URL.
// ---------------------------------------------------------------------------
await check("proposal-negatives-fail-closed", "AC4", async (evidence) => {
  const wrongHash = await tool(author, "honua_studio_propose_publication", { itemId: state.itemId, versionId: state.v1.versionId, contentHash: "0".repeat(64), route: EXPECTED.route, visibility: EXPECTED.visibility });
  assert.equal(wrongHash.isError, true, "a mismatched content hash must be refused");
  const narrowed = await tool(mcpFor("narrowedAuthor"), "honua_studio_propose_publication", { itemId: state.itemId, versionId: state.v1.versionId, contentHash: state.v1.contentHash, route: EXPECTED.route, visibility: EXPECTED.visibility });
  assert.equal(narrowed.isError, true, "a token without the publish scope must be refused");
  const foreign = await tool(mcpFor("foreignAdmin"), "honua_studio_propose_publication", { itemId: state.itemId, versionId: state.v1.versionId, contentHash: state.v1.contentHash, route: EXPECTED.route, visibility: EXPECTED.visibility });
  assert.equal(foreign.isError, true, "another tenant's administrator must not propose this item");
  const item = await itemPointers("author");
  assert.equal(item.publishedVersionId ?? null, null);
  evidence.wrongHash = wrongHash.text?.slice(0, 200);
  evidence.narrowedScope = narrowed.text?.slice(0, 200);
  evidence.foreignTenant = foreign.text?.slice(0, 200);
}, { requires: ["v1"] });

await check("terminal-proposes-publication", "AC1 AC3", async (evidence) => {
  const proposed = await tool(author, "honua_studio_propose_publication", { itemId: state.itemId, versionId: state.v1.versionId, contentHash: state.v1.contentHash, route: EXPECTED.route, visibility: EXPECTED.visibility, note: "#1426 candidate receipt" });
  assert.equal(proposed.isError, false, proposed.text);
  const p = proposed.content;
  assert.equal(p.status, "AwaitingApproval");
  assert.equal(p.humanConfirmationRequired, true);
  assert.equal(p.operation.status, "RequiresApproval");
  for (const field of ["proposalId", "operationInstanceId", "auditId", "correlationId", "proposalUri"]) assert.match(String(p[field]), /\S/, field);
  for (const field of ["publicationUrl", "activeUrl"]) assert.equal(field in p, false, `a proposal must not carry ${field}`);
  const item = await itemPointers("author");
  assert.equal(item.publishedVersionId ?? null, null, "a proposal must not be reported as published");
  evidence.status = p.status;
  state.proposal = { proposalId: p.proposalId, operationInstanceId: p.operationInstanceId };
}, { requires: ["v1"] });

await check("approval-negatives-fail-closed", "AC4", async (evidence) => {
  // A dedicated item and proposal: if the candidate wrongly accepts a refused
  // approval, it must not consume the proposal the positive path approves.
  const key = `${runKey}-negatives`;
  const created = await tool(author, "honua_studio_create_draft", { packageKey: key, family: "map", schemaVersion: "1.0", body: fixture });
  assert.equal(created.isError, false, created.text);
  const saved = await tool(author, "honua_studio_save_version", { draftId: created.content.draftId, generation: created.content.generation });
  assert.equal(saved.isError, false, saved.text);
  const proposed = await tool(author, "honua_studio_propose_publication", { itemId: saved.content.version.itemId, versionId: saved.content.version.versionId, contentHash: saved.content.version.contentHash, route: `/maps/${key}`, visibility: EXPECTED.visibility });
  assert.equal(proposed.isError, false, proposed.text);
  const negativeItemId = saved.content.version.itemId;
  const path = `/api/v1/admin/proposals/${proposed.content.proposalId}/approve`;
  // Non-requester refusals first, so a wrongly accepted self-approval cannot
  // mask them by resolving the proposal.
  const viewer = await rest("viewer", "POST", path, {});
  const foreign = await rest("foreignAdmin", "POST", path, {});
  const self = await rest("author", "POST", path, {});
  const listed = await rest("author", "GET", `/api/v1/studio/content-items?limit=100&searchTerm=${encodeURIComponent(key)}`);
  const item = listed.json?.data?.items?.find((candidate) => candidate.itemId === negativeItemId);
  evidence.statuses = { viewer: viewer.status, foreignTenant: foreign.status, self: self.status };
  evidence.selfOutcome = { status: self.json?.status, resolvedBy: self.json?.resolvedBy, detail: self.json?.detail };
  evidence.itemAfterRefusals = { state: item?.state, published: Boolean(item?.publishedVersionId) };
  assert.ok([401, 403].includes(viewer.status), `non-admin approval: ${viewer.status}`);
  assert.ok([403, 404].includes(foreign.status), `cross-tenant approval: ${foreign.status}`);
  assert.equal(self.status, 403, `self-approval must be refused; the candidate answered ${self.status} ${self.json?.status ?? ""} (honua-server#4901)`);
  assert.equal(item?.publishedVersionId ?? null, null, "refused approvals must not publish");
}, { requires: ["v1"] });

await check("separate-principal-approval-activates-publication", "AC1", async (evidence) => {
  const approved = await rest("approver", "POST", `/api/v1/admin/proposals/${state.proposal.proposalId}/approve`, {});
  assert.equal(approved.status, 200, approved.text.slice(0, 300));
  assert.equal(approved.json.status, "Succeeded");
  assert.equal(approved.json.resolvedBy, "map-approver");
  assert.match(approved.json.requestedBy, /:map-author@tenant:public$/);
  assert.ok(approved.json.diff.includes(`contentHash=${state.v1.contentHash}`));
  const item = await itemPointers("author");
  assert.equal(item.state, "published");
  assert.equal(item.publishedVersionId, state.v1.versionId);
  const handle = await rest("author", "GET", `/api/v1/operations/handles/${state.proposal.operationInstanceId}`);
  assert.equal(handle.status, 200, handle.text.slice(0, 300));
  assert.equal(handle.json.data.status, "Completed");
  assert.equal(handle.json.data.authorizationOutcome, "approved");
  assert.equal(handle.json.data.resourceIds.versionId, state.v1.versionId);
  assert.equal(handle.json.data.resourceIds.activeUrl, EXPECTED.route);
  const replay = await rest("approver", "POST", `/api/v1/admin/proposals/${state.proposal.proposalId}/approve`, {});
  assert.notEqual(replay.status, 200, "a resolved proposal must not be approved twice");
  evidence.itemState = item.state;
  evidence.activeUrl = handle.json.data.resourceIds.activeUrl;
  evidence.replayStatus = replay.status;
  state.activeUrl = handle.json.data.resourceIds.activeUrl;
}, { requires: ["proposal"] });

await check("final-governed-url-resolves", "AC1 AC5", async (evidence) => {
  const url = new URL(state.activeUrl, baseUrl).href;
  const anonymous = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  const authenticated = await bearerFetch("author")(url, { signal: AbortSignal.timeout(20_000) });
  evidence.finalUrl = state.activeUrl;
  evidence.statuses = { anonymous: anonymous.status, authenticated: authenticated.status };
  assert.ok(anonymous.ok || authenticated.ok, `the Active publication URL ${state.activeUrl} is not served (${anonymous.status}/${authenticated.status})`);
}, { requires: ["activeUrl"] });

await check("cross-tenant-reads-fail-closed", "AC4", async (evidence) => {
  const js = await rejects(sdkFor("foreignAdmin").contentVersions.get(state.itemId, state.v1.versionId));
  assert.equal(js.rejected, true, "another tenant must not read the version through the JS client");
  const studio = await rejects(studioFor("foreignAdmin").getVersion(state.itemId, state.v1.versionId));
  assert.equal(studio.rejected, true, "another tenant must not read the version through the Studio client");
  const mcp = await tool(mcpFor("foreignAdmin"), "honua_studio_get_draft", { draftId: state.reopenedDraftId ?? state.draftId });
  assert.equal(mcp.isError, true, "another tenant must not read the draft through MCP");
  evidence.js = js.message?.slice(0, 160);
  evidence.studio = studio.message?.slice(0, 160);
  evidence.mcp = mcp.text?.slice(0, 160);
}, { requires: ["v1"] });

// ---------------------------------------------------------------------------
// Supersede and roll back.
// ---------------------------------------------------------------------------
await check("supersede-then-rollback-restores-published-version", "AC4", async (evidence) => {
  const draft = await tool(author, "honua_studio_get_draft", { draftId: state.reopenedDraftId });
  assert.equal(draft.isError, false, draft.text);
  const restyled = await tool(author, "honua_studio_set_layer_style", { draftId: state.reopenedDraftId, generation: draft.content.generation, layerId: "places", styleRef: EXPECTED.restyleRef });
  assert.equal(restyled.isError, false, restyled.text);
  const saved = await tool(author, "honua_studio_save_version", { draftId: state.reopenedDraftId, generation: restyled.content.generation });
  assert.equal(saved.isError, false, saved.text);
  const v2 = saved.content.version;
  assert.equal(v2.versionNumber, 2);
  assert.notEqual(v2.contentHash, state.v1.contentHash);
  // The restyle must reach pixels: same feature, same view, the dark fill.
  const v2Render = await renderSavedBody(v2.envelope.body, "superseding-version.maplibre");
  const v2Centre = pixelAt(v2Render.raster, v2Render.raster.width >> 1, v2Render.raster.height >> 1);
  const darkFill = hex(v2Render.bound.body[EXPECTED.layer.id].paint["circle-color"]);
  assert.equal(v2Render.bound.styleId, EXPECTED.restyleRef);
  assert.ok(near(v2Centre, darkFill), `v2 centre pixel ${v2Centre} is not the restyled fill ${darkFill}`);
  if (state.v1Render) assert.equal(near(v2Centre, state.v1Render.centre), false, "restyling must change the rendered fill");
  evidence.v2Centre = v2Centre;
  const proposed = await tool(author, "honua_studio_propose_publication", { itemId: state.itemId, versionId: v2.versionId, contentHash: v2.contentHash, route: EXPECTED.route, visibility: EXPECTED.visibility });
  assert.equal(proposed.isError, false, proposed.text);
  const approved = await rest("approver", "POST", `/api/v1/admin/proposals/${proposed.content.proposalId}/approve`, {});
  assert.equal(approved.status, 200, approved.text.slice(0, 300));
  let item = await itemPointers("author");
  assert.equal(item.publishedVersionId, v2.versionId, "v2 supersedes v1");

  // Recorded now, asserted last: an accepted cross-tenant request must not hide
  // whether the owner's governed rollback restores the published pointer.
  const foreign = await rest("foreignAdmin", "POST", `/api/v1/studio/content-items/${state.itemId}/rollback-requests`, { targetVersionId: state.v1.versionId, pointer: "published", reason: "cross-tenant" });
  evidence.foreignRollback = { status: foreign.status, operationStatus: foreign.json?.status ?? foreign.json?.data?.status, proposalId: Boolean(foreign.json?.proposalId ?? foreign.json?.data?.proposalId) };
  item = await itemPointers("author");
  evidence.publishedAfterForeignRollback = item.publishedVersionId === v2.versionId ? "v2 (unchanged)" : "moved";
  const rollback = await rest("author", "POST", `/api/v1/studio/content-items/${state.itemId}/rollback-requests`, { targetVersionId: state.v1.versionId, pointer: "published", reason: "#1426 receipt rollback" });
  evidence.rollbackStatus = rollback.status;
  let proposalId = rollback.json?.proposalId ?? rollback.json?.operation?.proposalId ?? rollback.json?.data?.operation?.proposalId;
  if (rollback.status === 202 && !proposalId) proposalId = rollback.json?.data?.proposalId;
  if (proposalId) {
    const approvedRollback = await rest("approver", "POST", `/api/v1/admin/proposals/${proposalId}/approve`, {});
    assert.equal(approvedRollback.status, 200, approvedRollback.text.slice(0, 300));
    evidence.rollbackGoverned = true;
  } else {
    assert.ok([200, 201].includes(rollback.status), rollback.text.slice(0, 300));
    evidence.rollbackGoverned = false;
  }
  item = await itemPointers("author");
  const restored = item.publishedVersionId === state.v1.versionId;
  evidence.afterApprovedRollback = {
    published: restored ? "v1" : item.publishedVersionId === v2.versionId ? "v2" : "other",
    current: item.currentVersionId === state.v1.versionId ? "v1" : item.currentVersionId === v2.versionId ? "v2" : "other",
  };
  evidence.v2VersionNumber = v2.versionNumber;

  // Separation of duties on rollback: a second request, by the approver, that
  // the approver then tries to approve. It must be refused and move nothing.
  const second = await rest("approver", "POST", `/api/v1/studio/content-items/${state.itemId}/rollback-requests`, { targetVersionId: v2.versionId, pointer: "published", reason: "#1426 receipt self-approval probe" });
  const secondProposal = second.json?.proposalId ?? second.json?.operation?.proposalId ?? second.json?.data?.proposalId ?? second.json?.data?.operation?.proposalId;
  const selfRollback = secondProposal ? await rest("approver", "POST", `/api/v1/admin/proposals/${secondProposal}/approve`, {}) : undefined;
  item = await itemPointers("author");
  evidence.rollbackSelfApproval = {
    requestStatus: second.status, approveStatus: selfRollback?.status, approveOutcome: selfRollback?.json?.status,
    publishedAfterSelfApproval: item.publishedVersionId === state.v1.versionId ? "v1 (unchanged)" : item.publishedVersionId === v2.versionId ? "v2 (moved)" : "other",
  };

  assert.equal(restored, true, `an approved rollback (target published) must restore v1 as the published version; published is ${evidence.afterApprovedRollback.published}, current is ${evidence.afterApprovedRollback.current}`);
  assert.ok(secondProposal, `a rollback request must enter approval: ${second.status} ${second.text.slice(0, 200)}`);
  assert.equal(selfRollback.status, 403, `the rollback requester must not approve it; the candidate answered ${selfRollback.status} (honua-server#4901)`);
  assert.ok(foreign.status === 404 || foreign.status === 403, `cross-tenant rollback request must be refused; the candidate answered ${foreign.status} (honua-server#4905)`);
}, { requires: ["activeUrl", "reopenedDraftId"] });

await check("js-sdk-rollback-request-uses-server-contract", "AC2 AC4", async (evidence) => {
  // The installed client's own declared input type for a rollback request,
  // sent through its own method, against a published item of this run.
  const outcome = await rejects(sdkFor("author").rollbackRequests.create(state.itemId, {
    versionId: state.v1.versionId, pointer: "published", message: "#1426 installed JS client rollback",
  }));
  evidence.rejected = outcome.rejected;
  evidence.status = outcome.status;
  evidence.message = outcome.message?.slice(0, 240);
  evidence.declaredInput = "StudioRollbackRequestInput { versionId, pointer, message }";
  evidence.serverInput = "CreateStudioRollbackRequest { targetVersionId, pointer, reason }";
  assert.equal(outcome.rejected, false, `the installed JS client's declared rollback input is refused by the candidate: ${outcome.message}`);
}, { requires: ["activeUrl"] });

// ---------------------------------------------------------------------------
// Verdict and deterministic projection.
// ---------------------------------------------------------------------------
const volatile = /^(generatedAt|createdAt|updatedAt|resolvedAt|timestamp)$/;
const normalise = (value) => JSON.parse(JSON.stringify(value, (key, inner) => {
  if (volatile.test(key)) return "<time>";
  if (typeof inner !== "string") return inner;
  return inner
    .replaceAll(runKey, "<run>")
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "<uuid>")
    .replace(/\b[0-9a-f]{64}\b/g, "<sha256>")
    .replace(/(opinst|proposal)-[0-9a-f]{32}/g, "$1-<id>")
    .replace(/00-[0-9a-f]{32}-[0-9a-f]{16}-0[01]/g, "<traceparent>");
}));
receipt.summary = {
  pass: receipt.checks.filter((c) => c.verdict === "pass").length,
  fail: receipt.checks.filter((c) => c.verdict === "fail").length,
  blocked: receipt.checks.filter((c) => c.verdict === "blocked").length,
};
receipt.verdict = receipt.summary.fail === 0 && receipt.summary.blocked === 0 ? "qualified" : "not-qualified";
const projection = { candidate: receipt.candidate, clients: receipt.clients, checks: receipt.checks.map(({ id, criterion, verdict }) => ({ id, criterion, verdict })) };
const written = normalise(receipt);
// Added after normalisation: the digest is itself a sha256 and must survive it.
written.deterministicProjection = receipt.deterministicProjection = {
  fields: "candidate, clients, check ids/criteria/verdicts", sha256: sha256(canonical(normalise(projection))),
};
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, `${JSON.stringify(written, null, 2)}\n`);
console.log(JSON.stringify({ verdict: receipt.verdict, summary: receipt.summary, projection: receipt.deterministicProjection.sha256,
  checks: receipt.checks.map(({ id, verdict, diagnostic }) => ({ id, verdict, diagnostic: diagnostic?.split("\n")[0] })) }, null, 2));
// MCP sessions keep a server-initiated stream open; the receipt is written, so
// end the process rather than waiting for those sockets to time out.
process.exit(receipt.verdict === "qualified" ? 0 : 1);
