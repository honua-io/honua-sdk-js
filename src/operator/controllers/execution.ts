/**
 * `ExecutionController` — thin adapter on `IJobRun<ExecutionResult>`.
 * Subscribes to `watch()`, surfaces snapshot transitions on a controller
 * event stream, and routes the terminal payload onto the workspace.
 *
 * @module
 */

import {
  type IJobRun,
  type JobError,
  type JobProgress,
  type JobSnapshot,
  isJobTerminal,
} from "../../contract/index.js";
import { OPERATOR_EXECUTION_OUTPUT_KEY, type OperatorClient } from "../client.js";
import { HonuaOperatorExecutionError, type HonuaOperatorExecutionFailureKind } from "../errors.js";
import type { OperatorTelemetry } from "../telemetry.js";
import type { ExecutionResult, OperatorPlan } from "../workspace/types.js";
import { ListenerBag, type Unsubscribe, withTelemetrySpan } from "./base.js";

export type ExecutionEvent =
  | { kind: "started"; executionId: string }
  | { kind: "progress"; executionId: string; progress: JobProgress }
  | { kind: "successful"; executionId: string; result: ExecutionResult }
  | { kind: "failed"; executionId: string; error: HonuaOperatorExecutionError }
  | { kind: "dismissed"; executionId: string }
  | { kind: "error"; error: HonuaOperatorExecutionError };

export interface ExecutionControllerOptions {
  client: OperatorClient;
  telemetry?: OperatorTelemetry;
}

export class ExecutionController {
  readonly #client: OperatorClient;
  readonly #telemetry: OperatorTelemetry | undefined;
  readonly #bag = new ListenerBag<ExecutionEvent>();
  #activeRun: IJobRun<ExecutionResult> | undefined;
  #unsubscribe: (() => void) | undefined;
  #activePlan: OperatorPlan | undefined;
  #lastSnapshot: JobSnapshot<ExecutionResult> | undefined;
  // Per-start abort controller. dispose() aborts it so the in-flight
  // submitPlan() can short-circuit; the start path also uses identity
  // comparison (this.#startAbort === captured) to detect the case
  // where submitPlan resolved despite the abort and a newer start
  // already took ownership.
  #startAbort: AbortController | undefined;

  public constructor(options: ExecutionControllerOptions) {
    this.#client = options.client;
    this.#telemetry = options.telemetry;
  }

  public get run(): IJobRun<ExecutionResult> | undefined {
    return this.#activeRun;
  }

  public get snapshot(): JobSnapshot<ExecutionResult> | undefined {
    return this.#lastSnapshot;
  }

  public on(listener: (event: ExecutionEvent) => void): Unsubscribe {
    return this.#bag.on(listener);
  }

  /**
   * Submit a plan and start watching the resulting job. Resolves with
   * the live `IJobRun` once the watch subscription is active.
   *
   * Concurrent calls supersede each other: the second call disposes
   * the first (which aborts its in-flight `submitPlan`); if the older
   * `submitPlan` still resolves, the result is cancelled and the
   * promise rejects so the older caller does not see a started event
   * for a run that is no longer authoritative.
   */
  public async start(plan: OperatorPlan, signal?: AbortSignal): Promise<IJobRun<ExecutionResult>> {
    this.dispose();
    const startAbort = new AbortController();
    this.#startAbort = startAbort;
    const linkedSignal = linkSignals(signal, startAbort);

    let run: IJobRun<ExecutionResult>;
    try {
      run = await withTelemetrySpan(
        this.#telemetry,
        "execution-start",
        plan.intentId,
        () => this.#client.operator.submitPlan(plan, linkedSignal),
        { planId: plan.id, planKind: plan.kind },
      );
    } catch (error) {
      const wrapped = wrapExecutionError(error, "plan submission failed", {
        intentId: plan.intentId,
        detail: { planId: plan.id, planKind: plan.kind },
      });
      // Suppress the error event when this start was superseded — the
      // newer start owns the surface and a stale error would mislead
      // observers about the current execution.
      if (this.#startAbort === startAbort) {
        this.#bag.emit({ kind: "error", error: wrapped });
      }
      throw wrapped;
    }

    if (this.#startAbort !== startAbort) {
      // A newer start took ownership while we were awaiting submitPlan.
      // Cancel this run silently and reject so the original caller is
      // not handed a stale IJobRun.
      void run.cancel().catch(() => {});
      throw new HonuaOperatorExecutionError("execution superseded by a newer start", {
        intentId: plan.intentId,
        executionId: run.id,
        failureKind: "Cancelled",
      });
    }

    this.#activeRun = run;
    this.#activePlan = plan;
    this.#bag.emit({ kind: "started", executionId: run.id });

    this.#unsubscribe = run.watch((snapshot) => {
      // Stale-watch guard: an older watch subscription can fire after
      // dispose() if the underlying adapter has already buffered the
      // snapshot. `#activeRun !== run` means we are no longer the
      // authoritative run; drop without emitting.
      if (this.#activeRun !== run) return;
      this.#lastSnapshot = snapshot;
      if (snapshot.progress) {
        this.#bag.emit({ kind: "progress", executionId: run.id, progress: snapshot.progress });
      }
      if (!isJobTerminal(snapshot.status)) return;
      this.#emitTerminal(run.id, snapshot);
    });

    // The shared `IJobRun` contract permits passive `watch()` implementations
    // (the OGC adapter only registers listeners; polling is driven by
    // `results()`). Kick off the polling path so snapshots actually flow.
    // `results()` rejects with `HonuaJobFailedError` on failed/dismissed
    // terminals — those are already surfaced by the watcher above, so we
    // suppress them when the watcher already observed a terminal snapshot.
    // Any other rejection (poll-side network failure that prevents reaching
    // a terminal state) routes through the error event surface.
    void run.results().catch((error: unknown) => {
      if (this.#activeRun !== run) return;
      if (this.#lastSnapshot && isJobTerminal(this.#lastSnapshot.status)) return;
      const wrapped = wrapExecutionError(error, "execution polling failed", {
        intentId: plan.intentId,
        executionId: run.id,
      });
      this.#bag.emit({ kind: "error", error: wrapped });
    });
    return run;
  }

  public async cancel(): Promise<void> {
    if (!this.#activeRun) return;
    const run = this.#activeRun;
    try {
      await run.cancel();
    } catch (error) {
      if (this.#activeRun !== run) return;
      const wrapped = wrapExecutionError(error, "execution cancel failed", {
        intentId: this.#activePlan?.intentId,
        executionId: run.id,
      });
      this.#bag.emit({ kind: "error", error: wrapped });
      throw wrapped;
    }
  }

  public dispose(): void {
    this.#startAbort?.abort();
    this.#startAbort = undefined;
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
    this.#activeRun = undefined;
    this.#activePlan = undefined;
    this.#lastSnapshot = undefined;
  }

  #emitTerminal(executionId: string, snapshot: JobSnapshot<ExecutionResult>): void {
    const intentId = this.#activePlan?.intentId;
    const startedAt = Date.now();
    const detail = { executionId, status: snapshot.status };
    if (snapshot.status === "successful") {
      const result = snapshot.result?.outputs?.[OPERATOR_EXECUTION_OUTPUT_KEY];
      if (!result) {
        const error = new HonuaOperatorExecutionError("execution succeeded but no result was returned", {
          intentId,
          executionId,
          failureKind: "OutputBindingFailed",
        });
        this.#bag.emit({ kind: "failed", executionId, error });
        this.#telemetry?.error?.({
          kind: "execution-terminal",
          intentId,
          startedAt,
          finishedAt: startedAt,
          durationMs: 0,
          detail,
          error,
        });
        return;
      }
      this.#bag.emit({ kind: "successful", executionId, result });
      this.#telemetry?.after?.({
        kind: "execution-terminal",
        intentId,
        startedAt,
        finishedAt: startedAt,
        durationMs: 0,
        detail: { ...detail, resultKind: result.kind },
      });
      return;
    }
    if (snapshot.status === "dismissed") {
      this.#bag.emit({ kind: "dismissed", executionId });
      this.#telemetry?.after?.({
        kind: "execution-terminal",
        intentId,
        startedAt,
        finishedAt: startedAt,
        durationMs: 0,
        detail,
      });
      return;
    }
    const wrapped = jobErrorToExecutionError(snapshot.error, executionId, intentId);
    this.#bag.emit({ kind: "failed", executionId, error: wrapped });
    this.#telemetry?.error?.({
      kind: "execution-terminal",
      intentId,
      startedAt,
      finishedAt: startedAt,
      durationMs: 0,
      detail,
      error: wrapped,
    });
  }
}

function jobErrorToExecutionError(
  jobError: JobError | undefined,
  executionId: string,
  intentId: string | undefined,
): HonuaOperatorExecutionError {
  if (!jobError) {
    return new HonuaOperatorExecutionError("execution failed", {
      intentId,
      executionId,
      failureKind: "ExecutionFailed",
    });
  }
  const failureKind: HonuaOperatorExecutionFailureKind = jobError.code as HonuaOperatorExecutionFailureKind;
  return new HonuaOperatorExecutionError(jobError.message, {
    intentId,
    executionId,
    failureKind,
    detail: jobError.details ? { details: jobError.details } : undefined,
  });
}

function wrapExecutionError(
  error: unknown,
  fallbackMessage: string,
  context: { intentId?: string; executionId?: string; detail?: Record<string, unknown> },
): HonuaOperatorExecutionError {
  if (error instanceof HonuaOperatorExecutionError) return error;
  return new HonuaOperatorExecutionError(fallbackMessage, {
    ...context,
    failureKind: "ExecutionFailed",
    cause: error,
  });
}

/**
 * Returns an `AbortSignal` that fires when either the externally-supplied
 * caller signal aborts or the per-start internal controller is aborted by
 * `dispose()`. Lets `submitPlan` be cancelled by either source.
 */
function linkSignals(external: AbortSignal | undefined, internal: AbortController): AbortSignal {
  if (!external) return internal.signal;
  if (external.aborted) {
    internal.abort();
    return internal.signal;
  }
  external.addEventListener("abort", () => internal.abort(), { once: true });
  return internal.signal;
}
