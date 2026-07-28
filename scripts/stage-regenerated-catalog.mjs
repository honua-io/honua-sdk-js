#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

export const REQUIRED_CATALOG_PATHS = Object.freeze([
  "samples/catalog.v2.json",
  "samples/contract/v2/migrations/catalog.v1-to-v2.json",
]);
export const OPTIONAL_RELEASE_MATRIX_PATH =
  "samples/contract/v2/release-matrix-lanes.v1.json";
export const FORCED_CATALOG_PATHS = Object.freeze([
  "samples/dist/sample-ci-selection.v2.json",
]);

const MAX_GIT_OUTPUT_BYTES = 1024 * 1024;

function runGit(args, cwd, acceptedStatuses = [0]) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: MAX_GIT_OUTPUT_BYTES,
    shell: false,
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (!acceptedStatuses.includes(result.status)) {
    const detail = result.stderr?.trim() || result.stdout?.trim();
    throw new Error(
      detail || `git ${args.join(" ")} exited ${result.status ?? `on ${result.signal}`}`,
    );
  }
  return result;
}

function pathExists(candidate) {
  try {
    fs.lstatSync(candidate);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function trackedPath(relativePath, cwd) {
  const result = runGit(
    ["ls-files", "--error-unmatch", "--", relativePath],
    cwd,
    [0, 1],
  );
  return result.status === 0;
}

/**
 * Stage only the catalog projections owned by the regeneration workflow.
 *
 * The release-matrix establishment registry is intentionally optional until a
 * sealed browser receipt exists. Include it when present or already tracked so
 * creation, updates, and tracked deletion are all staged without broadening the
 * workflow's explicit path boundary.
 */
export function stageRegeneratedCatalog(cwd = process.cwd()) {
  const catalogPaths = [...REQUIRED_CATALOG_PATHS];
  const optionalAbsolutePath = path.resolve(cwd, OPTIONAL_RELEASE_MATRIX_PATH);
  const releaseMatrixIncluded =
    pathExists(optionalAbsolutePath) ||
    trackedPath(OPTIONAL_RELEASE_MATRIX_PATH, cwd);
  if (releaseMatrixIncluded) {
    catalogPaths.push(OPTIONAL_RELEASE_MATRIX_PATH);
  }

  runGit(["add", "-A", "--", ...catalogPaths], cwd);
  runGit(["add", "-f", "-A", "--", ...FORCED_CATALOG_PATHS], cwd);
  return Object.freeze({
    catalogPaths: Object.freeze(catalogPaths),
    forcedPaths: FORCED_CATALOG_PATHS,
    releaseMatrixIncluded,
  });
}

function main() {
  const result = stageRegeneratedCatalog();
  process.stdout.write(
    `Staged ${result.catalogPaths.length + result.forcedPaths.length} exact regenerated catalog path(s).\n`,
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  try {
    main();
  } catch (error) {
    process.stderr.write(
      `Unable to stage regenerated catalog paths: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
    process.exitCode = 1;
  }
}
