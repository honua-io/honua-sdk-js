#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  PROJECT_ROOT,
  loadPublicSurface,
  sourceFileForExport,
} from "./lib/public-surface.mjs";

const packageJson = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, "package.json"), "utf8"));
const surface = loadPublicSurface();
const sources = [
  ...new Set(
    surface.entrypoints
      .filter((entrypoint) => entrypoint.tier !== "deprecated")
      .map((entrypoint) => path.relative(PROJECT_ROOT, sourceFileForExport(packageJson, entrypoint.subpath))),
  ),
];

const result = spawnSync(
  "npx",
  [
    "--yes",
    "typedoc@^0.26",
    "--tsconfig",
    "tsconfig.json",
    "--out",
    "dist/docs-api",
    "--excludeInternal",
    "--excludePrivate",
    "--readme",
    "README.md",
    "--name",
    "@honua/sdk-js",
    ...sources,
  ],
  { cwd: PROJECT_ROOT, stdio: "inherit" },
);

if (result.error) throw result.error;
process.exit(result.status ?? 1);
