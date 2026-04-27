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
  | { kind: "dismissed"; executionId: string };

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
   */
  public async start(plan: OperatorPlan, signal?: AbortSignal): Promise<IJobRun<ExecutionResult>> {
    this.dispose();
    const run = await withTelemetrySpan(
      this.#telemetry,
      "execution-start",
      plan.intentId,
      () => this.#client.operator.submitPlan(plan, signal),
      { planId: plan.id, planKind: plan.kind },
    );
    this.#activeRun = run;
    this.#activePlan = plan;
    this.#bag.emit({ kind: "started", executionId: run.id });

    this.#unsubscribe = run.watch((snapshot) => {
      this.#lastSnapshot = snapshot;
      if (snapshot.progress) {
        this.#bag.emit({ kind: "progress", executionId: run.id, progress: snapshot.progress });
      }
      if (!isJobTerminal(snapshot.status)) return;
      this.#emitTerminal(run.id, snapshot);
    });
    return run;
  }

  public async cancel(): Promise<void> {
    if (!this.#activeRun) return;
    await this.#activeRun.cancel();
  }

  public dispose(): void {
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
