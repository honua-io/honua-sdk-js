import { createSampleViteConfig } from "../_kit/vite.config.js";

export default createSampleViteConfig(import.meta.url, {
  sdkEntrypoints: ["@honua/sdk-js", "@honua/sdk-js/contract", "@honua/sdk-js/map"],
});
