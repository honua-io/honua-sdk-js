import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import { expect, test } from "@playwright/test";

const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";

function getProjectRoot() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
}

function getExampleRoot(projectRoot) {
  return path.join(projectRoot, "examples", "kepler-analytics");
}

function buildExample(projectRoot) {
  const exampleRoot = getExampleRoot(projectRoot);
  const result = spawnSync(npmCommand, ["--prefix", exampleRoot, "run", "build"], {
    cwd: projectRoot,
    encoding: "utf8"
  });

  if (result.status !== 0) {
    throw new Error(
      `Failed to build kepler analytics example.\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`
    );
  }
}

function contentTypeFor(filePath) {
  if (filePath.endsWith(".html")) {
    return "text/html; charset=utf-8";
  }
  if (filePath.endsWith(".js")) {
    return "text/javascript; charset=utf-8";
  }
  if (filePath.endsWith(".css")) {
    return "text/css; charset=utf-8";
  }
  if (filePath.endsWith(".json")) {
    return "application/json; charset=utf-8";
  }
  if (filePath.endsWith(".svg")) {
    return "image/svg+xml";
  }
  return "application/octet-stream";
}

function startServer(projectRoot) {
  const distRoot = path.join(getExampleRoot(projectRoot), "dist");

  const server = http.createServer((req, res) => {
    const requestUrl = new URL(req.url ?? "/", "http://127.0.0.1");
    const relativePath = requestUrl.pathname === "/" ? "index.html" : requestUrl.pathname.slice(1);
    const filePath = path.join(distRoot, relativePath);

    if (filePath.startsWith(distRoot) && fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      res.writeHead(200, { "content-type": contentTypeFor(filePath) });
      res.end(fs.readFileSync(filePath));
      return;
    }

    const indexPath = path.join(distRoot, "index.html");
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(fs.readFileSync(indexPath));
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

async function getServerUrl(server) {
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to bind kepler analytics smoke server.");
  }
  return `http://127.0.0.1:${address.port}`;
}

test.describe.configure({ timeout: 120_000 });

test("kepler analytics fixture demo renders portfolio replay shell", async ({ page }) => {
  const projectRoot = getProjectRoot();
  buildExample(projectRoot);

  const pageErrors = [];
  const consoleErrors = [];

  page.on("pageerror", (error) => {
    pageErrors.push(error.message);
  });

  page.on("console", (message) => {
    if (message.type() === "error") {
      consoleErrors.push(message.text());
    }
  });

  const server = await startServer(projectRoot);
  try {
    const serverUrl = await getServerUrl(server);
    await page.goto(serverUrl, { waitUntil: "networkidle" });

    await expect.poll(async () => page.evaluate(() => window.__keplerAnalyticsReady === true)).toBe(true);

    expect(await page.evaluate(() => window.__keplerAnalyticsError ?? null)).toBeNull();
    expect(pageErrors).toEqual([]);
    expect(consoleErrors).toEqual([]);

    await expect
      .poll(async () => page.evaluate(() => window.__keplerAnalyticsHarness?.getReplayState() ?? null))
      .toEqual({
        currentTime: 1777653780000,
        dataIds: ["incidents", "unit-tracks"],
        filteredCounts: {
          incidents: 5,
          "unit-tracks": 12
        },
        layerIds: ["coverage-zones-layer", "incidents-layer", "unit-tracks-layer"],
        replayStatus: {
          incidents: "added",
          "unit-tracks": "added"
        },
        value: [1777651200000, 1777656360000]
      });

    expect(
      await page.evaluate(
        () =>
          window.__keplerAnalyticsHarness?.setReplayWindow(
            "2026-05-01T16:00:00.000Z",
            "2026-05-01T16:15:00.000Z"
          ) ?? false
      )
    ).toBe(true);
    await expect
      .poll(async () => page.evaluate(() => window.__keplerAnalyticsHarness?.getReplayState() ?? null))
      .toEqual({
        currentTime: 1777651650000,
        dataIds: ["incidents", "unit-tracks"],
        filteredCounts: {
          incidents: 1,
          "unit-tracks": 3
        },
        layerIds: ["coverage-zones-layer", "incidents-layer", "unit-tracks-layer"],
        replayStatus: {
          incidents: "value_changed",
          "unit-tracks": "value_changed"
        },
        value: [1777651200000, 1777652100000]
      });

    await expect(page.getByTestId("demo-title")).toHaveText("Honolulu operations replay");
    await expect(page.getByTestId("walkthrough-step-1")).toContainText("Play the first response wave");
    await expect(page.getByTestId("kpi-active-incidents")).toContainText("5");
    await expect(page.getByTestId("dataset-unit-tracks")).toContainText("Unit pings");
    await expect(page.getByTestId("fixture-provenance")).toHaveText("Honua export fixture");
    await expect(page.getByTestId("demo-ready")).toHaveText("Replay ready");
    await expect(page.locator("[data-testid='kepler-map'] .kepler-gl")).toBeVisible();
  } finally {
    await new Promise((resolve) => server.close(() => resolve(undefined)));
  }
});
