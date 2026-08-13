import { expect, test } from "@playwright/test";

import { startStacBrowserFixtureServer } from "../../examples/stac-imagery-browser/mock-server.mjs";
import { STAC_FIXTURE_AUTH_SENTINEL } from "../../examples/stac-imagery-browser/src/fixture-auth-sentinel.ts";

test.setTimeout(90_000);

test("STAC Walkthrough proves Maui search, pagination, signing, rendering, and cancellation", async ({ page }) => {
  const pageErrors = [];
  const consoleErrors = [];
  const failedRequests = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("requestfailed", (request) => failedRequests.push(`${request.method()} ${request.url()}`));

  const server = await startStacBrowserFixtureServer();
  try {
    await page.addInitScript(() => {
      const revokedObjectUrls = [];
      const revokeObjectUrl = URL.revokeObjectURL.bind(URL);
      Object.defineProperty(window, "__STAC_REVOKED_OBJECT_URLS__", { value: revokedObjectUrls });
      URL.revokeObjectURL = (url) => {
        revokedObjectUrls.push(String(url));
        revokeObjectUrl(url);
      };
    });
    await page.goto(server.url);
    await expect.poll(async () => page.evaluate(() => window.__HONUA_STAC_BROWSER__?.ready === true)).toBe(true);

    await expect(page.getByRole("heading", { name: "Find the clearest recent view of Maui." })).toBeVisible();
    await expect(page.locator("#method-state")).toHaveText("POST Item Search");
    await expect(page.locator("#page-state")).toContainText("2 loaded / ready for next page");
    await expect(page.locator("#result-list")).toContainText("West Maui cloud break");
    await expect(page.locator("#item-metadata")).toContainText("None required");
    await expect(page.locator("#asset-preview")).toBeVisible();
    await expect(page.locator("#asset-preview")).toHaveAttribute("src", /^blob:/);

    const pngToPmtiles = await page.evaluate(async () => {
      const runtime = window.__HONUA_STAC_BROWSER__;
      const itemId = runtime?.selectedItemId ?? "";
      const initialPreviewUrl = document.querySelector("#asset-preview")?.getAttribute("src") ?? "";
      const older = runtime?.selectAsset(itemId, "preview");
      await new Promise((resolve) => setTimeout(resolve, 10));
      const newer = runtime?.selectAsset(itemId, "tiles");
      const clearedSynchronously =
        document.querySelector("#asset-preview")?.hasAttribute("src") === false &&
        runtime?.mapSelectionSourceIds.length === 0 &&
        runtime?.mapSelectionLayerIds.length === 0;
      await Promise.all([older, newer]);
      return {
        initialPreviewUrl,
        clearedSynchronously,
        selectedAssetKey: runtime?.selectedAssetKey,
        selectedAssetFormat: runtime?.selectedAssetFormat,
        sourceIds: runtime?.mapSelectionSourceIds,
        layerIds: runtime?.mapSelectionLayerIds,
        inspectionVersion: runtime?.pmtilesInspection?.metadata.specVersion,
        trace: runtime?.trace ?? [],
        previewSrc: document.querySelector("#asset-preview")?.getAttribute("src") ?? "",
        revokedObjectUrls: window.__STAC_REVOKED_OBJECT_URLS__,
      };
    });
    expect(pngToPmtiles.clearedSynchronously).toBe(true);
    expect(pngToPmtiles.selectedAssetKey).toBe("tiles");
    expect(pngToPmtiles.selectedAssetFormat).toBe("pmtiles");
    expect(pngToPmtiles.sourceIds).toEqual([]);
    expect(pngToPmtiles.layerIds).toEqual([]);
    expect(pngToPmtiles.previewSrc).toBe("");
    expect(pngToPmtiles.inspectionVersion).toBe(3);
    expect(
      pngToPmtiles.trace.filter((entry) => entry.stage === "sign").map((entry) => entry.assetKey),
    ).toEqual(["tiles"]);
    expect(pngToPmtiles.trace.some((entry) => entry.stage === "range")).toBe(true);
    expect(JSON.stringify(pngToPmtiles)).not.toContain(STAC_FIXTURE_AUTH_SENTINEL);
    expect(pngToPmtiles.revokedObjectUrls).toContain(pngToPmtiles.initialPreviewUrl);

    await page.evaluate(() => {
      const runtime = window.__HONUA_STAC_BROWSER__;
      window.__STAC_OLDER_SELECTION__ = runtime?.selectAsset(runtime.selectedItemId, "tiles");
    });
    await expect
      .poll(() =>
        page.evaluate(() =>
          (window.__HONUA_STAC_BROWSER__?.trace ?? []).some(
            (entry) => entry.stage === "request" && new URL(entry.url).pathname.endsWith(".pmtiles"),
          ),
        ),
      )
      .toBe(true);
    const pmtilesToPng = await page.evaluate(async () => {
      const runtime = window.__HONUA_STAC_BROWSER__;
      const newer = runtime?.selectAsset(runtime.selectedItemId, "preview");
      const clearedSynchronously =
        runtime?.pmtilesInspection === undefined &&
        runtime?.mapSelectionSourceIds.length === 0 &&
        runtime?.mapSelectionLayerIds.length === 0;
      await Promise.all([window.__STAC_OLDER_SELECTION__, newer]);
      delete window.__STAC_OLDER_SELECTION__;
      const previewSrc = document.querySelector("#asset-preview")?.getAttribute("src") ?? "";
      return {
        clearedSynchronously,
        selectedAssetKey: runtime?.selectedAssetKey,
        selectedAssetFormat: runtime?.selectedAssetFormat,
        sourceIds: runtime?.mapSelectionSourceIds,
        layerIds: runtime?.mapSelectionLayerIds,
        trace: runtime?.trace ?? [],
        previewSrc,
        previewWasRevoked: window.__STAC_REVOKED_OBJECT_URLS__.includes(previewSrc),
      };
    });
    expect(pmtilesToPng.clearedSynchronously).toBe(true);
    expect(pmtilesToPng.selectedAssetKey).toBe("preview");
    expect(pmtilesToPng.selectedAssetFormat).toBe("raster");
    expect(pmtilesToPng.sourceIds).toEqual(["selected-stac-image", "selected-stac-footprint"]);
    expect(pmtilesToPng.layerIds).toEqual([
      "selected-stac-image-raster",
      "selected-stac-footprint-fill",
      "selected-stac-footprint-line",
    ]);
    expect(pmtilesToPng.previewSrc).toMatch(/^blob:/);
    expect(pmtilesToPng.previewWasRevoked).toBe(false);
    expect(
      pmtilesToPng.trace.filter((entry) => entry.stage === "sign").map((entry) => entry.assetKey),
    ).toEqual(["preview"]);
    expect(pmtilesToPng.trace.some((entry) => entry.stage === "range")).toBe(false);
    expect(
      pmtilesToPng.trace.some(
        (entry) => entry.stage === "request" && new URL(entry.url).pathname.endsWith(".pmtiles"),
      ),
    ).toBe(false);
    await expect(page.locator("#imagery-map canvas")).toBeVisible();
    expect(
      await page.evaluate(() => ({
        mapReady: window.__HONUA_STAC_BROWSER__?.mapReady,
        imageSource: window.__HONUA_STAC_BROWSER__?.mapImageSourceActive,
        footprintSource: window.__HONUA_STAC_BROWSER__?.mapFootprintSourceActive,
        mappedItemId: window.__HONUA_STAC_BROWSER__?.mappedItemId,
        coordinates: window.__HONUA_STAC_BROWSER__?.mappedCoordinates,
      })),
    ).toEqual({
      mapReady: true,
      imageSource: true,
      footprintSource: true,
      mappedItemId: "S2B_MAUI_20260502_WEST",
      coordinates: [
        [-156.72, 20.99],
        [-156.33, 20.99],
        [-156.33, 20.69],
        [-156.72, 20.69],
      ],
    });
    await expect(page.locator("#network-log")).toContainText("POST  /v1/search");
    await expect(page.locator("#network-log")).toContainText("SIGN");

    await page.evaluate(() => window.__HONUA_STAC_BROWSER__?.loadNext());
    await expect(page.locator("#page-state")).toContainText("3 loaded / ready for next page");
    await expect(page.locator("#result-list")).toContainText("Haleakala east slope");
    expect(
      await page.evaluate(() =>
        window.__HONUA_STAC_BROWSER__?.trace
          .filter((entry) => entry.stage === "request" && new URL(entry.url).pathname.endsWith("/search"))
          .map((entry) => ({ method: entry.method, pathname: new URL(entry.url).pathname })),
      ),
    ).toEqual([
      { method: "POST", pathname: "/v1/search" },
      { method: "POST", pathname: "/v1/search" },
    ]);
    await page.evaluate(() => window.__HONUA_STAC_BROWSER__?.loadNext());
    await expect(page.locator("#page-state")).toContainText("3 loaded / complete");

    await page.evaluate(() => window.__HONUA_STAC_BROWSER__?.search("GET"));
    await page.evaluate(() => window.__HONUA_STAC_BROWSER__?.loadNext());
    expect(
      await page.evaluate(() =>
        window.__HONUA_STAC_BROWSER__?.trace
          .filter((entry) => entry.stage === "request" && new URL(entry.url).pathname.endsWith("/search"))
          .map((entry) => entry.method),
      ),
    ).toEqual(["GET", "GET"]);

    await page.evaluate(() => window.__HONUA_STAC_BROWSER__?.search("POST"));
    const overlap = await page.evaluate(async () => {
      const image = document.querySelector("#asset-preview");
      const oldPreview = image?.getAttribute("src");
      const oldPage = window.__HONUA_STAC_BROWSER__?.loadNext();
      const newSearch = window.__HONUA_STAC_BROWSER__?.search("GET");
      const previewCleared = image?.hidden === true && !image.hasAttribute("src");
      const mapCleared = window.__HONUA_STAC_BROWSER__?.mapImageSourceActive === false;
      await newSearch;
      await oldPage;
      return {
        previewCleared,
        mapCleared,
        oldPreview,
        newPreview: image?.getAttribute("src"),
        loadedCount: window.__HONUA_STAC_BROWSER__?.loadedCount,
        status: window.__HONUA_STAC_BROWSER__?.paginationStatus,
        selectedItemId: window.__HONUA_STAC_BROWSER__?.selectedItemId,
        searchMethods: window.__HONUA_STAC_BROWSER__?.trace
          .filter((entry) => entry.stage === "request" && new URL(entry.url).pathname.endsWith("/search"))
          .map((entry) => entry.method),
      };
    });
    expect(overlap).toMatchObject({
      previewCleared: true,
      mapCleared: true,
      loadedCount: 2,
      status: "ready for next page",
      selectedItemId: "S2B_MAUI_20260502_WEST",
      searchMethods: ["GET"],
    });
    expect(overlap.newPreview).toMatch(/^blob:/);
    expect(overlap.newPreview).not.toBe(overlap.oldPreview);

    const assetOverlap = await page.evaluate(async () => {
      const image = document.querySelector("#asset-preview");
      const oldPreview = image?.getAttribute("src");
      const oldSelection = window.__HONUA_STAC_BROWSER__?.selectAsset("S2B_MAUI_20260502_WEST", "preview");
      const newSearch = window.__HONUA_STAC_BROWSER__?.search("POST");
      const previewCleared = image?.hidden === true && !image.hasAttribute("src");
      const mapCleared = window.__HONUA_STAC_BROWSER__?.mapImageSourceActive === false;
      await newSearch;
      await oldSelection;
      const trace = window.__HONUA_STAC_BROWSER__?.trace ?? [];
      return {
        previewCleared,
        mapCleared,
        oldPreview,
        newPreview: image?.getAttribute("src"),
        selectedItemId: window.__HONUA_STAC_BROWSER__?.selectedItemId,
        searchMethods: trace
          .filter((entry) => entry.stage === "request" && new URL(entry.url).pathname.endsWith("/search"))
          .map((entry) => entry.method),
        signCount: trace.filter((entry) => entry.stage === "sign").length,
        previewRequestCount: trace.filter(
          (entry) => entry.stage === "request" && new URL(entry.url).pathname.endsWith(".png"),
        ).length,
        imageSource: window.__HONUA_STAC_BROWSER__?.mapImageSourceActive,
        footprintSource: window.__HONUA_STAC_BROWSER__?.mapFootprintSourceActive,
      };
    });
    expect(assetOverlap).toMatchObject({
      previewCleared: true,
      mapCleared: true,
      selectedItemId: "S2B_MAUI_20260502_WEST",
      searchMethods: ["POST"],
      signCount: 1,
      previewRequestCount: 1,
      imageSource: true,
      footprintSource: true,
    });
    expect(assetOverlap.newPreview).toMatch(/^blob:/);
    expect(assetOverlap.newPreview).not.toBe(assetOverlap.oldPreview);

    await page.evaluate(async () => {
      await window.__HONUA_STAC_BROWSER__?.search("POST");
      const pending = window.__HONUA_STAC_BROWSER__?.loadNext();
      await new Promise((resolve) => setTimeout(resolve, 10));
      window.__HONUA_STAC_BROWSER__?.cancelPagination();
      await pending;
    });
    await expect(page.locator("#page-state")).toContainText("cancelled");
    expect(
      await page.evaluate(
        () =>
          window.__HONUA_STAC_BROWSER__?.mapImageSourceActive === false &&
          window.__HONUA_STAC_BROWSER__?.mapFootprintSourceActive === false,
      ),
    ).toBe(true);
    expect(await page.evaluate(() => window.__HONUA_STAC_BROWSER__?.trace.some((entry) => entry.stage === "cancel"))).toBe(
      true,
    );

    await page.evaluate(() => window.__HONUA_STAC_BROWSER__?.search("POST"));
    await page.evaluate(() =>
      window.__HONUA_STAC_BROWSER__?.selectAsset("S2B_MAUI_20260502_WEST", "metadata"),
    );
    await expect(page.locator("#handoff-state")).toContainText("no executable SDK handoff");
    expect(
      await page.evaluate(() =>
        window.__HONUA_STAC_BROWSER__?.trace
          .filter((entry) => entry.stage === "sign")
          .map((entry) => entry.assetKey),
      ),
    ).toEqual([]);

    await expect(page.getByRole("link", { name: "Open the complete project" })).toHaveAttribute(
      "href",
      "https://github.com/honua-io/honua-sdk-js/tree/trunk/examples/stac-imagery-browser",
    );
    await expect(page.locator(".code-panel pre")).toContainText("createDynamicStacClient");
    await expect(page.locator("#handoff-list")).toContainText("@honua/sdk-js/raster");
    await expect(page.locator("#handoff-list")).toContainText("@honua/sdk-js/pmtiles");

    await page.evaluate(() => {
      window.__STAC_PENDING_PMTILES__ = window.__HONUA_STAC_BROWSER__?.selectAsset(
        "S2B_MAUI_20260502_WEST",
        "tiles",
      );
    });
    await expect
      .poll(() =>
        page.evaluate(() =>
          window.__HONUA_STAC_BROWSER__?.trace.some(
            (entry) => entry.stage === "request" && new URL(entry.url).pathname.endsWith(".pmtiles"),
          ),
        ),
      )
      .toBe(true);
    await page.evaluate(() => window.__HONUA_STAC_BROWSER__?.cancelPagination());
    await page.evaluate(async () => {
      await window.__STAC_PENDING_PMTILES__;
      delete window.__STAC_PENDING_PMTILES__;
    });
    await expect(page.locator("#page-state")).toContainText("cancelled");
    expect(await page.evaluate(() => window.__HONUA_STAC_BROWSER__?.trace.some((entry) => entry.stage === "cancel"))).toBe(
      true,
    );

    await page.evaluate(async () => {
      await window.__HONUA_STAC_BROWSER__?.search("POST");
      await window.__HONUA_STAC_BROWSER__?.selectAsset("S2B_MAUI_20260502_WEST", "tiles");
    });
    await expect(page.locator("#handoff-state")).toContainText("pmtiles is ready for @honua/sdk-js/pmtiles");
    await expect(page.locator("#asset-inspection")).toContainText("PMTiles v3 / MVT");
    await expect(page.locator("#asset-inspection")).toContainText("206 bytes 0-16383/65536");
    const pmtilesProof = await page.evaluate(() => {
      const inspection = window.__HONUA_STAC_BROWSER__?.pmtilesInspection;
      const range = window.__HONUA_STAC_BROWSER__?.trace.find((entry) => entry.stage === "range");
      return {
        specVersion: inspection?.metadata.specVersion,
        requests: inspection?.metadata.transfer.requests,
        bytesFetched: inspection?.metadata.transfer.bytesFetched,
        range: range?.range,
        status: range?.status,
        authorization: range?.authorization,
        signedTracePath: range ? new URL(range.url).pathname : undefined,
        imageSource: window.__HONUA_STAC_BROWSER__?.mapImageSourceActive,
        footprintSource: window.__HONUA_STAC_BROWSER__?.mapFootprintSourceActive,
      };
    });
    expect(pmtilesProof).toEqual({
      specVersion: 3,
      requests: 1,
      bytesFetched: 16 * 1024,
      range: "bytes=0-16383",
      status: 206,
      authorization: "[redacted]",
      signedTracePath:
        "/v1/collections/sentinel-2-l2a/items/assets/signed/REDACTED/maui.pmtiles",
      imageSource: false,
      footprintSource: false,
    });

    expect(pageErrors).toEqual([]);
    expect(consoleErrors).toEqual([]);
    expect(failedRequests).toEqual([]);
  } finally {
    await server.close();
  }
});
