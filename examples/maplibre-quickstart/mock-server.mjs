import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { startSampleFixtureHarness } from "../../samples/scenarios/index.mjs";
import { createFixtureBuildEnvironment } from "../../scripts/lib/fixture-build-environment.mjs";
import { runNpmScriptSync } from "../../scripts/lib/npm-cli.mjs";

const exampleRoot = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(exampleRoot, "../..");
const distRoot = path.resolve(exampleRoot, "dist");

export const FIXTURE_BUILD_ENV = {
  VITE_HONUA_QUICKSTART_ENDPOINT: "honua:first-map-fixture",
  VITE_HONUA_QUICKSTART_PROTOCOL: "auto",
  VITE_HONUA_QUICKSTART_WHERE: "1=1",
  VITE_HONUA_QUICKSTART_RESULT_RECORD_COUNT: "25",
  VITE_HONUA_QUICKSTART_BASEMAP_STYLE: "/__honua-quickstart__/basemap-style.json",
};

function buildDemoIfNeeded(timeoutMs) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 600_000) {
    throw new Error("Quickstart fixture build timeout must be between 1000 and 600000ms.");
  }
  const result = runNpmScriptSync("demo:quickstart:build", {
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
  const arguments_ = process.argv.slice(2);
  const evidenceOnce = arguments_.length === 1 && arguments_[0] === "--evidence-once";
  if (arguments_.length > 0 && !evidenceOnce) throw new Error("Unknown First Map fixture server argument");

  const { server, url, close } = await startQuickstartFixtureServer();
  process.stdout.write(`quickstartMockUrl=${url}\n`);

  if (evidenceOnce) {
    let probe;
    try {
      const response = await fetch(url);
      const body = Buffer.from(await response.arrayBuffer());
      probe = {
        method: "GET",
        path: "/",
        status: response.status,
        bodyBytes: body.byteLength,
        bodySha256: createHash("sha256").update(body).digest("hex"),
        contentType: response.headers.get("content-type"),
      };
      if (!response.ok) throw new Error(`Fixture evidence probe failed with HTTP ${response.status}`);
    } finally {
      await close();
    }
    const activeConnectionsAfterClose = await new Promise((resolve, reject) => {
      server.getConnections((error, count) => (error ? reject(error) : resolve(count)));
    });
    const endpoint = new URL(url);
    process.stdout.write(
      `fixtureEvidence=${JSON.stringify({
        transport: "loopback-http",
        networkScope: "loopback-only",
        host: endpoint.hostname,
        port: Number(endpoint.port),
        ready: true,
        started: true,
        probe,
        closed: true,
        listeningAfterClose: server.listening,
        activeConnectionsAfterClose,
      })}\n`,
    );
    process.exit(0);
  }

  const shutdown = async () => {
    await close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
