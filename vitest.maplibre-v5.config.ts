import path from "node:path";

import { defineConfig } from "vitest/config";

/**
 * MapLibre 5 leg of the peer-major matrix (issue #1004).
 *
 * The default unit run resolves `maplibre-gl` to the 6.x devDependency. This
 * config re-runs the peer-facing specs with the specifier aliased to the
 * `maplibre-gl-v5` devDependency alias (`npm:maplibre-gl@^5.24.0`), so the
 * declared `^5.0.0 || ^6.0.0` peer range is evidence on both majors rather than
 * a claim on one. `HONUA_MAPLIBRE_PACKAGE` tells the specs which installed
 * directory backs the specifier for file-level assertions; the specs also
 * cross-check the imported module's reported version against it, so a broken
 * alias fails instead of silently re-running the 6.x leg.
 *
 * Only specs whose behavior depends on the real peer module belong here. Specs
 * that mock `maplibre-gl` are major-independent by construction and stay in the
 * single default run.
 */
export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^maplibre-gl$/,
        replacement: path.resolve(import.meta.dirname, "node_modules/maplibre-gl-v5"),
      },
    ],
  },
  test: {
    include: ["test/maplibre-peer-major-compat.test.ts"],
    exclude: ["dist/**", "node_modules/**"],
    env: { HONUA_MAPLIBRE_PACKAGE: "maplibre-gl-v5" },
    fileParallelism: false,
  },
});
