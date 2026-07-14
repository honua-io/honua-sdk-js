// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";

import { SampleCleanupRegistry } from "../examples/_kit/cleanup.js";
import { mountSamplePresentation } from "../examples/_kit/presentation.js";
import { runServiceExplorerWorkflow } from "../examples/service-explorer/src/workflow.js";
import type { StandaloneDataset } from "../examples/standalone-quickstart/src/data.js";
import { renderStandaloneFeatureList } from "../examples/standalone-quickstart/src/presentation.js";
import { runStandaloneWorkflow } from "../examples/standalone-quickstart/src/workflow.js";

describe("sample presentation", () => {
  it("rolls back listeners and timers rejected after cleanup completed", async () => {
    const registry = new SampleCleanupRegistry();
    await registry.dispose();
    const target = new EventTarget();
    const listener = vi.fn();
    expect(() => registry.listen(target, "probe", listener)).toThrow("after disposal completed");
    target.dispatchEvent(new Event("probe"));
    expect(listener).not.toHaveBeenCalled();

    const timeout = vi.spyOn(window, "clearTimeout");
    const interval = vi.spyOn(window, "clearInterval");
    expect(() => registry.timeout(() => undefined, 1)).toThrow("after disposal completed");
    expect(() => registry.interval(() => undefined, 1)).toThrow("after disposal completed");
    expect(timeout).toHaveBeenCalledOnce();
    expect(interval).toHaveBeenCalledOnce();
    timeout.mockRestore();
    interval.mockRestore();
  });

  it("runs async disposal once and exposes a rejection without an unhandled promise", async () => {
    let calls = 0;
    const presentation = mountSamplePresentation({
      sampleId: "presentation-test",
      evidence: { mode: "fixture" },
      async onDispose() {
        calls += 1;
        throw new Error("cleanup refused");
      },
    });
    const button = presentation.root.querySelector<HTMLButtonElement>("[data-testid='honua-sample-dispose']");
    button?.click();
    button?.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toBe(1);
    expect(button?.disabled).toBe(true);
    expect(presentation.root.querySelector("[role='alert']")?.textContent).toContain("cleanup refused");
    presentation.root.remove();
  });

  it("updates evidence and renders remote feature attributes as text, never markup", () => {
    const presentation = mountSamplePresentation({
      sampleId: "safe-text-test",
      evidence: { mode: "starting" },
    });
    presentation.updateEvidence({ endpoint: '<img src=x onerror="globalThis.pwned=true">' });
    expect(presentation.root.querySelector("img")).toBeNull();
    expect(presentation.root.textContent).toContain("<img src=x");

    const list = document.createElement("ul");
    const dataset = {
      geojson: {
        type: "FeatureCollection",
        features: [
          {
            type: "Feature",
            properties: { NAME: "<script>throw new Error('xss')</script>", detail: "<img src=x>" },
            geometry: null,
          },
        ],
      },
    } as unknown as StandaloneDataset;
    renderStandaloneFeatureList(list, dataset);
    expect(list.querySelector("script, img")).toBeNull();
    expect(list.textContent).toContain("<script>");
    presentation.root.remove();
  });

  it("aborts the in-flight esri-compat query when the copyable workflow is disposed", async () => {
    const controller = new AbortController();
    let queryCount = 0;
    const fetchFn = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      if (!url.includes("/query")) {
        return new Response(
          JSON.stringify({
            id: 0,
            name: "Abort test layer",
            type: "Feature Layer",
            geometryType: "esriGeometryPoint",
            fields: [],
            capabilities: "Query",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      queryCount += 1;
      if (queryCount === 1) {
        return new Response(
          JSON.stringify({
            objectIdFieldName: "OBJECTID",
            geometryType: "esriGeometryPoint",
            spatialReference: { wkid: 4326 },
            fields: [],
            features: [],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      });
    });
    const workflow = runStandaloneWorkflow(
      {
        featureLayerUrl: "https://example.test/rest/services/abort/FeatureServer/0",
        where: "1=1",
        outFields: ["*"],
        maxPages: 1,
        basemapStyle: "about:blank",
        sourceId: "abort-test",
      },
      { fetchFn, signal: controller.signal },
    );
    await vi.waitFor(() => expect(queryCount).toBe(2));
    controller.abort(new DOMException("disposed", "AbortError"));
    await expect(workflow).rejects.toMatchObject({ name: "HonuaNetworkError", cause: { name: "AbortError" } });
    expect(controller.signal.aborted).toBe(true);
  });

  it("does not convert service-explorer cancellation into fixture degradation", async () => {
    const controller = new AbortController();
    const fetchFn = vi.fn<typeof fetch>(async (_input, init) => {
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      });
    });
    const workflow = runServiceExplorerWorkflow(
      {
        honuaBaseUrl: "https://example.test",
        mode: "cloud",
        serviceId: "abort-test",
        layerId: 0,
        where: "1=1",
        resultRecordCount: 10,
        mapMoveDebounceMs: 10,
      },
      { fetchFn, signal: controller.signal },
    );
    await vi.waitFor(() => expect(fetchFn).toHaveBeenCalled());
    controller.abort(new DOMException("disposed", "AbortError"));
    await expect(workflow).rejects.toMatchObject({ name: "AbortError" });
    expect(controller.signal.aborted).toBe(true);
  });
});
