/**
 * `ChatController` — turn ledger and intent-draft pump for the freeform
 * request surface. The controller owns no streaming token assembly logic
 * beyond accumulating `ChatChunk.delta` strings; the transport (an
 * `AsyncIterable<ChatChunk>` from the `OperatorClient`) is responsible
 * for chunking.
 *
 * @module
 */

import type { ChatChunk, OperatorClient } from "../client.js";
import { HonuaOperatorIntentError } from "../errors.js";
import type { OperatorTelemetry } from "../telemetry.js";
import type { AnalysisIntent, BuilderIntent, ConversationTurn, TurnRole } from "../workspace/types.js";
import { ListenerBag, type Unsubscribe, withTelemetrySpan } from "./base.js";

export type ChatEvent =
  | { kind: "turn-updated"; turn: ConversationTurn }
  | { kind: "intent-drafted"; intent: AnalysisIntent | BuilderIntent }
  | { kind: "error"; error: HonuaOperatorIntentError };

export type DecorateTurn = (turn: ConversationTurn) => ConversationTurn;

export interface ChatControllerOptions {
  client: OperatorClient;
  telemetry?: OperatorTelemetry;
  /**
   * Pure transformation applied to a turn snapshot before the
   * `turn-updated` event fires. Cannot mutate controller state.
   */
  decorate?: DecorateTurn;
  /** Fixture seam for deterministic ids in tests. */
  generateTurnId?: () => string;
  /** Fixture seam for deterministic timestamps in tests. */
  now?: () => number;
}

let chatTurnCounter = 0;

function defaultTurnId(): string {
  chatTurnCounter += 1;
  return `turn-${Date.now().toString(36)}-${chatTurnCounter.toString(36)}`;
}

export class ChatController {
  readonly #client: OperatorClient;
  readonly #telemetry: OperatorTelemetry | undefined;
  readonly #decorate: DecorateTurn | undefined;
  readonly #generateTurnId: () => string;
  readonly #now: () => number;
  readonly #bag = new ListenerBag<ChatEvent>();
  readonly #turns: ConversationTurn[] = [];
  #abortController: AbortController | undefined;

  public constructor(options: ChatControllerOptions) {
    this.#client = options.client;
    this.#telemetry = options.telemetry;
    this.#decorate = options.decorate;
    this.#generateTurnId = options.generateTurnId ?? defaultTurnId;
    this.#now = options.now ?? (() => Date.now());
  }

  public get turns(): ReadonlyArray<ConversationTurn> {
    return this.#turns;
  }

  public on(listener: (event: ChatEvent) => void): Unsubscribe {
    return this.#bag.on(listener);
  }

  public abort(): void {
    this.#abortController?.abort();
    this.#abortController = undefined;
  }

  /**
   * Send a freeform user message and stream the agent reply. Resolves
   * with the final agent turn (intent draft inlined) when the stream
   * completes; rejects with `HonuaOperatorIntentError` on transport
   * failure.
   */
  public async send(text: string): Promise<ConversationTurn> {
    const userTurn = this.#appendTurn({ role: "user", content: text });
    const agentTurnId = this.#generateTurnId();
    const startedAt = this.#now();
    const agentIndex =
      this.#turns.push({
        turnId: agentTurnId,
        role: "agent",
        content: "",
        startedAt,
      }) - 1;
    this.#emitTurnUpdated(this.#turns[agentIndex]!);

    this.#abortController = new AbortController();
    const signal = this.#abortController.signal;

    try {
      return await withTelemetrySpan(
        this.#telemetry,
        "chat-turn",
        undefined,
        async () => {
          let intentDraft: AnalysisIntent | BuilderIntent | undefined;
          let accumulated = "";
          let lastChunk: ChatChunk | undefined;

          for await (const chunk of this.#client.operator.chat(text, signal)) {
            lastChunk = chunk;
            accumulated += chunk.delta;
            if (chunk.intentDraft) intentDraft = chunk.intentDraft;
            const updated: ConversationTurn = {
              turnId: agentTurnId,
              role: "agent",
              content: accumulated,
              startedAt,
              ...(chunk.done ? { finishedAt: this.#now() } : {}),
              ...(intentDraft ? { intentDraft } : {}),
            };
            this.#turns[agentIndex] = updated;
            this.#emitTurnUpdated(updated);
            if (chunk.done) break;
          }

          if (!lastChunk?.done) {
            // Stream ended without an explicit terminal chunk — close
            // the turn so consumers always observe a `finishedAt`.
            const closed: ConversationTurn = {
              ...this.#turns[agentIndex]!,
              finishedAt: this.#now(),
            };
            this.#turns[agentIndex] = closed;
            this.#emitTurnUpdated(closed);
          }
          if (intentDraft) {
            this.#bag.emit({ kind: "intent-drafted", intent: intentDraft });
          }
          // Touch userTurn so the variable is observed even when no
          // intermediate observer reads it (silences strict-unused).
          void userTurn;
          return this.#turns[agentIndex]!;
        },
        { turnId: agentTurnId },
      );
    } catch (error) {
      const wrapped =
        error instanceof HonuaOperatorIntentError
          ? error
          : new HonuaOperatorIntentError("chat send failed", { cause: error, detail: { turnId: agentTurnId } });
      this.#bag.emit({ kind: "error", error: wrapped });
      throw wrapped;
    } finally {
      this.#abortController = undefined;
    }
  }

  /** Append a system message (e.g. an embedder-supplied notice). */
  public appendSystem(content: string): ConversationTurn {
    return this.#appendTurn({ role: "system", content });
  }

  #appendTurn(input: { role: TurnRole; content: string }): ConversationTurn {
    const turn: ConversationTurn = {
      turnId: this.#generateTurnId(),
      role: input.role,
      content: input.content,
      startedAt: this.#now(),
      finishedAt: this.#now(),
    };
    this.#turns.push(turn);
    this.#emitTurnUpdated(turn);
    return turn;
  }

  #emitTurnUpdated(turn: ConversationTurn): void {
    const decorated = this.#decorate ? this.#decorate(turn) : turn;
    this.#bag.emit({ kind: "turn-updated", turn: decorated });
  }
}
