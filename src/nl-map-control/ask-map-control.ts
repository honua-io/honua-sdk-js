import { canonicalStringify, toJsonValue } from "../query-planner/index.js";
import {
  HonuaNlMapControlError,
  type NlMapControl,
  type NlMapPlan,
  type NlMapPlanApproval,
  type NlMapPlanExecution,
} from "./index.js";

/** A clarification is a planning outcome, never an executable substitute query. */
export class HonuaAskMapClarification extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "HonuaAskMapClarification";
  }
}

export type AskMapPhase =
  | "idle"
  | "planning"
  | "review"
  | "executing"
  | "succeeded"
  | "empty"
  | "clarification"
  | "refused"
  | "cancelled"
  | "failed";
export interface AskMapReview {
  readonly summary: string;
  readonly details: unknown;
}
export interface AskMapState {
  readonly phase: AskMapPhase;
  readonly message: string;
  readonly plan?: NlMapPlan;
  readonly review?: AskMapReview;
  readonly execution?: NlMapPlanExecution;
}
export interface AskMapSessionOptions<TContext> {
  /** Include source/schema/version, authorization identity, selection and captured viewport. No credentials. */
  readonly context: () => TContext;
  readonly createControl: (context: TContext, signal: AbortSignal) => NlMapControl;
  readonly review: (plan: NlMapPlan, context: TContext) => AskMapReview;
  readonly approve?: (plan: NlMapPlan, context: TContext, signal: AbortSignal) => Promise<NlMapPlanApproval>;
  /** Atomically render accepted results. Older operations never reach this callback. */
  readonly apply: (execution: NlMapPlanExecution, context: TContext) => { readonly count: number };
  readonly onState: (state: AskMapState) => void;
  /** Whole proposal/execution bounds, including a callback that ignores cancellation. */
  readonly timeoutMs?: number;
}
export interface AskMapSession {
  readonly state: AskMapState;
  propose(instruction: string): Promise<void>;
  execute(): Promise<void>;
  cancel(): void;
  /** Call on source, viewport, selection, mode or prompt changes. Preserves rendered results. */
  invalidate(): void;
}

/**
 * Experimental, framework-neutral review controller over the existing NL plan
 * and signed-approval machinery. Context is a captured snapshot; a change
 * requires an explicit new proposal. It stores no prompt or result history.
 */
export function createAskMapSession<TContext>(options: AskMapSessionOptions<TContext>): AskMapSession {
  const timeoutMs = options.timeoutMs ?? 15_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) {
    throw new Error("Ask this map timeoutMs must be an integer between 1 and 120000.");
  }
  let state: AskMapState = { phase: "idle", message: "Ask a question, then review its plan." };
  let generation = 0;
  let abort: AbortController | undefined;
  let pending:
    | { plan: NlMapPlan; control: NlMapControl; context: TContext; identity: string; controller: AbortController }
    | undefined;
  const identity = (context: TContext) => canonicalStringify(toJsonValue(context));
  const publish = (next: AskMapState) => {
    state = next;
    options.onState(next);
  };
  const stop = () => {
    generation += 1;
    abort?.abort();
    pending = undefined;
  };
  const unchanged = (bound: string) => bound === identity(options.context());
  function fail(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    publish({
      phase:
        error instanceof HonuaAskMapClarification
          ? "clarification"
          : error instanceof HonuaNlMapControlError
            ? "refused"
            : "failed",
      message,
    });
  }
  async function bounded<T>(action: (signal: AbortSignal) => Promise<T>, controller: AbortController): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: () => void = () => {};
    try {
      return await Promise.race([
        action(controller.signal),
        new Promise<never>((_resolve, reject) => {
          onAbort = () => reject(new DOMException("Request cancelled.", "AbortError"));
          controller.signal.addEventListener("abort", onAbort, { once: true });
          timer = setTimeout(() => {
            reject(new Error(`Request exceeded ${timeoutMs} ms.`));
            controller.abort();
          }, timeoutMs);
          if (controller.signal.aborted) onAbort();
        }),
      ]);
    } finally {
      clearTimeout(timer);
      controller.signal.removeEventListener("abort", onAbort);
    }
  }
  return {
    get state() {
      return state;
    },
    async propose(instruction) {
      stop();
      const ticket = generation;
      const controller = new AbortController();
      abort = controller;
      const context = structuredClone(options.context());
      const bound = identity(context);
      publish({ phase: "planning", message: "Preparing a bounded query for review…" });
      try {
        const control = options.createControl(context, controller.signal);
        const plan = await bounded((signal) => control.propose(instruction, { signal }), controller);
        if (ticket !== generation) return;
        if (!unchanged(bound)) {
          this.invalidate();
          return;
        }
        const review = options.review(plan, context);
        pending = { plan, control, context, identity: bound, controller };
        publish({ phase: "review", message: review.summary, plan, review });
      } catch (error) {
        if (ticket === generation) {
          pending = undefined;
          fail(error);
        }
      }
    },
    async execute() {
      if (!pending || state.phase !== "review") return;
      const reviewed = pending;
      pending = undefined; // consume synchronously: double clicks cannot execute twice
      if (!unchanged(reviewed.identity)) {
        this.invalidate();
        return;
      }
      const ticket = generation;
      const controller = reviewed.controller;
      abort = controller;
      publish({ ...state, phase: "executing", message: "Executing the reviewed query…" });
      try {
        const execution = await bounded(async (signal) => {
          const approval = options.approve ? await options.approve(reviewed.plan, reviewed.context, signal) : undefined;
          signal.throwIfAborted();
          if (!unchanged(reviewed.identity)) throw new Error("Query context changed; propose again.");
          return reviewed.control.execute(reviewed.plan, { signal, ...(approval ? { approval } : {}) });
        }, controller);
        if (ticket !== generation) return;
        if (!unchanged(reviewed.identity)) {
          this.invalidate();
          return;
        }
        if (execution.outcome !== "succeeded") {
          const failure = execution.results.find((result) => result.status === "error" || result.status === "denied");
          const detail = failure?.data as { message?: unknown } | undefined;
          publish({
            ...state,
            phase: failure?.status === "denied" ? "refused" : "failed",
            message: `${typeof detail?.message === "string" ? detail.message : (failure?.deniedReason ?? "The query failed.")} Previous results are preserved.`,
            execution,
          });
          return;
        }
        const result = options.apply(execution, reviewed.context);
        publish({
          ...state,
          phase: result.count ? "succeeded" : "empty",
          message: `${result.count} matching features.`,
          execution,
        });
      } catch (error) {
        if (ticket === generation) fail(error);
      }
    },
    cancel() {
      stop();
      publish({ phase: "cancelled", message: "Cancelled. Previous results are preserved." });
    },
    invalidate() {
      stop();
      publish({ phase: "idle", message: "Context changed. Propose again to capture the current view and selection." });
    },
  };
}

export interface AskMapControlOptions {
  readonly container: HTMLElement;
  readonly session: AskMapSession;
  readonly suggestions: readonly string[];
  readonly mode: "recorded" | "live";
}
/** Small accessible DOM control. Hosts own their map/results renderer and call render on state changes. */
export function mountAskMapControl(options: AskMapControlOptions): {
  render(state: AskMapState): void;
  dispose(): void;
} {
  const document = options.container.ownerDocument;
  const form = document.createElement("form");
  const label = document.createElement("label");
  label.textContent = options.mode === "recorded" ? "Question (recorded suggestions only)" : "Ask this map";
  const input = document.createElement("input");
  input.type = "text";
  input.maxLength = 2000;
  input.required = true;
  input.readOnly = options.mode === "recorded";
  label.append(input);
  const suggest = document.createElement("div");
  suggest.setAttribute("aria-label", "Suggested questions");
  for (const question of options.suggestions) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = question;
    button.addEventListener("click", () => {
      input.value = question;
      options.session.invalidate();
      input.focus();
    });
    suggest.append(button);
  }
  const propose = document.createElement("button");
  propose.type = "submit";
  propose.textContent = "Review query";
  const execute = document.createElement("button");
  execute.type = "button";
  execute.textContent = "Execute reviewed query";
  execute.disabled = true;
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.textContent = "Cancel / reject";
  const status = document.createElement("p");
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  const details = document.createElement("details");
  const summary = document.createElement("summary");
  summary.textContent = "Query, plan and receipt details";
  const raw = document.createElement("pre");
  details.append(summary, raw);
  form.append(label, suggest, propose, execute, cancel, status, details);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    void options.session.propose(input.value);
  });
  input.addEventListener("input", () => options.session.invalidate());
  execute.addEventListener("click", () => {
    void options.session.execute();
  });
  cancel.addEventListener("click", () => options.session.cancel());
  options.container.append(form);
  return {
    render(state) {
      status.textContent = state.message;
      status.dataset.phase = state.phase;
      execute.disabled = state.phase !== "review";
      propose.disabled = state.phase === "executing";
      raw.textContent = JSON.stringify(
        { query: state.review?.details, plan: state.plan, receipt: state.execution?.receipt },
        null,
        2,
      );
    },
    dispose() {
      options.session.cancel();
      form.remove();
    },
  };
}
