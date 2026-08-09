// Generated from examples/columnar-query-quickstart by scripts/sample-playgrounds.mjs.
// The repository build aliases @honua/sdk-js onto src/; a playground resolves
// the published package from node_modules instead, so no alias is needed.
import { defineConfig } from "vite";

export default defineConfig({
  server: { host: "127.0.0.1" },
  preview: { host: "127.0.0.1" },
  build: { outDir: "dist", emptyOutDir: true },
});
