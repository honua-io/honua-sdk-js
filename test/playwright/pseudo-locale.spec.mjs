import fs from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";

import { startWebComponentsFixtureServer } from "../../examples/web-components-basic/mock-server.mjs";

const qualification = JSON.parse(
  fs.readFileSync(path.resolve("config/component-qualification.v1.json"), "utf8"),
);
const CATALOG_COMPONENTS = qualification.components;

// The fixture uses the canonical web-components implementation for contested
// tags. The controls layer-list is mounted under its explicit test alias; the
// controls legend is already the explicit registrant in the fixture.
const HOSTS = {
  "controls.basemap-switcher": "honua-basemap-switcher",
  "controls.swipe-control": "honua-swipe-control",
  "controls.legend": "honua-legend",
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

function componentIds() {
  return CATALOG_COMPONENTS.map(({ id }) => id);
}

test.describe("pseudo-locale component qualification", () => {
  test("renders every catalog component and exercises expanded labels", async ({ page }) => {
    const server = await startWebComponentsFixtureServer();
    try {
      await page.setViewportSize({ width: 280, height: 720 });
      await page.goto(`${server.url}?controls-layer-list=1`);
      // The fixture intentionally uses same-origin mock data. The demo's ready
      // flag depends on network-backed startup, so the component qualification
      // lane waits for the custom elements to mount rather than gating on demo
      // data readiness.
      await page.waitForTimeout(500);

      await page.evaluate(() => {
        const map = document.querySelector("honua-map");
        const swipe = document.createElement("honua-swipe-control");
        swipe.id = "pseudo-swipe";
        swipe.map = map?.map;
        document.body.append(swipe);

        const featureEditor = document.createElement("honua-feature-editor");
        featureEditor.id = "pseudo-feature-editor";
        featureEditor.setAttribute("for", "ops-map");
        featureEditor.setAttribute("source", "incidents");
        document.body.append(featureEditor);

        const basemapControl = document.createElement("honua-basemap-control");
        basemapControl.id = "pseudo-basemap-control";
        basemapControl.setAttribute("for", "ops-map");
        document.body.append(basemapControl);

        const featureInspection = document.createElement("honua-feature-inspection");
        featureInspection.id = "pseudo-feature-inspection";
        featureInspection.setAttribute("label", "Incident inspection");
        document.body.append(featureInspection);

        const controlsLayerList = document.createElement("honua-controls-layer-list");
        controlsLayerList.id = "pseudo-controls-layer-list";
        controlsLayerList.map = map?.map;
        controlsLayerList.overlays = [{ id: "incident-points", label: "Incident response halos", layers: ["incident-points"] }];
        document.body.append(controlsLayerList);
      });
      await page.waitForTimeout(250);

      const result = await page.evaluate(({ hosts, ids }) => {
        const localize = (value) => {
          if (!/\p{L}/u.test(value)) return value;
          const accents = { a: "á", e: "ë", i: "ï", o: "ö", u: "ü", A: "Á", E: "Ë", I: "Ï", O: "Ö", U: "Ü" };
          const expanded = [...value].map((character) => accents[character] ?? character).join("");
          return `［${expanded}${"·".repeat(Math.max(0, Math.ceil([...value].length * 1.35) - [...expanded].length))}］`;
        };
        const byId = new Map();
        for (const id of ids) {
          const selector = hosts[id];
          const candidates = [...document.querySelectorAll(selector)];
          const element = id === "controls.layer-list"
            ? document.querySelector("#pseudo-controls-layer-list")
            : id === "controls.swipe-control"
              ? document.querySelector("#pseudo-swipe")
              : id === "web-components.feature-editor"
                ? document.querySelector("#pseudo-feature-editor")
                : id === "web-components.basemap-control"
                  ? document.querySelector("#pseudo-basemap-control")
                  : id === "web-components.feature-inspection"
                    ? document.querySelector("#pseudo-feature-inspection")
                    : candidates[0];
          if (element) byId.set(id, element);
        }

        const failures = [];
        const expanded = [];
        const visit = (root, owner) => {
          for (const node of root.querySelectorAll("*") ) {
            if (node.tagName === "STYLE" || node.tagName === "SCRIPT") continue;
            if (node.shadowRoot) visit(node.shadowRoot, owner);
            if (node.textContent?.trim()) {
              for (const textNode of node.childNodes) {
                if (textNode.nodeType === Node.TEXT_NODE && textNode.textContent?.trim()) {
                  textNode.textContent = textNode.textContent.replace(/\S[\s\S]*\S|\S/u, (text) => localize(text));
                  expanded.push({ owner, kind: "text", value: textNode.textContent });
                }
              }
            }
            for (const name of ["aria-label", "title", "placeholder"]) {
              const value = node.getAttribute(name);
              if (value?.trim()) {
                node.setAttribute(name, localize(value));
                expanded.push({ owner, kind: name, value: node.getAttribute(name) });
              }
            }
          }
        };

        for (const [id, host] of byId) {
          host.style.width = "280px";
          host.style.maxWidth = "280px";
          host.style.minWidth = "0";
          host.style.display = "block";
          if (host.shadowRoot) visit(host.shadowRoot, id);
        }

        const check = (root, owner) => {
          for (const node of root.querySelectorAll("*")) {
            if (node.tagName === "STYLE" || node.tagName === "SCRIPT") continue;
            if (node.classList.contains("sr-only")) continue;
            const style = getComputedStyle(node);
            const rect = node.getBoundingClientRect();
            if (rect.width <= 0 || rect.height <= 0 || style.display === "none") continue;
            const text = node.textContent?.trim() ?? "";
            if (!text) {
              if (node.shadowRoot) check(node.shadowRoot, owner);
              continue;
            }
            const scrollsHorizontally = style.overflowX === "auto" || style.overflowX === "scroll";
            const scrollsVertically = style.overflowY === "auto" || style.overflowY === "scroll";
            const clips = (node.scrollWidth > node.clientWidth + 1 && !scrollsHorizontally) ||
              (node.scrollHeight > node.clientHeight + 1 && !scrollsVertically);
            const truncates = style.textOverflow === "ellipsis" ||
              (style.whiteSpace === "nowrap" && style.overflow === "hidden");
            if (clips || truncates) failures.push({ owner, tag: node.tagName.toLowerCase(), clips, truncates, text: text.slice(0, 120) });
            if (node.shadowRoot) check(node.shadowRoot, owner);
          }
        };
        for (const [id, host] of byId) if (host.shadowRoot) check(host.shadowRoot, id);
        return { ids, mounted: [...byId.keys()], expandedCount: expanded.length, failures };
      }, { hosts: HOSTS, ids: componentIds() });

      expect(result.mounted, `mounted=${JSON.stringify(result.mounted)} ids=${JSON.stringify(componentIds())}`).toEqual(
        expect.arrayContaining(componentIds()),
      );
      expect(result.mounted).toHaveLength(componentIds().length);
      expect(result.expandedCount).toBeGreaterThan(20);
      expect(result.failures, JSON.stringify(result.failures, null, 2)).toEqual([]);
    } finally {
      await server.close();
    }
  });
});
