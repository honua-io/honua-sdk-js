import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { startSampleFixtureHarness } from "../../samples/scenarios/index.mjs";
import { createFixtureBuildEnvironment } from "../../scripts/lib/fixture-build-environment.mjs";

const exampleRoot = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(exampleRoot, "../..");
const distRoot = path.resolve(exampleRoot, "dist");

function buildDemoIfNeeded(timeoutMs) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 600_000) {
    throw new Error("Incident fixture build timeout must be between 1000 and 600000ms.");
  }
  const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
  const result = spawnSync(npmCommand, ["run", "demo:incident:build", "--silent"], {
    cwd: projectRoot,
    stdio: "inherit",
    env: createFixtureBuildEnvironment(),
    timeout: timeoutMs,
  });
  if (result.status !== 0) {
    if (result.error?.code === "ETIMEDOUT")
      throw new Error(`Incident fixture build exceeded its ${timeoutMs}ms budget.`);
    throw new Error("Failed to build the realtime incident dashboard before starting the fixture harness.");
  }
}

export async function startIncidentDashboardFixtureServer({ build = true, buildTimeoutMs = 120_000 } = {}) {
  if (build) buildDemoIfNeeded(buildTimeoutMs);
  const fixtureRunId = "incident-operations";
  const harness = await startSampleFixtureHarness({
    sampleId: "incident-operations",
    staticRoot: distRoot,
    defaultRunId: fixtureRunId,
  });
  const query = new URLSearchParams({ transport: "fixture-edit", fixtureRun: fixtureRunId });
  const unauthorizedQuery = new URLSearchParams(query);
  unauthorizedQuery.set("fixtureAuthorization", "unauthorized");
  return Object.freeze({
    ...harness,
    fixtureRunId,
    runUrl: `${harness.origin}/__fixture__/runs/${fixtureRunId}`,
    requestLogUrl: `${harness.origin}/__fixture__/runs/${fixtureRunId}/requests`,
    url: `${harness.origin}/?${query}`,
    unauthorizedUrl: `${harness.origin}/?${unauthorizedQuery}`,
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { url, close } = await startIncidentDashboardFixtureServer();
  process.stdout.write(`incidentDashboardMockUrl=${url}\n`);
  const shutdown = async () => {
    await close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
