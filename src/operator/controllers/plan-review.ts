/**
 * `PlanReviewController` — exposes a server-produced plan, lets the
 * embedder accept or revise it, and emits lifecycle events the workspace
 * relays to embedders.
 *
 * Plan revisions are pass-through to the server; the controller never
 * mutates plan steps locally.
 *
 * @module
 */

import type { OperatorClient } from "../client.js";
import { HonuaOperatorPlanError } from "../errors.js";
import type { OperatorTelemetry } from "../telemetry.js";
import type {
  AnalysisPlan,
  BuilderPlan,
  DeploymentPlan,
  OperatorPlan,
  PlanStep,
  PublishingPlan,
} from "../workspace/types.js";
import { ListenerBag, type Unsubscribe, withTelemetrySpan } from "./base.js";

export type PlanRevisionRequest = {
  readonly intentId: string;
  readonly notes?: string;
};

export type PlanReviewEvent =
  | { kind: "plan-loaded"; plan: OperatorPlan }
  | { kind: "plan-accepted"; plan: OperatorPlan }
  | { kind: "plan-revising"; plan: OperatorPlan }
  | { kind: "plan-revised"; plan: OperatorPlan }
  | { kind: "error"; error: HonuaOperatorPlanError };

export type DecorateStep = (step: PlanStep) => PlanStep;

export interface PlanReviewControllerOptions {
  client: OperatorClient;
  telemetry?: OperatorTelemetry;
  /** Pure transformation applied to plan steps before they are emitted. */
  decorateStep?: DecorateStep;
}

export class PlanReviewController {
  readonly #client: OperatorClient;
  readonly #telemetry: OperatorTelemetry | undefined;
  readonly #decorateStep: DecorateStep | undefined;
  readonly #bag = new ListenerBag<PlanReviewEvent>();
  #plan: OperatorPlan | undefined;

  public constructor(options: PlanReviewControllerOptions) {
    this.#client = options.client;
    this.#telemetry = options.telemetry;
    this.#decorateStep = options.decorateStep;
  }

  public get plan(): OperatorPlan | undefined {
    return this.#plan ? this.#decoratedPlan(this.#plan) : undefined;
  }

  public on(listener: (event: PlanReviewEvent) => void): Unsubscribe {
    return this.#bag.on(listener);
  }

  /**
   * Load the plan attached to an intent. Wraps transport errors in
   * `HonuaOperatorPlanError` and emits an `error` event.
   */
  public async load(intentId: string, signal?: AbortSignal): Promise<OperatorPlan> {
    try {
      const plan = await withTelemetrySpan(this.#telemetry, "plan-load", intentId, () =>
        this.#client.operator.getPlan(intentId, signal),
      );
      this.#plan = plan;
      const decorated = this.#decoratedPlan(plan);
      this.#bag.emit({ kind: "plan-loaded", plan: decorated });
      return decorated;
    } catch (error) {
      const wrapped =
        error instanceof HonuaOperatorPlanError
          ? error
          : new HonuaOperatorPlanError("plan load failed", { intentId, cause: error });
      this.#bag.emit({ kind: "error", error: wrapped });
      throw wrapped;
    }
  }

  /**
   * Accept the loaded plan. The controller does not start execution —
   * the workspace handles the hand-off to `ExecutionController`.
   */
  public accept(): OperatorPlan {
    if (!this.#plan) {
      throw new HonuaOperatorPlanError("acceptPlan called before plan load");
    }
    const decorated = this.#decoratedPlan(this.#plan);
    this.#bag.emit({ kind: "plan-accepted", plan: decorated });
    return decorated;
  }

  /**
   * Ask the server for a revised plan. The controller forwards the
   * embedder's revision notes through `OperatorClient.revisePlan` so
   * the server can act on them, instead of just observing them in
   * telemetry. The controller never mutates step shape locally.
   */
  public async revise(request: PlanRevisionRequest, signal?: AbortSignal): Promise<OperatorPlan> {
    if (this.#plan) {
      this.#bag.emit({ kind: "plan-revising", plan: this.#decoratedPlan(this.#plan) });
    }
    try {
      const next = await withTelemetrySpan(
        this.#telemetry,
        "plan-load",
        request.intentId,
        () => this.#client.operator.revisePlan(request.intentId, request.notes, signal),
        { revision: true, notes: request.notes },
      );
      this.#plan = next;
      const decorated = this.#decoratedPlan(next);
      this.#bag.emit({ kind: "plan-revised", plan: decorated });
      return decorated;
    } catch (error) {
      const wrapped =
        error instanceof HonuaOperatorPlanError
          ? error
          : new HonuaOperatorPlanError("plan revision failed", {
              intentId: request.intentId,
              cause: error,
            });
      this.#bag.emit({ kind: "error", error: wrapped });
      throw wrapped;
    }
  }

  #decoratedPlan(plan: OperatorPlan): OperatorPlan {
    if (!this.#decorateStep) return plan;
    const steps = plan.steps.map((step) => this.#decorateStep!(step));
    switch (plan.kind) {
      case "analysis":
        return { ...plan, steps } satisfies AnalysisPlan;
      case "publishing":
        return { ...plan, steps } satisfies PublishingPlan;
      case "builder":
        return { ...plan, steps } satisfies BuilderPlan;
      case "deployment":
        return { ...plan, steps } satisfies DeploymentPlan;
    }
  }
}
