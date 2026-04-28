/**
 * Vitest global setup for the integration lane. Runs once before any
 * surface test file. Performs three jobs:
 *
 *   1. Detects whether the integration lane is configured. If
 *      `HONUA_INTEGRATION_BASE_URL` is unset, surfaces will skip
 *      themselves (see `integrationSuite` in `harness.ts`) — global
 *      setup just leaves the metadata file unwritten so a normal
 *      `npm run test:integration` invocation in an unconfigured env
 *      reports zero exercised surfaces and exits clean.
 *   2. Health-checks the server by fetching `getCompatibility()` so
 *      the lane fails fast (with a clear message) when the configured
 *      URL points at a stopped or unreachable server.
 *   3. Initializes `test-results/integration-meta.json` so per-surface
 *      `recordSurface` calls can append entries.
 *
 * @module
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { HonuaClient } from "@honua/sdk-js";
import { tryResolveIntegrationConfig } from "./harness.js";
import { initializeMeta } from "./reporter.js";

const PACKAGE_JSON_PATH = path.resolve(fileURLToPath(import.meta.url), "../../../package.json");

export async function setup(): Promise<void> {
  const config = tryResolveIntegrationConfig();
  if (!config) {
    // Nothing to do — surfaces will register as skipped via
    // `describe.skip(...)` and the run will pass.
    return;
  }

  const client = new HonuaClient({
    baseUrl: config.baseUrl,
    timeoutMs: Math.min(config.timeoutMs, 15_000),
    ...(config.apiKey ? { apiKey: config.apiKey } : {}),
    ...(config.bearerToken ? { bearerToken: config.bearerToken } : {}),
  });

  let serverVersion: string | undefined;
  let releaseChannel: string | undefined;
  try {
    const compatibility = await client.getCompatibility();
    serverVersion = compatibility.serverVersion;
    releaseChannel = compatibility.releaseChannel;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Honua Server health check failed at ${config.baseUrl} (GET /api/v1/admin/capabilities): ${message}. Ensure the server is running before invoking the integration lane.`,
    );
  }

  const sdkPackage = readPackageInfo();
  initializeMeta({
    sdkVersion: sdkPackage.version,
    sdkPackage: sdkPackage.name,
    serverVersion,
    serverReleaseChannel: releaseChannel,
    serverImage: process.env.HONUA_INTEGRATION_SERVER_IMAGE?.trim() || undefined,
    serverCommit: process.env.HONUA_INTEGRATION_SERVER_COMMIT?.trim() || undefined,
    baseUrl: config.baseUrl,
    seedProfile: config.seedProfile,
    serviceId: config.serviceId,
    layerId: config.layerId,
    collectionId: config.collectionId,
    tileMatrixSetId: config.tileMatrixSetId,
    startedAt: new Date().toISOString(),
  });
}

export async function teardown(): Promise<void> {
  // No global state to clean up. The metadata file is intentionally
  // left in place for CI artifact upload.
}

function readPackageInfo(): { name: string; version: string } {
  const raw = fs.readFileSync(PACKAGE_JSON_PATH, "utf8");
  const parsed = JSON.parse(raw) as { name?: string; version?: string };
  return {
    name: parsed.name ?? "@honua/sdk-js",
    version: parsed.version ?? "0.0.0",
  };
}
