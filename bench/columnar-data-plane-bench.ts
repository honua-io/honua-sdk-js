/**
 * Deterministic end-to-end columnar data-plane benchmark.
 *
 * Where `columnar-bench.ts` measures only the final renderer projection, this
 * harness walks the whole #394 data plane for one batch:
 *
 * 1. build   — deterministic packed fixture plus `createColumnarBatch` validation
 * 2. worker  — one-owner lease, structured-clone transfer across a real
 *              `MessageChannel` worker boundary, a registered columnar worker
 *              operation that scans packed columns, and ownership return
 * 3. render  — `bindColumnarBatchToDeckGl` plus `DeckGlAdapter.project`
 *
 * Nothing here needs a live server, a real `Worker`, or a real deck.gl: the
 * transport is a `MessageChannel` (genuine structured clone and genuine buffer
 * detach) and the layer peer is a stub that captures the forwarded binary
 * `data`. The run therefore measures SDK overhead only, exactly like the other
 * deterministic bench harnesses.
 *
 * The semantic invariants are machine independent — zero payload copies, sender
 * backings detached, renderer attributes aliasing the batch's own
 * `ArrayBuffer`s, monotonic progress, preserved row count — so they gate on
 * every host. The timing and retained-memory numbers carry the absolute budgets
 * declared for this scenario in `bench/budgets.json`.
 */
import { performance } from "node:perf_hooks";

import {
  type ColumnarBatchV1,
  type ColumnarWorkerFaultEvent,
  type ColumnarWorkerMessageEvent,
  type ColumnarWorkerOperation,
  type ColumnarWorkerOperationContext,
  type ColumnarWorkerTransport,
  createColumnarWorkerSession,
  startColumnarWorkerHost,
} from "../src/columnar/index.js";
import { createDeckGlAdapter } from "../src/deckgl/adapter.js";
import { bindColumnarBatchToDeckGl } from "../src/deckgl/columnar.js";
import type { DeckGlLayer } from "../src/deckgl/types.js";
import { COLUMNAR_FIXTURE_BUFFER_IDS, buildColumnarBatchFixture } from "./columnar-fixture.js";
import { collectGarbage, retainedBytes } from "./retained-memory.js";

/** The registered worker operation name used by this scenario. */
const OPERATION = "columnar-data-plane.scan";

/** Captures the binary data deck.gl would receive; performs no rendering. */
class StubBinaryLayer implements DeckGlLayer {
  public readonly id: string | undefined;
  public readonly data: unknown;
  public constructor(props: Readonly<Record<string, unknown>>) {
    this.id = typeof props.id === "string" ? props.id : undefined;
    this.data = props.data;
  }
}

export interface ColumnarDataPlaneBenchmarkOptions {
  featureCount: number;
  warmupRuns: number;
  measurementRuns: number;
}

export interface ColumnarDataPlaneSample {
  /** Wall time for build + worker round trip + renderer projection. */
  totalDurationMs: number;
  buildDurationMs: number;
  workerDurationMs: number;
  renderDurationMs: number;
  featuresPerSecond: number;
  /** Unique backing allocation bytes divided by row count. */
  backingBytesPerFeature: number;
  /**
   * Peak `heapUsed + arrayBuffers` observed at any stage boundary, minus a
   * **collected** pre-run reading, divided by row count.
   *
   * Two properties make this a sound ceiling rather than a decorative number.
   *
   * First, the baseline is taken immediately after a forced collection, so it
   * measures live bytes only. Without that, the baseline would carry unreachable
   * objects from the warm-up run and the five preceding corpus scenarios; a
   * collection landing inside this scenario's window would then offset — or
   * exceed — the allocations being measured, and a regression materializing
   * hundreds of bytes per feature could still report under the ceiling.
   * `collectedBaseline` fails the scenario when no collector is available, so
   * the gate refuses to publish an unsound reading instead of passing silently.
   *
   * Second, the value is a peak across the stage boundaries rather than a
   * start-to-end delta. A delta goes negative whenever a collection lands in the
   * window. From a collected baseline the peak can only rise, because garbage
   * can be created during the run but none is carried into it.
   */
  peakRetainedBytesPerFeature: number;
  /** Payload bytes copied across the transfer and the projection. Always zero. */
  copiedBytes: number;
  /** Bytes relinquished to the worker boundary. */
  transferBytes: number;
}

export interface ColumnarDataPlaneBenchmarkResult {
  samples: ColumnarDataPlaneSample[];
  invariants: {
    checks: {
      /** No payload buffer was sliced or cloned at any stage. */
      zeroPayloadCopies: boolean;
      /** Every sender backing allocation was detached by the transfer. */
      senderBuffersDetached: boolean;
      /** Every projected deck.gl attribute aliases the batch's own ArrayBuffer. */
      rendererAliasesBatchBuffers: boolean;
      /** Worker progress was non-decreasing and terminated at exactly 1. */
      monotonicProgress: boolean;
      /** The row count survived the whole round trip. */
      rowCountPreserved: boolean;
      /** The worker operation observed every row of the packed geometry column. */
      operationScannedEveryRow: boolean;
      /**
       * A collector was available, so `peakRetainedBytesPerFeature` was measured
       * from a garbage-free baseline. Run Node with `--expose-gc`; `npm run
       * bench:lab` already does. Without it the memory ceiling cannot be
       * enforced soundly, so the scenario fails rather than reporting a number
       * that a mid-run collection may have quietly deflated.
       */
      collectedBaseline: boolean;
    };
    passed: boolean;
  };
}

interface DataPlaneRun {
  sample: ColumnarDataPlaneSample;
  checks: ColumnarDataPlaneBenchmarkResult["invariants"]["checks"];
}

type MessageListener = (event: ColumnarWorkerMessageEvent) => void;
type FaultListener = (event: ColumnarWorkerFaultEvent) => void;

/**
 * Adapt one `MessagePort` to the SDK's transport seam. A `MessageChannel` gives
 * the harness real structured-clone semantics and real `ArrayBuffer` detach
 * without paying worker-thread startup variance.
 *
 * A `MessagePort` has no `error` event, so an `error` registration is accepted
 * and never fires. That is safe here because the benchmark drives no faults, and
 * an operation failure surfaces as a settled request rather than a transport
 * fault.
 */
class MessagePortTransport implements ColumnarWorkerTransport {
  private readonly forwarders = new Map<MessageListener, (event: MessageEvent) => void>();

  public constructor(private readonly port: MessagePort) {}

  public postMessage(message: unknown, transfer: readonly ArrayBuffer[]): void {
    this.port.postMessage(message, [...transfer]);
  }

  public addEventListener(type: "message" | "error", listener: MessageListener | FaultListener): void {
    if (type !== "message") return;
    const message = listener as MessageListener;
    const forward = (event: MessageEvent): void => message({ data: event.data });
    this.forwarders.set(message, forward);
    this.port.addEventListener("message", forward);
    this.port.start();
  }

  public removeEventListener(type: "message" | "error", listener: MessageListener | FaultListener): void {
    if (type !== "message") return;
    const message = listener as MessageListener;
    const forward = this.forwarders.get(message);
    if (!forward) return;
    this.forwarders.delete(message);
    this.port.removeEventListener("message", forward);
  }

  public dispose(): void {
    this.port.close();
  }
}

/**
 * A columnar worker operation that reads every packed coordinate without
 * materializing a single row object, then returns the same batch so ownership
 * flows back to the caller with no new allocation.
 */
function createScanOperation(): { operation: ColumnarWorkerOperation; scanned: () => number } {
  let scannedRows = -1;
  const operation: ColumnarWorkerOperation = (
    batch: ColumnarBatchV1,
    context: ColumnarWorkerOperationContext,
  ): ColumnarBatchV1 => {
    context.signal.throwIfAborted();
    context.reportProgress(0, "scan");
    const descriptor = batch.buffers.find((buffer) => buffer.id === COLUMNAR_FIXTURE_BUFFER_IDS.position);
    if (!descriptor) throw new Error("columnar-data-plane: the fixture position column is missing");
    const coordinates = new Float32Array(descriptor.data, descriptor.byteOffset, descriptor.byteLength / 4);
    let checksum = 0;
    for (let index = 0; index < coordinates.length; index += 2) checksum += coordinates[index]!;
    if (!Number.isFinite(checksum)) throw new Error("columnar-data-plane: the geometry column is not finite");
    scannedRows = coordinates.length / 2;
    context.reportProgress(1, "complete");
    return batch;
  };
  return { operation, scanned: () => scannedRows };
}

function projectionRequest(batch: ColumnarBatchV1) {
  return bindColumnarBatchToDeckGl({
    batch,
    layerId: "columnar-data-plane",
    attributes: [
      { accessor: "getPosition", bufferId: COLUMNAR_FIXTURE_BUFFER_IDS.position, component: "float32", size: 2 },
      { accessor: "getRadius", bufferId: COLUMNAR_FIXTURE_BUFFER_IDS.radius, component: "float32", size: 1 },
      {
        accessor: "getFillColor",
        bufferId: COLUMNAR_FIXTURE_BUFFER_IDS.fillColor,
        component: "uint8",
        size: 4,
        normalized: true,
      },
    ],
    identity: {
      sourceId: "columnar-data-plane",
      planId: "plan:columnar-data-plane",
      featureIdColumn: { bufferId: COLUMNAR_FIXTURE_BUFFER_IDS.id, component: "uint32" },
    },
  });
}

async function runOnce(featureCount: number): Promise<DataPlaneRun> {
  const channel = new MessageChannel();
  const { operation, scanned } = createScanOperation();
  const host = startColumnarWorkerHost({
    transport: new MessagePortTransport(channel.port2),
    operations: { [OPERATION]: operation },
  });
  const session = createColumnarWorkerSession({ createWorker: () => new MessagePortTransport(channel.port1) });
  try {
    const collectedBaseline = collectGarbage();
    const retainedBefore = retainedBytes();

    const buildStarted = performance.now();
    const { batch } = buildColumnarBatchFixture(featureCount);
    const senderBackings = [...new Set(batch.buffers.map((buffer) => buffer.data))];
    const buildDurationMs = performance.now() - buildStarted;
    let retainedPeak = retainedBytes();

    const workerStarted = performance.now();
    const progress: number[] = [];
    const executed = await session.execute(OPERATION, batch, {
      onProgress: (event) => progress.push(event.fraction),
    });
    const workerDurationMs = performance.now() - workerStarted;
    retainedPeak = Math.max(retainedPeak, retainedBytes());

    const renderStarted = performance.now();
    const adapter = createDeckGlAdapter({ peers: { ScatterplotLayer: StubBinaryLayer } });
    const projection = adapter.project(projectionRequest(executed.batch));
    const renderDurationMs = performance.now() - renderStarted;
    retainedPeak = Math.max(retainedPeak, retainedBytes());

    const layer = projection.layer as StubBinaryLayer;
    const forwarded = layer.data as { attributes: Record<string, { value: ArrayBufferView }> };
    const returnedBackings = new Set(executed.batch.buffers.map((buffer) => buffer.data));
    const totalDurationMs = buildDurationMs + workerDurationMs + renderDurationMs;

    return {
      sample: {
        totalDurationMs,
        buildDurationMs,
        workerDurationMs,
        renderDurationMs,
        featuresPerSecond: (featureCount / Math.max(totalDurationMs, 0.001)) * 1_000,
        backingBytesPerFeature: executed.outputMetrics.backingBytes / featureCount,
        peakRetainedBytesPerFeature: (retainedPeak - retainedBefore) / featureCount,
        copiedBytes:
          executed.inputMetrics.copiedBytes + executed.outputMetrics.copiedBytes + projection.metrics.copiedBytes,
        transferBytes: executed.inputMetrics.transferBytes,
      },
      checks: {
        zeroPayloadCopies:
          executed.inputMetrics.copiedBytes === 0 &&
          executed.outputMetrics.copiedBytes === 0 &&
          projection.metrics.copiedBytes === 0,
        senderBuffersDetached: senderBackings.every((backing) => backing.byteLength === 0),
        rendererAliasesBatchBuffers: Object.values(forwarded.attributes).every((attribute) =>
          returnedBackings.has(attribute.value.buffer as ArrayBuffer),
        ),
        monotonicProgress:
          progress.length > 0 &&
          progress.at(-1) === 1 &&
          progress.every((fraction, index) => index === 0 || fraction >= progress[index - 1]!),
        rowCountPreserved: executed.batch.rowCount === featureCount,
        operationScannedEveryRow: scanned() === featureCount,
        collectedBaseline,
      },
    };
  } finally {
    // Both ports must close even if the first disposal throws.
    try {
      session.dispose();
    } finally {
      host.dispose();
    }
  }
}

/**
 * Run the deterministic columnar data-plane benchmark. Every reported check is
 * the conjunction across all measurement runs, so one bad repetition fails the
 * scenario.
 */
export async function runColumnarDataPlaneBenchmark(
  options: ColumnarDataPlaneBenchmarkOptions,
): Promise<ColumnarDataPlaneBenchmarkResult> {
  assertOptions(options);
  for (let run = 0; run < options.warmupRuns; run += 1) await runOnce(options.featureCount);
  const measured: DataPlaneRun[] = [];
  for (let run = 0; run < options.measurementRuns; run += 1) measured.push(await runOnce(options.featureCount));
  const checks = {
    zeroPayloadCopies: measured.every((run) => run.checks.zeroPayloadCopies),
    senderBuffersDetached: measured.every((run) => run.checks.senderBuffersDetached),
    rendererAliasesBatchBuffers: measured.every((run) => run.checks.rendererAliasesBatchBuffers),
    monotonicProgress: measured.every((run) => run.checks.monotonicProgress),
    rowCountPreserved: measured.every((run) => run.checks.rowCountPreserved),
    operationScannedEveryRow: measured.every((run) => run.checks.operationScannedEveryRow),
    collectedBaseline: measured.every((run) => run.checks.collectedBaseline),
  };
  return {
    samples: measured.map((run) => run.sample),
    invariants: { checks, passed: Object.values(checks).every(Boolean) },
  };
}

function assertOptions(options: ColumnarDataPlaneBenchmarkOptions): void {
  if (
    !Number.isInteger(options.featureCount) ||
    options.featureCount < 1 ||
    !Number.isInteger(options.warmupRuns) ||
    options.warmupRuns < 0 ||
    !Number.isInteger(options.measurementRuns) ||
    options.measurementRuns < 1
  ) {
    throw new Error("Columnar data-plane benchmark options must be positive integers");
  }
}
