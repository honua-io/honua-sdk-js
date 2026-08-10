import { createSampleViteConfig } from "../_kit/vite.config.js";

const config = createSampleViteConfig(import.meta.url, {
  sdkEntrypoints: ["@honua/sdk-js/columnar-workflow"],
});

export default {
  ...config,
  server: { ...config.server, port: 5193 },
};
