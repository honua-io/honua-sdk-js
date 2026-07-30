import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test } from "@playwright/test";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function contentType(filePath) {
  if (filePath.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (filePath.endsWith(".css")) return "text/css; charset=utf-8";
  return "text/html; charset=utf-8";
}

async function startSdkFixtureServer() {
  const server = createServer(async (request, response) => {
    const requestPath = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    const relativePath = requestPath === "/" ? "test/playwright/analytics-uplot-fixture.html" : requestPath.slice(1);
    const filePath = path.resolve(repoRoot, relativePath);
    if (!filePath.startsWith(`${repoRoot}${path.sep}`)) {
      response.writeHead(404).end();
      return;
    }

    try {
      const body = await readFile(filePath);
      response.writeHead(200, { "content-type": contentType(filePath) });
      response.end(body);
    } catch {
      response.writeHead(404).end();
    }
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not start analytics fixture server");
  return {
    url: `http://127.0.0.1:${address.port}/`,
    close: () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}

test("the real optional uPlot adapter mounts, links brush state, patches, and disposes", async ({ page }) => {
  const server = await startSdkFixtureServer();
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  try {
    await page.goto(server.url);
    const result = await page.evaluate(async () => {
      const analytics = await import("/dist/src/analytics/index.js");
      const { createUplotAnalyticsAdapter } = await import("/dist/src/analytics/adapters/uplot.js");
      const uplot = await import("/node_modules/uplot/dist/uPlot.esm.js");
      const artifact = (sequence, values) =>
        analytics.acceptTimeSeriesArtifact({
          identity: analytics.analyticsArtifactIdentity({
            artifactId: "incidents-by-hour",
            sourceId: "incidents",
            planFingerprint: "sha256:plan",
            sequence,
            acceptedAt: "2026-07-29T00:00:00.000Z",
          }),
          provenance: analytics.analyticsProvenance({ computedBy: "server", bounds: analytics.UNBOUNDED }),
          measure: { field: "count", fn: "count", label: "Incidents", unit: "count", unitSystem: "count" },
          dimension: "reported_at",
          interval: { unit: "hour", step: 1 },
          marks: values.map((value, index) => ({
            key: `h${index}`,
            label: `Hour ${index}`,
            value,
            start: `2026-07-29T0${index}:00:00.000Z`,
            end: `2026-07-29T0${index + 1}:00:00.000Z`,
          })),
        });

      const target = document.createElement("div");
      document.body.append(target);
      const interactions = [];
      const adapter = createUplotAnalyticsAdapter({ module: uplot });
      const first = artifact(0, [2, 4, 6]);
      const handle = await adapter.mount({
        artifact: first,
        target,
        linkedState: { selectedMarkKeys: [] },
        host: { emit: (interaction) => interactions.push(interaction) },
      });
      const chart = handle.chart;
      const left = chart.valToPos(Date.parse(first.marks[1].start) / 1000, "x");
      const right = chart.valToPos(Date.parse(first.marks[2].end) / 1000, "x");
      chart.setSelect({ left, top: 0, width: right - left, height: 100 }, true);
      const patched = artifact(1, [3, 8, 13]);
      const decision = handle.update(patched);
      const sameChartAfterPatch = handle.chart === chart;
      const liveChartData = chart.data?.[1];
      const originalRemoveEventListener = chart.over?.removeEventListener?.bind(chart.over);
      let clickListenerRemoved = false;
      if (chart.over && originalRemoveEventListener) {
        chart.over.removeEventListener = (type, listener, options) => {
          if (type === "click") clickListenerRemoved = true;
          return originalRemoveEventListener(type, listener, options);
        };
      }
      const canvasCountBeforeDispose = target.querySelectorAll("canvas").length;
      handle.dispose();

      return {
        canvasCountBeforeDispose,
        brush: interactions.find((interaction) => interaction.kind === "temporal-brush"),
        decision,
        sameChartAfterPatch,
        liveChartData,
        disposed: handle.disposed,
        targetChildrenAfterDispose: target.children.length,
        clickListenerRemoved,
      };
    });

    expect(result.canvasCountBeforeDispose).toBeGreaterThan(0);
    expect(result.brush).toMatchObject({ kind: "temporal-brush", artifactId: "incidents-by-hour" });
    expect(result.decision).toMatchObject({ disposition: "patch", reason: "newer-sequence" });
    expect(result.sameChartAfterPatch).toBe(true);
    expect(result.liveChartData).toEqual([3, 8, 13]);
    expect(result.disposed).toBe(true);
    expect(result.targetChildrenAfterDispose).toBe(0);
    expect(result.clickListenerRemoved).toBe(true);
    expect(pageErrors).toEqual([]);
  } finally {
    await server.close();
  }
});
