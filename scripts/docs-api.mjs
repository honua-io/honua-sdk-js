#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import {
  PROJECT_ROOT,
  loadPublicSurface,
  sourceFileForExport,
} from "./lib/public-surface.mjs";
import { runNpxSync } from "./lib/npm-cli.mjs";

const packageJson = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, "package.json"), "utf8"));
const surface = loadPublicSurface();
const sources = [
  ...new Set(
    surface.entrypoints
      .filter((entrypoint) => entrypoint.tier !== "deprecated")
      .map((entrypoint) => path.relative(PROJECT_ROOT, sourceFileForExport(packageJson, entrypoint.subpath)).split(path.sep).join("/")),
  ),
];

const result = runNpxSync(
  [
    "--yes",
    "typedoc@0.28.17",
    "--tsconfig",
    "tsconfig.docs.json",
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
