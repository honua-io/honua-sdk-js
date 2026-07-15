import path from "node:path";

import {
  PREPARED_SDK_RUN_ID_ENV,
  type PreparedSdkManifest,
  verifyManifestArtifact,
  verifyPreparedSdkArtifact,
} from "../scripts/lib/prepared-sdk-artifact.mjs";
import { getProjectRoot } from "./migration-cli-lock.js";

let verifiedManifest: PreparedSdkManifest | undefined;

export function getPreparedMigrationCliPath(): string {
  return getPreparedSdkArtifact(path.join("dist", "src", "migration", "cli.js"));
}

export function getPreparedEsriCompatEntryPath(): string {
  return getPreparedSdkArtifact(path.join("dist", "src", "esri-compat-entry.js"));
}

export function getPreparedHonuaEntryPath(): string {
  return getPreparedSdkArtifact(path.join("dist", "src", "honua.js"));
}

function getPreparedSdkArtifact(relativePath: string): string {
  const projectRoot = getProjectRoot();
  const manifest = getRunManifest(projectRoot);
  return verifyManifestArtifact(projectRoot, manifest, relativePath);
}

function getRunManifest(projectRoot: string): PreparedSdkManifest {
  if (verifiedManifest) return verifiedManifest;
  const expectedRunId = process.env[PREPARED_SDK_RUN_ID_ENV];
  if (!expectedRunId) {
    throw new Error(
      `Vitest did not provide ${PREPARED_SDK_RUN_ID_ENV}; use the repository Vitest configuration and prepare the SDK artifact first.`,
    );
  }
  verifiedManifest = verifyPreparedSdkArtifact({ projectRoot, expectedRunId, verifyTrees: false });
  return verifiedManifest;
}
