import { expect, test } from "@playwright/test";

import { startImageryCogFixtureServer } from "../../examples/imagery-cog-quickstart/mock-server.mjs";

test.setTimeout(90_000);

test("Imagery and COG Quickstart discovers, reads, renders, refuses, switches, and disposes direct COGs", async ({
  page,
}) => {
  const pageErrors = [];
  page.on("pageerror", (error) => {
    pageErrors.push(error.message);
  });

  const server = await startImageryCogFixtureServer();
  try {
    await page.goto(server.url);
    await expect.poll(async () => page.evaluate(() => window.__HONUA_IMAGERY_COG_DEMO__?.ready === true)).toBe(true);

    await expect(page.locator("#direct-cog-status")).toContainText("ready");
    await expect(page.locator("#direct-cog-inspection")).toContainText("256×192");
    await expect(page.locator("#direct-cog-provenance")).toContainText("oahu-direct-cog-fixture/visual-a");
    await expect(page.locator("#direct-cog-transfer-summary")).toContainText("exact range request");
    await expect(page.locator("#direct-cog-ranges li")).toHaveCount(4);
    const initial = await page.evaluate(() => window.__HONUA_IMAGERY_COG_DEMO__?.directCog);
    expect(initial).toMatchObject({
      phase: "ready",
      selectedAssetKey: "visual-a",
      candidateCount: 7,
      decoderModuleLoads: 1,
      decoderLoads: 1,
      decoderDisposals: 0,
      mapSourceMounted: true,
      mapLayerMounted: true,
      render: { state: "ready", mounted: true, lastRender: { transfer: { requests: 4 } } },
      transfer: { requests: 4, bytesFetched: 288 },
    });
    expect(initial.transfer.ranges.every((range) => range.outcome === "success" && range.length < 1024)).toBe(true);

    for (const [assetKey, errorCode] of [
      ["range-unsupported", "range-unsupported"],
      ["cors-blocked", "cors-unavailable"],
      ["unsupported-crs", "unsupported-crs"],
      ["unsupported-format", "unsupported-format"],
    ]) {
      await page.evaluate((key) => window.__HONUA_IMAGERY_COG_DEMO__?.selectCogAsset(key), assetKey);
      await expect(page.locator("#direct-cog-status")).toContainText(errorCode);
      await expect(page.locator("#direct-cog-error")).toContainText(errorCode);
      const failure = await page.evaluate(() => window.__HONUA_IMAGERY_COG_DEMO__?.directCog);
      expect(failure).toMatchObject({ phase: "failed", selectedAssetKey: assetKey, errorCode });
    }

    await page.evaluate(async () => {
      const runtime = window.__HONUA_IMAGERY_COG_DEMO__;
      if (!runtime) throw new Error("Missing imagery COG runtime.");
      const obsolete = runtime.selectCogAsset("visual-slow");
      await new Promise((resolve) => setTimeout(resolve, 40));
      const latest = runtime.selectCogAsset("visual-b");
      await Promise.allSettled([obsolete, latest]);
    });
    await expect(page.locator("#direct-cog-status")).toContainText("ready");
    const switched = await page.evaluate(() => window.__HONUA_IMAGERY_COG_DEMO__?.directCog);
    expect(switched).toMatchObject({ phase: "ready", selectedAssetKey: "visual-b" });
    expect(switched.abortedOperations).toBeGreaterThanOrEqual(1);
    expect(switched.decoderDisposals).toBeGreaterThanOrEqual(6);
    expect(switched.staleCompletions).toBeGreaterThanOrEqual(1);

    await expect(page.locator("#mode-state")).toContainText("Fixture safe mode");
    await expect(page.locator("#capability-state")).toContainText("WMS GetMap");
    await expect(page.locator("#capability-state")).toContainText("ImageServer tile");
    await expect(page.locator("#cache-state")).toContainText("2 ready");
    await expect(page.locator("#layer-list")).toContainText("Published COG through ImageServer");
    await expect(page.locator("#audit-table")).toContainText("HonuaImageService.tileUrl");

    const tileTemplates = await page.evaluate(() => window.__HONUA_IMAGERY_COG_DEMO__?.tileTemplates ?? []);
    expect(tileTemplates.some((template) => template.includes("/ImageServer/tile/{z}/{y}/{x}?f=png"))).toBe(true);
    expect(tileTemplates.some((template) => template.includes("REQUEST=GetMap"))).toBe(true);

    await page.evaluate(() => window.__HONUA_IMAGERY_COG_DEMO__?.toggleLayer("oahu-cog-image-server", false));
    await expect.poll(async () => page.evaluate(() => window.__HONUA_IMAGERY_COG_DEMO__?.activeLayerCount)).toBe(1);
    await expect(page.locator("#active-layer-count")).toHaveText("1 active");

    await page.getByRole("button", { name: /COG export preview/ }).click();
    await expect(page.locator("#export-state")).toContainText("/fixtures/imagery/export/oahu-cog-preview.png");

    const assetPicker = page.getByLabel("Asset and failure scenario");
    await assetPicker.focus();
    await expect(assetPicker).toBeFocused();
    await page.setViewportSize({ width: 390, height: 844 });
    const pickerBox = await assetPicker.boundingBox();
    expect(pickerBox?.height).toBeGreaterThanOrEqual(44);
    expect(pickerBox?.width).toBeLessThanOrEqual(390);

    const disposalsBefore = switched.decoderDisposals;
    await page.evaluate(() => window.__HONUA_IMAGERY_COG_DEMO__?.disposeCog());
    await expect(page.locator("#direct-cog-status")).toContainText("disposed");
    const disposed = await page.evaluate(() => window.__HONUA_IMAGERY_COG_DEMO__?.directCog);
    expect(disposed).toMatchObject({
      phase: "disposed",
      render: undefined,
      mapSourceMounted: false,
      mapLayerMounted: false,
    });
    expect(disposed.decoderDisposals).toBeGreaterThan(disposalsBefore);

    expect(pageErrors).toEqual([]);
  } finally {
    await server.close();
  }
});
