// @vitest-environment jsdom

import { beforeAll, describe, expect, it } from "vitest";

import { LegendCompat } from "../src/esri-compat/legend.js";
import { HonuaWidgetHost, registerHonuaWidgetKit } from "../src/esri-compat/widget-host.js";

/**
 * Widget-host tag-ownership verification (PR #506 review): when another
 * registrant already owns a delegation tag — e.g. the controls kit registers
 * its own `honua-legend` with an `entries` API when imported first — the host
 * must NOT mount that foreign element and assign web-components properties
 * into it; it falls back to the headless shim behavior instead.
 *
 * This lives in its own test file so the jsdom custom-element registry is
 * fresh: the foreign class must win the tag before the injected kit loader is
 * ever executed.
 */

beforeAll(() => {
  registerHonuaWidgetKit(() => import("../src/web-components/index.js"));
});

class ForeignLegendElement extends HTMLElement {}

describe("HonuaWidgetHost tag-ownership verification", () => {
  it("refuses to mount when a foreign class owns the tag, without breaking other tags", async () => {
    customElements.define("honua-legend", ForeignLegendElement);

    const container = document.createElement("div");
    document.body.append(container);

    const host = new HonuaWidgetHost("honua-legend", container);
    expect(host.available).toBe(true);
    expect(await host.mount()).toBeUndefined();
    expect(container.children).toHaveLength(0);

    // The shim path degrades to headless: LegendCompat still loads and
    // computes items, it just does not render a component into the container.
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
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(legend.items).toHaveLength(1);
    expect(container.children).toHaveLength(0);

    // Tags the kit still owns keep mounting (the kit import registered them).
    const listContainer = document.createElement("div");
    document.body.append(listContainer);
    const listHost = new HonuaWidgetHost("honua-layer-list", listContainer);
    const mounted = await listHost.mount();
    expect(mounted?.tagName.toLowerCase()).toBe("honua-layer-list");
  });

  it("refuses tags the kit does not provide at all", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const host = new HonuaWidgetHost("honua-unknown-widget", container);
    expect(await host.mount()).toBeUndefined();
  });
});
