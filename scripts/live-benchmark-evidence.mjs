#!/usr/bin/env node

/**
 * Opt-in evidence probe for the canonical Honua demo and AWS-hosted STAC data.
 * It is scheduled/manual only: default PR and local validation never contact it.
 */
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { validateEvidenceEnvelope } from "./sample-contract.mjs";

const TIMEOUT_MS = 30_000;

function parseArgs(argv) {
  const options = { output: "test-results/live-benchmark-evidence.json", strict: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--output") options.output = argv[++index] ?? "";
    else if (arg === "--strict") options.strict = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!options.output) throw new Error("--output must not be empty");
  return options;
}

function gitCommit() {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

function sanitizedBaseUrl(value) {
  const parsed = new URL(value);
  if (!/^https?:$/.test(parsed.protocol)) throw new Error("Live base URL must use HTTP(S)");
  parsed.username = "";
  parsed.password = "";
  parsed.search = "";
  parsed.hash = "";
  return parsed.href.replace(/\/$/, "");
}

async function requestJson(url, headers = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const startedAt = new Date();
  const timerStartedAt = performance.now();
  try {
    const response = await fetch(url, {
      headers: { accept: "application/json", ...headers },
      signal: controller.signal,
    });
    const body = await response.json().catch(() => undefined);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return {
      body,
      latencyMs: performance.now() - timerStartedAt,
      observedAt: startedAt.toISOString(),
      serverDate: response.headers.get("date"),
      etag: response.headers.get("etag"),
      lastModified: response.headers.get("last-modified"),
    };
  } finally {
    clearTimeout(timer);
  }
}

async function probeTarget(definition) {
  if (definition.skipReason) {
    return {
      id: definition.id,
      sampleId: definition.sampleId,
      journeyId: definition.journeyId,
      status: "skipped",
      provider: definition.provider,
      endpoint: definition.endpoint,
      authMode: definition.authMode,
      attribution: definition.attribution,
      skipReason: definition.skipReason,
    };
  }

  const startedAt = new Date().toISOString();
  try {
    const evidence = await definition.run();
    return {
      id: definition.id,
      sampleId: definition.sampleId,
      journeyId: definition.journeyId,
      status: "passed",
      provider: definition.provider,
      endpoint: definition.endpoint,
      authMode: definition.authMode,
      attribution: definition.attribution,
      startedAt,
      completedAt: new Date().toISOString(),
      ...evidence,
    };
  } catch (error) {
    return {
      id: definition.id,
      sampleId: definition.sampleId,
      journeyId: definition.journeyId,
      status: "failed",
      provider: definition.provider,
      endpoint: definition.endpoint,
      authMode: definition.authMode,
      attribution: definition.attribution,
      startedAt,
      completedAt: new Date().toISOString(),
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function assertionStrings(checks) {
  return Object.entries(checks ?? {}).map(([name, value]) => `${name}=${JSON.stringify(value)}`);
}

export function toSampleEvidence(target, sdk, generatedAt) {
  const executed = target.status === "passed";
  const failed = target.status === "failed";
  const observedAt = target.freshness?.observedAt ?? target.completedAt ?? generatedAt;
  return validateEvidenceEnvelope({
    format: "honua.sdk.sample-evidence.v1",
    schemaVersion: 1,
    sampleId: target.sampleId,
    lane: "live",
    status: executed ? "executed" : failed ? "failed" : "skipped",
    reason: executed ? null : target.error ?? target.skipReason ?? "Live target did not execute.",
    observedAt,
    authMode: target.authMode,
    sdk,
    source: {
      provider: target.provider,
      identity: target.provenance?.source ?? target.id,
      endpoint: target.endpoint,
      deploymentVersion: target.endpointVersion ?? null,
      dataVersion: target.freshness?.sourceDataTimestamp ?? target.protocolVersion ?? null,
    },
    provenance: executed
      ? {
          sourceId: target.provenance.source,
          observedAt,
          validAt: target.freshness?.sourceDataTimestamp ?? null,
          state: "live",
          attribution: target.attribution,
        }
      : null,
    semantics: {
      operation: target.journeyId,
      outcome: executed ? target.journey?.visibleOutcome.kind ?? "live-check-passed" : null,
      itemCount: executed ? target.journey?.visibleOutcome.itemCount ?? null : null,
      assertions: executed ? assertionStrings(target.checks) : [],
    },
    timing: {
      totalMs: executed ? target.latencyMs : null,
      firstSuccessfulInteractionMs: executed ? target.journey?.timeToFirstSuccessfulInteractionMs ?? null : null,
    },
    degradation: {
      state: executed ? "none" : failed ? "unexpected" : "unavailable",
      reasons: executed ? [] : [target.error ?? target.skipReason ?? "Live target did not execute."],
    },
    artifacts: [],
  });
}

export async function collectLiveEvidence(env = process.env) {
  const generatedAt = new Date().toISOString();
  const packageJson = JSON.parse(await readFile("package.json", "utf8"));
  const enabled = env.HONUA_BENCH_LIVE_ENABLED === "true";
  if (!enabled) {
    return {
      format: "honua.sdk.benchmark-live-evidence.v1",
      schemaVersion: 1,
      generatedAt,
      contract: {
        producerIssue: "https://github.com/honua-io/honua-sdk-js/issues/401",
        consumerIssue: "https://github.com/honua-io/honua-site/issues/120",
      },
      sdk: { package: packageJson.name, version: packageJson.version, gitCommit: gitCommit() },
      run: {
        status: "skipped",
        trigger: env.GITHUB_EVENT_NAME ?? "local",
        skipReason: "HONUA_BENCH_LIVE_ENABLED is not true; live probes are opt-in",
      },
      targets: [],
    };
  }

  const honuaBaseUrl = sanitizedBaseUrl(env.HONUA_BENCH_LIVE_BASE_URL ?? "https://demo.honua.io");
  const apiKey = env.HONUA_BENCH_LIVE_API_KEY;
  const authMode = apiKey ? "api-key" : "anonymous";
  const authHeaders = apiKey ? { "x-api-key": apiKey } : {};
  const awsBaseUrl = "https://earth-search.aws.element84.com/v1";
  const sdk = { package: packageJson.name, version: packageJson.version, gitCommit: gitCommit() };
  const rawTargets = await Promise.all([
    probeTarget({
      id: "honua-demo-ogc-query",
      sampleId: "service-explorer",
      journeyId: "discover-and-query-first-feature",
      provider: "honua-demo",
      endpoint: `${honuaBaseUrl}/ogc/features`,
      authMode,
      attribution: "Honua canonical demo data",
      async run() {
        const capabilities = await requestJson(`${honuaBaseUrl}/api/v1/admin/capabilities`, authHeaders);
        const collections = await requestJson(`${honuaBaseUrl}/ogc/features/collections?f=json`, authHeaders);
        const firstCollection = collections.body?.collections?.[0]?.id;
        if (!firstCollection) throw new Error("No OGC collection was advertised");
        const itemsUrl = `${honuaBaseUrl}/ogc/features/collections/${encodeURIComponent(firstCollection)}/items?f=json&limit=1`;
        const items = await requestJson(itemsUrl, authHeaders);
        if (items.body?.type !== "FeatureCollection" || !Array.isArray(items.body?.features)) {
          throw new Error("OGC items response was not a FeatureCollection");
        }
        return {
          endpointVersion: capabilities.body?.data?.serverVersion ?? null,
          protocolVersion: capabilities.body?.data?.metadataApiVersion ?? null,
          latencyMs: capabilities.latencyMs + collections.latencyMs + items.latencyMs,
          checks: {
            collectionCount: collections.body.collections.length,
            selectedCollection: String(firstCollection),
            returnedFeatureCount: items.body.features.length,
          },
          journey: {
            id: "discover-and-query-first-feature",
            timeToFirstSuccessfulInteractionMs:
              capabilities.latencyMs + collections.latencyMs + items.latencyMs,
            visibleOutcome: {
              kind: "feature-collection",
              itemCount: items.body.features.length,
            },
            console: {
              applicable: false,
              reason: "Protocol probe has no browser console",
            },
            accessibility: {
              applicable: false,
              reason: "Protocol probe has no rendered user interface",
            },
          },
          freshness: {
            observedAt: items.observedAt,
            serverDate: items.serverDate,
            sourceDataTimestamp: null,
            etag: items.etag,
            lastModified: items.lastModified,
          },
          provenance: {
            source: "canonical-honua-demo",
            requestedUrls: [
              `${honuaBaseUrl}/api/v1/admin/capabilities`,
              `${honuaBaseUrl}/ogc/features/collections?f=json`,
              itemsUrl,
            ],
          },
        };
      },
    }),
    probeTarget({
      id: "aws-earth-search-stac",
      sampleId: "stac-imagery-browser",
      journeyId: "discover-and-search-first-item",
      provider: "element84-earth-search-aws",
      endpoint: awsBaseUrl,
      authMode: "anonymous",
      attribution: "Element 84 Earth Search and source collection providers",
      skipReason: env.HONUA_BENCH_LIVE_SKIP_AWS_REASON || undefined,
      async run() {
        const landing = await requestJson(awsBaseUrl);
        const searchUrl = `${awsBaseUrl}/search?collections=sentinel-2-l2a&limit=1`;
        const search = await requestJson(searchUrl);
        if (search.body?.type !== "FeatureCollection" || !Array.isArray(search.body?.features)) {
          throw new Error("STAC search response was not a FeatureCollection");
        }
        return {
          endpointVersion: landing.body?.stac_version ?? null,
          protocolVersion: landing.body?.stac_version ?? null,
          latencyMs: landing.latencyMs + search.latencyMs,
          checks: { returnedItemCount: search.body.features.length },
          journey: {
            id: "discover-and-search-first-item",
            timeToFirstSuccessfulInteractionMs: landing.latencyMs + search.latencyMs,
            visibleOutcome: {
              kind: "stac-feature-collection",
              itemCount: search.body.features.length,
            },
            console: {
              applicable: false,
              reason: "Protocol probe has no browser console",
            },
            accessibility: {
              applicable: false,
              reason: "Protocol probe has no rendered user interface",
            },
          },
          freshness: {
            observedAt: search.observedAt,
            serverDate: search.serverDate,
            sourceDataTimestamp: search.body.features[0]?.properties?.datetime ?? null,
            etag: search.etag,
            lastModified: search.lastModified,
          },
          provenance: {
            source: "earth-search-sentinel-2-l2a",
            requestedUrls: [awsBaseUrl, searchUrl],
          },
        };
      },
    }),
  ]);
  const targets = rawTargets.map((rawTarget) => {
    const { sampleId: _sampleId, journeyId: _journeyId, attribution: _attribution, ...target } = rawTarget;
    return { ...target, sampleEvidence: toSampleEvidence(rawTarget, sdk, generatedAt) };
  });

  const failed = targets.filter((target) => target.status === "failed").length;
  const passed = targets.filter((target) => target.status === "passed").length;
  return {
    format: "honua.sdk.benchmark-live-evidence.v1",
    schemaVersion: 1,
    generatedAt,
    contract: {
      producerIssue: "https://github.com/honua-io/honua-sdk-js/issues/401",
      consumerIssue: "https://github.com/honua-io/honua-site/issues/120",
    },
    sdk,
    run: {
      status: failed > 0 ? "failed" : passed > 0 ? "passed" : "skipped",
      trigger: env.GITHUB_EVENT_NAME ?? "local",
      skipReason: passed === 0 && failed === 0 ? "Every configured target was skipped" : null,
    },
    targets,
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const evidence = await collectLiveEvidence();
  await mkdir(path.dirname(options.output), { recursive: true });
  await writeFile(options.output, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  process.stdout.write(
    `Live benchmark evidence: ${evidence.run.status}; ${evidence.targets.length} target(s); ${options.output}\n`,
  );
  for (const target of evidence.targets) {
    process.stdout.write(`  ${target.id}: ${target.status}${target.skipReason ? ` (${target.skipReason})` : ""}\n`);
  }
  if (options.strict && evidence.run.status === "failed") process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    process.stderr.write(`live benchmark evidence failed: ${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  });
}
