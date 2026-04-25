/**
 * Canonical async-operation surface. `IJobRun` is the protocol-neutral
 * vocabulary every long-running operation in the SDK speaks. It is the
 * receipt returned from operations that complete asynchronously on the
 * server (OGC API Processes execution, future GeoServices async export
 * tickets, OData function imports, etc.).
 *
 * Per the ticket constraint, OGC Processes specifically must surface
 * through this shared interface — there is no `OgcJobRun` top-level
 * type. The implementation in `src/core/ogc-processes.ts` returns
 * `IJobRun<T>` directly.
 *
 * @module
 */

/**
 * Coarse-grained job lifecycle. The OGC API Processes 1.0 status values
 * (`accepted`, `running`, `successful`, `failed`, `dismissed`) are the
 * canonical vocabulary; adapters for protocols that report a narrower or
 * wider set must map onto these.
 */
export type JobStatus = "accepted" | "running" | "successful" | "failed" | "dismissed";

/** Human-meaningful job-progress signal. Optional; servers may omit fields. */
export interface JobProgress {
  /** 0..100. Omitted when the server does not report a numeric estimate. */
  percent?: number;
  /** Human-readable status message for the current step. */
  message?: string;
  /** ISO-8601 timestamp of when the server last updated the progress. */
  updatedAt?: string;
}

/**
 * Snapshot of a job's state. Returned from `IJobRun.poll()` and emitted
 * to `IJobRun.watch` listeners. The result/error fields are filled only
 * for terminal states.
 */
export interface JobSnapshot<T = unknown> {
  status: JobStatus;
  progress?: JobProgress;
  /** Payload returned for terminal `successful` snapshots only. */
  result?: JobResult<T>;
  /** Error envelope returned for terminal `failed` snapshots. */
  error?: JobError;
}

/**
 * Server-side error envelope for a failed job. Mirrors the OGC API
 * Processes "exception" shape; adapters for other protocols translate
 * onto this surface so callers can branch on `code` without protocol
 * knowledge.
 */
export interface JobError {
  /** Stable machine code (e.g. `"InvalidParameterValue"`). */
  code: string;
  /** Human-readable explanation. */
  message: string;
  /** Optional details payload as returned by the server. */
  details?: unknown;
}

/**
 * Job-result document. `outputs` is a map of output-id → value; the SDK
 * does not parse the value further (it may be a GeoJSON feature
 * collection, a download URL, a binary asset, etc., depending on the
 * process). Adapters narrow `T` for typed access.
 */
export interface JobResult<T = unknown> {
  outputs: Record<string, T>;
}

/** Listener function invoked on every observed snapshot transition. */
export type JobSnapshotListener<T = unknown> = (snapshot: JobSnapshot<T>) => void;

/**
 * Canonical async-operation handle. Methods are intentionally narrow so
 * downstream tickets that submit jobs (operator workflows, manifest
 * apply, etc.) can speak one vocabulary across protocols.
 */
export interface IJobRun<T = unknown> {
  /** Stable identifier assigned by the server when the job was accepted. */
  readonly id: string;
  /** Process / operation identifier, e.g. an OGC processId. */
  readonly type: string;
  /**
   * Last-observed status. Backed by the most recent `poll()` /
   * `status()` / `watch()` snapshot; reads are synchronous.
   */
  readonly status: JobStatus;
  /** Last-observed progress, if the server reported any. */
  readonly progress: JobProgress | undefined;
  /** Force a fresh server poll and return the resulting snapshot. */
  poll(): Promise<JobSnapshot<T>>;
  /**
   * Subscribe to snapshot transitions. The callback fires on every
   * observed status / progress change, and again on the terminal
   * snapshot. Returns an unsubscribe handle.
   */
  watch(listener: JobSnapshotListener<T>): () => void;
  /**
   * Wait for the job to reach a terminal state and resolve with the
   * outputs. Rejects with `HonuaJobFailedError` for `failed` /
   * `dismissed` terminal states. Implementations must poll on a
   * configurable interval; the default cadence is left to the adapter.
   */
  results(): Promise<JobResult<T>>;
  /**
   * Cancel / dismiss the job. Idempotent. Returns the resulting status
   * (typically `dismissed`, but the server may have raced to a terminal
   * state already, in which case the original terminal status is
   * returned).
   */
  cancel(): Promise<JobStatus>;
}

/**
 * `true` when the snapshot status is one of the terminal values
 * (`successful`, `failed`, `dismissed`). Useful for stop conditions in
 * watchers and tests.
 */
export function isJobTerminal(status: JobStatus): boolean {
  return status === "successful" || status === "failed" || status === "dismissed";
}
