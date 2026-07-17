import { verifyFirstMapBudgets } from "../../scripts/verify-first-map-budgets.mjs";
import { createSampleViteConfig } from "../_kit/vite.config.js";

const config = createSampleViteConfig(import.meta.url, {
  sdkEntrypoints: ["@honua/sdk-js", "@honua/sdk-js/map"],
});
let bundleWritten = false;

config.plugins = [
  ...(config.plugins ?? []),
  {
    name: "honua-first-map-budgets",
    writeBundle() {
      bundleWritten = true;
    },
    closeBundle() {
      if (!bundleWritten) return;
      verifyFirstMapBudgets();
    },
  },
];

export default config;
