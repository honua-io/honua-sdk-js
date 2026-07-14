import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { generateWidgetSurvivalGuideMarkdown, validateGuideLinks } from "../scripts/generate-widget-survival-guide.mjs";
import { SUPPORTED_ARCGIS_MODULES } from "../src/migration/codemod.js";
import * as widgetDispositionData from "../src/migration/widget-dispositions.js";
import {
  WIDGET_DISPOSITIONS,
  WIDGET_DISPOSITION_KINDS,
  WIDGET_SURVIVAL_GUIDE_PATH,
  widgetNameFromModulePath,
} from "../src/migration/widget-dispositions.js";

const GUIDE_PATH = path.join(process.cwd(), WIDGET_SURVIVAL_GUIDE_PATH);
const SURVIVAL_TIER_COMPONENTS = [
  { widget: "LayerList", tagName: "honua-layer-list", source: "src/web-components/elements.ts" },
  { widget: "Legend", tagName: "honua-legend", source: "src/web-components/elements.ts" },
  { widget: "Measurement", tagName: "honua-measurement", source: "src/web-components/measurement.ts" },
  { widget: "Search", tagName: "honua-search", source: "src/web-components/elements.ts" },
] as const;
type WidgetDispositionWithDocumentation = (typeof WIDGET_DISPOSITIONS)[number] & {
  appPlatformComponent?: {
    moduleSpecifier: string;
    tagName: string;
    source: string;
    usageHtml: string;
  };
};
const WIDGET_DISPOSITIONS_WITH_DOCUMENTATION = WIDGET_DISPOSITIONS as readonly WidgetDispositionWithDocumentation[];

describe("widget disposition data", () => {
  it("has unique widget names and module paths", () => {
    const widgets = WIDGET_DISPOSITIONS.map((entry) => entry.widget);
    expect(new Set(widgets).size).toBe(widgets.length);
    const modules = WIDGET_DISPOSITIONS.flatMap((entry) => [...entry.esmModules, ...entry.amdModules]);
    expect(new Set(modules).size).toBe(modules.length);
  });

  it("uses exactly one disposition from the fixed taxonomy per widget, with no bare TBD rows", () => {
    for (const entry of WIDGET_DISPOSITIONS) {
      expect(WIDGET_DISPOSITION_KINDS).toContain(entry.disposition);
      expect(entry.target.trim().length).toBeGreaterThan(0);
      expect(entry.notes.trim().length).toBeGreaterThan(0);
      expect(entry.target).not.toMatch(/\bTBD\b/i);
      expect(entry.notes).not.toMatch(/\bTBD\b/i);
    }
  });

  it("maps every module path back to its own widget", () => {
    for (const entry of WIDGET_DISPOSITIONS) {
      for (const modulePath of [...entry.esmModules, ...entry.amdModules]) {
        expect(widgetNameFromModulePath(modulePath)).toBe(entry.widget);
      }
    }
  });

  it("grounds shim-backed dispositions in real files under src/esri-compat/", () => {
    for (const entry of WIDGET_DISPOSITIONS) {
      if (entry.disposition === "automated" || entry.disposition === "compat-shim") {
        expect(entry.shimSource, `${entry.widget} must record its shim source`).toBeDefined();
        expect(fs.existsSync(path.join(process.cwd(), entry.shimSource!))).toBe(true);
      }
    }
  });

  it("records the four survival-tier app-platform components in the shared disposition data", () => {
    const componentRows = WIDGET_DISPOSITIONS_WITH_DOCUMENTATION.filter((entry) => entry.appPlatformComponent);
    expect(componentRows.map((entry) => entry.widget).sort()).toEqual(
      SURVIVAL_TIER_COMPONENTS.map((entry) => entry.widget).sort(),
    );

    for (const expected of SURVIVAL_TIER_COMPONENTS) {
      const component = WIDGET_DISPOSITIONS_WITH_DOCUMENTATION.find(
        (entry) => entry.widget === expected.widget,
      )?.appPlatformComponent;
      expect(component).toMatchObject({
        moduleSpecifier: "@honua/app-platform/web-components",
        tagName: expected.tagName,
        source: expected.source,
      });
      expect(component?.usageHtml).toContain(`<${expected.tagName}`);
      expect(component?.usageHtml).toContain('<honua-map id="map">');
      expect(fs.existsSync(path.join(process.cwd(), expected.source))).toBe(true);
    }
  });

  it("covers every widget module the codemod can rewrite (scanner/codemod consistency)", () => {
    const knownWidgets = new Set(WIDGET_DISPOSITIONS.map((entry) => entry.widget));
    const codemodWidgetModules = SUPPORTED_ARCGIS_MODULES.filter((modulePath) =>
      modulePath.startsWith("@arcgis/core/widgets/"),
    );
    expect(codemodWidgetModules.length).toBeGreaterThan(0);
    for (const modulePath of codemodWidgetModules) {
      const widget = widgetNameFromModulePath(modulePath);
      expect(widget, modulePath).toBeDefined();
      expect(knownWidgets.has(widget!), `${modulePath} is missing from widget-dispositions`).toBe(true);
    }
  });
});

describe("widget survival guide", () => {
  it("is up to date with the disposition data (regeneration is clean)", () => {
    const generated = generateWidgetSurvivalGuideMarkdown(widgetDispositionData);
    const current = fs.existsSync(GUIDE_PATH) ? fs.readFileSync(GUIDE_PATH, "utf8") : "";
    // Normalize line endings so Windows checkouts (core.autocrlf) do not fail on EOL alone.
    expect(
      current.replace(/\r\n/g, "\n"),
      `${WIDGET_SURVIVAL_GUIDE_PATH} has drifted from src/migration/widget-dispositions.ts; run npm run docs:widget-guide`,
    ).toBe(generated);
  });

  it("contains an anchor section for every widget", () => {
    const guide = fs.readFileSync(GUIDE_PATH, "utf8");
    for (const entry of WIDGET_DISPOSITIONS) {
      expect(guide).toContain(`### ${entry.widget}`);
    }
  });

  it("links every survival-tier row to its app-platform component with generated usage", () => {
    const guide = fs.readFileSync(GUIDE_PATH, "utf8");
    for (const expected of SURVIVAL_TIER_COMPONENTS) {
      const summaryRow = guide.split("\n").find((line) => line.startsWith(`| [${expected.widget}]`));
      expect(summaryRow).toContain(
        `Direct app-platform component: [\`<${expected.tagName}>\`](../${expected.source}) from \`@honua/app-platform/web-components\``,
      );
      const usageHtml = WIDGET_DISPOSITIONS_WITH_DOCUMENTATION.find((entry) => entry.widget === expected.widget)
        ?.appPlatformComponent?.usageHtml;
      if (!usageHtml) throw new Error(`${expected.widget} is missing app-platform usage markup`);
      expect(guide).toContain(`import "@honua/app-platform/web-components";`);
      expect(guide).toContain(usageHtml);
    }
  });

  it("states the deprecation/removal framing and out-of-scope surfaces", () => {
    const guide = fs.readFileSync(GUIDE_PATH, "utf8");
    expect(guide).toContain("as early as Q1 2027");
    expect(guide).toContain("SceneView / 3D rendering");
    expect(guide).toContain("Locator");
    expect(guide).toContain("Geoprocessor");
  });

  it("has no broken relative links", () => {
    const guide = fs.readFileSync(GUIDE_PATH, "utf8");
    expect(() => validateGuideLinks(guide, WIDGET_SURVIVAL_GUIDE_PATH, process.cwd())).not.toThrow();
  });
});
