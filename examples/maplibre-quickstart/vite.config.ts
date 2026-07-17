import { verifyFirstMapBudgets } from "../../scripts/verify-first-map-budgets.mjs";
import { createSampleViteConfig } from "../_kit/vite.config.js";

const config = createSampleViteConfig(import.meta.url, {
  sdkEntrypoints: ["@honua/sdk-js", "@honua/sdk-js/map"],
});

config.plugins = [
  ...(config.plugins ?? []),
  {
    name: "honua-first-map-budgets",
    closeBundle() {
      verifyFirstMapBudgets();
    },
  },
];

export default config;
