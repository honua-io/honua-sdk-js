import { expect, test } from "@playwright/test";

import { startWebComponentsFixtureServer } from "../../examples/web-components-basic/mock-server.mjs";

const HOSTS = {
  "controls.basemap-switcher": "honua-basemap-switcher",
  "controls.swipe-control": "honua-swipe-control",
  "controls.legend": "honua-controls-legend",
  "controls.layer-list": "honua-controls-layer-list",
  "web-components.map": "honua-map",
  "web-components.layer-list": "honua-layer-list",
  "web-components.legend": "honua-legend",
  "web-components.feature-table": "honua-feature-table",
  "web-components.feature-inspection": "honua-feature-inspection",
  "web-components.search": "honua-search",
  "web-components.editor": "honua-editor",
  "web-components.feature-editor": "honua-feature-editor",
  "web-components.chart": "honua-chart",
  "web-components.basemap-control": "honua-basemap-control",
  "web-components.bookmarks": "honua-bookmarks",
  "web-components.locate-control": "honua-locate-control",
  "web-components.measure-control": "honua-measure-control",
  "web-components.measurement": "honua-measurement",
  "web-components.time-slider": "honua-time-slider",
  "web-components.sketch-control": "honua-sketch-control",
  "web-components.print-export": "honua-print-export",
  "web-components.map-status": "honua-map-status",
  "web-components.action-panel": "honua-action-panel",
};

test("detached catalog components are collectible", async ({ page }) => {
  const server = await startWebComponentsFixtureServer();
  const client = await page.context().newCDPSession(page);
  try {
    await page.goto(`${server.url}?controls-layer-list=1`);
    await page.waitForTimeout(500);
    await client.send("HeapProfiler.enable");

    const failures = [];
    for (const [id, tag] of Object.entries(HOSTS)) {
      await page.evaluate((elementTag) => {
        const element = document.createElement(elementTag);
        if (elementTag !== "honua-map") element.setAttribute("for", "missing-memory-map");
        document.body.append(element);
        window.__HONUA_MEMORY_REF__ = new WeakRef(element);
        element.remove();
      }, tag);

      let collected = false;
      for (let attempt = 0; attempt < 20 && !collected; attempt += 1) {
        await client.send("HeapProfiler.collectGarbage");
        await page.waitForTimeout(100);
        collected = await page.evaluate(() => window.__HONUA_MEMORY_REF__?.deref() === undefined);
      }
      if (!collected) failures.push(id);
    }

    expect(failures, `retained components: ${failures.join(", ")}`).toEqual([]);
  } finally {
    await client.detach();
    await server.close();
  }
});
