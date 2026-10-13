import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import ts from "typescript";
import { probeFirstMap, readMapObservation } from "../../scripts/lib/create-honua-app-browser.mjs";

describe("scaffold rendered data observation", () => {
  for (const template of ["vanilla-ts", "react-ts"]) {
    it(`${template} observes only the mounted data source and removes listeners`, async () => {
      const source = readFileSync(new URL(`../../packages/create-honua-app/templates/${template}/src/rendered-features.ts`, import.meta.url), "utf8");
      const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext } }).outputText;
      const { observeRenderedFeatures, STARTER_SOURCE_ID } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);
      const dataset = {};
      const handlers = new Map();
      let loaded = false;
      let count = 0;
      let queries = 0;
      let ownedLayer = true;
      const map = {
        getContainer: () => ({ dataset }),
        isStyleLoaded: () => loaded,
        getStyle: () => ({ layers: [{ id: "background" }, { id: "basemap", source: "other" }, ...(ownedLayer ? [{ id: "data", source: STARTER_SOURCE_ID }] : [])] }),
        queryRenderedFeatures: (geometry, options) => {
          queries++;
          assert.equal(geometry, undefined);
          assert.deepEqual(options, { layers: ["data"] });
          return Array.from({ length: count }, () => ({ source: STARTER_SOURCE_ID }));
        },
        on: (event, handler) => handlers.set(event, handler),
        off: (event, handler) => { assert.equal(handlers.get(event), handler); handlers.delete(event); },
      };
      const stop = observeRenderedFeatures(map);
      assert.equal(queries, 0);
      assert.equal(dataset.honuaRenderedFeatures, "0");
      loaded = true;
      handlers.get("render")();
      assert.equal(dataset.honuaRenderedFeatures, "0");
      count = 3;
      handlers.get("idle")();
      assert.equal(dataset.honuaRenderedFeatures, "3");
      assert.equal(dataset.honuaMapState, "mounted");
      ownedLayer = false;
      const before = queries;
      handlers.get("render")();
      assert.equal(dataset.honuaRenderedFeatures, "0");
      assert.equal(queries, before, "must not query all layers when only basemap layers remain");
      stop();
      assert.equal(handlers.size, 0);
      assert.deepEqual(dataset, {});
    });
  }

  it("does not replace absent rendered evidence with queried rows or a canvas", () => {
    const original = globalThis.document;
    try {
      globalThis.document = {
        querySelector: (selector) => selector === ".maplibregl-canvas" ? {} : null,
        getElementById: () => ({ textContent: "250" }),
      };
      assert.deepEqual(readMapObservation(), { mapMounted: false, canvasPresent: true, renderedFeatureCount: 0 });
      globalThis.document.querySelector = (selector) => selector === ".maplibregl-canvas" ? {} : { getAttribute: () => "3" };
      assert.deepEqual(readMapObservation(), { mapMounted: true, canvasPresent: true, renderedFeatureCount: 3 });
      for (const value of ["", "3 rows", "-1", "NaN", "9007199254740992"]) {
        globalThis.document.querySelector = (selector) => selector === ".maplibregl-canvas" ? {} : { getAttribute: () => value };
        assert.equal(readMapObservation().renderedFeatureCount, 0);
      }
    } finally { globalThis.document = original; }
  });

  it("preserves observed canvas, errors and off-origin requests on timeout and closes the browser", async () => {
    const original = globalThis.document;
    const journey = { mapMounted: false, canvasPresent: false, renderedFeatureCount: 0, consoleErrors: [], externalRequests: [] };
    const handlers = new Map();
    let closed = false;
    try {
      globalThis.document = { querySelector: (selector) => selector === ".maplibregl-canvas" ? {} : null };
      const page = {
        on: (event, handler) => handlers.set(event, handler),
        goto: async () => {
          handlers.get("console")({ type: () => "error", text: () => "actual console error" });
          handlers.get("pageerror")(new Error("actual page error"));
          for (const url of ["http://localhost:123/a", "blob:http://localhost:123/worker", "data:text/plain,hello", "http://localhost:123.evil/a"]) {
            handlers.get("request")({ url: () => url });
          }
        },
        waitForSelector: async () => {},
        waitForFunction: async (predicate, _arg, options) => {
          assert.equal(options.timeout, 45_000);
          assert.equal(predicate(), false);
          throw new Error("retained timeout");
        },
        evaluate: async (fn) => fn(),
      };
      await assert.rejects(probeFirstMap("http://localhost:123", journey, { launch: async () => ({ newPage: async () => page, close: async () => { closed = true; } }) }), /retained timeout/);
      assert.equal(journey.canvasPresent, true);
      assert.equal(journey.mapMounted, false);
      assert.equal(journey.renderedFeatureCount, 0);
      assert.deepEqual(journey.consoleErrors, ["actual console error", "actual page error"]);
      assert.deepEqual(journey.externalRequests, ["http://localhost:123.evil/a"]);
      assert.equal(closed, true);
    } finally { globalThis.document = original; }
  });
});
