// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { type CompatEvent, CompatEventBus } from "../src/esri-compat/event-bus.js";
import { LayerListCompat } from "../src/esri-compat/layer-list.js";
import { LegendCompat } from "../src/esri-compat/legend.js";
import { HonuaWidgetHost, registerHonuaWidgetKit } from "../src/esri-compat/widget-host.js";

/**
 * Missing-widget-kit diagnostic (issue #957). Compat widget shims render real
 * UI only after the application injects the web-component kit; before #957 a
 * mount without one silently no-opped, so a migrated app came up blank with
 * zero signal. The first such mount now emits exactly one `console.warn` plus
 * one `widget-kit.missing` bus event naming `registerHonuaWidgetKit`.
 *
 * The latch is module-scoped and re-armed by `registerHonuaWidgetKit`, so each
 * test resets it explicitly through the public API rather than a test-only
 * escape hatch.
 */

const DOCS_URL =
  "https://github.com/honua-io/honua-sdk-js/blob/trunk/docs/migration-honua-maplibre.md#widget-kit-registration";

let warn: ReturnType<typeof vi.spyOn>;

function makeContainer(id: string): HTMLElement {
  const container = document.createElement("div");
  container.id = id;
  document.body.append(container);
  return container;
}

function collectMissingKitEvents(bus: CompatEventBus): CompatEvent<unknown>[] {
  const events: CompatEvent<unknown>[] = [];
  bus.on("widget-kit.missing", (event) => events.push(event as CompatEvent<unknown>));
  return events;
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 5; index += 1) {
    await Promise.resolve();
  }
}

/** Shims render through fire-and-forget `void host.update(...)` calls. */
async function until(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("condition not reached in time");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

beforeEach(() => {
  document.body.innerHTML = "";
  // Re-arms the one-time diagnostic, then leaves the host with no kit.
  registerHonuaWidgetKit(undefined);
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  warn.mockRestore();
  registerHonuaWidgetKit(undefined);
});

describe("missing widget-kit diagnostic", () => {
  it("warns once with an actionable message when no kit is registered", async () => {
    const bus = new CompatEventBus();
    const events = collectMissingKitEvents(bus);

    const host = new HonuaWidgetHost("honua-legend", makeContainer("legend-container"), bus);
    expect(await host.mount()).toBeUndefined();

    expect(warn).toHaveBeenCalledTimes(1);
    const message = String(warn.mock.calls[0]?.[0]);
    expect(message).toContain("honua-legend");
    expect(message).toContain('registerHonuaWidgetKit(() => import("@honua/sdk-js/web-components"))');
    expect(message).toContain(DOCS_URL);

    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("widget-kit.missing");
    expect(events[0]?.payload).toMatchObject({
      tagName: "honua-legend",
      api: "registerHonuaWidgetKit",
      docs: DOCS_URL,
      message,
    });
    expect(events[0]?.source).toBe(host);
  });

  it("emits once per runtime, not once per widget instance", async () => {
    const bus = new CompatEventBus();
    const events = collectMissingKitEvents(bus);

    const legendHost = new HonuaWidgetHost("honua-legend", makeContainer("legend-container"), bus);
    const listHost = new HonuaWidgetHost("honua-layer-list", makeContainer("list-container"), bus);

    expect(await legendHost.mount()).toBeUndefined();
    expect(await listHost.mount()).toBeUndefined();
    // Repeat mounts of the same host stay quiet too.
    expect(await legendHost.mount()).toBeUndefined();

    expect(warn).toHaveBeenCalledTimes(1);
    expect(events).toHaveLength(1);
  });

  it("stays silent once a kit is registered", async () => {
    registerHonuaWidgetKit(() => import("../src/web-components/index.js"));
    const bus = new CompatEventBus();
    const events = collectMissingKitEvents(bus);

    const host = new HonuaWidgetHost("honua-legend", makeContainer("legend-container"), bus);
    const element = await host.mount();

    expect(element?.tagName.toLowerCase()).toBe("honua-legend");
    expect(warn).not.toHaveBeenCalled();
    expect(events).toEqual([]);
  });

  it("stays silent for headless shims that never resolved a container", async () => {
    const bus = new CompatEventBus();
    const events = collectMissingKitEvents(bus);

    const host = new HonuaWidgetHost("honua-legend", "no-such-container-id", bus);
    expect(host.available).toBe(false);
    expect(await host.mount()).toBeUndefined();

    expect(warn).not.toHaveBeenCalled();
    expect(events).toEqual([]);
  });

  it("drops a previously mounted element when the kit is unregistered", async () => {
    registerHonuaWidgetKit(() => import("../src/web-components/index.js"));
    const bus = new CompatEventBus();
    const events = collectMissingKitEvents(bus);
    const container = makeContainer("legend-container");
    const host = new HonuaWidgetHost("honua-legend", container, bus);

    const element = await host.mount();
    expect(element?.tagName.toLowerCase()).toBe("honua-legend");
    expect(container.children).toHaveLength(1);

    // The documented unregister flow must return the shim to state-model-only
    // mode rather than stranding a live component that no longer updates.
    registerHonuaWidgetKit(undefined);
    await host.update((mounted) => {
      mounted.items = [{ id: "stale", label: "Stale" }];
    });

    expect(container.children).toHaveLength(0);
    expect(element?.isConnected).toBe(false);
    expect(host.element).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(events).toHaveLength(1);

    // Re-registering mounts a fresh element into the same container.
    registerHonuaWidgetKit(() => import("../src/web-components/index.js"));
    const remounted = await host.mount();
    expect(remounted?.tagName.toLowerCase()).toBe("honua-legend");
    expect(remounted).not.toBe(element);
    expect(container.children).toHaveLength(1);
  });

  it("clears rendered LegendCompat UI when the kit is unregistered mid-flight", async () => {
    registerHonuaWidgetKit(() => import("../src/web-components/index.js"));
    const container = makeContainer("legend-container");
    const legend = new LegendCompat({
      map: {
        layers: [
          {
            id: "parcels",
            title: "Parcels",
            visible: true,
            getLegend: () => ({
              layers: [{ layerId: 0, layerName: "Parcels", legend: [{ label: "Residential" }] }],
            }),
          },
        ],
      },
      container,
    });
    await legend.load();
    await until(() => container.querySelector("honua-legend") !== null);

    registerHonuaWidgetKit(undefined);
    await legend.refresh();
    await until(() => container.querySelector("honua-legend") === null);

    // State model survives; only the rendering degrades.
    expect(legend.items).toHaveLength(1);
    expect(warn).toHaveBeenCalledTimes(1);
    legend.destroy();
  });

  it("rebinds LayerListCompat toggles to the element remounted after a kit cycle", async () => {
    registerHonuaWidgetKit(() => import("../src/web-components/index.js"));
    const container = makeContainer("list-container");
    const roads = { id: "roads", title: "Roads", visible: true };
    const layerList = new LayerListCompat({ map: { layers: [roads] }, container });
    await layerList.load();
    await until(() => container.querySelector("honua-layer-list")?.shadowRoot?.textContent?.includes("Roads") === true);

    registerHonuaWidgetKit(undefined);
    await layerList.refresh();
    await until(() => container.querySelector("honua-layer-list") === null);

    registerHonuaWidgetKit(() => import("../src/web-components/index.js"));
    await layerList.refresh();
    await until(() => container.querySelector("honua-layer-list")?.shadowRoot?.textContent?.includes("Roads") === true);

    // The remounted element is a new node: its change listener must have been
    // rebound, or toggles silently stop reaching the shim.
    const checkbox = container
      .querySelector("honua-layer-list")
      ?.shadowRoot?.querySelector<HTMLInputElement>("input[data-layer-id='roads']");
    expect(checkbox?.checked).toBe(true);
    checkbox!.checked = false;
    checkbox!.dispatchEvent(new Event("change"));
    await until(() => roads.visible === false);

    layerList.destroy();
  });

  it("re-arms when the kit is registered and then unregistered again", async () => {
    const bus = new CompatEventBus();
    const events = collectMissingKitEvents(bus);
    const host = new HonuaWidgetHost("honua-legend", makeContainer("legend-container"), bus);

    await host.mount();
    expect(warn).toHaveBeenCalledTimes(1);

    registerHonuaWidgetKit(() => import("../src/web-components/index.js"));
    await host.mount();
    expect(warn).toHaveBeenCalledTimes(1);

    registerHonuaWidgetKit(undefined);
    await host.mount();
    expect(warn).toHaveBeenCalledTimes(2);
    expect(events).toHaveLength(2);
  });

  it("reaches the shim event bus from LegendCompat and LayerListCompat", async () => {
    const eventBus = new CompatEventBus();
    const events = collectMissingKitEvents(eventBus);
    const layer = {
      id: "parcels",
      title: "Parcels",
      visible: true,
      getLegend: () => ({
        layers: [{ layerId: 0, layerName: "Parcels", legend: [{ label: "Residential" }] }],
      }),
    };

    const legend = new LegendCompat({
      map: { layers: [layer] },
      container: makeContainer("legend-container"),
      eventBus,
    });
    await legend.load();
    const layerList = new LayerListCompat({
      map: { layers: [layer] },
      container: makeContainer("list-container"),
      eventBus,
    });
    await layerList.load();
    await flushMicrotasks();

    // The shims still compute their state model; only the rendering degrades.
    expect(legend.items).toHaveLength(1);
    expect(layerList.items).toHaveLength(1);
    expect(document.getElementById("legend-container")?.children).toHaveLength(0);

    expect(warn).toHaveBeenCalledTimes(1);
    expect(events).toHaveLength(1);
    expect(events[0]?.payload).toMatchObject({ api: "registerHonuaWidgetKit" });

    legend.destroy();
    layerList.destroy();
  });
});
