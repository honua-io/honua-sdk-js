/**
 * Stream / pagination performance harness for the stable contract surface.
 *
 * Measures throughput and latency of draining a paginated feature stream through
 * the protocol-neutral `createDataset(...).source(id).stream(query)` API against
 * the deterministic in-process transport in {@link createMockTransport}. Because
 * the transport is fixture-backed, results are reproducible and require no live
 * server.
 *
 * Metrics emitted per page size (see {@link StreamBenchMetrics}):
 *  - `featuresPerSecond`  — total features drained / wall time
 *  - `timeToFirstPageMs`  — latency until the first page is yielded
 *  - `heapUsedDeltaBytes` / `heapUsedPeakBytes` — memory profile across the drain
 *
 * This module is intentionally dependency-free beyond the SDK so it can run under
 * plain `node`, `vitest`, or `vitest bench`.
 */
import { createDataset } from "../src/contract/source.js";
import { PROTOCOL_DEFAULT_CAPABILITIES } from "../src/contract/types.js";
import type { Query, Result } from "../src/contract/types.js";
import { HonuaClient } from "../src/core/client.js";
import type { HonuaFeature } from "../src/core/types.js";
import { buildFeatureFixture } from "./feature-fixture.js";
import { createMockTransport } from "./mock-transport.js";

const SOURCE_ID = "incidents";

export interface StreamBenchMetrics {
  /** Page size (`pagination.limit`) used for this run. */
  pageSize: number;
  /** Total features drained from the stream. */
  totalFeatures: number;
  /** Number of pages yielded by the stream. */
  pageCount: number;
  /** Wall-clock time to drain the entire stream, in milliseconds. */
  totalDurationMs: number;
  /** Latency from starting the drain until the first page is yielded, in milliseconds. */
  timeToFirstPageMs: number;
  /** Sustained throughput: total features / total time. */
  featuresPerSecond: number;
  /** `process.memoryUsage().heapUsed` delta across the drain, in bytes. */
  heapUsedDeltaBytes: number;
  /** Peak `heapUsed` observed (sampled per page), in bytes. */
  heapUsedPeakBytes: number;
}

export interface StreamBenchOptions {
  /** Number of synthetic features in the fixture. Default 50_000. */
  featureCount?: number;
  /** Page sizes (`pagination.limit`) to sweep. Default [500, 2000, 10000]. */
  pageSizes?: readonly number[];
  /** Optional artificial per-page transport latency in ms. Default 0. */
  pageLatencyMs?: number;
  /** Whether to retain geometry in the drained pages. Default true. */
  returnGeometry?: boolean;
}

export interface StreamBenchReport {
  featureCount: number;
  pageLatencyMs: number;
  runs: StreamBenchMetrics[];
}

function heapUsed(): number {
  return process.memoryUsage().heapUsed;
}

/**
 * Drive a single drain of the stream at one page size and collect metrics.
 * The fixture is rebuilt per run so heap deltas are not polluted by fixture
 * allocation from prior runs.
 */
export async function runStreamBenchOnce(
  fixture: readonly HonuaFeature[],
  pageSize: number,
  pageLatencyMs: number,
  returnGeometry: boolean,
): Promise<StreamBenchMetrics> {
  const transport = createMockTransport({ features: fixture, pageLatencyMs });
  const client = new HonuaClient({ baseUrl: "http://bench.local", fetchFn: transport.fetchFn });
  const dataset = createDataset({
    id: "stream-bench",
    client,
    skipCompatibilityCheck: true,
    sources: [
      {
        id: SOURCE_ID,
        protocol: "geoservices-feature-service",
        locator: { url: "http://bench.local", serviceId: "incidents", layerId: 0 },
        capabilities: PROTOCOL_DEFAULT_CAPABILITIES["geoservices-feature-service"],
      },
    ],
  });

  const source = dataset.source(SOURCE_ID);
  if (!source) {
    throw new Error(`stream-bench: source "${SOURCE_ID}" failed to resolve`);
  }

  const query: Query = {
    where: "1=1",
    returnGeometry,
    pagination: { limit: pageSize },
  };

  let totalFeatures = 0;
  let pageCount = 0;
  let timeToFirstPageMs = Number.NaN;

  // Sample memory after a settle point; the delta is heap growth attributable
  // to streaming, not fixture construction (the fixture is built by the caller).
  const heapStart = heapUsed();
  let heapPeak = heapStart;

  const start = performance.now();
  for await (const page of source.stream(query) as AsyncGenerator<Result, void, undefined>) {
    if (pageCount === 0) {
      timeToFirstPageMs = performance.now() - start;
    }
    pageCount += 1;
    totalFeatures += page.features.length;
    const sample = heapUsed();
    if (sample > heapPeak) {
      heapPeak = sample;
    }
  }
  const totalDurationMs = performance.now() - start;

  const featuresPerSecond = totalDurationMs > 0 ? (totalFeatures / totalDurationMs) * 1000 : 0;

  return {
    pageSize,
    totalFeatures,
    pageCount,
    totalDurationMs,
    timeToFirstPageMs: Number.isNaN(timeToFirstPageMs) ? totalDurationMs : timeToFirstPageMs,
    featuresPerSecond,
    heapUsedDeltaBytes: heapUsed() - heapStart,
    heapUsedPeakBytes: heapPeak,
  };
}

/**
 * Sweep the configured page sizes and return one {@link StreamBenchMetrics} per size.
 * Deterministic and server-free; safe to call from tests or a CLI.
 */
export async function runStreamBench(options: StreamBenchOptions = {}): Promise<StreamBenchReport> {
  const featureCount = options.featureCount ?? 50_000;
  const pageSizes = options.pageSizes ?? [500, 2000, 10_000];
  const pageLatencyMs = options.pageLatencyMs ?? 0;
  const returnGeometry = options.returnGeometry ?? true;

  const fixture = buildFeatureFixture(featureCount);
  const runs: StreamBenchMetrics[] = [];
  for (const pageSize of pageSizes) {
    runs.push(await runStreamBenchOnce(fixture, pageSize, pageLatencyMs, returnGeometry));
  }

  return { featureCount, pageLatencyMs, runs };
}

/** Format a metrics report as an aligned text table for CLI output. */
export function formatReport(report: StreamBenchReport): string {
  const header = `stream/pagination bench — ${report.featureCount.toLocaleString()} features, page latency ${report.pageLatencyMs}ms`;
  const cols = ["pageSize", "pages", "features", "totalMs", "ttfpMs", "feat/sec", "heapΔ MB", "heapPeak MB"];
  const rows = report.runs.map((r) => [
    String(r.pageSize),
    String(r.pageCount),
    String(r.totalFeatures),
    r.totalDurationMs.toFixed(2),
    r.timeToFirstPageMs.toFixed(2),
    Math.round(r.featuresPerSecond).toLocaleString(),
    (r.heapUsedDeltaBytes / 1_048_576).toFixed(2),
    (r.heapUsedPeakBytes / 1_048_576).toFixed(2),
  ]);

  const widths = cols.map((c, i) => Math.max(c.length, ...rows.map((row) => row[i].length)));
  const fmt = (cells: string[]): string => cells.map((cell, i) => cell.padStart(widths[i])).join("  ");

  return [header, "", fmt(cols), fmt(widths.map((w) => "-".repeat(w))), ...rows.map(fmt)].join("\n");
}
