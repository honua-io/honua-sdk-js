#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { liveEvidenceOutputContract } from "./lib/live-evidence-output.mjs";
import { validateEvidenceEnvelope } from "./sample-contract.mjs";

export const IMAGERY_TERRAIN_LIVE_TARGET = Object.freeze({
  provider: "element84-earth-search-sentinel-cogs",
  itemId: "S2A_4QFJ_20230108_0_L2A",
  collectionId: "sentinel-2-l2a",
  acquiredAt: "2023-01-08T21:19:31.047000Z",
  itemUrl:
    "https://earth-search.aws.element84.com/v1/collections/sentinel-2-l2a/items/S2A_4QFJ_20230108_0_L2A",
  assetUrl:
    "https://sentinel-cogs.s3.us-west-2.amazonaws.com/sentinel-s2-l2a-cogs/4/Q/FJ/2023/1/S2A_4QFJ_20230108_0_L2A/TCI.tif",
  licenseUrl: "https://sentinel.esa.int/documents/247904/690755/Sentinel_Data_Legal_Notice",
  mediaType: "image/tiff; application=geotiff; profile=cloud-optimized",
  epsg: 32604,
  cloudCover: 0.514744,
  bbox: Object.freeze([-158.03948970116338, 20.708132571859636, -157.48449115696747, 21.700589634636817]),
  objectBytes: 86_065_339,
  etag: '"929417f387933fb86d82340bed7243ed-11"',
  lastModified: "Mon, 09 Jan 2023 01:38:38 GMT",
});

const SAMPLE_ID = "imagery-cog-quickstart";
const PRODUCER_PATH = "scripts/imagery-terrain-live-evidence.mjs";
const REQUEST_ORIGIN = "https://honua.io";
const RANGE_HEADER = "bytes=0-63";
const MAX_STAC_BYTES = 1024 * 1024;
const RANGE_BYTES = 64;
const REQUEST_TIMEOUT_MS = 30_000;

export const IMAGERY_TERRAIN_LIVE_PRODUCER_ARTIFACT = Object.freeze({
  kind: "producer-generator",
  path: PRODUCER_PATH,
  sha256: createHash("sha256")
    .update(await readFile(new URL("./imagery-terrain-live-evidence.mjs", import.meta.url)))
    .digest("hex"),
});

function parseArgs(argv) {
  const options = { output: "test-results/imagery-terrain-live-evidence.json", strict: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--output") options.output = argv[++index] ?? "";
    else if (argument === "--strict") options.strict = true;
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (!options.output) throw new Error("--output must not be empty");
  return options;
}

function reportedCommit(env) {
  if (/^[a-f0-9]{40}$/.test(env.HONUA_SAMPLE_SOURCE_REVISION ?? "")) {
    return env.HONUA_SAMPLE_SOURCE_REVISION;
  }
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

function baseEnvelope(packageJson, observedAt, env) {
  return {
    format: "honua.sdk.sample-evidence.v1",
    schemaVersion: 1,
    sampleId: SAMPLE_ID,
    lane: "live",
    status: "failed",
    reason: "Live evidence did not execute.",
    observedAt,
    authMode: "anonymous",
    sdk: { package: packageJson.name, version: packageJson.version, gitCommit: reportedCommit(env) },
    source: {
      provider: IMAGERY_TERRAIN_LIVE_TARGET.provider,
      identity: `${IMAGERY_TERRAIN_LIVE_TARGET.itemId}:visual`,
      endpoint: IMAGERY_TERRAIN_LIVE_TARGET.assetUrl,
      deploymentVersion: "earth-search-v1",
      dataVersion: IMAGERY_TERRAIN_LIVE_TARGET.acquiredAt,
    },
    provenance: null,
    semantics: { operation: "pinned-stac-cog-range-qualification", outcome: null, itemCount: null, assertions: [] },
    timing: { totalMs: null, firstSuccessfulInteractionMs: null },
    degradation: { state: "unexpected", reasons: ["Live evidence did not execute."] },
    artifacts: [IMAGERY_TERRAIN_LIVE_PRODUCER_ARTIFACT],
  };
}

export function validatePinnedLiveUrl(value, label = "Live target URL") {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new Error(`${label} must be an unsigned credential-free HTTPS URL.`);
  }
  return url.href;
}

function responseHeader(response, name) {
  return response.headers.get(name)?.trim() ?? null;
}

async function readBoundedBody(response, byteLimit, label) {
  const declaredLength = Number(responseHeader(response, "content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > byteLimit) {
    await response.body?.cancel(`${label} declared an oversized response.`);
    throw new Error(`${label} declared ${declaredLength} bytes, exceeding the ${byteLimit}-byte limit.`);
  }
  if (!response.body) throw new Error(`${label} response body is missing.`);
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > byteLimit) {
        await reader.cancel(`${label} exceeded its byte limit.`);
        throw new Error(`${label} exceeded the ${byteLimit}-byte limit.`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function assertResponseTarget(response, expectedUrl, label) {
  if (response.redirected || (response.url && response.url !== expectedUrl)) {
    throw new Error(`${label} redirected away from its pinned URL.`);
  }
}

function assertCors(response, label) {
  const allowOrigin = responseHeader(response, "access-control-allow-origin");
  if (allowOrigin !== "*" && allowOrigin !== REQUEST_ORIGIN) {
    throw new Error(`${label} did not allow the qualification origin.`);
  }
  return allowOrigin;
}

function assertPinnedItem(item) {
  if (item?.id !== IMAGERY_TERRAIN_LIVE_TARGET.itemId || item.collection !== IMAGERY_TERRAIN_LIVE_TARGET.collectionId) {
    throw new Error("Earth Search returned a different pinned item identity.");
  }
  if (
    item.properties?.datetime !== IMAGERY_TERRAIN_LIVE_TARGET.acquiredAt ||
    item.properties?.["proj:epsg"] !== IMAGERY_TERRAIN_LIVE_TARGET.epsg ||
    item.properties?.["eo:cloud_cover"] !== IMAGERY_TERRAIN_LIVE_TARGET.cloudCover
  ) {
    throw new Error("Pinned STAC acquisition, CRS, or cloud metadata drifted.");
  }
  if (JSON.stringify(item.bbox) !== JSON.stringify(IMAGERY_TERRAIN_LIVE_TARGET.bbox)) {
    throw new Error("Pinned STAC footprint bounds drifted.");
  }
  const asset = item.assets?.visual;
  if (
    asset?.href !== IMAGERY_TERRAIN_LIVE_TARGET.assetUrl ||
    asset?.type !== IMAGERY_TERRAIN_LIVE_TARGET.mediaType ||
    !asset.roles?.includes("visual")
  ) {
    throw new Error("Pinned STAC visual asset identity, media type, or role drifted.");
  }
  if (
    JSON.stringify(asset["proj:shape"]) !== "[10980,10980]" ||
    JSON.stringify(asset["proj:transform"]) !== "[10,0,600000,0,-10,2400000]"
  ) {
    throw new Error("Pinned STAC visual asset resolution or shape drifted.");
  }
  const bandNames = asset["eo:bands"]?.map((band) => band.common_name);
  if (JSON.stringify(bandNames) !== '["red","green","blue"]') {
    throw new Error("Pinned STAC visual band metadata drifted.");
  }
  if (!item.links?.some((link) => link.rel === "license" && link.href === IMAGERY_TERRAIN_LIVE_TARGET.licenseUrl)) {
    throw new Error("Pinned STAC license link drifted.");
  }
  return asset;
}

function exposedRangeHeaders(response) {
  const exposed = new Set(
    (responseHeader(response, "access-control-expose-headers") ?? "")
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean),
  );
  return ["accept-ranges", "content-range", "etag"].every((name) => exposed.has(name) || exposed.has("*"));
}

function isTiffHeader(bytes) {
  return (
    (bytes[0] === 0x49 && bytes[1] === 0x49 && bytes[2] === 0x2a && bytes[3] === 0x00) ||
    (bytes[0] === 0x4d && bytes[1] === 0x4d && bytes[2] === 0x00 && bytes[3] === 0x2a)
  );
}

async function pinnedFetch(fetchImpl, url, init) {
  return fetchImpl(url, {
    ...init,
    redirect: "manual",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
}

export async function collectImageryTerrainLiveEvidence(options = {}) {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const packageJson = options.packageJson ?? JSON.parse(await readFile("package.json", "utf8"));
  const now = options.now ?? (() => Date.now());
  const startedAt = now();
  const observedAt = new Date(startedAt).toISOString();
  const base = baseEnvelope(packageJson, observedAt, env);

  if (env.HONUA_SAMPLE_LIVE_ENABLED !== "true") {
    const reason = "HONUA_SAMPLE_LIVE_ENABLED is not true; public network execution is opt-in.";
    return validateEvidenceEnvelope({
      ...base,
      status: "skipped",
      reason,
      degradation: { state: "unavailable", reasons: [reason] },
    });
  }

  try {
    const itemUrl = validatePinnedLiveUrl(IMAGERY_TERRAIN_LIVE_TARGET.itemUrl, "STAC item URL");
    const assetUrl = validatePinnedLiveUrl(IMAGERY_TERRAIN_LIVE_TARGET.assetUrl, "COG asset URL");
    const itemResponse = await pinnedFetch(fetchImpl, itemUrl, {
      headers: { Accept: "application/geo+json, application/json", Origin: REQUEST_ORIGIN },
    });
    assertResponseTarget(itemResponse, itemUrl, "STAC item request");
    if (itemResponse.status !== 200) throw new Error(`Pinned STAC item returned HTTP ${itemResponse.status}.`);
    assertCors(itemResponse, "Pinned STAC item");
    const itemBytes = await readBoundedBody(itemResponse, MAX_STAC_BYTES, "Pinned STAC item");
    const item = JSON.parse(new TextDecoder().decode(itemBytes));
    assertPinnedItem(item);
    const firstSuccessfulInteractionMs = Math.max(0, now() - startedAt);

    const rangeResponse = await pinnedFetch(fetchImpl, assetUrl, {
      headers: { Accept: IMAGERY_TERRAIN_LIVE_TARGET.mediaType, Origin: REQUEST_ORIGIN, Range: RANGE_HEADER },
    });
    assertResponseTarget(rangeResponse, assetUrl, "COG range request");
    if (rangeResponse.status !== 206) {
      throw new Error(`Pinned COG range returned HTTP ${rangeResponse.status}; exact 206 is required.`);
    }
    assertCors(rangeResponse, "Pinned COG range");
    const expectedContentRange = `bytes 0-63/${IMAGERY_TERRAIN_LIVE_TARGET.objectBytes}`;
    if (responseHeader(rangeResponse, "content-range") !== expectedContentRange) {
      throw new Error("Pinned COG Content-Range drifted or was not exact.");
    }
    if (responseHeader(rangeResponse, "accept-ranges")?.toLowerCase() !== "bytes") {
      throw new Error("Pinned COG did not advertise byte ranges.");
    }
    if (responseHeader(rangeResponse, "etag") !== IMAGERY_TERRAIN_LIVE_TARGET.etag) {
      throw new Error("Pinned COG ETag drifted.");
    }
    if (responseHeader(rangeResponse, "last-modified") !== IMAGERY_TERRAIN_LIVE_TARGET.lastModified) {
      throw new Error("Pinned COG Last-Modified drifted.");
    }
    if (responseHeader(rangeResponse, "content-type") !== IMAGERY_TERRAIN_LIVE_TARGET.mediaType) {
      throw new Error("Pinned COG response media type drifted.");
    }
    const cacheControl = responseHeader(rangeResponse, "cache-control") ?? "";
    if (!/public/iu.test(cacheControl) || !/max-age=31536000/iu.test(cacheControl) || !/immutable/iu.test(cacheControl)) {
      throw new Error("Pinned COG immutable cache policy drifted.");
    }
    const rangeBytes = await readBoundedBody(rangeResponse, RANGE_BYTES, "Pinned COG range");
    if (rangeBytes.byteLength !== RANGE_BYTES || !isTiffHeader(rangeBytes)) {
      throw new Error("Pinned COG range was not exactly 64 bytes with a TIFF signature.");
    }

    const headersExposed = exposedRangeHeaders(rangeResponse);
    const degradationReasons = headersExposed
      ? []
      : [
          "The public COG accepts browser-origin range requests, but does not expose Content-Range, Accept-Ranges, and ETag to browser JavaScript; a same-origin Honua proxy is required for an in-app receipt.",
        ];
    return validateEvidenceEnvelope({
      ...base,
      status: "executed",
      reason: null,
      provenance: {
        sourceId: `earth-search:${IMAGERY_TERRAIN_LIVE_TARGET.collectionId}:${IMAGERY_TERRAIN_LIVE_TARGET.itemId}:visual`,
        observedAt,
        validAt: IMAGERY_TERRAIN_LIVE_TARGET.acquiredAt,
        state: "live",
        attribution: "Copernicus Sentinel data 2023; cataloged by Element 84 Earth Search.",
      },
      semantics: {
        operation: "pinned-stac-cog-range-qualification",
        outcome: headersExposed
          ? "pinned-stac-cog-range-verified-browser-headers-exposed"
          : "pinned-stac-cog-range-verified-browser-header-exposure-degraded",
        itemCount: 1,
        assertions: [
          `stac-item=${IMAGERY_TERRAIN_LIVE_TARGET.itemId}`,
          `collection=${IMAGERY_TERRAIN_LIVE_TARGET.collectionId}`,
          `acquired-at=${IMAGERY_TERRAIN_LIVE_TARGET.acquiredAt}`,
          `epsg=${IMAGERY_TERRAIN_LIVE_TARGET.epsg}`,
          `bbox=${IMAGERY_TERRAIN_LIVE_TARGET.bbox.join(",")}`,
          "resolution-metres=10",
          "visual-bands=red,green,blue",
          `range-request=${RANGE_HEADER}`,
          `content-range=${expectedContentRange}`,
          `range-response-bytes=${rangeBytes.byteLength}`,
          `object-bytes=${IMAGERY_TERRAIN_LIVE_TARGET.objectBytes}`,
          `etag=${IMAGERY_TERRAIN_LIVE_TARGET.etag}`,
          `last-modified=${IMAGERY_TERRAIN_LIVE_TARGET.lastModified}`,
          `cache-control=${cacheControl}`,
          "cors-origin-allowed=true",
          `browser-range-headers-exposed=${headersExposed}`,
          `license=${IMAGERY_TERRAIN_LIVE_TARGET.licenseUrl}`,
          "unbounded-cog-gets=0",
        ],
      },
      timing: {
        totalMs: Math.max(0, now() - startedAt),
        firstSuccessfulInteractionMs,
      },
      degradation: {
        state: headersExposed ? "none" : "expected",
        reasons: degradationReasons,
      },
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return validateEvidenceEnvelope({
      ...base,
      reason,
      degradation: { state: "unexpected", reasons: [reason] },
    });
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const contract = liveEvidenceOutputContract(SAMPLE_ID, options.output);
  const evidence = await collectImageryTerrainLiveEvidence();
  await mkdir(path.dirname(contract.output), { recursive: true });
  await writeFile(contract.output, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  process.stdout.write(`Imagery and Terrain live evidence: ${evidence.status}; ${contract.output}\n`);
  if (options.strict && evidence.status !== "executed") process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  });
}
