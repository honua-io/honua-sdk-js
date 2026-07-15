#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";

import { assertTestBuildOwnership } from "./lib/test-build-ownership.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
try {
  const result = assertTestBuildOwnership({ projectRoot });
  process.stdout.write(`testBuildOwnership=valid files=${result.filesChecked}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
