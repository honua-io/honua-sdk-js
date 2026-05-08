import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/staging/cloud-demo-services.integration.ts"],
    exclude: ["dist/**", "node_modules/**"],
    fileParallelism: false,
  },
});
