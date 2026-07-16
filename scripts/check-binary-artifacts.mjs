#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { scanBinaryArtifactFiles } from "./lib/binary-artifact-policy.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const trackedOutput = execFileSync("git", ["-c", "core.quotepath=false", "ls-files", "--cached", "-z"], {
  cwd: root,
  encoding: "utf8",
  maxBuffer: 64 * 1024 * 1024,
});
const trackedFiles = trackedOutput.split("\0").filter(Boolean);
const violations = scanBinaryArtifactFiles({ root, paths: trackedFiles });

if (violations.length > 0) {
  process.stderr.write("Binary artifact policy FAILED:\n");
  for (const violation of violations) process.stderr.write(`  - ${violation.file}: ${violation.reason}\n`);
  process.stderr.write(
    "\nGenerated executables must be acquired from an authoritative pinned source, verified by digest, and cached outside Git.\n",
  );
  process.exit(1);
}

process.stdout.write(`binaryArtifactPolicy=ok trackedFiles=${trackedFiles.length}\n`);
