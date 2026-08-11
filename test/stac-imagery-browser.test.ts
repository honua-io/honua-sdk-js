import { describe, expect, it, vi } from "vitest";

import {
  MAUI_BOUNDS,
  MAUI_DATETIME,
  mauiSearchRequest,
} from "../examples/stac-imagery-browser/src/dynamic-stac-example.js";
import { MAUI_ITEMS, createStacFixtureEnvironment } from "../examples/stac-imagery-browser/src/fixtures.js";
import { HonuaAbortError } from "../src/core/errors.js";
import { createDynamicStacClient } from "../src/stac/index.js";

describe("STAC imagery browser product evidence", () => {
  it("searches Maui with the exact bounded product request", () => {
    expect(mauiSearchRequest("POST")).toMatchObject({
      method: "POST",
      collections: ["sentinel-2-l2a"],
      bbox: MAUI_BOUNDS,
      datetime: MAUI_DATETIME,
      filterLang: "cql2-json",
      filter: { op: "<=", args: [{ property: "eo:cloud_cover" }, 20] },
      sortby: [{ field: "properties.datetime", direction: "desc" }],
    });
  });

  it.each(["GET", "POST"] as const)("pages a %s search through a relative next link", async (method) => {
    const fixture = createStacFixtureEnvironment(createDynamicStacClient, { pageDelayMs: 0 });
    const ids: Array<string | number> = [];

    for await (const item of fixture.stac.items({
      ...mauiSearchRequest(method),
      pageSize: 2,
      maxPages: 2,
    })) {
      if (item.id !== undefined) ids.push(item.id);
    }

    const searches = fixture.trace.filter(
      (entry) => entry.stage === "request" && new URL(entry.url).pathname.endsWith("/search"),
    );
    expect(ids).toEqual(MAUI_ITEMS.map((item) => item.id));
    expect(searches.map((entry) => entry.method)).toEqual([method, method]);
    expect(new URL(searches[1]?.url ?? "https://invalid.test").pathname).toBe("/v1/search");
    if (method === "POST") expect(searches[1]?.body?.token).toBe("maui-page-2");
    else expect(new URL(searches[1]?.url ?? "https://invalid.test").searchParams.get("token")).toBe("maui-page-2");
  });

  it("selects an asset without extension declarations and filters before signing", async () => {
    const fixture = createStacFixtureEnvironment(createDynamicStacClient, { pageDelayMs: 0 });
    const item = MAUI_ITEMS[0];

    expect(item?.stac_extensions).toBeUndefined();
    const selected = await fixture.stac.selectAsset(item!, {
      assetKeys: ["visual", "tiles", "metadata"],
      formats: ["cog"],
      roles: ["data"],
    });

    expect(selected).toMatchObject({
      key: "visual",
      format: "cog",
      handoff: { kind: "cog", packageExport: "@honua/sdk-js/cog" },
    });
    expect(fixture.trace.filter((entry) => entry.stage === "sign").map((entry) => entry.assetKey)).toEqual(["visual"]);
  });

  it("cancels a pending relative page request", async () => {
    const fixture = createStacFixtureEnvironment(createDynamicStacClient, { pageDelayMs: 250 });
    const controller = new AbortController();
    const pages = fixture.stac.pages({
      ...mauiSearchRequest("POST", controller.signal),
      pageSize: 2,
      maxPages: 2,
    });

    expect((await pages.next()).value).toHaveLength(2);
    const pending = pages.next();
    await vi.waitFor(() =>
      expect(fixture.trace.filter((entry) => entry.stage === "request" && entry.method === "POST")).toHaveLength(2),
    );
    controller.abort();

    await expect(pending).rejects.toBeInstanceOf(HonuaAbortError);
    expect(fixture.trace.some((entry) => entry.stage === "cancel" && entry.method === "ABORT")).toBe(true);
  });

  it("uses iterator truth for a partial page with next and a full final page", async () => {
    const partialWithNext = createStacFixtureEnvironment(createDynamicStacClient, {
      pageDelayMs: 0,
      pages: [[MAUI_ITEMS[0]!], [MAUI_ITEMS[1]!, MAUI_ITEMS[2]!]],
    }).stac.pages({ ...mauiSearchRequest("GET"), pageSize: 2, maxPages: 3 });

    expect(await partialWithNext.next()).toMatchObject({ done: false, value: [{ id: MAUI_ITEMS[0]?.id }] });
    expect(await partialWithNext.next()).toMatchObject({
      done: false,
      value: [{ id: MAUI_ITEMS[1]?.id }, { id: MAUI_ITEMS[2]?.id }],
    });
    expect((await partialWithNext.next()).done).toBe(true);

    const fullFinal = createStacFixtureEnvironment(createDynamicStacClient, {
      pageDelayMs: 0,
      pages: [[MAUI_ITEMS[0]!, MAUI_ITEMS[1]!]],
    }).stac.pages({ ...mauiSearchRequest("POST"), pageSize: 2, maxPages: 2 });

    expect(await fullFinal.next()).toMatchObject({ done: false, value: [{}, {}] });
    expect((await fullFinal.next()).done).toBe(true);
  });

  it("keeps each Sentinel platform truthful", () => {
    expect(MAUI_ITEMS.map((item) => [item.id, item.properties?.platform])).toEqual([
      ["S2B_MAUI_20260502_WEST", "sentinel-2b"],
      ["S2A_MAUI_20260424_CENTRAL", "sentinel-2a"],
      ["S2B_MAUI_20260418_EAST", "sentinel-2b"],
    ]);
  });
});
