import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { generateWidgetSurvivalGuideMarkdown, validateGuideLinks } from "../scripts/generate-widget-survival-guide.mjs";
import { SUPPORTED_ARCGIS_MODULES } from "../src/migration/codemod.js";
import * as widgetDispositionData from "../src/migration/widget-dispositions.js";
import {
  WIDGET_DISPOSITIONS,
  WIDGET_DISPOSITION_DOCUMENTATION,
  WIDGET_DISPOSITION_KINDS,
  WIDGET_SURVIVAL_GUIDE_PATH,
  widgetNameFromModulePath,
} from "../src/migration/widget-dispositions.js";

const GUIDE_PATH = path.join(process.cwd(), WIDGET_SURVIVAL_GUIDE_PATH);
// Every row that names a native custom element. Kept explicit so adding or
// removing one is a deliberate edit rather than a silent drift — the epic in
// honua-sdk-js#1315 overstated its own scope by roughly 2x precisely because
// nothing tied the disposition rows to the elements that actually ship.
const NATIVE_ELEMENT_COMPONENTS = [
  { widget: "AreaMeasurement2D", tagName: "honua-measurement", source: "src/web-components/measurement.ts" },
  { widget: "DistanceMeasurement2D", tagName: "honua-measurement", source: "src/web-components/measurement.ts" },
  { widget: "Editor", tagName: "honua-editor", source: "src/web-components/elements.ts" },
  { widget: "FeatureTable", tagName: "honua-feature-table", source: "src/web-components/elements.ts" },
  { widget: "LayerList", tagName: "honua-layer-list", source: "src/web-components/elements.ts" },
  { widget: "Legend", tagName: "honua-legend", source: "src/web-components/elements.ts" },
  { widget: "Measurement", tagName: "honua-measurement", source: "src/web-components/measurement.ts" },
  { widget: "Print", tagName: "honua-print-export", source: "src/web-components/elements.ts" },
  { widget: "Search", tagName: "honua-search", source: "src/web-components/elements.ts" },
  { widget: "Sketch", tagName: "honua-sketch-control", source: "src/web-components/elements.ts" },
  { widget: "TimeSlider", tagName: "honua-time-slider", source: "src/web-components/time-slider.ts" },
] as const;
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

  it("keeps documentation-only component metadata off the public runtime rows", () => {
    for (const entry of WIDGET_DISPOSITIONS) {
      const expectedKeys = ["amdModules", "disposition", "esmModules", "notes", "target", "widget"];
      if (entry.shimSource) expectedKeys.push("shimSource");
      expect(Object.keys(entry).sort()).toEqual(expectedKeys.sort());
      expect("appPlatformComponent" in entry).toBe(false);
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
      if (
        entry.disposition === "automated" ||
        entry.disposition === "compat-shim" ||
        entry.disposition === "app-platform"
      ) {
        expect(entry.shimSource, `${entry.widget} must record its shim source`).toBeDefined();
        expect(fs.existsSync(path.join(process.cwd(), entry.shimSource!))).toBe(true);
      }
    }
  });

  it("states a measured parity delta for every compat-shim and manual-workaround row", () => {
    // honua-sdk-js#1315 AC-1. `compat-shim` describes the migration path, not
    // the absence of a native element, so a row without a delta is an invitation
    // to re-estimate the work from the label — which is how that epic came to
    // overstate itself by roughly 2x.
    for (const entry of WIDGET_DISPOSITION_DOCUMENTATION) {
      if (
        entry.disposition !== "compat-shim" &&
        entry.disposition !== "app-platform" &&
        entry.disposition !== "manual-workaround"
      ) {
        continue;
      }
      expect(entry.parityDelta, `${entry.widget} must state what the native component does not cover`).toBeDefined();
      expect(entry.parityDelta!.trim().length).toBeGreaterThan(0);
      expect(entry.parityDelta!, `${entry.widget} parity delta must not be a placeholder`).not.toMatch(
        /\bTBD\b|\bunknown\b/i,
      );
    }
  });

  it("keeps the parity delta off the public runtime rows", () => {
    for (const entry of WIDGET_DISPOSITIONS) {
      expect("parityDelta" in entry).toBe(false);
    }
  });

  it("names only custom elements this kit actually registers", async () => {
    // The claim "a native element ships" is only worth making if the tag is in
    // the element registry. Registering into a throwaway registry proves it
    // without asserting against a duplicated list of tag names.
    const { defineHonuaWebComponent } = await import("../src/web-components/elements.js");
    const tagNames = new Set(
      WIDGET_DISPOSITION_DOCUMENTATION.flatMap((entry) =>
        entry.appPlatformComponent ? [entry.appPlatformComponent.tagName] : [],
      ),
    );
    expect(tagNames.size).toBeGreaterThan(0);
    for (const tagName of tagNames) {
      const defined = new Map<string, CustomElementConstructor>();
      const registry = {
        get: (name: string) => defined.get(name),
        define: (name: string, ctor: CustomElementConstructor) => {
          defined.set(name, ctor);
        },
      } as unknown as CustomElementRegistry;
      defineHonuaWebComponent(tagName, registry);
      expect(defined.has(tagName), `<${tagName}> is named in widget-dispositions but is not a registered element`).toBe(
        true,
      );
    }
  });

  it("names a native element on every app-platform row and on no compat-shim row", () => {
    // #1315 AC-2. The two labels differ only in whether a native element ships,
    // so that has to be structurally true rather than a matter of narration —
    // reading `compat-shim` as "no native component" is what produced the
    // original 2x overestimate.
    for (const entry of WIDGET_DISPOSITION_DOCUMENTATION) {
      if (entry.disposition === "app-platform") {
        expect(entry.appPlatformComponent, `${entry.widget} is app-platform but names no native element`).toBeDefined();
      }
      if (entry.disposition === "compat-shim") {
        expect(
          entry.appPlatformComponent,
          `${entry.widget} names a native element, so it belongs in app-platform`,
        ).toBeUndefined();
      }
    }
  });

  it("records the native-element components in the shared disposition data", () => {
    const componentRows = WIDGET_DISPOSITION_DOCUMENTATION.filter((entry) => entry.appPlatformComponent);
    expect(componentRows.map((entry) => entry.widget).sort()).toEqual(
      NATIVE_ELEMENT_COMPONENTS.map((entry) => entry.widget).sort(),
    );

    for (const expected of NATIVE_ELEMENT_COMPONENTS) {
      const component = WIDGET_DISPOSITION_DOCUMENTATION.find(
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

  it("links every native-element row to its app-platform component with generated usage", () => {
    const guide = fs.readFileSync(GUIDE_PATH, "utf8");
    for (const expected of NATIVE_ELEMENT_COMPONENTS) {
      const summaryRow = guide.split("\n").find((line) => line.startsWith(`| [${expected.widget}]`));
      expect(summaryRow).toContain(
        `Direct app-platform component: [\`<${expected.tagName}>\`](../${expected.source}) from \`@honua/app-platform/web-components\``,
      );
      const usageHtml = WIDGET_DISPOSITION_DOCUMENTATION.find((entry) => entry.widget === expected.widget)
        ?.appPlatformComponent?.usageHtml;
      if (!usageHtml) throw new Error(`${expected.widget} is missing app-platform usage markup`);
      expect(guide).toContain('```ts doc-test=skip reason="requires the separately published app-platform package"');
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
