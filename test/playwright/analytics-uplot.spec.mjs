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

test("scatter rectangle controls and keyboard point selection share map/table state", async ({ page }) => {
  const server = await startSdkFixtureServer();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    await page.goto(server.url);
    await page.evaluate(async () => {
      const a = await import("/dist/src/analytics/index.js");
      const { createExplorationContext } = await import("/dist/src/exploration/context.js");
      const context = createExplorationContext({ datasetId: "d", sourceIds: ["s"] });
      const view = context.connectView({ id: "scatter", role: "chart" });
      const peer = context.connectView({ id: "map-table", role: "grid" });
      peer.setFilter("peer", { field: "active", operator: "=", value: true });
      const artifact = a.acceptScatterArtifact({
        identity: a.analyticsArtifactIdentity({ artifactId: "scatter", sourceId: "s", acceptedAt: "2026-11-10T00:00:00Z" }),
        provenance: a.analyticsProvenance({ computedBy: "server", bounds: a.UNBOUNDED }),
        dimension: "height", yDimension: "weight", measure: { field: "weight", fn: "avg" },
        marks: [
          { key: "a", label: "Point A", x: 10, value: 20, targets: [{ sourceId: "s", id: 1 }] },
          { key: "b", label: "Point B", x: 30, value: 40, targets: [{ sourceId: "s", id: 2 }] },
        ],
      });
      const registry = a.createAnalyticsAdapterRegistry({ adapters: [a.createDefaultAnalyticsPresentation()] });
      const session = a.createAnalyticsLinkedSession({ view, artifact, registry });
      const target = document.createElement("div");
      document.body.append(target);
      await session.present({ target });
      window.scatterFixture = { session, peer };
    });
    const x = page.getByRole("group", { name: "height", exact: true });
    const y = page.getByRole("group", { name: "weight", exact: true });
    await x.getByLabel("Minimum").fill("5");
    await x.getByLabel("Maximum").fill("15");
    await y.getByLabel("Minimum").fill("10");
    await y.getByLabel("Maximum").fill("25");
    await page.getByRole("button", { name: "Apply rectangle" }).focus();
    await page.keyboard.press("Enter");
    expect(await page.evaluate(() => Object.values(window.scatterFixture.peer.state.filters))).toEqual(
      expect.arrayContaining([
        { field: "height", operator: "between", value: [5, 15], appliesTo: ["s"] },
        { field: "weight", operator: "between", value: [10, 25], appliesTo: ["s"] },
      ]),
    );
    await page.getByRole("button", { name: "Point A", exact: true }).focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("button", { name: "Point A", exact: true })).toBeFocused();
    await expect(page.getByRole("button", { name: "Point A", exact: true })).toHaveAttribute("aria-pressed", "true");
    expect(await page.evaluate(() => window.scatterFixture.peer.state.selection)).toEqual([{ sourceId: "s", id: 1 }]);
    await page.evaluate(() => window.scatterFixture.peer.select([{ sourceId: "s", id: 2 }], { replace: true }));
    await expect(page.getByRole("button", { name: "Point B", exact: true })).toHaveAttribute("aria-pressed", "true");
    await x.getByLabel("Minimum").fill("100");
    await page.getByRole("button", { name: "Apply rectangle" }).click();
    await expect(page.getByRole("status")).toContainText("minimum at or below its maximum");
    expect(await page.evaluate(() => window.scatterFixture.session.linkedState.rectangle.x)).toEqual({ min: 5, max: 15 });
    await page.getByRole("button", { name: "Clear rectangle" }).click();
    expect(await page.evaluate(() => Object.keys(window.scatterFixture.peer.state.filters))).toEqual(["peer"]);
    expect(await page.evaluate(() => window.scatterFixture.peer.state.selection)).toEqual([{ sourceId: "s", id: 2 }]);
    await page.evaluate(() => window.scatterFixture.session.dispose());
    await expect(page.locator("table")).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally {
    await server.close();
  }
});

test("the real scatter chart drag publishes two bounds without selecting the release point", async ({ page }) => {
  const server = await startSdkFixtureServer();
  try {
    await page.goto(server.url);
    const box = await page.evaluate(async () => {
      const a = await import("/dist/src/analytics/index.js");
      const { createUplotAnalyticsAdapter } = await import("/dist/src/analytics/adapters/uplot.js");
      const { createExplorationContext } = await import("/dist/src/exploration/context.js");
      const uplot = await import("/node_modules/uplot/dist/uPlot.esm.js");
      const context = createExplorationContext({ datasetId: "d", sourceIds: ["s"] });
      const view = context.connectView({ id: "scatter", role: "chart" });
      const peer = context.connectView({ id: "map", role: "map" });
      peer.setFilter("peer", { field: "active", operator: "=", value: true });
      const artifact = a.acceptScatterArtifact({
        identity: a.analyticsArtifactIdentity({ artifactId: "scatter", sourceId: "s", acceptedAt: "2026-11-10T00:00:00Z" }),
        provenance: a.analyticsProvenance({ computedBy: "server", bounds: a.UNBOUNDED }),
        dimension: "height", yDimension: "weight", measure: { field: "weight", fn: "avg" },
        marks: [
          { key: "a", label: "A", x: 10, value: 20, targets: [1] },
          { key: "b", label: "B", x: 30, value: 40, targets: [2] },
        ],
      });
      const registry = a.createAnalyticsAdapterRegistry({ adapters: [createUplotAnalyticsAdapter({ module: uplot })] });
      const session = a.createAnalyticsLinkedSession({ view, artifact, registry });
      const target = document.createElement("div");
      document.body.append(target);
      const presentation = await session.present({ target });
      const chart = presentation.handle.chart;
      window.scatterDragFixture = { session, peer };
      const rect = chart.over.getBoundingClientRect();
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    });
    await page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.8, box.y + box.height * 0.8, { steps: 12 });
    await page.mouse.up();
    const result = await page.evaluate(() => ({
      rectangle: window.scatterDragFixture.session.linkedState.rectangle,
      filters: Object.values(window.scatterDragFixture.peer.state.filters),
      selection: window.scatterDragFixture.peer.state.selection,
    }));
    expect(result.rectangle.x.min).toBeLessThan(result.rectangle.x.max);
    expect(result.rectangle.y.min).toBeLessThan(result.rectangle.y.max);
    expect(result.filters).toHaveLength(3);
    expect(result.filters).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: "height", value: [result.rectangle.x.min, result.rectangle.x.max] }),
      expect.objectContaining({ field: "weight", value: [result.rectangle.y.min, result.rectangle.y.max] }),
    ]));
    expect(result.selection).toEqual([]);
    await page.evaluate(() => window.scatterDragFixture.session.dispose());
    await expect(page.locator("canvas")).toHaveCount(0);
  } finally {
    await server.close();
  }
});

test("real uPlot paints a peer-selected scatter point in the selection color", async ({ page }) => {
  const server = await startSdkFixtureServer();
  try {
    await page.goto(server.url);
    await page.evaluate(async () => {
      const a = await import("/dist/src/analytics/index.js");
      const { createUplotAnalyticsAdapter } = await import("/dist/src/analytics/adapters/uplot.js");
      const { createExplorationContext } = await import("/dist/src/exploration/context.js");
      const uplot = await import("/node_modules/uplot/dist/uPlot.esm.js");
      const context = createExplorationContext({ datasetId: "d", sourceIds: ["s"] });
      const view = context.connectView({ id: "scatter", role: "chart" });
      const peer = context.connectView({ id: "map", role: "map" });
      const artifact = a.acceptScatterArtifact({
        identity: a.analyticsArtifactIdentity({ artifactId: "scatter", sourceId: "s", acceptedAt: "2026-11-10T00:00:00Z" }),
        provenance: a.analyticsProvenance({ computedBy: "server", bounds: a.UNBOUNDED }),
        dimension: "height", yDimension: "weight", measure: { field: "weight", fn: "avg" },
        marks: [
          { key: "a", label: "A", x: 10, value: 20, targets: [{ sourceId: "s", id: 1 }] },
          { key: "b", label: "B", x: 30, value: 40, targets: [{ sourceId: "s", id: 2 }] },
        ],
      });
      const registry = a.createAnalyticsAdapterRegistry({ adapters: [createUplotAnalyticsAdapter({ module: uplot })] });
      const session = a.createAnalyticsLinkedSession({ view, artifact, registry });
      const target = document.createElement("div");
      document.body.append(target);
      const presentation = await session.present({ target });
      window.scatterColorFixture = { session, peer, chart: presentation.handle.chart };
    });
    const before = await page.evaluate(() => window.scatterColorFixture.chart.ctx.canvas.toDataURL());
    await page.evaluate(() => window.scatterColorFixture.peer.select([{ sourceId: "s", id: 2 }], { replace: true }));
    const after = await page.evaluate(() => {
      const chart = window.scatterColorFixture.chart;
      const { width, height } = chart.ctx.canvas;
      const pixels = chart.ctx.getImageData(0, 0, width, height).data;
      let selected = 0;
      for (let index = 0; index < pixels.length; index += 4) {
        const red = pixels[index];
        const green = pixels[index + 1];
        const blue = pixels[index + 2];
        if (Math.abs(red - 154) <= 8 && Math.abs(green - 52) <= 8 && Math.abs(blue - 18) <= 8) selected += 1;
      }
      return { selected, keys: window.scatterColorFixture.session.linkedState.selectedMarkKeys };
    });
    expect(before).not.toBe("");
    expect(after.keys).toEqual(["b"]);
    expect(after.selected).toBeGreaterThan(0);
    await page.evaluate(() => {
      window.scatterColorFixture.chart.setScale("x", { min: 32, max: 60 });
    });
    const zoomed = await page.evaluate(() => {
      const chart = window.scatterColorFixture.chart;
      const bounds = chart.bbox;
      const canvas = chart.ctx.canvas;
      const pixels = chart.ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      const plotLeft = Math.floor(bounds.left);
      const plotRight = Math.ceil(bounds.left + bounds.width);
      const plotTop = Math.floor(bounds.top);
      const plotBottom = Math.ceil(bounds.top + bounds.height);
      let outside = 0;
      for (let index = 0; index < pixels.length; index += 4) {
        const red = pixels[index];
        const green = pixels[index + 1];
        const blue = pixels[index + 2];
        if (Math.abs(red - 154) > 8 || Math.abs(green - 52) > 8 || Math.abs(blue - 18) > 8) continue;
        const pixel = index / 4;
        const x = pixel % canvas.width;
        const y = Math.floor(pixel / canvas.width);
        if (x < plotLeft - 1 || x >= plotRight + 1 || y < plotTop - 1 || y >= plotBottom + 1) outside += 1;
      }
      return {
        outside,
        px: chart.valToPos(30, "x", true),
        left: bounds.left,
        scaleMin: chart.scales.x.min,
        keys: window.scatterColorFixture.session.linkedState.selectedMarkKeys,
      };
    });
    expect(zoomed.keys).toEqual(["b"]);
    expect(zoomed.scaleMin).toBe(32);
    expect(zoomed.px).toBeLessThan(zoomed.left);
    expect(zoomed.outside).toBe(0);
    await page.evaluate(() => window.scatterColorFixture.session.dispose());
  } finally {
    await server.close();
  }
});
