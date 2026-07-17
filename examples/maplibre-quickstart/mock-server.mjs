import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { startSampleFixtureHarness } from "../../samples/scenarios/index.mjs";
import { createFixtureBuildEnvironment } from "../../scripts/lib/fixture-build-environment.mjs";

const exampleRoot = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(exampleRoot, "../..");
const distRoot = path.resolve(exampleRoot, "dist");

export const FIXTURE_BUILD_ENV = {
  VITE_HONUA_QUICKSTART_BASE_URL: "",
  VITE_HONUA_QUICKSTART_SERVICE_ID: "natural-earth",
  VITE_HONUA_QUICKSTART_LAYER_ID: "0",
  VITE_HONUA_QUICKSTART_WHERE: "1=1",
  VITE_HONUA_QUICKSTART_RESULT_RECORD_COUNT: "25",
  VITE_HONUA_QUICKSTART_BASEMAP_STYLE: "/__honua-quickstart__/basemap-style.json",
};

function buildDemoIfNeeded(timeoutMs) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 600_000) {
    throw new Error("Quickstart fixture build timeout must be between 1000 and 600000ms.");
  }
  const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
  const result = spawnSync(npmCommand, ["run", "demo:quickstart:build", "--silent"], {
    cwd: projectRoot,
    stdio: "inherit",
    env: createFixtureBuildEnvironment(FIXTURE_BUILD_ENV),
    timeout: timeoutMs,
  });
  if (result.status !== 0) {
    if (result.error?.code === "ETIMEDOUT")
      throw new Error(`Quickstart fixture build exceeded its ${timeoutMs}ms budget.`);
    throw new Error("Failed to build the quickstart demo before starting the fixture harness.");
  }
}

export async function startQuickstartFixtureServer({ build = true, buildTimeoutMs = 120_000 } = {}) {
  if (build) buildDemoIfNeeded(buildTimeoutMs);
  return startSampleFixtureHarness({
    sampleId: "first-map",
    staticRoot: distRoot,
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { url, close } = await startQuickstartFixtureServer();
  process.stdout.write(`quickstartMockUrl=${url}\n`);
  const shutdown = async () => {
    await close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
