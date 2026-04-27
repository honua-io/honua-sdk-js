/**
 * `ClarificationController` — typed form derived from
 * `intent.clarifications[]`. Submission is a pass-through to
 * `OperatorClient.operator.clarify` and yields a fresh intent revision.
 *
 * @module
 */

import type { OperatorClient } from "../client.js";
import { HonuaOperatorIntentError } from "../errors.js";
import type { OperatorTelemetry } from "../telemetry.js";
import type { AnalysisIntent, BuilderIntent, ClarificationAnswer, ClarificationField } from "../workspace/types.js";
import { ListenerBag, type Unsubscribe, withTelemetrySpan } from "./base.js";

export interface ClarificationState {
  readonly intent: AnalysisIntent | BuilderIntent | undefined;
  readonly fields: ReadonlyArray<ClarificationField>;
  readonly answers: ReadonlyMap<string, string>;
  readonly submitting: boolean;
}

export type ClarificationEvent =
  | { kind: "loaded"; intent: AnalysisIntent | BuilderIntent }
  | { kind: "answer-changed"; fieldId: string; value: string }
  | { kind: "submitted"; intent: AnalysisIntent | BuilderIntent }
  | { kind: "error"; error: HonuaOperatorIntentError };

export interface ClarificationControllerOptions {
  client: OperatorClient;
  telemetry?: OperatorTelemetry;
}

export class ClarificationController {
  readonly #client: OperatorClient;
  readonly #telemetry: OperatorTelemetry | undefined;
  readonly #bag = new ListenerBag<ClarificationEvent>();
  #intent: AnalysisIntent | BuilderIntent | undefined;
  #answers = new Map<string, string>();
  #submitting = false;

  public constructor(options: ClarificationControllerOptions) {
    this.#client = options.client;
    this.#telemetry = options.telemetry;
  }

  public get state(): ClarificationState {
    return {
      intent: this.#intent,
      fields: this.#intent?.clarifications ?? [],
      answers: new Map(this.#answers),
      submitting: this.#submitting,
    };
  }

  public on(listener: (event: ClarificationEvent) => void): Unsubscribe {
    return this.#bag.on(listener);
  }

  public load(intent: AnalysisIntent | BuilderIntent): void {
    this.#intent = intent;
    this.#answers.clear();
    this.#bag.emit({ kind: "loaded", intent });
  }

  public setAnswer(fieldId: string, value: string): void {
    if (!this.#intent) {
      throw new HonuaOperatorIntentError("setAnswer called before clarification load");
    }
    const exists = this.#intent.clarifications?.some((field) => field.id === fieldId);
    if (!exists) {
      throw new HonuaOperatorIntentError(`unknown clarification field "${fieldId}"`, {
        intentId: this.#intent.id,
        detail: { fieldId },
      });
    }
    this.#answers.set(fieldId, value);
    this.#bag.emit({ kind: "answer-changed", fieldId, value });
  }

  /**
   * Submit the current answers and resolve with the revised intent.
   * Missing required answers reject with `HonuaOperatorIntentError`
   * before any network call so the controller never depends on the
   * server for required-field validation.
   */
  public async submit(signal?: AbortSignal): Promise<AnalysisIntent | BuilderIntent> {
    if (!this.#intent) {
      throw new HonuaOperatorIntentError("submit called before clarification load");
    }
    const intent = this.#intent;
    const missing: string[] = [];
    for (const field of intent.clarifications ?? []) {
      if (field.required && !(this.#answers.get(field.id) ?? "").trim()) missing.push(field.id);
    }
    if (missing.length > 0) {
      throw new HonuaOperatorIntentError("missing required clarification answers", {
        intentId: intent.id,
        detail: { missing },
      });
    }
    const answers: ClarificationAnswer[] = [...this.#answers.entries()].map(([fieldId, value]) => ({
      fieldId,
      value,
    }));
    this.#submitting = true;
    try {
      const revised = await withTelemetrySpan(
        this.#telemetry,
        "clarify",
        intent.id,
        () => this.#client.operator.clarify(intent.id, answers, signal),
        { fieldCount: answers.length },
      );
      this.#intent = revised;
      this.#answers.clear();
      this.#bag.emit({ kind: "submitted", intent: revised });
      return revised;
    } catch (error) {
      const wrapped =
        error instanceof HonuaOperatorIntentError
          ? error
          : new HonuaOperatorIntentError("clarification submit failed", {
              intentId: intent.id,
              cause: error,
            });
      this.#bag.emit({ kind: "error", error: wrapped });
      throw wrapped;
    } finally {
      this.#submitting = false;
    }
  }
}
