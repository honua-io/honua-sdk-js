import { createSampleViteConfig } from "../_kit/vite.config.js";

export default createSampleViteConfig(import.meta.url, {
  sdkEntrypoints: [
    "@honua/sdk-js",
    "@honua/sdk-js/app-workspace",
    "@honua/sdk-js/exploration",
    "@honua/sdk-js/honua",
    "@honua/sdk-js/interactions",
    "@honua/sdk-js/style",
  ],
});
