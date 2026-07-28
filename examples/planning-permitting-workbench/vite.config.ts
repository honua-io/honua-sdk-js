import { createSampleViteConfig } from "../_kit/vite.config.js";

export default createSampleViteConfig(import.meta.url, {
  sdkEntrypoints: [
    "@honua/sdk-js/app-workspace",
    "@honua/sdk-js/contract",
    "@honua/sdk-js/exploration",
    "@honua/sdk-js/geocoding",
    "@honua/sdk-js/geometry",
    "@honua/sdk-js/honua",
    "@honua/sdk-js/interactions",
    "@honua/sdk-js/web-components",
  ],
});
