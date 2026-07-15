import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { getProjectRoot } from "./migration-cli-lock.js";

const SOURCE_INPUT_PATHS = ["src", "tsconfig.json"] as const;
const snapshots = new Map<string, string>();

export function getPreparedMigrationCliPath(): string {
  return getPreparedSdkArtifact(path.join("dist", "src", "migration", "cli.js"), "migration CLI");
}

export function getPreparedEsriCompatEntryPath(): string {
  return getPreparedSdkArtifact(path.join("dist", "src", "esri-compat-entry.js"), "Esri compatibility runtime");
}

export function getPreparedHonuaEntryPath(): string {
  return getPreparedSdkArtifact(path.join("dist", "src", "honua.js"), "Honua runtime");
}

function getPreparedSdkArtifact(relativePath: string, label: string): string {
  const projectRoot = getProjectRoot();
  const artifactPath = path.join(projectRoot, relativePath);
  const artifactStat = readRegularFileStat(artifactPath, label);
  const newestSourceMtime = newestInputMtime(projectRoot);

  if (artifactStat.mtimeMs < newestSourceMtime) {
    throw prerequisiteError(label, artifactPath, "is older than its SDK source inputs");
  }

  const digest = createHash("sha256").update(fs.readFileSync(artifactPath)).digest("hex");
  const previousDigest = snapshots.get(artifactPath);
  if (previousDigest && previousDigest !== digest) {
    throw new Error(
      `${label} changed after this test worker started: ${artifactPath}. SDK artifacts are immutable for the duration of a test run.`,
    );
  }
  snapshots.set(artifactPath, digest);

  return artifactPath;
}

function readRegularFileStat(artifactPath: string, label: string): fs.Stats {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(artifactPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw prerequisiteError(label, artifactPath, "does not exist");
    }
    throw error;
  }

  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw prerequisiteError(label, artifactPath, "is not a regular file");
  }
  return stat;
}

function newestInputMtime(projectRoot: string): number {
  let newest = 0;
  for (const relativePath of SOURCE_INPUT_PATHS) {
    newest = Math.max(newest, newestMtime(path.join(projectRoot, relativePath)));
  }
  return newest;
}

function newestMtime(inputPath: string): number {
  const stat = fs.lstatSync(inputPath);
  if (!stat.isDirectory()) {
    return stat.mtimeMs;
  }

  let newest = stat.mtimeMs;
  for (const entry of fs.readdirSync(inputPath, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) {
      continue;
    }
    newest = Math.max(newest, newestMtime(path.join(inputPath, entry.name)));
  }
  return newest;
}

function prerequisiteError(label: string, artifactPath: string, reason: string): Error {
  return new Error(
    `Prepared ${label} ${reason}: ${artifactPath}. Use \`npm test -- <spec>\` so the SDK is built once before Vitest, or run \`npm run build\` before invoking Vitest directly.`,
  );
}
