import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadGeoTiffCogDecoderFactory } from "./lib/geotiff-cog-decoder.mjs";
import { validateEvidenceEnvelope } from "./sample-contract.mjs";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CONTRACT_PATH = "test/fixtures/cog/public-earth-search-sentinel-2.json";
const PRODUCER_PATH = "scripts/cog-live-evidence.mjs";
const DEFAULT_OUTPUT = "test-results/cog-live-evidence.json";

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, relativePath), "utf8"));
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function sourceRevision() {
  const supplied = process.env.HONUA_SAMPLE_SOURCE_REVISION;
  if (/^[a-f0-9]{40}$/.test(supplied ?? "")) return supplied;
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: PROJECT_ROOT, encoding: "utf8" }).trim();
}

function addDays(iso, days) {
  return new Date(Date.parse(iso) + days * 86_400_000).toISOString();
}

export function validateCogPublicContract(contract) {
  invariant(contract.format === "honua.sdk.cog-public-contract.v1", "COG public contract format drift");
  invariant(contract.schemaVersion === 1, "COG public contract schemaVersion drift");
  invariant(new URL(contract.stac.itemUrl).protocol === "https:", "Pinned STAC item must use HTTPS");
  invariant(new URL(contract.asset.url).protocol === "https:", "Pinned COG asset must use HTTPS");
  invariant(contract.stac.assetKey === "visual", "Pinned STAC asset key drift");
  invariant(contract.asset.mediaType.includes("profile=cloud-optimized"), "Pinned asset must declare COG media evidence");
  invariant(Number.isSafeInteger(contract.asset.byteLength) && contract.asset.byteLength > 0, "Pinned asset byte length is invalid");
  invariant(/^[a-f0-9]{64}$/.test(contract.asset.prefix.sha256), "Pinned prefix digest is invalid");
  invariant(contract.asset.prefix.length <= 1024, "Pinned prefix check must remain bounded");
  invariant(contract.expectedInspection.format === "cog", "Pinned inspection must expect a COG");
  invariant(contract.boundedRead.width * contract.boundedRead.height <= 65_536, "Pinned source read is not bounded");
  invariant(
    contract.boundedRead.sampling.width * contract.boundedRead.sampling.height <= 4_096,
    "Pinned decoded output is not bounded",
  );
  invariant(contract.freshness.scheduledCadenceDays <= contract.freshness.evidenceValidityDays, "Evidence expires before its cadence");
  invariant(Date.parse(contract.stac.acquisitionAt) < Date.parse(contract.freshness.contractObservedAt), "Acquisition/probe chronology is invalid");
  return contract;
}

function baseEvidence(contract, observedAt, status, reason) {
  const packageJson = readJson("package.json");
  return {
    format: "honua.sdk.sample-evidence.v1",
    schemaVersion: 1,
    sampleId: "imagery-cog-quickstart",
    lane: "live",
    status,
    reason,
    observedAt,
    authMode: "anonymous",
    sdk: { package: packageJson.name, version: packageJson.version, gitCommit: sourceRevision() },
    source: {
      provider: contract.provider.name,
      identity: contract.stac.itemId,
      endpoint: contract.stac.itemUrl,
      deploymentVersion: null,
      dataVersion: contract.asset.etag,
    },
  };
}

function skippedEvidence(contract, observedAt, reason) {
  return validateEvidenceEnvelope({
    ...baseEvidence(contract, observedAt, "skipped", reason),
    provenance: null,
    semantics: { operation: "stac-direct-cog-inspect-read", outcome: null, itemCount: null, assertions: [] },
    timing: { totalMs: null, firstSuccessfulInteractionMs: null },
    degradation: { state: "unavailable", reasons: ["live-network-gate-disabled"] },
    artifacts: [],
    cog: {
      contractPath: CONTRACT_PATH,
      contractSha256: sha256(fs.readFileSync(path.join(PROJECT_ROOT, CONTRACT_PATH))),
      networkGate: "HONUA_COG_LIVE_ENABLED",
      scheduledOnly: true,
    },
  });
}

async function verifyPrefix(contract, fetchFn, signal) {
  const { offset, length, sha256: expectedDigest } = contract.asset.prefix;
  const response = await fetchFn(contract.asset.url, {
    headers: { range: `bytes=${offset}-${offset + length - 1}` },
    credentials: "omit",
    redirect: "error",
    signal,
  });
  invariant(response.status === 206, `Pinned prefix Range returned HTTP ${response.status}`);
  invariant(response.headers.get("content-range") === `bytes ${offset}-${offset + length - 1}/${contract.asset.byteLength}`, "Pinned Content-Range drift");
  invariant(response.headers.get("etag") === contract.asset.etag, "Pinned asset ETag drift");
  invariant(response.headers.get("last-modified") === contract.asset.lastModified, "Pinned Last-Modified drift");
  const bytes = new Uint8Array(await response.arrayBuffer());
  invariant(bytes.byteLength === length, "Pinned prefix byte length drift");
  invariant(sha256(bytes) === expectedDigest, "Pinned prefix digest drift");
  return { contentRange: response.headers.get("content-range"), etag: response.headers.get("etag"), sha256: sha256(bytes) };
}

function validateInspection(inspection, expected) {
  invariant(inspection.format === expected.format, "Live COG format drift");
  invariant(inspection.width === expected.width && inspection.height === expected.height, "Live COG dimensions drift");
  invariant(`${inspection.crs.authority}:${inspection.crs.code}` === expected.crs, "Live COG CRS drift");
  invariant(inspection.bands.length === expected.bandCount, "Live COG band count drift");
  invariant(JSON.stringify(inspection.bands.map((band) => band.dataType)) === JSON.stringify(expected.dataTypes), "Live COG data types drift");
  invariant(JSON.stringify(inspection.resolution) === JSON.stringify(expected.resolution), "Live COG resolution drift");
  invariant(JSON.stringify(inspection.overviewDecimations) === JSON.stringify(expected.overviewDecimations), "Live COG overview drift");
}

function validateTransfer(transfer, contract) {
  invariant(transfer.requests > 0, "Live COG read produced no range evidence");
  invariant(transfer.bytesFetched > 0 && transfer.bytesFetched < contract.asset.byteLength, "Live COG read was empty or unbounded");
  invariant(transfer.bytesFetched <= 4 * 1024 * 1024, "Live COG read exceeded the evidence byte ceiling");
  invariant(transfer.ranges.every((range) => range.outcome === "success"), "Live COG range ledger contains a failure");
  invariant(transfer.ranges.every((range) => range.status === 206), "Live COG range ledger contains a non-partial response");
  invariant(transfer.ranges.every((range) => range.bytesReceived === range.length), "Live COG range length drift");
}

function windowDigest(result) {
  const hash = createHash("sha256");
  for (const band of result.bands) {
    hash.update(new Uint8Array(band.values.buffer, band.values.byteOffset, band.values.byteLength));
  }
  return hash.digest("hex");
}

export async function runCogLiveEvidence(options = {}) {
  const contract = validateCogPublicContract(options.contract ?? readJson(CONTRACT_PATH));
  const observedAt = options.observedAt ?? new Date().toISOString();
  const enabled = options.enabled ?? /^(?:1|true)$/i.test(process.env.HONUA_COG_LIVE_ENABLED ?? "");
  const strict = options.strict ?? false;
  if (!enabled) {
    const evidence = skippedEvidence(contract, observedAt, "Live COG evidence is disabled outside its scheduled/manual network lane.");
    if (strict) throw Object.assign(new Error(evidence.reason), { evidence });
    return evidence;
  }

  const fetchFn = options.fetchFn ?? fetch;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 90_000);
  const started = performance.now();
  let session;
  try {
    const [{ connect }, { openStacCogAsset }] = await Promise.all([
      import("../dist/src/index.js"),
      import("../dist/src/cog/index.js"),
    ]);
    const connection = await connect({
      endpoint: contract.stac.itemUrl,
      protocol: "stac",
      authorizationScopeFingerprint: "anonymous",
      clientOptions: { fetchFn },
      signal: controller.signal,
    });
    const candidate = connection.inspection.stacStatic?.assetCandidates.find(
      (asset) => asset.assetKey === contract.stac.assetKey,
    );
    invariant(candidate?.state === "classified" && candidate.kind === "cog", "Pinned STAC asset is no longer classified as COG");
    invariant(candidate.href === contract.asset.url, "Pinned STAC asset URL drift");
    invariant(candidate.mediaType === contract.asset.mediaType, "Pinned STAC media type drift");
    invariant(candidate.evidence.some((entry) => entry.kind === "media-type" && entry.supports?.includes("cog")), "Pinned STAC asset lost media-type evidence");

    const prefix = await verifyPrefix(contract, fetchFn, controller.signal);
    const decoderFactory = await loadGeoTiffCogDecoderFactory();
    session = openStacCogAsset(candidate, {
      decoderFactory,
      fetchFn,
      limits: {
        maxMetadataRequests: 64,
        maxWindowRequests: 16,
        maxRangeBytes: 2 * 1024 * 1024,
        maxMetadataBytes: 2 * 1024 * 1024,
        maxWindowBytes: 2 * 1024 * 1024,
        maxTotalBytes: 4 * 1024 * 1024,
        maxWindowPixels: 65_536,
        maxDecodedBytes: 2 * 1024 * 1024,
      },
    });
    const inspection = await session.inspect({ signal: controller.signal });
    validateInspection(inspection, contract.expectedInspection);
    invariant(inspection.provenance.assetValidator === `etag:${contract.asset.etag}`, "SDK range validator drift");
    const result = await session.readWindow(contract.boundedRead, { signal: controller.signal });
    validateTransfer(result.transfer, contract);
    invariant(result.width === contract.boundedRead.sampling.width, "Bounded COG output width drift");
    invariant(result.height === contract.boundedRead.sampling.height, "Bounded COG output height drift");
    invariant(result.bands.every((band) => band.values.length === result.width * result.height), "Bounded COG sample length drift");

    const totalMs = performance.now() - started;
    const producerBytes = fs.readFileSync(path.join(PROJECT_ROOT, PRODUCER_PATH));
    const contractBytes = fs.readFileSync(path.join(PROJECT_ROOT, CONTRACT_PATH));
    return validateEvidenceEnvelope({
      ...baseEvidence(contract, observedAt, "executed", null),
      provenance: {
        sourceId: `${contract.stac.collectionId}/${contract.stac.itemId}/${contract.stac.assetKey}`,
        observedAt,
        validAt: contract.stac.acquisitionAt,
        state: "live",
        attribution: contract.provider.attribution,
      },
      semantics: {
        operation: "stac-direct-cog-inspect-read",
        outcome: "classified-inspected-and-bounded-window-decoded",
        itemCount: 1,
        assertions: [
          "stac-media-type-classified-cog",
          "pinned-prefix-and-validator-match",
          "inspection-semantics-match-contract",
          "all-sdk-asset-responses-are-exact-206-ranges",
          "decoded-window-is-bounded",
        ],
      },
      timing: { totalMs, firstSuccessfulInteractionMs: totalMs },
      degradation: { state: "none", reasons: [] },
      artifacts: [
        { kind: "producer-generator", path: PRODUCER_PATH, sha256: sha256(producerBytes) },
        { kind: "public-cog-contract", path: CONTRACT_PATH, sha256: sha256(contractBytes) },
      ],
      cog: {
        prefix,
        classification: {
          candidateId: candidate.id,
          confidence: candidate.confidence,
          mediaType: candidate.mediaType,
          evidence: candidate.evidence,
        },
        inspection: {
          width: inspection.width,
          height: inspection.height,
          crs: `${inspection.crs.authority}:${inspection.crs.code}`,
          bands: inspection.bands,
          resolution: inspection.resolution,
          overviewDecimations: inspection.overviewDecimations,
          validator: inspection.provenance.assetValidator,
        },
        read: {
          request: contract.boundedRead,
          width: result.width,
          height: result.height,
          sampleSha256: windowDigest(result),
        },
        transfer: result.transfer,
        freshness: {
          acquisitionAt: contract.stac.acquisitionAt,
          probedAt: observedAt,
          validUntil: addDays(observedAt, contract.freshness.evidenceValidityDays),
          cadenceDays: contract.freshness.scheduledCadenceDays,
        },
      },
    });
  } catch (error) {
    const totalMs = performance.now() - started;
    const failureCode = typeof error?.code === "string" ? error.code : error?.name ?? "live-evidence-failed";
    const failureMessage = error?.message ?? String(error);
    const producerBytes = fs.readFileSync(path.join(PROJECT_ROOT, PRODUCER_PATH));
    const contractBytes = fs.readFileSync(path.join(PROJECT_ROOT, CONTRACT_PATH));
    const evidence = validateEvidenceEnvelope({
      ...baseEvidence(contract, observedAt, "failed", failureMessage),
      provenance: {
        sourceId: `${contract.stac.collectionId}/${contract.stac.itemId}/${contract.stac.assetKey}`,
        observedAt,
        validAt: contract.stac.acquisitionAt,
        state: "live",
        attribution: contract.provider.attribution,
      },
      semantics: { operation: "stac-direct-cog-inspect-read", outcome: null, itemCount: null, assertions: [] },
      timing: { totalMs, firstSuccessfulInteractionMs: null },
      degradation: { state: "unexpected", reasons: [failureCode] },
      artifacts: [
        { kind: "producer-generator", path: PRODUCER_PATH, sha256: sha256(producerBytes) },
        { kind: "public-cog-contract", path: CONTRACT_PATH, sha256: sha256(contractBytes) },
      ],
      cog: {
        failure: { code: failureCode, message: failureMessage },
        freshness: {
          acquisitionAt: contract.stac.acquisitionAt,
          probedAt: observedAt,
          validUntil: null,
          cadenceDays: contract.freshness.scheduledCadenceDays,
        },
      },
    });
    throw Object.assign(error instanceof Error ? error : new Error(failureMessage), { evidence });
  } finally {
    clearTimeout(timeout);
    await session?.dispose();
  }
}

function parseArguments(argv) {
  let output = DEFAULT_OUTPUT;
  let strict = false;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--strict") strict = true;
    else if (argv[index] === "--output") output = argv[++index];
    else throw new Error(`Unknown COG live-evidence argument: ${argv[index]}`);
  }
  return { output, strict };
}

async function main() {
  const { output, strict } = parseArguments(process.argv.slice(2));
  let evidence;
  try {
    evidence = await runCogLiveEvidence({ strict });
  } catch (error) {
    evidence = error?.evidence;
    if (evidence) {
      const outputPath = path.resolve(PROJECT_ROOT, output);
      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      fs.writeFileSync(outputPath, `${JSON.stringify(evidence, null, 2)}\n`);
    }
    throw error;
  }
  const outputPath = path.resolve(PROJECT_ROOT, output);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(evidence, null, 2)}\n`);
  process.stdout.write(`${evidence.status}: ${output}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`COG live evidence failed: ${error?.message ?? error}\n`);
    process.exitCode = 1;
  });
}
