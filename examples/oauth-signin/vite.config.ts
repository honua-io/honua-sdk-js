import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const exampleRoot = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(exampleRoot, "../..");

export default defineConfig({
  root: exampleRoot,
  envDir: exampleRoot,
  resolve: {
    alias: [
      // More specific subpaths must precede the bare specifier.
      { find: "@honua/sdk-js/auth", replacement: path.resolve(repoRoot, "src/core/auth/index.ts") },
      { find: "@honua/sdk-js/honua", replacement: path.resolve(repoRoot, "src/honua.ts") },
      { find: "@honua/sdk-js", replacement: path.resolve(repoRoot, "src/index.ts") },
    ],
  },
  server: { host: "127.0.0.1", fs: { allow: [repoRoot] } },
  preview: { host: "127.0.0.1" },
  build: { outDir: "dist", emptyOutDir: true },
});
