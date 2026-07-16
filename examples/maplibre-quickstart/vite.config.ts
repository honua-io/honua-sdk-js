import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vite";

import { verifyFirstMapBudgets } from "../../scripts/verify-first-map-budgets.mjs";

const exampleRoot = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(exampleRoot, "../..");
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
  ["@honua/sdk-js/map", "./map", "src/map/index.ts"],
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
  plugins: [
    {
      name: "honua-first-map-budgets",
      closeBundle() {
        verifyFirstMapBudgets();
      },
    },
  ],
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
