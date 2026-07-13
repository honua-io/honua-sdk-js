import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vite";

const exampleRoot = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(exampleRoot, "../..");

// Benchmark lane (scripts/benchmark-time-to-first-map.mjs): when
// HONUA_QUICKSTART_SDK_DIR points at an installed @honua/sdk-js package,
// bundle the example against that package's published dist entrypoints so the
// measured browser map exercises exactly what consumers install. Otherwise
// (default dev/demo lanes) alias into the repo TypeScript source.
const installedSdkDir = process.env.HONUA_QUICKSTART_SDK_DIR;

const versionManifestPath = installedSdkDir
  ? path.resolve(installedSdkDir, "package.json")
  : path.resolve(repoRoot, "package.json");
const packageJson = JSON.parse(fs.readFileSync(versionManifestPath, "utf8")) as {
  version: string;
  exports?: Record<string, string | { default?: string }>;
};

const SDK_ALIAS_SUBPATHS: ReadonlyArray<readonly [find: string, exportKey: string, srcRelative: string]> = [
  ["@honua/sdk-js/contract", "./contract", "src/contract/index.ts"],
  ["@honua/sdk-js/exploration", "./exploration", "src/exploration/index.ts"],
  ["@honua/sdk-js/query-planner", "./query-planner", "src/query-planner/index.ts"],
  ["@honua/sdk-js/interactions", "./interactions", "src/interactions/index.ts"],
  ["@honua/sdk-js/honua", "./honua", "src/honua.ts"],
  ["@honua/sdk-js", ".", "src/index.ts"],
];

function sdkAliases(): Array<{ find: string; replacement: string }> {
  if (!installedSdkDir) {
    return SDK_ALIAS_SUBPATHS.map(([find, , srcRelative]) => ({
      find,
      replacement: path.resolve(repoRoot, srcRelative),
    }));
  }
  return SDK_ALIAS_SUBPATHS.map(([find, exportKey]) => {
    const entry = packageJson.exports?.[exportKey];
    const target = typeof entry === "string" ? entry : entry?.default;
    if (typeof target !== "string") {
      throw new Error(`installed @honua/sdk-js declares no default export for "${exportKey}"`);
    }
    return { find, replacement: path.resolve(installedSdkDir, target) };
  });
}

export default defineConfig({
  define: {
    __HONUA_SDK_VERSION__: JSON.stringify(packageJson.version),
  },
  root: exampleRoot,
  envDir: exampleRoot,
  resolve: {
    alias: sdkAliases(),
  },
  server: {
    host: "127.0.0.1",
    fs: {
      allow: [repoRoot],
    },
  },
  preview: {
    host: "127.0.0.1",
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
