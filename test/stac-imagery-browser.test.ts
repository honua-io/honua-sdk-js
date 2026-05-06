import { describe, expect, it } from "vitest";

import { createFixtureStacCatalogDataset } from "../examples/stac-imagery-browser/src/fixtures.js";
import {
  DEFAULT_STAC_FILTERS,
  buildStacSearchQuery,
  cancelStacPagination,
  createStacBrowserSession,
  loadNextStacPage,
  projectSelectedAsset,
  searchStacPage,
  selectStacAsset,
} from "../examples/stac-imagery-browser/src/model.js";

describe("STAC Imagery Catalog Browser sample", () => {
  it("constructs STAC search parameters for AOI, time, collection, cloud cover, and asset type", () => {
    const query = buildStacSearchQuery(DEFAULT_STAC_FILTERS, 2);

    expect(query).toEqual({
      collections: ["sentinel-2-l2a"],
      bbox: [-158.18, 21.22, -157.7, 21.58],
      datetime: "2026-04-01T00:00:00Z/2026-05-05T23:59:59Z",
      limit: 2,
      query: {
        "eo:cloud_cover": { lte: 25 },
        "assets.type": { eq: "image/png" },
      },
    });
  });

  it("paginates incrementally and preserves an explicit cancellation state", () => {
    const dataset = createFixtureStacCatalogDataset();
    const firstPage = searchStacPage(dataset, DEFAULT_STAC_FILTERS, 0, 2);
    const session = createStacBrowserSession(dataset, DEFAULT_STAC_FILTERS);
    const next = loadNextStacPage(session);
    const cancelled = cancelStacPagination(next);
    const controller = new AbortController();
    controller.abort();
    const abortedPage = searchStacPage(dataset, DEFAULT_STAC_FILTERS, 2, 2, controller.signal);

    expect(firstPage.items.map((item) => item.id)).toEqual([
      "S2A_20260412T211901_OAHU_01",
      "S2B_20260418T212029_OAHU_02",
    ]);
    expect(firstPage.nextOffset).toBe(2);
    expect(next.loadedItems.map((item) => item.id)).toEqual([
      "S2A_20260412T211901_OAHU_01",
      "S2B_20260418T212029_OAHU_02",
      "S2A_20260501T211859_OAHU_04",
    ]);
    expect(next.paginationStatus).toBe("complete");
    expect(cancelled.paginationStatus).toBe("cancelled");
    expect(abortedPage.status).toBe("cancelled");
  });

  it("projects selected assets into renderable preview layers or unsupported raster messaging", () => {
    const session = createStacBrowserSession();
    const visualSession = selectStacAsset(session, "S2A_20260412T211901_OAHU_01", "visual");
    const cogSession = selectStacAsset(session, "S2A_20260412T211901_OAHU_01", "cog");
    const item = session.dataset.items[0];
    const thumbnail = item?.assets.find((asset) => asset.key === "thumbnail");

    expect(visualSession.projection).toMatchObject({
      itemId: "S2A_20260412T211901_OAHU_01",
      assetKey: "visual",
      renderable: true,
      previewLayer: { kind: "tile", label: "Honua tile preview" },
    });
    expect(visualSession.projection?.linkedView.selection).toEqual(["S2A_20260412T211901_OAHU_01"]);
    expect(cogSession.projection?.renderable).toBe(false);
    expect(cogSession.projection?.message).toContain("Raster band math and coverage export are not enabled");
    expect(item && thumbnail ? projectSelectedAsset(item, thumbnail).previewLayer?.kind : undefined).toBe("thumbnail");
  });
});
