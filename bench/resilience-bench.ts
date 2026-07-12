import { performance } from "node:perf_hooks";

import {
  type OfflineRegionCommitGuard,
  type OfflineRegionDownloadReceipt,
  type OfflineRegionManifestV1,
  type OfflineRegionResourceV1,
  type OfflineRegionStore,
  type OfflineRegionStoredRegion,
  type OfflineRegionWriteTransaction,
  createOfflineRegionManifest,
  downloadOfflineRegion,
} from "../src/offline/index.js";
import {
  type RealtimeDurableCheckpointV1,
  type RealtimeResumeContextV1,
  createResumableRealtimeSubscription,
} from "../src/realtime/index.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const FIXED_NOW = Date.parse("2026-07-11T12:00:00.000Z");
const FIXED_OBSERVED_AT = "2026-07-11T11:59:00.000Z";

export interface ResilienceTimingSample {
  totalDurationMs: number;
  operationsPerSecond: number;
}

export interface ResilienceInvariantResult {
  passed: boolean;
  checks: Readonly<Record<string, boolean | number | string | null>>;
  semantics: {
    freshness: { status: "fresh" | "stale"; ageMs: number; maxAgeMs: number };
    cursor: { present: boolean };
    retry: { count: number };
    ordering: { status: "preserved" | "violated" | "not-applicable" };
    duplication: { ignoredCount: number; appliedCount: number };
    credentialMaterialPresent: boolean;
  };
}

export interface ResilienceBenchmarkResult {
  samples: ResilienceTimingSample[];
  invariants: ResilienceInvariantResult;
}

export interface OfflineReloadBenchmarkOptions {
  resourceCount: number;
  resourceBytes: number;
  reloadCycles: number;
  maxFreshnessAgeMs: number;
  warmupRuns: number;
  measurementRuns: number;
  /** Deliberate regression fixtures used only by benchmark tests. */
  fault?: "stale" | "corrupt-resource";
}

export interface RealtimeReconnectBenchmarkOptions {
  eventCount: number;
  replayDuplicateCount: number;
  maxFreshnessAgeMs: number;
  warmupRuns: number;
  measurementRuns: number;
  /** Deliberate regression fixtures used only by benchmark tests. */
  fault?: "sequence-gap" | "duplicate-applied";
}

class MemoryOfflineStore implements OfflineRegionStore {
  public revision = 0;
  public regions: OfflineRegionStoredRegion[] = [];
  public manifest?: OfflineRegionManifestV1;
  public readonly resources = new Map<string, Uint8Array>();

  public async inventory() {
    return { revision: String(this.revision), regions: this.regions.map((region) => ({ ...region })) };
  }

  public async beginWrite(): Promise<OfflineRegionWriteTransaction> {
    const pending = new Map<string, Uint8Array>();
    return {
      evict: async () => undefined,
      write: async (resource, bytes) => {
        pending.set(resource.id, Uint8Array.from(bytes));
      },
      commit: async (manifest, receipt, guard) => this.commit(manifest, receipt, guard, pending),
      rollback: async () => undefined,
    };
  }

  private commit(
    manifest: OfflineRegionManifestV1,
    receipt: OfflineRegionDownloadReceipt,
    guard: OfflineRegionCommitGuard,
    pending: ReadonlyMap<string, Uint8Array>,
  ): "committed" | "inventory-changed" {
    if (guard.expectedInventoryRevision !== String(this.revision)) return "inventory-changed";
    this.manifest = manifest;
    this.resources.clear();
    for (const [id, bytes] of pending) this.resources.set(id, Uint8Array.from(bytes));
    this.regions = [
      {
        id: manifest.id,
        logicalByteLength: manifest.totalLogicalBytes,
        lastAccessedAt: receipt.completedAt,
        ...(manifest.expiresAt ? { expiresAt: manifest.expiresAt } : {}),
      },
    ];
    this.revision += 1;
    return "committed";
  }
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

async function sha256(bytes: Uint8Array): Promise<`sha256:${string}`> {
  const owned = new Uint8Array(bytes.byteLength);
  owned.set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", owned.buffer);
  return `sha256:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function payload(index: number, byteLength: number): Uint8Array {
  const seed = encoder.encode(`offline-resource-${index.toString().padStart(6, "0")}|`);
  const bytes = new Uint8Array(byteLength);
  for (let offset = 0; offset < bytes.length; offset += 1) bytes[offset] = seed[offset % seed.length] ?? 0;
  return bytes;
}

async function prepareOfflineFixture(options: OfflineReloadBenchmarkOptions): Promise<{
  manifestBytes: Uint8Array;
  store: MemoryOfflineStore;
}> {
  const resources: OfflineRegionResourceV1[] = [];
  const bytesById = new Map<string, Uint8Array>();
  for (let index = 0; index < options.resourceCount; index += 1) {
    const id = `resource/${index.toString().padStart(6, "0")}`;
    const bytes = payload(index, options.resourceBytes);
    bytesById.set(id, bytes);
    resources.push({
      id,
      kind: index === 0 ? "metadata" : "tile",
      byteLength: bytes.byteLength,
      integrity: await sha256(bytes),
      sourceVersion: "offline-benchmark-source-v1",
      schemaVersion: "offline-benchmark-schema-v1",
      planVersion: "offline-benchmark-plan-v1",
      attributionIds: [],
    });
  }
  const observedAt = options.fault === "stale" ? "2026-07-10T00:00:00.000Z" : FIXED_OBSERVED_AT;
  const manifest = await createOfflineRegionManifest({
    name: "Deterministic offline benchmark region",
    sourceId: "benchmark-offline-source",
    endpoint: "https://offline.invalid/FeatureServer/0?f=json",
    authorizationScopeFingerprint: "benchmark-public-scope-v1",
    bounds: { minX: -158, minY: 21, maxX: -157, maxY: 22, crs: "EPSG:4326" },
    sourceVersion: "offline-benchmark-source-v1",
    schemaVersion: "offline-benchmark-schema-v1",
    planVersion: "offline-benchmark-plan-v1",
    observation: { state: "cached", observedAt },
    expiresAt: "2099-01-01T00:00:00.000Z",
    resources,
  });
  const store = new MemoryOfflineStore();
  await downloadOfflineRegion(manifest, {
    store,
    logicalQuotaBytes: manifest.totalLogicalBytes,
    now: () => new Date(FIXED_NOW),
    load: async (resource) => bytesById.get(resource.id) ?? new Uint8Array(),
  });
  if (options.fault === "corrupt-resource") store.resources.get(resources[0]?.id ?? "")?.fill(0);
  return { manifestBytes: encoder.encode(JSON.stringify(manifest)), store };
}

async function reloadOffline(
  fixture: Awaited<ReturnType<typeof prepareOfflineFixture>>,
  reloadCycles: number,
): Promise<{ sample: ResilienceTimingSample; resourceCount: number; integrityVerified: boolean; observedAt: string }> {
  let resourceCount = 0;
  let integrityVerified = true;
  let observedAt = "";
  const started = performance.now();
  for (let cycle = 0; cycle < reloadCycles; cycle += 1) {
    const manifest = JSON.parse(decoder.decode(fixture.manifestBytes)) as OfflineRegionManifestV1;
    observedAt = manifest.source.observation.observedAt;
    for (const resource of manifest.resources) {
      const bytes = fixture.store.resources.get(resource.id);
      if (!bytes || bytes.byteLength !== resource.byteLength || (await sha256(bytes)) !== resource.integrity) {
        integrityVerified = false;
      }
      resourceCount += 1;
    }
  }
  const totalDurationMs = performance.now() - started;
  return {
    sample: { totalDurationMs, operationsPerSecond: (resourceCount / Math.max(totalDurationMs, 0.001)) * 1_000 },
    resourceCount,
    integrityVerified,
    observedAt,
  };
}

export async function runOfflineReloadBenchmark(
  options: OfflineReloadBenchmarkOptions,
): Promise<ResilienceBenchmarkResult> {
  positiveInteger(options.resourceCount, "resourceCount");
  positiveInteger(options.resourceBytes, "resourceBytes");
  positiveInteger(options.reloadCycles, "reloadCycles");
  positiveInteger(options.measurementRuns, "measurementRuns");
  const fixture = await prepareOfflineFixture(options);
  for (let run = 0; run < options.warmupRuns; run += 1) await reloadOffline(fixture, options.reloadCycles);
  const measured = [];
  for (let run = 0; run < options.measurementRuns; run += 1) {
    measured.push(await reloadOffline(fixture, options.reloadCycles));
  }
  const expectedResources = options.resourceCount * options.reloadCycles;
  const observedAt = measured[0]?.observedAt ?? "";
  const ageMs = FIXED_NOW - Date.parse(observedAt);
  const freshnessStatus = ageMs <= options.maxFreshnessAgeMs ? "fresh" : "stale";
  const integrityVerified = measured.every((result) => result.integrityVerified);
  const countsMatch = measured.every((result) => result.resourceCount === expectedResources);
  return {
    samples: measured.map((result) => result.sample),
    invariants: {
      passed: freshnessStatus === "fresh" && integrityVerified && countsMatch,
      checks: { expectedResources, countsMatch, integrityVerified },
      semantics: {
        freshness: { status: freshnessStatus, ageMs, maxAgeMs: options.maxFreshnessAgeMs },
        cursor: { present: false },
        retry: { count: 0 },
        ordering: { status: "not-applicable" },
        duplication: { ignoredCount: 0, appliedCount: 0 },
        credentialMaterialPresent: false,
      },
    },
  };
}

const realtimeContext: RealtimeResumeContextV1 = {
  kind: "honua.realtime-resume-context",
  version: 1,
  sourceId: "benchmark-incidents",
  queryFingerprint: "sha256:benchmark-query-v1",
  sourceVersion: "benchmark-source-v1",
  schemaVersion: "benchmark-schema-v1",
  authorizationScopeFingerprint: "sha256:benchmark-public-scope-v1",
};

async function seedRealtimeCheckpoint(): Promise<RealtimeDurableCheckpointV1> {
  const gate = await createResumableRealtimeSubscription({
    context: realtimeContext,
    apply: () => undefined,
    now: () => FIXED_NOW,
  });
  const delivery = await gate.enqueue({
    type: "snapshot",
    eventId: "event-1",
    sequence: 1,
    cursor: "internal-cursor-1",
    features: [],
  });
  gate.close();
  if (!delivery.checkpoint) throw new Error("Realtime benchmark could not establish its deterministic checkpoint");
  return delivery.checkpoint;
}

async function reconnectRealtime(
  checkpoint: RealtimeDurableCheckpointV1,
  options: RealtimeReconnectBenchmarkOptions,
): Promise<{
  sample: ResilienceTimingSample;
  orderingPreserved: boolean;
  duplicateIgnoredCount: number;
  duplicateAppliedCount: number;
  cursorPresent: boolean;
  retryCount: number;
}> {
  let appliedCount = 0;
  let lastAppliedSequence = checkpoint.resume.sequence;
  let orderingPreserved = true;
  const started = performance.now();
  let retryCount = 0;
  const open = async (attempt: number) => {
    if (attempt === 0) throw new Error("deterministic transient reconnect failure");
    return createResumableRealtimeSubscription({
      context: realtimeContext,
      initialCheckpoint: checkpoint,
      now: () => FIXED_NOW,
      apply: (event) => {
        const sequence = event.sequence ?? -1;
        if (sequence !== lastAppliedSequence + 1) orderingPreserved = false;
        lastAppliedSequence = sequence;
        appliedCount += 1;
      },
    });
  };
  try {
    await open(0);
  } catch {
    retryCount += 1;
  }
  const gate = await open(1);
  for (let replay = 0; replay < options.replayDuplicateCount; replay += 1) {
    await gate.enqueue({ type: "upsert", eventId: "event-1", sequence: 1, feature: { id: 1, feature: {} } });
  }
  for (let index = 0; index < options.eventCount; index += 1) {
    const sequence = index + 2 + (options.fault === "sequence-gap" && index === 0 ? 1 : 0);
    const delivery = await gate.enqueue({
      type: "upsert",
      eventId: `event-${sequence}`,
      sequence,
      cursor: `internal-cursor-${sequence}`,
      feature: { id: sequence, feature: { state: "open" } },
    });
    if (delivery.status !== "applied") orderingPreserved = false;
  }
  const totalDurationMs = performance.now() - started;
  const duplicateIgnoredCount = gate.state.duplicateEventCount;
  const duplicateAppliedCount =
    Math.max(0, appliedCount - options.eventCount) + (options.fault === "duplicate-applied" ? 1 : 0);
  const cursorPresent = typeof gate.state.checkpoint?.resume.cursor === "string";
  gate.close();
  return {
    sample: {
      totalDurationMs,
      operationsPerSecond:
        ((options.eventCount + options.replayDuplicateCount) / Math.max(totalDurationMs, 0.001)) * 1_000,
    },
    orderingPreserved,
    duplicateIgnoredCount,
    duplicateAppliedCount,
    cursorPresent,
    retryCount,
  };
}

export async function runRealtimeReconnectBenchmark(
  options: RealtimeReconnectBenchmarkOptions,
): Promise<ResilienceBenchmarkResult> {
  positiveInteger(options.eventCount, "eventCount");
  positiveInteger(options.replayDuplicateCount, "replayDuplicateCount");
  positiveInteger(options.measurementRuns, "measurementRuns");
  const checkpoint = await seedRealtimeCheckpoint();
  for (let run = 0; run < options.warmupRuns; run += 1) await reconnectRealtime(checkpoint, options);
  const measured = [];
  for (let run = 0; run < options.measurementRuns; run += 1)
    measured.push(await reconnectRealtime(checkpoint, options));
  const orderingPreserved = measured.every((result) => result.orderingPreserved);
  const duplicateIgnoredCount = Math.min(...measured.map((result) => result.duplicateIgnoredCount));
  const duplicateAppliedCount = Math.max(...measured.map((result) => result.duplicateAppliedCount));
  const cursorPresent = measured.every((result) => result.cursorPresent);
  const retryCount = Math.max(...measured.map((result) => result.retryCount));
  const ageMs = FIXED_NOW - Date.parse(checkpoint.savedAt);
  const freshnessStatus = ageMs <= options.maxFreshnessAgeMs ? "fresh" : "stale";
  const duplicatesIgnored = duplicateIgnoredCount === options.replayDuplicateCount && duplicateAppliedCount === 0;
  return {
    samples: measured.map((result) => result.sample),
    invariants: {
      passed:
        freshnessStatus === "fresh" && cursorPresent && retryCount === 1 && orderingPreserved && duplicatesIgnored,
      checks: {
        cursorPresent,
        retryCount,
        orderingPreserved,
        expectedDuplicateIgnoredCount: options.replayDuplicateCount,
        duplicateIgnoredCount,
        duplicateAppliedCount,
      },
      semantics: {
        freshness: { status: freshnessStatus, ageMs, maxAgeMs: options.maxFreshnessAgeMs },
        cursor: { present: cursorPresent },
        retry: { count: retryCount },
        ordering: { status: orderingPreserved ? "preserved" : "violated" },
        duplication: { ignoredCount: duplicateIgnoredCount, appliedCount: duplicateAppliedCount },
        credentialMaterialPresent: false,
      },
    },
  };
}
