import { gzipSync } from "node:zlib";

import { type Plugin, defineConfig } from "vite";

import { createSampleViteConfig } from "../_kit/vite.config.js";

export const FIRST_MAP_BUNDLE_BUDGET = Object.freeze({
  javascriptBytes: 1_800_000,
  javascriptGzipBytes: 475_000,
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
});

export default defineConfig({
  ...shared,
  plugins: [bundleBudget, ...(shared.plugins ?? [])],
});
