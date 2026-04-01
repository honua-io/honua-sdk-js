#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const scriptRoot = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptRoot, "..");
const exampleRoot = path.join(repoRoot, "examples", "kepler-analytics");
const exampleLockfile = path.join(exampleRoot, "package-lock.json");
const installedLockfile = path.join(exampleRoot, "node_modules", ".package-lock.json");
const viteBinary = path.join(
  exampleRoot,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "vite.cmd" : "vite"
);
const keplerReducersPackage = path.join(
  exampleRoot,
  "node_modules",
  "@kepler.gl",
  "reducers",
  "package.json"
);

function exists(targetPath) {
  return fs.existsSync(targetPath);
}

function installRequired() {
  if (!exists(viteBinary) || !exists(keplerReducersPackage) || !exists(installedLockfile)) {
    return true;
  }

  return fs.statSync(exampleLockfile).mtimeMs > fs.statSync(installedLockfile).mtimeMs;
}

if (!installRequired()) {
  process.exit(0);
}

const result = spawnSync(npmCommand, ["install", "--prefix", exampleRoot, "--legacy-peer-deps"], {
  cwd: repoRoot,
  stdio: "inherit"
});

if (typeof result.status === "number") {
  process.exit(result.status);
}

if (result.error) {
  throw result.error;
}

process.exit(1);
