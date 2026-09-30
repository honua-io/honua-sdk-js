// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from "vitest";

import {
  AttributionCompat,
  CompassCompat,
  FullscreenCompat,
  HomeCompat,
  ScaleBarCompat,
  ZoomCompat,
} from "../src/esri-compat/controls.js";
import { DirectionsCompat } from "../src/esri-compat/directions.js";
import { FeatureFormCompat } from "../src/esri-compat/feature-form.js";
import { FeatureLayerCompat } from "../src/esri-compat/feature-layer.js";
import { AttachmentsCompat, FeaturesCompat, ScaleRangeCompat } from "../src/esri-compat/widget-shell-hosts.js";
import { registerHonuaWidgetKit } from "../src/esri-compat/widget-host.js";
import { sampleElevations } from "../src/widget-capabilities.js";
import {
  HonuaAttachmentsElement,
  HonuaAttributionElement,
  HonuaChartElement,
  HonuaCompassElement,
  HonuaDirectionsElement,
  HonuaFeaturePagerElement,
  HonuaFullscreenElement,
  HonuaHomeElement,
  HonuaScaleBarElement,
  HonuaScaleRangeElement,
  HonuaSketchControlElement,
  HonuaZoomElement,
} from "../src/web-components/index.js";
import * as widgetKit from "../src/web-components/index.js";

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

function histogramStats(values: readonly number[]) {
  const sum = values.reduce((total, value) => total + value, 0);
  return {
    count: values.length,
    sum,
    min: Math.min(...values),
    max: Math.max(...values),
    average: sum / values.length,
  };
}

describe("widget chrome, lists, and capabilities", () => {
  beforeEach(() => {
    document.body.replaceChildren();
    registerHonuaWidgetKit(widgetKit);
  });

  it("mounts map chrome through the compat host", async () => {
    const homeCalls: unknown[] = [];
    const homeView = {
      goTo(target: unknown) {
        homeCalls.push(target);
      },
    };
    const compassView = { rotation: 40, goTo() {} };
    const home = makeContainer();
    const compass = makeContainer();
    const zoom = makeContainer();
    const scale = makeContainer();
    const fullscreen = makeContainer();
    const attribution = makeContainer();

    new HomeCompat({ view: homeView, container: home, viewpoint: { center: [1, 2], zoom: 8 } });
    new CompassCompat({ view: compassView, container: compass });
    new ZoomCompat({ view: {}, container: zoom });
    new ScaleBarCompat({ view: {}, container: scale });
    new FullscreenCompat({ view: {}, container: fullscreen });
    new AttributionCompat({ view: {}, container: attribution, attributions: ["Honua"] });

    await until(() => home.querySelector("honua-home") instanceof HonuaHomeElement, 3000, "honua-home");
    await until(() => compass.querySelector("honua-compass") instanceof HonuaCompassElement, 3000, "honua-compass");
    await until(() => zoom.querySelector("honua-zoom") instanceof HonuaZoomElement, 3000, "honua-zoom");
    await until(() => scale.querySelector("honua-scale-bar") instanceof HonuaScaleBarElement, 3000, "honua-scale-bar");
    await until(
      () => fullscreen.querySelector("honua-fullscreen") instanceof HonuaFullscreenElement,
      3000,
      "honua-fullscreen",
    );
    await until(
      () => attribution.querySelector("honua-attribution") instanceof HonuaAttributionElement,
      3000,
      "honua-attribution",
    );

    const homeElement = home.querySelector("honua-home") as HonuaHomeElement;
    await until(() => homeElement.viewpoint?.zoom === 8, 3000, "home viewpoint");
    homeElement.shadowRoot?.querySelector<HTMLButtonElement>(".maplibregl-ctrl-home")?.click();
    expect(homeCalls).toEqual([{ center: [1, 2], zoom: 8 }]);

    const compassElement = compass.querySelector("honua-compass") as HonuaCompassElement;
    await until(() => compassElement.view === compassView, 3000, "compass view");
    compassElement.shadowRoot?.querySelector<HTMLButtonElement>(".maplibregl-ctrl-compass")?.click();
    expect(compassView.rotation).toBe(0);

    expect(zoom.querySelector("honua-zoom")?.shadowRoot?.querySelector(".maplibregl-ctrl-zoom-in")).toBeTruthy();
    expect(scale.querySelector("honua-scale-bar")?.shadowRoot?.querySelector(".maplibregl-ctrl-scale")).toBeTruthy();
    expect(
      fullscreen.querySelector("honua-fullscreen")?.shadowRoot?.querySelector(".maplibregl-ctrl-fullscreen"),
    ).toBeTruthy();
    const attributionElement = attribution.querySelector("honua-attribution") as HonuaAttributionElement;
    await until(
      () => attributionElement.shadowRoot?.textContent?.includes("Honua") === true,
      3000,
      "attribution text",
    );
    expect(attributionElement.shadowRoot?.textContent).not.toContain("travel mode");
  }, 60_000);

  it("pages features, lists attachment names, sets scale range, and renders route steps only when they exist", async () => {
    const features = makeContainer();
    const attachments = makeContainer();
    const scaleRange = makeContainer();
    const withSteps = makeContainer();
    const polylineOnly = makeContainer();
    const hits = [
      { title: "Hydrant", attributes: { name: "Hydrant" } },
      { title: "Valve", attributes: { name: "Valve" } },
      { title: "Meter", attributes: { name: "Meter" } },
    ];
    new FeaturesCompat({ container: features, features: hits });
    const attachmentLayer = {
      async queryAttachments() {
        return {
          attachmentGroups: [
            {
              parentObjectId: 1,
              attachmentInfos: [
                { name: "site.jpg" },
                { name: "plan.pdf" },
              ],
            },
          ],
        };
      },
    };
    const attachmentWidget = new AttachmentsCompat({ container: attachments, layer: attachmentLayer });
    const layer = {
      minScale: 1000,
      maxScale: 5000,
      setScaleRange(min: number, max: number) {
        this.minScale = min;
        this.maxScale = max;
      },
    };
    new ScaleRangeCompat({ container: scaleRange, layer });
    const stepped = new DirectionsCompat({ container: withSteps, view: {} });
    const plain = new DirectionsCompat({ container: polylineOnly, view: {} });
    stepped.setRoute({
      path: [
        [0, 0],
        [1, 1],
      ],
      totalLengthMeters: 12,
      totalTimeSeconds: 4,
      summary: "12 m",
      directionFeatures: [{ text: "Head north", lengthKilometers: 0.01, timeMinutes: 1 }],
    } as never);
    plain.setRoute({
      path: [
        [0, 0],
        [1, 1],
      ],
      totalLengthMeters: 12,
      totalTimeSeconds: 4,
      summary: "polyline only",
    } as never);

    await until(
      () => features.querySelector("honua-feature-pager") instanceof HonuaFeaturePagerElement,
      3000,
      "honua-feature-pager",
    );
    const pager = features.querySelector("honua-feature-pager") as HonuaFeaturePagerElement;
    await until(() => pager.shadowRoot?.querySelectorAll("honua-feature-inspection").length === 3, 3000, "three pages");
    expect(pager.shadowRoot?.textContent).toContain("Hydrant");
    expect(pager.shadowRoot?.textContent).toContain("Valve");
    expect(pager.shadowRoot?.textContent).toContain("Meter");

    await attachmentWidget.load();
    await until(
      () => attachments.querySelector("honua-attachments") instanceof HonuaAttachmentsElement,
      3000,
      "honua-attachments",
    );
    const attachmentElement = attachments.querySelector("honua-attachments") as HonuaAttachmentsElement;
    await until(() => attachmentElement.shadowRoot?.textContent?.includes("site.jpg") === true, 3000, "attachment names");
    expect(attachmentElement.shadowRoot?.textContent).toContain("plan.pdf");
    expect(attachmentElement.shadowRoot?.querySelector('input[type="file"]')).toBeNull();
    expect(attachmentElement.shadowRoot?.querySelector("button")).toBeNull();

    await until(
      () => scaleRange.querySelector("honua-scale-range") instanceof HonuaScaleRangeElement,
      3000,
      "honua-scale-range",
    );
    const range = scaleRange.querySelector("honua-scale-range") as HonuaScaleRangeElement;
    await until(() => range.shadowRoot?.querySelector("input") instanceof HTMLInputElement, 3000, "scale inputs");
    const minInput = range.shadowRoot?.querySelector<HTMLInputElement>("[data-min]");
    const maxInput = range.shadowRoot?.querySelector<HTMLInputElement>("[data-max]");
    expect(minInput).toBeTruthy();
    expect(maxInput).toBeTruthy();
    if (!minInput || !maxInput) return;
    minInput.value = "100";
    maxInput.value = "200";
    minInput.dispatchEvent(new Event("change"));
    expect(layer.minScale).toBe(100);
    expect(layer.maxScale).toBe(200);
    expect(range.shadowRoot?.textContent).not.toContain("thumbnail");
    expect(range.shadowRoot?.textContent).not.toContain("region");

    await until(
      () => withSteps.querySelector("honua-directions") instanceof HonuaDirectionsElement,
      3000,
      "honua-directions",
    );
    const steppedElement = withSteps.querySelector("honua-directions") as HonuaDirectionsElement;
    await until(() => steppedElement.shadowRoot?.textContent?.includes("Head north") === true, 3000, "direction step");
    expect(steppedElement.shadowRoot?.querySelectorAll("li")).toHaveLength(1);
    expect(steppedElement.shadowRoot?.querySelector("select")).toBeNull();

    const plainElement = polylineOnly.querySelector("honua-directions") as HonuaDirectionsElement;
    await until(
      () => plainElement?.shadowRoot?.textContent?.includes("polyline only") === true,
      3000,
      "direction summary",
    );
    expect(plainElement.shadowRoot?.querySelector("li")).toBeNull();
    expect(plainElement.shadowRoot?.querySelector("ol")).toBeNull();
  }, 60_000);

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
      const zoom = new ZoomCompat({ container: container as never, view: {} });
      expect(zoom.layout).toBe("vertical");
      expect(container.children).toHaveLength(0);
    } finally {
      Object.defineProperty(globalThis, "document", { value: saved, configurable: true });
    }
  });

  it("snaps a new vertex only when snapping is on, draws histogram bins, evaluates form expressions, applies two of three edits, and samples elevation", async () => {
    const sketch = new HonuaSketchControlElement();
    document.body.append(sketch);
    sketch.snappingOptions = { enabled: true, distance: 1 };
    expect(sketch.addVertex({ x: 0, y: 0 })).toEqual({ x: 0, y: 0 });
    expect(sketch.addVertex({ x: 0.4, y: 0 })).toEqual({ x: 0, y: 0 });
    expect(sketch.addVertex({ x: 5, y: 5 })).toEqual({ x: 5, y: 5 });
    sketch.snappingOptions = { enabled: false };
    expect(sketch.addVertex({ x: 0.4, y: 0 })).toEqual({ x: 0.4, y: 0 });

    const values = [1, 2, 3, 10];
    const stats = histogramStats(values);
    const chart = document.createElement("honua-chart") as HonuaChartElement;
    document.body.append(chart);
    const equal = chart.showHistogram(values, stats, 2, "equal-interval");
    const quantile = chart.showHistogram(values, stats, 2, "quantile");
    expect(equal.map((bin) => bin.value)).not.toEqual(quantile.map((bin) => bin.value));
    for (const bin of [...equal, ...quantile]) {
      expect(bin).not.toHaveProperty("color");
      expect(Object.keys(bin).sort()).toEqual(["label", "max", "min", "value"]);
    }
    expect(chart.shadowRoot?.textContent).toContain(String(quantile[0]?.value));
    expect(chart.shadowRoot?.textContent).not.toContain("predominance");
    expect(chart.shadowRoot?.textContent).not.toContain("class-break");
    const layer = { definitionExpression: "" };
    chart.rangeLayer = layer;
    const min = chart.shadowRoot?.querySelector<HTMLInputElement>("[data-range-min]");
    const max = chart.shadowRoot?.querySelector<HTMLInputElement>("[data-range-max]");
    expect(min).toBeTruthy();
    expect(max).toBeTruthy();
    if (!min || !max) return;
    min.value = "1";
    max.value = "2.5";
    min.dispatchEvent(new Event("change"));
    expect(layer.definitionExpression).toBe("value >= 1 AND value <= 2.5");

    const form = new FeatureFormCompat({
      formTemplate: {
        fields: [
          { name: "notes", visibleExpression: "$feature.status == 'open'" },
          { name: "total", valueExpression: "$feature.a + $feature.b" },
          { name: "rank", valueExpression: "Rank($feature.a)" },
        ],
      },
    });
    form.setFeature({ attributes: { status: "closed", a: 2, b: 3 } });
    expect(form.expressionResult?.hidden).toEqual(["notes"]);
    expect(form.expressionResult?.values.total).toBe(5);
    expect(form.expressionResult?.values.rank).toBeUndefined();
    expect(form.expressionResult?.errors).toEqual([
      { field: "rank", message: "unknown function Rank in Rank($feature.a)" },
    ]);

    class RejectingLayer extends FeatureLayerCompat {
      public override async applyEdits(options: { updates?: unknown[] }) {
        const update = options.updates?.[0] as { attributes?: { id?: number } } | undefined;
        if (update?.attributes?.id === 2) {
          return { updateResults: [{ objectId: 2, success: false, error: { code: 1, description: "locked" } }] };
        }
        return { updateResults: [{ objectId: update?.attributes?.id ?? 0, success: true }] };
      }
    }
    const edits = await new RejectingLayer({ source: [] }).applyToFeatures(
      [{ attributes: { id: 1 } }, { attributes: { id: 2 } }, { attributes: { id: 3 } }],
      { status: "edited" },
    );
    expect(edits.applied).toHaveLength(2);
    expect(edits.rejected).toEqual([{ feature: { attributes: { id: 2 } }, reason: "locked" }]);
    expect(edits.applied.map((feature) => feature.attributes?.id)).toEqual([1, 3]);

    const line: [number, number][] = [
      [0, 0],
      [3, 0],
    ];
    const sampled = sampleElevations(line, { elevationAt: (longitude) => longitude }, 1);
    expect(sampled.error).toBeUndefined();
    expect(sampled.samples.map((sample) => sample.position[0])).toEqual([0, 1, 2, 3]);
    expect(sampled.samples.map((sample) => sample.elevation)).toEqual([0, 1, 2, 3]);
    expect(sampleElevations(line, undefined)).toEqual({ samples: [], error: "terrain-missing" });
  });
});
