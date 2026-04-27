/**
 * `ApprovalController` — loads the policy decision for an in-flight
 * operation and exposes a single `confirm()` action when the gate is
 * `pending`. The controller never short-circuits a deferred outcome
 * to "approved"; it surfaces the server's verbatim decision.
 *
 * Audit entries returned with each decision are forwarded to the
 * `OperatorTelemetry.after` hook as `approval-audit` events so partner
 * observability stacks see the same evidence the server records. The
 * server remains the canonical audit-of-record — client telemetry is
 * observability, not evidence.
 *
 * @module
 */

import type { OperatorClient } from "../client.js";
import { HonuaOperatorApprovalError } from "../errors.js";
import type { OperatorTelemetry } from "../telemetry.js";
import type { ApprovalAuditEntry, ApprovalDecision } from "../workspace/types.js";
import { ListenerBag, type Unsubscribe, emitTelemetryEvent, withTelemetrySpan } from "./base.js";

export type ApprovalEvent =
  | { kind: "loaded"; decision: ApprovalDecision }
  | { kind: "confirmed"; decision: ApprovalDecision }
  | { kind: "audit"; entry: ApprovalAuditEntry; decision: ApprovalDecision }
  | { kind: "error"; error: HonuaOperatorApprovalError };

export interface ApprovalControllerOptions {
  client: OperatorClient;
  telemetry?: OperatorTelemetry;
}

export class ApprovalController {
  readonly #client: OperatorClient;
  readonly #telemetry: OperatorTelemetry | undefined;
  readonly #bag = new ListenerBag<ApprovalEvent>();
  readonly #seenAudit = new Set<string>();
  #decision: ApprovalDecision | undefined;
  // Bumped on every load() / confirm() entry so a slow approval call
  // for operation A cannot resolve after the controller has moved on
  // to operation B and emit a stale `loaded` / `confirmed` for A. The
  // captured value is checked at resolution time; mismatch ⇒ drop.
  #generation = 0;

  public constructor(options: ApprovalControllerOptions) {
    this.#client = options.client;
    this.#telemetry = options.telemetry;
  }

  public get decision(): ApprovalDecision | undefined {
    return this.#decision;
  }

  public on(listener: (event: ApprovalEvent) => void): Unsubscribe {
    return this.#bag.on(listener);
  }

  public async load(operationId: string, signal?: AbortSignal): Promise<ApprovalDecision> {
    const gen = ++this.#generation;
    try {
      const decision = await withTelemetrySpan(
        this.#telemetry,
        "approval-load",
        undefined,
        () => this.#client.operator.getApproval(operationId, signal),
        { operationId },
      );
      if (gen !== this.#generation) {
        // Superseded by a newer load()/confirm(); drop without
        // committing or emitting so a stale operationId does not
        // overwrite the active decision.
        return decision;
      }
      this.#decision = decision;
      this.#fanOutAudit(decision);
      this.#bag.emit({ kind: "loaded", decision });
      return decision;
    } catch (error) {
      const wrapped =
        error instanceof HonuaOperatorApprovalError
          ? error
          : new HonuaOperatorApprovalError("approval load failed", {
              cause: error,
              detail: { operationId },
            });
      if (gen === this.#generation) {
        this.#bag.emit({ kind: "error", error: wrapped });
      }
      throw wrapped;
    }
  }

  /**
   * Confirm a `pending` approval. The controller refuses to invoke the
   * server when the loaded decision is in any other state — preventing
   * a UI from re-confirming an already granted/denied/deferred outcome.
   * Returns the server's outcome unchanged.
   */
  public async confirm(operationId: string, signal?: AbortSignal): Promise<ApprovalDecision> {
    if (!this.#decision || this.#decision.operationId !== operationId) {
      throw new HonuaOperatorApprovalError("confirm requires a loaded decision for the same operation", {
        detail: { operationId, decisionOperationId: this.#decision?.operationId },
      });
    }
    if (this.#decision.state !== "pending") {
      throw new HonuaOperatorApprovalError(`cannot confirm an approval in state "${this.#decision.state}"`, {
        detail: { operationId, state: this.#decision.state },
      });
    }
    const gen = ++this.#generation;
    try {
      const next = await withTelemetrySpan(
        this.#telemetry,
        "approval-confirm",
        undefined,
        () => this.#client.operator.confirmApproval(operationId, signal),
        { operationId },
      );
      if (gen !== this.#generation) {
        return next;
      }
      this.#decision = next;
      this.#fanOutAudit(next);
      this.#bag.emit({ kind: "confirmed", decision: next });
      return next;
    } catch (error) {
      const wrapped =
        error instanceof HonuaOperatorApprovalError
          ? error
          : new HonuaOperatorApprovalError("approval confirm failed", {
              cause: error,
              detail: { operationId },
            });
      if (gen === this.#generation) {
        this.#bag.emit({ kind: "error", error: wrapped });
      }
      throw wrapped;
    }
  }

  #fanOutAudit(decision: ApprovalDecision): void {
    for (const entry of decision.audit) {
      const key = `${decision.operationId}|${entry.at}|${entry.actor}|${entry.action}`;
      if (this.#seenAudit.has(key)) continue;
      this.#seenAudit.add(key);
      emitTelemetryEvent(this.#telemetry, "approval-audit", undefined, {
        operationId: decision.operationId,
        actor: entry.actor,
        action: entry.action,
        reason: entry.reason,
        at: entry.at,
      });
      this.#bag.emit({ kind: "audit", entry, decision });
    }
  }
}
