/**
 * The optional Kepler.gl analytics-workspace bridge (REQ-001, NFR-001).
 *
 * Honua keeps discovery, query, plan, edit, and stream semantics; Kepler owns
 * exploratory presentation. This module is the single reusable entrypoint an
 * application uses to open an accepted Honua result, columnar artifact, or
 * supported remote source in a Kepler workspace, keep it reconciled, share
 * linked state, and export a credential-safe saved map.
 *
 * `kepler.gl`, `react`, `react-dom`, and `redux` are never imported by the SDK:
 * they are optional peers the host supplies, either directly as
 * {@link KeplerPeers} or through {@link loadKeplerPeers}, which resolves
 * `@kepler.gl/actions` with a dynamic import. Every projection, mapping, and
 * reconciliation function works with no peer at all — the peers are needed only
 * to dispatch into a live Kepler store.
 *
 * @experimental
 * @module
 */

import { projectArrowTableToKeplerDataset } from "./ingest-arrow.js";
import { projectColumnarBatchToKeplerDataset } from "./ingest-columnar.js";
import { projectRemoteSourceToKepler } from "./ingest-remote.js";
import { DEFAULT_KEPLER_BRIDGE_LIMITS, normalizeKeplerLimits, projectResultToKeplerDataset } from "./ingest.js";
import type { CreateKeplerLinkedStateSyncOptions, KeplerLinkedStateSync } from "./linked-state.js";
import { createKeplerLinkedStateSync } from "./linked-state.js";
import type {
  KeplerReconciliationEvent,
  KeplerReconciliationPlan,
  KeplerWorkspaceDatasetState,
} from "./reconciliation.js";
import { estimateKeplerRowBytes, keplerDatasetStateFromProjection, reconcileKeplerDataset } from "./reconciliation.js";
import type { KeplerRedactionResult, RedactKeplerExportStateOptions } from "./redaction.js";
import { redactKeplerExportState } from "./redaction.js";
import type {
  KeplerArrowTableProjectionRequest,
  KeplerBridgeCapability,
  KeplerBridgeLimits,
  KeplerColumnarProjectionRequest,
  KeplerCompatibility,
  KeplerDatasetProjection,
  KeplerPeers,
  KeplerProcessors,
  KeplerProtoDataset,
  KeplerRemoteSourceProjection,
  KeplerRemoteSourceProjectionRequest,
  KeplerResultProjectionRequest,
  KeplerWorkspaceHost,
  LoadKeplerPeersOptions,
  LoadKeplerProcessorsOptions,
} from "./types.js";
import { HonuaKeplerBridgeError, KEPLER_BRIDGE_CONTRACT_VERSION, KEPLER_COMPATIBILITY_RANGE } from "./types.js";

/** Declared ingestion support for bridge contract v1.1. */
export const KEPLER_BRIDGE_CAPABILITIES: readonly KeplerBridgeCapability[] = Object.freeze([
  Object.freeze({
    strategy: "row-object-direct" as const,
    supported: true,
    geoJsonRoundTrip: false,
    reason: "Attribute and aggregate rows are written straight into Kepler's tabular ingestion model.",
  }),
  Object.freeze({
    strategy: "point-columns-direct" as const,
    supported: true,
    geoJsonRoundTrip: false,
    reason: "Point geometry becomes a longitude/latitude column pair a Kepler point layer binds to directly.",
  }),
  Object.freeze({
    strategy: "columnar-columns-direct" as const,
    supported: true,
    geoJsonRoundTrip: false,
    reason: "Columnar artifact columns are transposed in place into Kepler rows.",
  }),
  Object.freeze({
    strategy: "arrow-table-processor" as const,
    supported: true,
    geoJsonRoundTrip: false,
    reason:
      "A host-supplied Kepler processArrowTable adapter consumes an Arrow table without an SDK GeoJSON serialization round trip.",
  }),
  Object.freeze({
    strategy: "geojson-column" as const,
    supported: true,
    geoJsonRoundTrip: true,
    reason:
      "Kepler exposes no tabular or binary path for line/polygon/multi-part geometry, so this path serializes geometry and reports the exact byte cost.",
  }),
  Object.freeze({
    strategy: "remote-basemap-style" as const,
    supported: true,
    geoJsonRoundTrip: false,
    reason:
      "Raster tile and style sources are referenced as a Kepler custom basemap; the SDK never proxies their tiles.",
  }),
  Object.freeze({
    strategy: "remote-vector-tileset" as const,
    supported: true,
    geoJsonRoundTrip: false,
    reason: "Vector tile sources are referenced as a Kepler tileset dataset descriptor.",
  }),
  Object.freeze({
    strategy: "arrow-columns-zero-copy" as const,
    supported: false,
    geoJsonRoundTrip: false,
    reason:
      "Kepler's Arrow/GeoArrow buffer-preserving path needs the apache-arrow peer and Kepler's own geoarrow field type; it remains outside bridge contract v1.1.",
  }),
]);

interface ParsedVersion {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
}

function parseVersion(value: string): ParsedVersion | undefined {
  const core = value.trim().split("+", 1)[0].split("-", 1)[0];
  const parts = core.split(".");
  if (parts.length < 1 || parts.length > 3) return undefined;
  const numbers = parts.map((part) => Number.parseInt(part, 10));
  if (numbers.some((part) => !Number.isInteger(part) || part < 0)) return undefined;
  return { major: numbers[0], minor: numbers[1] ?? 0, patch: numbers[2] ?? 0 };
}

function compareVersions(left: ParsedVersion, right: ParsedVersion): number {
  if (left.major !== right.major) return left.major - right.major;
  if (left.minor !== right.minor) return left.minor - right.minor;
  return left.patch - right.patch;
}

/** Evaluate a declared Kepler.gl version against {@link KEPLER_COMPATIBILITY_RANGE}. */
export function evaluateKeplerCompatibility(version: string): KeplerCompatibility {
  const parsed = typeof version === "string" ? parseVersion(version) : undefined;
  if (parsed === undefined) {
    return Object.freeze({
      declaredVersion: String(version),
      range: KEPLER_COMPATIBILITY_RANGE,
      supported: false,
      reason: `"${String(version)}" is not a parseable semantic version.`,
    });
  }
  const minimum = parseVersion(KEPLER_COMPATIBILITY_RANGE.minimum) as ParsedVersion;
  const exclusiveMaximum = parseVersion(KEPLER_COMPATIBILITY_RANGE.exclusiveMaximum) as ParsedVersion;
  const supported = compareVersions(parsed, minimum) >= 0 && compareVersions(parsed, exclusiveMaximum) < 0;
  return Object.freeze({
    declaredVersion: version,
    range: KEPLER_COMPATIBILITY_RANGE,
    supported,
    reason: supported
      ? `kepler.gl ${version} is inside the supported range >=${KEPLER_COMPATIBILITY_RANGE.minimum} <${KEPLER_COMPATIBILITY_RANGE.exclusiveMaximum}.`
      : `kepler.gl ${version} is outside the supported range >=${KEPLER_COMPATIBILITY_RANGE.minimum} <${KEPLER_COMPATIBILITY_RANGE.exclusiveMaximum}.`,
  });
}

/** Throwing form of {@link evaluateKeplerCompatibility}. */
export function assertKeplerCompatibility(version: string): KeplerCompatibility {
  const compatibility = evaluateKeplerCompatibility(version);
  if (!compatibility.supported) {
    throw new HonuaKeplerBridgeError("unsupported-kepler-version", compatibility.reason, {
      declaredVersion: compatibility.declaredVersion,
      range: KEPLER_COMPATIBILITY_RANGE,
    });
  }
  return compatibility;
}

const defaultImportModule = (specifier: string): Promise<unknown> => import(specifier);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readFunction(module: Record<string, unknown>, name: string): ((...args: never[]) => unknown) | undefined {
  const value = module[name];
  return typeof value === "function" ? (value as (...args: never[]) => unknown) : undefined;
}

/**
 * Resolve the optional `@kepler.gl/actions` peer with a dynamic import, so a
 * consumer that never opens a Kepler workspace never loads Kepler, React, or
 * Redux. The Kepler version must be declared by the caller because
 * `@kepler.gl/actions` does not export its own.
 */
export async function loadKeplerPeers(options: LoadKeplerPeersOptions): Promise<KeplerPeers> {
  const compatibility = assertKeplerCompatibility(options?.version);
  let module: unknown;
  try {
    module = await (options.importModule ?? defaultImportModule)("@kepler.gl/actions");
  } catch (cause) {
    throw new HonuaKeplerBridgeError(
      "missing-peer",
      'The Kepler bridge requires the optional peer "@kepler.gl/actions". Install it or inject KeplerPeers.',
      { package: "@kepler.gl/actions" },
      { cause },
    );
  }
  if (!isRecord(module)) {
    throw new HonuaKeplerBridgeError("missing-peer", 'The loaded "@kepler.gl/actions" module is not a module object.', {
      package: "@kepler.gl/actions",
    });
  }
  const addDataToMap = readFunction(module, "addDataToMap");
  if (addDataToMap === undefined) {
    throw new HonuaKeplerBridgeError(
      "missing-peer",
      'The loaded "@kepler.gl/actions" module does not export addDataToMap.',
      { package: "@kepler.gl/actions", export: "addDataToMap" },
    );
  }
  const optional = (["replaceDataInMap", "removeDataset", "setFilter", "updateMap", "wrapTo"] as const).reduce<
    Record<string, unknown>
  >((accumulator, name) => {
    const value = readFunction(module as Record<string, unknown>, name);
    if (value !== undefined) accumulator[name] = value;
    return accumulator;
  }, {});
  return Object.freeze({
    version: compatibility.declaredVersion,
    addDataToMap: addDataToMap as KeplerPeers["addDataToMap"],
    ...optional,
  }) as KeplerPeers;
}

/** Resolve Kepler's optional Arrow processor without importing it in SDK core. */
export async function loadKeplerProcessors(options: LoadKeplerProcessorsOptions): Promise<KeplerProcessors> {
  const compatibility = assertKeplerCompatibility(options?.version);
  let module: unknown;
  try {
    module = await (options.importModule ?? defaultImportModule)("@kepler.gl/processors");
  } catch (cause) {
    throw new HonuaKeplerBridgeError(
      "missing-peer",
      'The Kepler Arrow bridge requires the optional peer "@kepler.gl/processors". Install it or inject KeplerProcessors.',
      { package: "@kepler.gl/processors" },
      { cause },
    );
  }
  if (!isRecord(module)) {
    throw new HonuaKeplerBridgeError(
      "missing-peer",
      'The loaded "@kepler.gl/processors" module is not a module object.',
      {
        package: "@kepler.gl/processors",
      },
    );
  }
  const processArrowTable = readFunction(module, "processArrowTable");
  if (processArrowTable === undefined) {
    throw new HonuaKeplerBridgeError(
      "missing-peer",
      'The loaded "@kepler.gl/processors" module does not export processArrowTable.',
      { package: "@kepler.gl/processors", export: "processArrowTable" },
    );
  }
  return Object.freeze({
    version: compatibility.declaredVersion,
    processArrowTable: processArrowTable as KeplerProcessors["processArrowTable"],
  });
}

export interface CreateKeplerWorkspaceBridgeOptions {
  readonly peers: KeplerPeers;
  /** Optional Kepler processors used by `openArrowTable`. */
  readonly processors?: KeplerProcessors;
  /** Attach a live Kepler store so `open*` also dispatches. Omit to work payload-only. */
  readonly host?: KeplerWorkspaceHost;
  readonly limits?: Partial<KeplerBridgeLimits>;
}

/** Result of opening one dataset in the workspace. */
export interface KeplerOpenedDataset {
  readonly projection: KeplerDatasetProjection;
  /** `addDataToMap` payload — dispatch it yourself when no host is attached. */
  readonly addDataToMapPayload: Readonly<Record<string, unknown>>;
  /** True when the bridge dispatched into an attached host. */
  readonly dispatched: boolean;
}

export interface KeplerWorkspaceMetrics {
  readonly datasets: number;
  readonly rows: number;
  readonly estimatedRowBytes: number;
}

export interface KeplerWorkspaceBridge {
  readonly contractVersion: typeof KEPLER_BRIDGE_CONTRACT_VERSION;
  readonly compatibility: KeplerCompatibility;
  readonly capabilities: readonly KeplerBridgeCapability[];
  readonly limits: KeplerBridgeLimits;
  readonly metrics: KeplerWorkspaceMetrics;
  readonly datasetIds: readonly string[];
  readonly disposed: boolean;

  /** Open a bounded accepted result. */
  openResult(request: KeplerResultProjectionRequest): KeplerOpenedDataset;
  /** Open a bounded columnar artifact with no GeoJSON round trip. */
  openColumnarBatch(request: KeplerColumnarProjectionRequest): KeplerOpenedDataset;
  /** Open an opaque Apache Arrow table through Kepler's optional processor. */
  openArrowTable(request: KeplerArrowTableProjectionRequest): KeplerOpenedDataset;
  /** Reference a supported remote tile/imagery source. */
  openRemoteSource(request: KeplerRemoteSourceProjectionRequest): KeplerRemoteSourceProjection;

  /** Current tracked state for an open dataset. */
  datasetState(datasetId: string): KeplerWorkspaceDatasetState;
  /** Current rows/fields as a Kepler proto dataset, for a bounded re-dispatch. */
  materializeDataset(datasetId: string): KeplerProtoDataset;
  /** Reconcile a snapshot or delta. Bounded plans advance the tracked state. */
  reconcile(datasetId: string, event: KeplerReconciliationEvent): KeplerReconciliationPlan;

  /** Bind shared exploration state over the declared channels only. */
  linkState(
    options: Omit<CreateKeplerLinkedStateSyncOptions, "sourceId"> & {
      readonly sourceId?: string;
      readonly datasetId?: string;
    },
  ): KeplerLinkedStateSync;

  /** Redact a Kepler saved map / exported state before it is persisted or shared. */
  exportState<T>(state: T, options?: RedactKeplerExportStateOptions): KeplerRedactionResult<T>;

  /** Remove one dataset from the workspace. */
  close(datasetId: string): void;
  dispose(): void;
}

/**
 * Create a disposable Kepler workspace bridge. The bridge holds only the
 * projected rows it tracks for reconciliation and every linked-state
 * subscription it created; `dispose()` releases both.
 */
export function createKeplerWorkspaceBridge(options: CreateKeplerWorkspaceBridgeOptions): KeplerWorkspaceBridge {
  const peers = options?.peers;
  if (typeof peers !== "object" || peers === null || typeof peers.addDataToMap !== "function") {
    throw new HonuaKeplerBridgeError(
      "missing-peer",
      "createKeplerWorkspaceBridge requires KeplerPeers with addDataToMap.",
    );
  }
  const compatibility = assertKeplerCompatibility(peers.version);
  const processors = options.processors;
  if (processors !== undefined && typeof processors.processArrowTable !== "function") {
    throw new HonuaKeplerBridgeError("missing-peer", "Kepler processors must implement processArrowTable.");
  }
  const limits = normalizeKeplerLimits(options.limits);
  const host = options.host;
  if (host !== undefined && typeof host.dispatch !== "function") {
    throw new HonuaKeplerBridgeError("invalid-request", "A Kepler workspace host must implement dispatch(action).");
  }
  const states = new Map<string, KeplerWorkspaceDatasetState>();
  const projections = new Map<string, KeplerDatasetProjection>();
  /** Current approximate retained row bytes per open dataset. */
  const retained = new Map<string, number>();
  const syncs = new Set<KeplerLinkedStateSync>();
  let disposed = false;

  function assertLive(operation: string): void {
    if (disposed) {
      throw new HonuaKeplerBridgeError(
        "disposed",
        `The Kepler bridge is disposed; ${operation} is no longer available.`,
      );
    }
  }

  function requireState(datasetId: string): KeplerWorkspaceDatasetState {
    const state = states.get(datasetId);
    if (state === undefined) {
      throw new HonuaKeplerBridgeError(
        "unknown-dataset",
        `Dataset "${datasetId}" is not open in this Kepler workspace.`,
        {
          datasetId,
        },
      );
    }
    return state;
  }

  /**
   * Live retained-byte total. Read from `retained`, which is re-measured after
   * every accepted reconciliation — the opening projection's
   * `metrics.estimatedRowBytes` only describes the dataset as first loaded, so
   * charging that forever would let deltas grow a workspace past the global
   * budget while metrics reported the original size.
   */
  function retainedBytes(excludeDatasetId?: string): number {
    let bytes = 0;
    for (const [datasetId, datasetBytes] of retained) {
      if (datasetId === excludeDatasetId) continue;
      bytes += datasetBytes;
    }
    return bytes;
  }

  function dispatch(action: unknown): boolean {
    if (host === undefined) return false;
    const wrapped =
      host.instanceId !== undefined && typeof peers.wrapTo === "function"
        ? peers.wrapTo(host.instanceId, action as never)
        : (action as never);
    host.dispatch(wrapped);
    return true;
  }

  function open(projection: KeplerDatasetProjection): KeplerOpenedDataset {
    const datasetId = projection.dataset.info.id;
    if (states.has(datasetId)) {
      throw new HonuaKeplerBridgeError(
        "duplicate-dataset",
        `Dataset "${datasetId}" is already open; close it or reconcile a snapshot instead of re-opening it.`,
        { datasetId },
      );
    }
    if (states.size + 1 > limits.maxDatasets) {
      throw new HonuaKeplerBridgeError(
        "limit-exceeded",
        `A Kepler workspace may hold at most ${limits.maxDatasets} datasets.`,
        { maxDatasets: limits.maxDatasets },
      );
    }
    const nextBytes = retainedBytes() + projection.metrics.estimatedRowBytes;
    if (nextBytes > limits.maxRetainedRowBytes) {
      throw new HonuaKeplerBridgeError(
        "limit-exceeded",
        `Opening "${datasetId}" would retain approximately ${nextBytes} bytes, over the ${limits.maxRetainedRowBytes}-byte workspace budget.`,
        { datasetId, bytes: nextBytes, maxRetainedRowBytes: limits.maxRetainedRowBytes },
      );
    }
    states.set(datasetId, keplerDatasetStateFromProjection(projection));
    projections.set(datasetId, projection);
    retained.set(datasetId, projection.metrics.estimatedRowBytes);
    const payload = Object.freeze({
      datasets: [projection.dataset],
      options: Object.freeze({ centerMap: false, readOnly: false }),
    });
    const dispatched = dispatch(peers.addDataToMap(payload));
    return Object.freeze({ projection, addDataToMapPayload: payload, dispatched });
  }

  return {
    contractVersion: KEPLER_BRIDGE_CONTRACT_VERSION,
    compatibility,
    capabilities: KEPLER_BRIDGE_CAPABILITIES,
    limits,
    get metrics() {
      let rows = 0;
      for (const state of states.values()) rows += state.rows.length;
      return Object.freeze({ datasets: states.size, rows, estimatedRowBytes: retainedBytes() });
    },
    get datasetIds() {
      return Object.freeze([...states.keys()]);
    },
    get disposed() {
      return disposed;
    },
    openResult(request) {
      assertLive("openResult");
      return open(projectResultToKeplerDataset(request, limits));
    },
    openColumnarBatch(request) {
      assertLive("openColumnarBatch");
      return open(projectColumnarBatchToKeplerDataset(request, limits));
    },
    openArrowTable(request) {
      assertLive("openArrowTable");
      if (processors === undefined) {
        throw new HonuaKeplerBridgeError(
          "missing-peer",
          'openArrowTable requires the optional "@kepler.gl/processors" peer or an injected KeplerProcessors adapter.',
          { package: "@kepler.gl/processors" },
        );
      }
      return open(projectArrowTableToKeplerDataset(request, processors, limits));
    },
    openRemoteSource(request) {
      assertLive("openRemoteSource");
      return projectRemoteSourceToKepler(request);
    },
    datasetState(datasetId) {
      assertLive("datasetState");
      return requireState(datasetId);
    },
    materializeDataset(datasetId) {
      assertLive("materializeDataset");
      const state = requireState(datasetId);
      const projection = projections.get(datasetId) as KeplerDatasetProjection;
      return Object.freeze({
        info: projection.dataset.info,
        data: Object.freeze({ fields: state.fields, rows: state.rows }),
        metadata: projection.dataset.metadata,
      });
    },
    reconcile(datasetId, event) {
      assertLive("reconcile");
      const state = requireState(datasetId);
      const plan = reconcileKeplerDataset(state, event, limits);
      if (plan.nextState === undefined) return plan;
      // The per-dataset ceilings were already enforced by the reconciler; the
      // workspace still owns the global one, and a grown dataset must be
      // re-measured before it is accepted or the total silently drifts.
      const nextDatasetBytes = estimateKeplerRowBytes(plan.nextState.rows);
      const nextTotal = retainedBytes(datasetId) + nextDatasetBytes;
      if (nextTotal > limits.maxRetainedRowBytes) {
        return Object.freeze({
          operations: Object.freeze([
            Object.freeze({
              kind: "rebuild-workspace" as const,
              datasetId,
              reason: "row-budget-exceeded" as const,
              detail: `Applying the update would retain approximately ${nextTotal} bytes across the workspace, over the ${limits.maxRetainedRowBytes}-byte budget.`,
            }),
          ]),
          diagnostic: Object.freeze({
            mode: "rebuild-required" as const,
            bounded: false,
            rowsAppended: 0,
            rowsUpdated: 0,
            rowsRemoved: 0,
            rowsUnmatchedDeletes: 0,
            identityMismatches: Object.freeze([]),
            rebuildReason: "row-budget-exceeded" as const,
            detail: `Applying the update would retain approximately ${nextTotal} bytes across the workspace, over the ${limits.maxRetainedRowBytes}-byte budget.`,
          }),
        });
      }
      states.set(datasetId, plan.nextState);
      retained.set(datasetId, nextDatasetBytes);
      return plan;
    },
    linkState(linkOptions) {
      assertLive("linkState");
      const datasetId = linkOptions.datasetId;
      const sourceId =
        linkOptions.sourceId ??
        (datasetId === undefined ? undefined : projections.get(datasetId)?.dataset.metadata.provenance.sourceId);
      if (sourceId === undefined) {
        throw new HonuaKeplerBridgeError(
          "invalid-request",
          "linkState requires a sourceId, or a datasetId of an open dataset to read it from.",
        );
      }
      const sync = createKeplerLinkedStateSync({ ...linkOptions, sourceId });
      syncs.add(sync);
      return sync;
    },
    exportState(state, exportOptions) {
      return redactKeplerExportState(state, exportOptions);
    },
    close(datasetId) {
      assertLive("close");
      requireState(datasetId);
      states.delete(datasetId);
      projections.delete(datasetId);
      retained.delete(datasetId);
      if (typeof peers.removeDataset === "function") dispatch(peers.removeDataset(datasetId));
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const sync of syncs) sync.dispose();
      syncs.clear();
      states.clear();
      projections.clear();
      retained.clear();
    },
  };
}

/** Re-exported for callers that only need the default budgets. */
export { DEFAULT_KEPLER_BRIDGE_LIMITS };
