import { gzipSync } from "node:zlib";

import { type Plugin, defineConfig } from "vite";

import { createSampleViteConfig } from "../_kit/vite.config.js";

// Reset for the typed semantic filter reaching Source.query() (#947): every
// adapter lowers Query.filter / Query.temporalFilter onto its own dialect, and
// all adapters live in the single contract/source module this demo's
// createDataset() path imports, so the lowering layer is reachable code rather
// than shakeable dead weight — even though First Map itself never passes a
// filter. The FES lowering was split into its own module and the queryFilter
// builder is `@__PURE__`-annotated so an app that composes no filter drops it;
// what remains is the SQL-92 / CQL2 / OData lowering the adapters call.
// Measured 1,913,004 JS / 503,392 gzip (from 1,892,447 / 498,120 at 87191dbd,
// which already sat at 99.6% of the previous ceiling). Ceilings are measured
// actual plus ~4% headroom, as with the earlier connect/discovery reset
// (#551/#585/#586, measured 1,828,695 JS / 485,371 gzip).
export const FIRST_MAP_BUNDLE_BUDGET = Object.freeze({
  javascriptBytes: 1_990_000,
  javascriptGzipBytes: 524_000,
});

let bundleBudgetFailure: Error | undefined;

const bundleBudget: Plugin = {
  name: "honua-first-map-bundle-budget",
  enforce: "pre",
  generateBundle(_options, bundle) {
    bundleBudgetFailure = undefined;
    const chunks = Object.values(bundle).filter((entry) => entry.type === "chunk");
    const javascriptBytes = chunks.reduce((total, chunk) => total + Buffer.byteLength(chunk.code), 0);
    const javascriptGzipBytes = chunks.reduce((total, chunk) => total + gzipSync(chunk.code).byteLength, 0);
    if (
      javascriptBytes > FIRST_MAP_BUNDLE_BUDGET.javascriptBytes ||
      javascriptGzipBytes > FIRST_MAP_BUNDLE_BUDGET.javascriptGzipBytes
    ) {
      bundleBudgetFailure = new Error(
        `First Map JavaScript bundle ${javascriptBytes} bytes / ${javascriptGzipBytes} gzip exceeds ` +
          `${FIRST_MAP_BUNDLE_BUDGET.javascriptBytes} / ${FIRST_MAP_BUNDLE_BUDGET.javascriptGzipBytes}.`,
      );
      return;
    }
    this.emitFile({
      type: "asset",
      fileName: "first-map-bundle-budget.json",
      source: `${JSON.stringify(
        {
          format: "honua.sdk.first-map-bundle.v1",
          status: "passed",
          measurement: { javascriptBytes, javascriptGzipBytes },
          budget: FIRST_MAP_BUNDLE_BUDGET,
        },
        null,
        2,
      )}\n`,
    });
  },
  writeBundle() {
    // Let every generateBundle hook record the final inventory before
    // reporting a budget failure; otherwise closeBundle masks the root cause.
    if (bundleBudgetFailure) throw bundleBudgetFailure;
  },
};

const shared = createSampleViteConfig(import.meta.url, {
  sdkEntrypoints: ["@honua/sdk-js", "@honua/sdk-js/runtime"],
  sdkRuntimePeers: ["maplibre-gl"],
});

export default defineConfig({
  ...shared,
  plugins: [bundleBudget, ...(shared.plugins ?? [])],
});
