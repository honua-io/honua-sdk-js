#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runNpmScriptSync } from "./lib/npm-cli.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "docs", "learning-paths.v1.json"), "utf8"));
const scripts = [...new Set(manifest.paths.map((learningPath) => learningPath.typecheckScript))];

for (const script of scripts) {
  const result = runNpmScriptSync(
    script,
    { cwd: root, stdio: "inherit" },
    { silent: false },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

process.stdout.write(`learningPathTypechecks=ok scripts=${scripts.length}\n`);
