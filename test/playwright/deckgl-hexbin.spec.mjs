import { expect, test } from "@playwright/test";
import { build } from "esbuild";

let script;
test.beforeAll(async () => {
  const bundle = await build({
    stdin: {
      contents: `import {Deck} from '@deck.gl/core';
        import {SolidPolygonLayer, ScatterplotLayer} from '@deck.gl/layers';
        import {createDeckGlAdapter, projectDeckGlHexbins} from './src/deckgl/index.ts';
        window.hexbinPeers = {Deck, SolidPolygonLayer, ScatterplotLayer, createDeckGlAdapter, projectDeckGlHexbins};`,
      resolveDir: process.cwd(),
    },
    bundle: true, write: false, format: "iife", platform: "browser",
  });
  script = bundle.outputFiles[0].text;
});

test("real deck.gl draws and picks every binary hexagon", async ({ page }) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.setContent('<canvas id="map" width="600" height="400"></canvas>');
  await page.addScriptTag({ content: script });
  const result = await page.evaluate(async () => {
    const { Deck, SolidPolygonLayer, ScatterplotLayer, createDeckGlAdapter, projectDeckGlHexbins } = window.hexbinPeers;
    const adapter = createDeckGlAdapter({ peers: { SolidPolygonLayer, ScatterplotLayer } });
    const hexbin = projectDeckGlHexbins(adapter, {
      layerId: "rendered-counts", radiusMeters: 500,
      positions: new Float64Array([0, 0, 0.00001, 0.00001, 0.02, 0]),
      identity: { sourceId: "requests", planId: "all", featureIds: [71, 72, 73] },
    });
    let deck;
    try {
      await new Promise((resolve, reject) => {
        deck = new Deck({
          canvas: document.querySelector("#map"), width: 600, height: 400,
          initialViewState: { longitude: 0.01, latitude: 0, zoom: 13 },
          layers: [hexbin.projection.layer],
          onAfterRender: resolve, onError: reject,
        });
      });
      const viewport = deck.getViewports()[0];
      const picked = hexbin.bins.map((bin) => {
        const [x, y] = viewport.project(bin.center);
        const pick = deck.pickObject({ x, y, radius: 1 });
        if (!pick || pick.layer.id !== "rendered-counts") throw new Error("Rendered hexagon was not pickable");
        return hexbin.selectionsForBin(pick.index).map(({ featureId }) => featureId);
      });
      return { picked, polygons: hexbin.projection.layer.props.data.length };
    } finally {
      deck?.finalize();
      adapter.dispose();
    }
  });
  expect(result).toEqual({ picked: [[71, 72], [73]], polygons: 2 });
  expect(errors).toEqual([]);
});
