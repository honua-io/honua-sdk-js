#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { prepareSdkArtifact } from "./lib/prepared-sdk-artifact.mjs";
import { resolveNpmRunInvocation } from "./lib/npm-run-invocation.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const modeByFlag = new Map([
  ["--prepare", "build-if-needed"],
  ["--force-build", "force-build"],
  ["--already-prepared", "already-prepared"],
  ["--adopt-additions", "adopt-additions"],
]);
const flag = process.argv[2] ?? "--prepare";
const mode = modeByFlag.get(flag);

function runScript(mode) {
  // Standalone `prepare:test-sdk` is not itself one of the heavy names
  // recognized by the shared host semaphore. Delegate cache misses to
  // exact `npm run build`; its force-build owner then invokes the internal
  // compiler while inheriting the reentrant lock marker.
  const script = mode === "build-if-needed" ? "build" : "compile";
  const invocation = resolveNpmRunInvocation(script);
  const result =
    spawnSync(invocation.command, invocation.args, {
      cwd: projectRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      shell: invocation.shell,
    });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || `${mode} exited ${result.status}`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (!mode || process.argv.length > 3) {
    process.stderr.write(
      "Usage: node scripts/prepare-sdk-test-artifacts.mjs [--prepare|--force-build|--already-prepared|--adopt-additions]\n",
    );
    process.exitCode = 2;
  } else {
    try {
      const manifest = prepareSdkArtifact({
        projectRoot,
        mode,
        runBuild: () => runScript(mode),
      });
      process.stdout.write(
        `preparedSdkRun=${manifest.runId} inputs=${manifest.inputs.sha256} dist=${manifest.dist.sha256} files=${manifest.dist.fileCount}\n`,
      );
    } catch (error) {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    }
  }
}
