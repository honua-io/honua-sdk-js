#!/usr/bin/env node

import { materializeMigrationWorkbenchArtifacts } from "./lib/migration-workbench-artifacts.mjs";

const args = process.argv.slice(2);
const mode =
  args.length === 1 && args[0] === "--write"
    ? "write"
    : args.length === 1 && args[0] === "--check"
      ? "check"
      : undefined;

if (!mode) {
  process.stderr.write("Usage: node scripts/generate-migration-workbench-artifacts.mjs (--write|--check)\n");
  process.exitCode = 1;
} else {
  try {
    const result = await materializeMigrationWorkbenchArtifacts({ mode });
    process.stdout.write(
      `migrationWorkbenchArtifacts=${mode} files=${result.artifactCount}\n${result.paths.join("\n")}\n`,
    );
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
