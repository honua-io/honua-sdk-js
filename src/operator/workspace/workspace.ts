/**
 * `OperatorWorkspace` — cross-surface orchestrator. Wires controllers
 * for chat, clarification, plan review, execution, map and builder
 * workspaces, and approval into a single typed event stream that
 * embedders can subscribe to.
 *
 * Individual controllers stay independently usable; the workspace is
 * the orchestrator, not a gatekeeper.
 *
 * @module
 */

import type { LinkedViewPresetName } from "../../exploration/index.js";
import type { LoadMapPackageOptions } from "../../runtime/index.js";
import type { OperatorClient } from "../client.js";
import { ApprovalController } from "../controllers/approval.js";
import { ListenerBag } from "../controllers/base.js";
import { BuilderWorkspaceController } from "../controllers/builder-workspace.js";
import { ChatController } from "../controllers/chat.js";
import { ClarificationController } from "../controllers/clarification.js";
import { ExecutionController } from "../controllers/execution.js";
import { type MapFactory, MapWorkspaceController } from "../controllers/map-workspace.js";
import { PlanReviewController } from "../controllers/plan-review.js";
import { HonuaOperatorIntentError, HonuaOperatorPlanError, isHonuaOperatorError } from "../errors.js";
import type { MessageCatalog } from "../i18n/messages.js";
import type { OperatorTelemetry } from "../telemetry.js";
import { type ThemeProvider, createThemeProvider } from "../theming/provider.js";
import type { OperatorThemeTokens } from "../theming/tokens.js";
import type { Unsubscribe, WorkspaceEvent } from "./events.js";
import type { OperatorPlan } from "./types.js";

export interface OperatorWorkspaceOptions {
  client: OperatorClient;
  /** Optional MapLibre map factory; required if the host plans to load map packages. */
  mapFactory?: MapFactory;
  /** Map-runtime options for `loadMapPackage`. */
  mapLoadOptions?: Omit<LoadMapPackageOptions, "telemetry">;
  /** Linked-view preset for the embedded `ExplorationContext`. Defaults to `"mapDriven"`. */
  explorationPreset?: LinkedViewPresetName;
  theme?: ThemeProvider | OperatorThemeTokens;
  messages?: MessageCatalog;
  telemetry?: OperatorTelemetry;
}

export class OperatorWorkspace {
  public readonly chat: ChatController;
  public readonly clarification: ClarificationController;
  public readonly planReview: PlanReviewController;
  public readonly execution: ExecutionController;
  public readonly map: MapWorkspaceController | undefined;
  public readonly builder: BuilderWorkspaceController;
  public readonly approval: ApprovalController;
  public readonly theme: ThemeProvider;
  public readonly messages: MessageCatalog | undefined;

  readonly #telemetry: OperatorTelemetry | undefined;
  readonly #bag = new ListenerBag<WorkspaceEvent>();
  readonly #unsubscribers: Array<() => void> = [];
  #activeIntentId: string | undefined;
  #activeOperationId: string | undefined;

  public constructor(options: OperatorWorkspaceOptions) {
    const { client, telemetry } = options;
    this.#telemetry = telemetry;
    this.theme =
      options.theme && typeof (options.theme as ThemeProvider).apply === "function"
        ? (options.theme as ThemeProvider)
        : createThemeProvider(options.theme as OperatorThemeTokens | undefined);
    this.messages = options.messages;

    this.chat = new ChatController({ client, telemetry });
    this.clarification = new ClarificationController({ client, telemetry });
    this.planReview = new PlanReviewController({ client, telemetry });
    this.execution = new ExecutionController({ client, telemetry });
    this.builder = new BuilderWorkspaceController({ client, telemetry });
    this.approval = new ApprovalController({ client, telemetry });
    this.map = options.mapFactory
      ? new MapWorkspaceController({
          client,
          mapFactory: options.mapFactory,
          explorationPreset: options.explorationPreset,
          telemetry,
          ...(options.mapLoadOptions ? { loadOptions: options.mapLoadOptions } : {}),
        })
      : undefined;

    this.#wireChat();
    this.#wireClarification();
    this.#wirePlanReview();
    this.#wireExecution();
    this.#wireMap();
    this.#wireBuilder();
    this.#wireApproval();
  }

  public on(listener: (event: WorkspaceEvent) => void): Unsubscribe {
    return this.#bag.on(listener);
  }

  public dispose(): void {
    for (const off of this.#unsubscribers.splice(0)) off();
    this.execution.dispose();
    this.map?.dispose();
    this.builder.dispose();
    this.#bag.clear();
  }

  // ── Wiring ──────────────────────────────────────────────────

  #wireChat(): void {
    this.#unsubscribers.push(
      this.chat.on((event) => {
        switch (event.kind) {
          case "turn-updated":
            this.#bag.emit({ kind: "turn-updated", turn: event.turn });
            break;
          case "intent-drafted":
            this.#activeIntentId = event.intent.id;
            this.map?.bindIntent(event.intent.id);
            this.builder.bindIntent(event.intent.id);
            this.#bag.emit({ kind: "intent-drafted", intent: event.intent });
            if (event.intent.clarifications && event.intent.clarifications.length > 0) {
              this.clarification.load(event.intent);
              this.#bag.emit({ kind: "clarification-needed", intent: event.intent });
            } else {
              this.#advanceToPlan(event.intent.id);
            }
            break;
          case "error":
            this.#emitError(event.error);
            break;
        }
      }),
    );
  }

  #wireClarification(): void {
    this.#unsubscribers.push(
      this.clarification.on((event) => {
        switch (event.kind) {
          case "submitted":
            this.#activeIntentId = event.intent.id;
            this.map?.bindIntent(event.intent.id);
            this.builder.bindIntent(event.intent.id);
            this.#bag.emit({ kind: "clarification-answered", intent: event.intent });
            if (event.intent.clarifications && event.intent.clarifications.length > 0) {
              this.#bag.emit({ kind: "clarification-needed", intent: event.intent });
            } else {
              this.#advanceToPlan(event.intent.id);
            }
            break;
          case "error":
            this.#emitError(event.error);
            break;
          case "loaded":
          case "answer-changed":
            // Intermediate signals — embedder reads through controller.
            break;
        }
      }),
    );
  }

  #wirePlanReview(): void {
    this.#unsubscribers.push(
      this.planReview.on((event) => {
        switch (event.kind) {
          case "plan-loaded":
          case "plan-revised":
            this.#bag.emit({ kind: "plan-loaded", plan: event.plan });
            break;
          case "plan-accepted":
            this.#bag.emit({ kind: "plan-accepted", plan: event.plan });
            this.#advanceToExecution(event.plan);
            break;
          case "plan-revising":
            // Intermediate; embedder watches the controller event stream.
            break;
          case "error":
            this.#emitError(event.error);
            break;
        }
      }),
    );
  }

  #wireExecution(): void {
    this.#unsubscribers.push(
      this.execution.on((event) => {
        switch (event.kind) {
          case "started":
            this.#activeOperationId = event.executionId;
            this.#bag.emit({ kind: "execution-started", executionId: event.executionId });
            break;
          case "progress":
            this.#bag.emit({
              kind: "execution-progress",
              executionId: event.executionId,
              ...(event.progress.percent !== undefined ? { percent: event.progress.percent } : {}),
              ...(event.progress.message !== undefined ? { message: event.progress.message } : {}),
            });
            break;
          case "successful": {
            this.#bag.emit({ kind: "execution-terminal", executionId: event.executionId, result: event.result });
            const { result } = event;
            if (result.mapPackage && this.map) {
              void this.map.loadPackage(result.mapPackage).catch((error: unknown) => {
                if (isHonuaOperatorError(error)) this.#emitError(error);
              });
            }
            if (result.appPackage) {
              void this.builder.loadPackage(result.appPackage).catch((error: unknown) => {
                if (isHonuaOperatorError(error)) this.#emitError(error);
              });
              if (result.mapPackage) this.builder.bindMapPackage(result.mapPackage);
            }
            break;
          }
          case "failed":
            this.#emitError(event.error);
            break;
          case "dismissed":
            this.#bag.emit({ kind: "execution-dismissed", executionId: event.executionId });
            break;
          case "error":
            this.#emitError(event.error);
            break;
        }
      }),
    );
  }

  // Cross-surface hand-offs. The workspace orchestrates the documented
  // state machine — chat/clarification → plan-load → execution-start —
  // so embedders observe a single event stream rather than wiring each
  // controller transition by hand. Async failures surface through the
  // controllers' own `error` events, which `#wirePlanReview` /
  // `#wireExecution` route to `#emitError`; the trailing `.catch` here
  // only suppresses the unhandled-rejection warning.
  #advanceToPlan(intentId: string): void {
    void this.planReview.load(intentId).catch(() => {});
  }

  #advanceToExecution(plan: OperatorPlan): void {
    void this.execution.start(plan).catch(() => {});
  }

  #wireMap(): void {
    if (!this.map) return;
    this.#unsubscribers.push(
      this.map.on((event) => {
        switch (event.kind) {
          case "package-loaded":
            this.#bag.emit({ kind: "map-loaded", pkg: event.pkg });
            break;
          case "package-refined":
            this.#bag.emit({ kind: "map-refined", pkg: event.pkg });
            break;
          case "error":
            this.#emitError(event.error);
            break;
          case "package-disposed":
            break;
        }
      }),
    );
  }

  #wireBuilder(): void {
    this.#unsubscribers.push(
      this.builder.on((event) => {
        switch (event.kind) {
          case "package-loaded":
            this.#bag.emit({ kind: "app-loaded", pkg: event.pkg });
            break;
          case "package-refined":
            this.#bag.emit({ kind: "app-refined", pkg: event.pkg });
            break;
          case "map-bound":
            // Internal hand-off; not a top-level workspace event.
            break;
          case "error":
            this.#emitError(event.error);
            break;
        }
      }),
    );
  }

  #wireApproval(): void {
    this.#unsubscribers.push(
      this.approval.on((event) => {
        switch (event.kind) {
          case "loaded":
            if (event.decision.state === "pending") {
              this.#bag.emit({ kind: "approval-required", decision: event.decision });
            } else {
              this.#bag.emit({ kind: "approval-resolved", decision: event.decision });
            }
            break;
          case "confirmed":
            this.#bag.emit({ kind: "approval-resolved", decision: event.decision });
            break;
          case "audit":
            // Audit fan-out happens through telemetry.
            break;
          case "error":
            this.#emitError(event.error);
            break;
        }
      }),
    );
  }

  #emitError(error: unknown): void {
    if (isHonuaOperatorError(error)) {
      this.#bag.emit({ kind: "error", error, recoverable: this.#isRecoverable(error) });
      return;
    }
    // Defensive: anything that is not a known operator error gets
    // wrapped as an intent-stage error so embedders never see a raw
    // `unknown` on the workspace event stream.
    const wrapped = new HonuaOperatorIntentError("workspace observed an unrecognized error", { cause: error });
    this.#bag.emit({ kind: "error", error: wrapped, recoverable: false });
  }

  #isRecoverable(error: unknown): boolean {
    if (error instanceof HonuaOperatorIntentError) return true;
    if (error instanceof HonuaOperatorPlanError) return true;
    return false;
  }

  /** Read-only accessor used by host code that needs the active context. */
  public get activeIntentId(): string | undefined {
    return this.#activeIntentId;
  }

  public get activeOperationId(): string | undefined {
    return this.#activeOperationId;
  }
}

export type { Unsubscribe, WorkspaceEvent } from "./events.js";
