import { expect, test } from "@playwright/test";

import { startWebComponentsFixtureServer } from "../../examples/web-components-basic/mock-server.mjs";

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
].join("; ");

test("web-component catalog renders without strict-CSP violations", async ({ page }) => {
  await page.addInitScript(() => {
    window.__HONUA_CSP_VIOLATIONS__ = [];
    document.addEventListener("securitypolicyviolation", (event) => {
      window.__HONUA_CSP_VIOLATIONS__.push({
        blockedURI: event.blockedURI,
        directive: event.effectiveDirective,
        source: event.sourceFile,
      });
    });
  });
  const server = await startWebComponentsFixtureServer({ headers: { "content-security-policy": CSP } });
  try {
    await page.goto(`${server.url}?controls-layer-list=1`);
    await page.waitForTimeout(500);
    await page.evaluate(() => {
      const map = document.querySelector("honua-map");
      const swipe = document.createElement("honua-swipe-control");
      swipe.map = map?.map;
      document.body.append(swipe);
      const controlsLayerList = document.createElement("honua-controls-layer-list");
      controlsLayerList.map = map?.map;
      document.body.append(controlsLayerList);
      const Legend = customElements.get("honua-legend");
      if (Legend && !customElements.get("honua-controls-legend")) {
        customElements.define("honua-controls-legend", class extends Legend {});
      }
      document.body.append(document.createElement("honua-controls-legend"));
      const featureEditor = document.createElement("honua-feature-editor");
      featureEditor.setAttribute("for", "ops-map");
      document.body.append(featureEditor);
      swipe.position = 25;
      const legend = document.createElement("honua-legend");
      legend.items = [{ id: "csp", label: "CSP", color: "#2563eb" }];
      document.body.append(legend);
      const chart = document.createElement("honua-chart");
      chart.chartModel = {
        title: "CSP",
        data: [{ label: "CSP", value: 5, color: "#2563eb" }],
      };
      document.body.append(chart);
    });
    await page.waitForTimeout(100);

    const result = await page.evaluate(() => ({
      violations: window.__HONUA_CSP_VIOLATIONS__,
      tags: [...document.querySelectorAll("*")]
        .filter((element) => element.tagName.toLowerCase().startsWith("honua-") && element.shadowRoot)
        .map((element) => element.tagName.toLowerCase()),
      mounted: [...document.querySelectorAll("*")].filter(
        (element) => element.tagName.toLowerCase().startsWith("honua-") && element.shadowRoot,
      ).length,
    }));
    expect(result.mounted, JSON.stringify(result.tags)).toBeGreaterThanOrEqual(22);
    expect(result.violations, JSON.stringify(result.violations, null, 2)).toEqual([]);
  } finally {
    await server.close();
  }
});
