// @vitest-environment jsdom

import fs from "node:fs";
import path from "node:path";

import { beforeEach, describe, expect, it } from "vitest";

import { BasemapGalleryCompat } from "../src/esri-compat/basemap-gallery.js";
import { BookmarksCompat } from "../src/esri-compat/bookmarks.js";
import { BasemapToggleCompat, LocateCompat } from "../src/esri-compat/controls.js";
import { EditorCompat } from "../src/esri-compat/editor.js";
import { CompatEventBus } from "../src/esri-compat/event-bus.js";
import { FeatureFormCompat } from "../src/esri-compat/feature-form.js";
import { FeatureTableCompat } from "../src/esri-compat/feature-table.js";
import { MeasurementCompat } from "../src/esri-compat/measurement.js";
import { PopupCompat } from "../src/esri-compat/popup.js";
import { PrintCompat } from "../src/esri-compat/print.js";
import { SearchCompat } from "../src/esri-compat/search.js";
import { SketchCompat } from "../src/esri-compat/sketch.js";
import { registerHonuaWidgetKit } from "../src/esri-compat/widget-host.js";

/**
 * Hosted compat widgets mount the kit class that owns their tag and copy shim
 * state onto that element. With no kit the container stays empty and
 * `widget-kit.missing` fires once per runtime.
 */

async function until(predicate: () => boolean, timeoutMs = 3000, label = "condition"): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error(`${label} not reached in time`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function makeContainer(): HTMLElement {
  const container = document.createElement("div");
  document.body.append(container);
  return container;
}

describe("hosted compat widgets", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    registerHonuaWidgetKit(() => import("../src/web-components/index.js"));
  });

  it("mounts each kit class and shows a later shim change on the element", async () => {
    const kit = await import("../src/web-components/index.js");
    const view = { id: "view" };
    const layer = { id: "layer" };
    const source = {
      async search() {
        return [];
      },
    };
    const otherSource = {
      async search() {
        return [];
      },
    };
    const feature = { attributes: { name: "elm" } };
    const nextFeature = { attributes: { name: "oak" } };
    const template = { title: "{name}" };
    const snapping = { enabled: true };
    const nextSnapping = { enabled: false };

    const searchContainer = makeContainer();
    const search = new SearchCompat({
      view,
      container: searchContainer,
      sources: [source],
      includeDefaultSources: false,
    });
    search.setActiveSource(otherSource);

    const measurementContainer = makeContainer();
    const measurement = new MeasurementCompat({ view, container: measurementContainer, activeTool: "distance" });
    measurement.start("area");

    const editorContainer = makeContainer();
    const editor = new EditorCompat({
      view,
      container: editorContainer,
      layerInfos: [{ layer }],
      snappingOptions: snapping,
    });
    editor.setSnappingOptions(nextSnapping);

    const formContainer = makeContainer();
    const form = new FeatureFormCompat({
      view,
      container: formContainer,
      layer,
      feature,
      formTemplate: template,
    });
    form.setFeature(nextFeature);

    const tableContainer = makeContainer();
    const table = new FeatureTableCompat({
      view,
      container: tableContainer,
      layer: layer as never,
      fieldConfigs: [{ name: "name" }],
    });
    table.setVisibleFields(["name", "height"]);

    const bookmarksContainer = makeContainer();
    const bookmarks = new BookmarksCompat({ view, container: bookmarksContainer, bookmarks: [{ name: "Start" }] });
    bookmarks.add({ name: "Park" });

    const galleryContainer = makeContainer();
    const gallery = new BasemapGalleryCompat({ view, container: galleryContainer, source: [{ id: "streets" }] });
    gallery.setBasemaps([{ id: "streets" }, { id: "imagery" }]);

    const toggleContainer = makeContainer();
    const toggle = new BasemapToggleCompat({
      view,
      container: toggleContainer,
      map: { basemap: { id: "streets" } },
      nextBasemap: { id: "imagery" },
    });
    toggle.toggle();

    const locateContainer = makeContainer();
    const locate = new LocateCompat({
      view,
      container: locateContainer,
      locateProvider: async () => ({ coords: { latitude: 1, longitude: 2 } }),
    });
    await locate.locate();

    const sketchContainer = makeContainer();
    const sketch = new SketchCompat({ view, container: sketchContainer, layer, snappingOptions: snapping });
    sketch.setSnappingOptions(nextSnapping);

    const printContainer = makeContainer();
    const print = new PrintCompat({ view, container: printContainer, templateOptions: { format: "pdf" } });
    print.setFormat("png32");

    const popupContainer = makeContainer();
    const popup = new PopupCompat({ view, container: popupContainer });
    popup.open({ features: [feature], title: "Elm", content: template });

    const cases = [
      {
        container: searchContainer,
        tag: "honua-search",
        ctor: kit.HonuaSearchElement,
        read: (element: HTMLElement) => {
          expect((element as { view?: unknown }).view).toBe(view);
          expect((element as { activeSource?: unknown }).activeSource).toBe(otherSource);
        },
      },
      {
        container: measurementContainer,
        tag: "honua-measurement",
        ctor: kit.HonuaMeasurementElement,
        read: (element: HTMLElement) => {
          expect((element as { activeTool?: unknown }).activeTool).toBe("area");
        },
      },
      {
        container: editorContainer,
        tag: "honua-editor",
        ctor: kit.HonuaEditorElement,
        read: (element: HTMLElement) => {
          expect((element as { layer?: unknown }).layer).toBe(layer);
          expect((element as { snappingOptions?: { enabled?: boolean } }).snappingOptions?.enabled).toBe(false);
        },
      },
      {
        container: formContainer,
        tag: "honua-feature-editor",
        ctor: kit.HonuaFeatureEditorElement,
        read: (element: HTMLElement) => {
          expect((element as { feature?: unknown }).feature).toBe(nextFeature);
          expect((element as { formTemplate?: unknown }).formTemplate).toBe(template);
        },
      },
      {
        container: tableContainer,
        tag: "honua-feature-table",
        ctor: kit.HonuaFeatureTableElement,
        read: (element: HTMLElement) => {
          expect((element as { visibleFields?: readonly string[] }).visibleFields).toEqual(["name", "height"]);
        },
      },
      {
        container: bookmarksContainer,
        tag: "honua-bookmarks",
        ctor: kit.HonuaBookmarksElement,
        read: (element: HTMLElement) => {
          expect((element as { bookmarkList?: { name: string }[] }).bookmarkList?.map((item) => item.name)).toEqual([
            "Start",
            "Park",
          ]);
        },
      },
      {
        container: galleryContainer,
        tag: "honua-basemap-control",
        ctor: kit.HonuaBasemapControlElement,
        read: (element: HTMLElement) => {
          expect((element as { mode?: string }).mode).toBe("gallery");
          expect((element as { basemaps?: { id: string }[] }).basemaps).toEqual([{ id: "streets" }, { id: "imagery" }]);
        },
      },
      {
        container: toggleContainer,
        tag: "honua-basemap-control",
        ctor: kit.HonuaBasemapControlElement,
        read: (element: HTMLElement) => {
          expect((element as { mode?: string }).mode).toBe("toggle");
          expect((element as { nextBasemap?: { id?: string } }).nextBasemap?.id).toBe("streets");
        },
      },
      {
        container: locateContainer,
        tag: "honua-locate-control",
        ctor: kit.HonuaLocateControlElement,
        read: (element: HTMLElement) => {
          expect((element as { locateState?: string }).locateState).toBe("ready");
          expect((element as { view?: unknown }).view).toBe(view);
        },
      },
      {
        container: sketchContainer,
        tag: "honua-sketch-control",
        ctor: kit.HonuaSketchControlElement,
        read: (element: HTMLElement) => {
          expect((element as { layer?: unknown }).layer).toBe(layer);
          expect((element as { snappingOptions?: { enabled?: boolean } }).snappingOptions?.enabled).toBe(false);
        },
      },
      {
        container: printContainer,
        tag: "honua-print-export",
        ctor: kit.HonuaPrintExportElement,
        read: (element: HTMLElement) => {
          expect((element as { format?: string }).format).toBe("png32");
        },
      },
      {
        container: popupContainer,
        tag: "honua-feature-inspection",
        ctor: kit.HonuaFeatureInspectionElement,
        read: (element: HTMLElement) => {
          expect((element as { selectedFeature?: unknown }).selectedFeature).toBe(feature);
          expect((element as { template?: unknown }).template).toBe(template);
        },
      },
    ];

    for (const entry of cases) {
      await until(() => entry.container.querySelector(entry.tag) instanceof entry.ctor, 3000, entry.tag);
      const element = entry.container.querySelector(entry.tag);
      expect(element, entry.tag).toBeInstanceOf(entry.ctor);
      entry.read(element as HTMLElement);
    }
  }, 60_000);

  it("leaves every hosted container empty and warns once when no kit is registered", async () => {
    registerHonuaWidgetKit(undefined);
    const calls: unknown[][] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => {
      calls.push(args);
    };
    try {
      const bus = new CompatEventBus();
      const events: unknown[] = [];
      bus.on("widget-kit.missing", (event) => {
        events.push(event);
      });
      const containers = [makeContainer(), makeContainer(), makeContainer()];
      new SearchCompat({ container: containers[0], view: {}, eventBus: bus, includeDefaultSources: false });
      new MeasurementCompat({ container: containers[1], view: {}, eventBus: bus });
      new PopupCompat({ container: containers[2], view: {}, eventBus: bus });
      await new Promise((resolve) => setTimeout(resolve, 30));
      for (const container of containers) {
        expect(container.children).toHaveLength(0);
      }
      expect(events).toHaveLength(1);
      expect(calls).toHaveLength(1);
    } finally {
      console.warn = original;
    }
  });

  it("does not touch a DOM when no document exists", () => {
    const saved = globalThis.document;
    Object.defineProperty(globalThis, "document", { value: undefined, configurable: true });
    try {
      const container = {
        appendChild() {
          throw new Error("touched the DOM");
        },
        children: [],
      };
      const search = new SearchCompat({ container: container as never, view: {}, includeDefaultSources: false });
      expect(search.view).toEqual({});
      expect(container.children).toHaveLength(0);
    } finally {
      Object.defineProperty(globalThis, "document", { value: saved, configurable: true });
    }
  });

  it("does not import the web-components kit from the compat sources", () => {
    const root = path.resolve(import.meta.dirname, "../src/esri-compat");
    const files = fs.readdirSync(root).filter((name) => name.endsWith(".ts"));
    for (const name of files) {
      const source = fs.readFileSync(path.join(root, name), "utf8");
      const code = source
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "")
        .replace(/`(?:\\[\s\S]|[^`\\])*`/g, "''")
        .replace(/'(?:\\[^\n]|[^'\n\\])*'/g, "''")
        .replace(/"(?:\\[^\n]|[^"\n\\])*"/g, '""');
      expect(code, name).not.toMatch(/from\s+["'][^"']*web-components/);
      expect(code, name).not.toMatch(/import\(\s*["'][^"']*web-components/);
    }
  });
});
