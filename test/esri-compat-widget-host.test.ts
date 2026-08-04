// @vitest-environment jsdom

import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { LayerListCompat } from "../src/esri-compat/layer-list.js";
import { LegendCompat } from "../src/esri-compat/legend.js";
import { TimeSliderCompat } from "../src/esri-compat/time-slider.js";
import { HonuaWidgetHost, registerHonuaWidgetKit } from "../src/esri-compat/widget-host.js";

/**
 * esri-compat widget delegation (issue #493 REQ-004): Legend / LayerList
 * shims constructed with a `container` render through the survival-tier
 * `<honua-legend>` / `<honua-layer-list>` components via `HonuaWidgetHost`.
 *
 * The kit is injected by the application (`registerHonuaWidgetKit`) — the
 * compat entrypoint never imports it, keeping the /esri-compat bundle budget
 * intact. These suites register a lazy loader up front, matching app wiring.
 */

beforeAll(() => {
  registerHonuaWidgetKit(() => import("../src/web-components/index.js"));
});

async function until(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("condition not reached in time");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function makeContainer(): HTMLElement {
  const container = document.createElement("div");
  container.id = "widget-container";
  document.body.append(container);
  return container;
}

describe("HonuaWidgetHost", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("stays headless while no kit is registered, and picks up a later registration", async () => {
    registerHonuaWidgetKit(undefined);
    try {
      const container = makeContainer();
      const host = new HonuaWidgetHost("honua-legend", container);
      expect(host.available).toBe(true);
      expect(await host.mount()).toBeUndefined();
      expect(container.children).toHaveLength(0);

      // Late registration (the app wires the kit after the shim exists).
      registerHonuaWidgetKit(() => import("../src/web-components/index.js"));
      const element = await host.mount();
      expect(element?.tagName.toLowerCase()).toBe("honua-legend");
    } finally {
      registerHonuaWidgetKit(() => import("../src/web-components/index.js"));
    }
  });

  it("stays headless when the registered loader throws", async () => {
    registerHonuaWidgetKit(() => {
      throw new Error("kit unavailable");
    });
    try {
      const host = new HonuaWidgetHost("honua-legend", makeContainer());
      expect(await host.mount()).toBeUndefined();
    } finally {
      registerHonuaWidgetKit(() => import("../src/web-components/index.js"));
    }
  });

  it("resolves containers from elements and ids, and mounts the component", async () => {
    const container = makeContainer();
    const byElement = new HonuaWidgetHost("honua-legend", container);
    expect(byElement.available).toBe(true);
    const byId = new HonuaWidgetHost("honua-legend", "widget-container");
    expect(byId.available).toBe(true);
    const missing = new HonuaWidgetHost("honua-legend", "no-such-id");
    expect(missing.available).toBe(false);
    expect(await missing.mount()).toBeUndefined();

    const element = await byElement.mount();
    expect(element?.tagName.toLowerCase()).toBe("honua-legend");
    expect(container.querySelector("honua-legend")).toBe(element);

    // Mounting again reuses the element.
    expect(await byElement.mount()).toBe(element);

    byElement.destroy();
    expect(container.querySelector("honua-legend")).toBeNull();
  });
});

describe("LegendCompat delegation", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("renders shim legend items through <honua-legend>", async () => {
    const container = makeContainer();
    const layer = {
      id: "parcels",
      title: "Parcels",
      visible: true,
      getLegend: () => ({
        layers: [
          {
            layerId: 0,
            layerName: "Parcels",
            legend: [
              { label: "Residential", imageData: "QQ==", contentType: "image/png", width: 16, height: 16 },
              { label: "Commercial", imageData: "Qg==", contentType: "image/png", width: 16, height: 16 },
            ],
          },
        ],
      }),
    };
    const legend = new LegendCompat({ map: { layers: [layer] }, container });
    await legend.load();

    await until(
      () => container.querySelector("honua-legend")?.shadowRoot?.textContent?.includes("Residential") === true,
    );
    const element = container.querySelector("honua-legend");
    const text = element?.shadowRoot?.textContent ?? "";
    expect(text).toContain("Commercial");
    const icon = element?.shadowRoot?.querySelector("img.swatch");
    expect(icon?.getAttribute("src")).toBe("data:image/png;base64,QQ==");

    legend.destroy();
    expect(container.querySelector("honua-legend")).toBeNull();
  });
});

describe("LayerListCompat delegation", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("renders shim rows through <honua-layer-list> and routes toggles back to the shim", async () => {
    const container = makeContainer();
    const roads = { id: "roads", title: "Roads", visible: true };
    const parcels = { id: "parcels", title: "Parcels", visible: true };
    const layerList = new LayerListCompat({ map: { layers: [roads, parcels] }, container });
    await layerList.load();

    await until(() => container.querySelector("honua-layer-list")?.shadowRoot?.textContent?.includes("Roads") === true);
    const element = container.querySelector("honua-layer-list");
    const checkbox = element?.shadowRoot?.querySelector<HTMLInputElement>("input[data-layer-id='roads']");
    expect(checkbox?.checked).toBe(true);

    // Unchecking routes through LayerListCompat.toggle and mutates the layer.
    checkbox!.checked = false;
    checkbox!.dispatchEvent(new Event("change"));
    await until(() => roads.visible === false);
    expect(layerList.items.find((item) => item.id === "roads")).toBeUndefined();

    // includeHidden=false drops the row after refresh; the remaining row stays.
    await until(
      () => container.querySelector("honua-layer-list")?.shadowRoot?.textContent?.includes("Roads") === false,
    );
    expect(container.querySelector("honua-layer-list")?.shadowRoot?.textContent).toContain("Parcels");

    layerList.destroy();
    expect(container.querySelector("honua-layer-list")).toBeNull();
  });
});

describe("TimeSliderCompat delegation", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("renders the shim transport through <honua-time-slider> and routes gestures back to the shim", async () => {
    const container = makeContainer();
    const slider = new TimeSliderCompat({
      container,
      fullTimeExtent: { start: "2026-06-01T00:00:00.000Z", end: "2026-06-15T00:00:00.000Z" },
      timeExtent: { start: "2026-06-01T00:00:00.000Z", end: "2026-06-03T00:00:00.000Z" },
      stops: { interval: { value: 1, unit: "days" } },
    });
    await slider.load();
    await until(() => container.querySelector("honua-time-slider")?.shadowRoot != null);

    const element = container.querySelector("honua-time-slider");
    const scrubber = element?.shadowRoot?.querySelector("[data-time-slider]");
    // The adapter satisfies the element's playback contract: bounds come from
    // the shim's own full time extent, not from a snapshot the shim pushed.
    expect(scrubber?.getAttribute("role")).toBe("slider");
    expect(scrubber?.getAttribute("aria-valuemin")).toBe(String(Date.parse("2026-06-01T00:00:00.000Z")));
    expect(scrubber?.getAttribute("aria-valuemax")).toBe(String(Date.parse("2026-06-13T00:00:00.000Z")));
    expect(scrubber?.getAttribute("aria-valuenow")).toBe(String(Date.parse("2026-06-01T00:00:00.000Z")));
    // The shim's playRate is construction-only, so the element hides the speed
    // control rather than offering a rate change it cannot honour.
    expect(element?.shadowRoot?.querySelector("[data-time-speed]")).toBeNull();

    // A real key event on the element moves the shim's own timeExtent.
    scrubber?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }));
    expect(slider.timeExtent?.start.toISOString()).toBe("2026-06-02T00:00:00.000Z");

    element?.shadowRoot?.querySelector<HTMLButtonElement>("[data-time-toggle]")?.click();
    expect(slider.playing).toBe(true);
    expect(element?.shadowRoot?.querySelector("[data-time-toggle]")?.getAttribute("aria-pressed")).toBe("true");

    slider.destroy();
    expect(container.querySelector("honua-time-slider")).toBeNull();
  });

  it("mounts the declared degraded state when the widget has no full time extent", async () => {
    const container = makeContainer();
    const slider = new TimeSliderCompat({ container });
    await slider.load();
    await until(() => container.querySelector("honua-time-slider")?.shadowRoot != null);

    const element = container.querySelector("honua-time-slider");
    expect(element?.getAttribute("unavailable-reason")).toContain("no usable time-info metadata");
    expect(element?.shadowRoot?.querySelector("[data-time-slider]")?.getAttribute("aria-disabled")).toBe("true");
    expect(element?.shadowRoot?.querySelector<HTMLButtonElement>("[data-time-toggle]")?.disabled).toBe(true);
    slider.destroy();
  });
});
