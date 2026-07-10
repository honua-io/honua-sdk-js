#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "docs", "learning-paths.v1.json"), "utf8"));
const scripts = [...new Set(manifest.paths.map((learningPath) => learningPath.typecheckScript))];
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

for (const script of scripts) {
  const result = spawnSync(npm, ["run", script], { cwd: root, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

process.stdout.write(`learningPathTypechecks=ok scripts=${scripts.length}\n`);
