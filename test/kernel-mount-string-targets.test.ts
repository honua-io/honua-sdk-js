import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SourceDescriptor } from "../src/contract/types.js";
import { PROTOCOL_DEFAULT_CAPABILITIES } from "../src/contract/types.js";
import { createHonuaKernel } from "../src/kernel/index.js";
import { maplibreRenderer } from "../src/runtime/index.js";
import { FakeMap, emptyResult, fixture } from "./helpers/kernel-mount-fixtures.js";

describe("connection MapLibre mount: string targets in a DOM host", () => {
  // MapLibre treats a string container as an element id, so "#map" (the README
  // and quickstart form) must be resolved to its element before construction.
  const element = { nodeType: 1, id: "map" };
  const lookups: string[] = [];
  const fakeDocument = {
    getElementById: (id: string) => {
      lookups.push(`id:${id}`);
      return id === "map" ? element : null;
    },
    querySelector: (selector: string) => {
      lookups.push(`selector:${selector}`);
      if (selector === "##") throw new SyntaxError("'##' is not a valid selector.");
      return selector === "#map" || selector === "main > .map" ? element : null;
    },
  };

  async function mountTarget(target: string): Promise<{ created: Readonly<Record<string, unknown>>[] }> {
    const descriptor: SourceDescriptor = {
      id: "imagery",
      protocol: "maplibre-raster",
      locator: { url: "https://tiles.example.test/owned/{z}/{x}/{y}.png" },
      capabilities: PROTOCOL_DEFAULT_CAPABILITIES["maplibre-raster"],
    };
    const data = fixture<Record<string, unknown>>(
      descriptor,
      vi.fn(async () => emptyResult<Record<string, unknown>>()),
    );
    const kernel = createHonuaKernel({ connectDelegate: async () => data.connection });
    const connection = await kernel.connect(descriptor.locator.url, { protocol: "maplibre-raster" });
    const created: Readonly<Record<string, unknown>>[] = [];
    const maps: FakeMap[] = [];
    class InjectedMap extends FakeMap {
      constructor(options: Readonly<Record<string, unknown>>) {
        super();
        created.push(options);
        maps.push(this);
      }
    }
    try {
      const mounted = await connection.mount(target, {
        renderer: maplibreRenderer({ Map: InjectedMap }),
        style: "auto",
      });
      maps[0]!.emit("render");
      await mounted.ready;
    } finally {
      await kernel.dispose();
    }
    return { created };
  }

  beforeEach(() => {
    lookups.length = 0;
    vi.stubGlobal("document", fakeDocument);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each(["#map", "main > .map"])("resolves the CSS selector %s to its element", async (target) => {
    const { created } = await mountTarget(target);
    expect(created).toHaveLength(1);
    expect(created[0]!.container).toBe(element);
  });

  it("keeps MapLibre's element-id form and prefers it over a selector", async () => {
    const { created } = await mountTarget("map");
    expect(created[0]!.container).toBe(element);
    expect(lookups).toEqual(["id:map"]);
  });

  it("keeps the string for a document shim without element lookup", async () => {
    vi.stubGlobal("document", {});
    const { created } = await mountTarget("#map");
    expect(created[0]!.container).toBe("#map");
  });

  it.each(["#missing", "##"])("refuses %s before constructing a map", async (target) => {
    await expect(mountTarget(target)).rejects.toThrow(/matches no element/);
    expect(lookups).toEqual([`id:${target}`, `selector:${target}`]);
  });
});
