/**
 * Telemetry artifact for the integration lane. The suite writes one
 * `test-results/integration-meta.json` per run that the CI workflow
 * uploads as an artifact, so drift between SDK versions and server
 * commits is traceable from the CI summary alone.
 *
 * The artifact is the only observable signal the integration lane
 * adds to CI; it is intentionally append-only at the surface level so
 * that test files can call {@link recordSurface} from `beforeAll`
 * without needing a global registration step.
 *
 * @module
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TEST_RESULTS_DIR = path.resolve(fileURLToPath(import.meta.url), "../../../test-results");
const META_FILE = path.join(TEST_RESULTS_DIR, "integration-meta.json");

/**
 * Per-surface entry recorded into the metadata file. `reason` is set
 * when the surface is intentionally skipped (no public adapter, missing
 * seed data) and absent for actively exercised surfaces.
 */
export interface IntegrationSurfaceEntry {
  surface: string;
  status: "exercised" | "skipped";
  reason?: string;
  recordedAt: string;
}

/** Top-level metadata document written to `test-results/integration-meta.json`. */
export interface IntegrationMetaDocument {
  sdkVersion: string;
  sdkPackage: string;
  serverVersion: string | undefined;
  serverReleaseChannel: string | undefined;
  serverImage: string | undefined;
  serverCommit: string | undefined;
  baseUrl: string;
  seedProfile: string;
  serviceId: string;
  layerId: number;
  collectionId: string;
  tileMatrixSetId: string;
  startedAt: string;
  surfaces: IntegrationSurfaceEntry[];
}

interface MutableMeta extends IntegrationMetaDocument {
  surfaces: IntegrationSurfaceEntry[];
}

let mutableMeta: MutableMeta | undefined;
const surfaceIndex = new Map<string, IntegrationSurfaceEntry>();

/**
 * Initialize the metadata document once per process. Called from the
 * Vitest global setup with the resolved server compatibility envelope so
 * the file already names the SDK and server versions before any surface
 * test runs.
 */
export function initializeMeta(initial: Omit<IntegrationMetaDocument, "surfaces">): void {
  mutableMeta = { ...initial, surfaces: [] };
  surfaceIndex.clear();
  flushMeta();
}

/**
 * Append a surface to the metadata file. Idempotent — calling twice for
 * the same surface keeps the original entry but overwrites the reason
 * (so a skip recorded ahead of time can later be marked as exercised
 * without leaving stale text behind).
 *
 * Vitest runs surface test files in worker processes that do not share
 * module state with the global setup process, so when the worker calls
 * this function `mutableMeta` is `undefined` even though
 * `initializeMeta()` already wrote the artifact. Restore from disk in
 * that case and merge the new surface entry. `vitest.integration.config.ts`
 * pins `fileParallelism: false` so reads and writes stay serial.
 */
export function recordSurface(surface: string, skipReason?: string): void {
  if (!mutableMeta) {
    const restored = restoreMetaFromDisk();
    if (!restored) return;
    mutableMeta = restored;
    surfaceIndex.clear();
    for (const entry of mutableMeta.surfaces) {
      surfaceIndex.set(entry.surface, entry);
    }
  }
  const existing = surfaceIndex.get(surface);
  if (existing) {
    if (skipReason) {
      existing.status = "skipped";
      existing.reason = skipReason;
    } else if (existing.status !== "exercised") {
      existing.status = "exercised";
      delete existing.reason;
    }
    flushMeta();
    return;
  }
  const entry: IntegrationSurfaceEntry = {
    surface,
    status: skipReason ? "skipped" : "exercised",
    ...(skipReason ? { reason: skipReason } : {}),
    recordedAt: new Date().toISOString(),
  };
  surfaceIndex.set(surface, entry);
  mutableMeta.surfaces.push(entry);
  flushMeta();
}

/** Return the current metadata document or `undefined` if not initialized. */
export function readMeta(): IntegrationMetaDocument | undefined {
  return mutableMeta ? structuredClone(mutableMeta) : undefined;
}

/** Path to the on-disk metadata artifact. Exposed for assertions and CI uploads. */
export function metaFilePath(): string {
  return META_FILE;
}

function flushMeta(): void {
  if (!mutableMeta) return;
  fs.mkdirSync(TEST_RESULTS_DIR, { recursive: true });
  fs.writeFileSync(META_FILE, `${JSON.stringify(mutableMeta, null, 2)}\n`);
}

function restoreMetaFromDisk(): MutableMeta | undefined {
  let raw: string;
  try {
    raw = fs.readFileSync(META_FILE, "utf8");
  } catch {
    return undefined;
  }
  let parsed: IntegrationMetaDocument;
  try {
    parsed = JSON.parse(raw) as IntegrationMetaDocument;
  } catch {
    return undefined;
  }
  return { ...parsed, surfaces: [...(parsed.surfaces ?? [])] };
}
