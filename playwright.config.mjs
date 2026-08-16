import path from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "@playwright/test";

import { loadBrowserShardMap, resolveShardFromEnvironment, shardTestMatch } from "./scripts/lib/browser-shards.mjs";

// One browser failure domain per job (honua-io/honua-sdk-js#1286 REQ-004).
// HONUA_BROWSER_SHARD selects the reviewed partition in
// config/browser-shards.v1.json; unset -- which is every local run, ci.yml's
// authoritative `JS SDK` job, and the `test:maplibre-compat:prepared` lane that
// names its spec explicitly -- runs the whole directory exactly as before.
// Everything else about the browser contract (single chromium project, one
// worker, CI retries) is deliberately unchanged: sharding redistributes the
// work, it does not weaken it.
//
// The shard map is loaded LAZILY, behind the env check. This file is shared
// with the authoritative job, so reading a shadow-lane config file eagerly
// would let a malformed or missing config/browser-shards.v1.json break
// production Playwright at config load. Unsharded runs never open it; a sharded
// run still fails loudly rather than silently running every spec.
const projectRoot = path.dirname(fileURLToPath(import.meta.url));
const shard = resolveShardFromEnvironment(() => loadBrowserShardMap(projectRoot), process.env);

export default defineConfig({
  testDir: "./test/playwright",
  ...(shard ? { testMatch: shardTestMatch(shard) } : {}),
  outputDir: process.env.HONUA_SAMPLE_PLAYWRIGHT_OUTPUT_DIR ?? ".tmp/playwright-output",
  timeout: 30_000,
  expect: {
    timeout: 10_000,
  },
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? "dot" : "list",
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
  use: {
    headless: true,
  },
});
