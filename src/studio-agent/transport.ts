/**
 * Chat transport seam.
 *
 * **Origin.** Ported verbatim from `honua-studio`'s `src/chat/transport.ts`
 * (honua-studio#6, AD-4). A session depends only on this interface — never on
 * `fetch` or a concrete provider — so the same session drives a turn whether
 * the model is behind the real server AI proxy ({@link SseChatTransport}) or
 * a deterministic scripted conversation in a test.
 *
 * @module
 */
import type { StudioAiChatEvent, StudioAiChatRequest } from "./ai-contract.js";

export interface ChatTransport {
  /**
   * Streams one chat turn. Implementations MUST respect `signal` —
   * cancellation is mid-stream abort, not merely "don't start" (the proxy
   * contract follows the same abort-the-HTTP-request convention as the rest
   * of the platform's streaming surfaces).
   */
  streamChat(request: StudioAiChatRequest, signal: AbortSignal): AsyncIterable<StudioAiChatEvent>;
}

/**
 * Thrown by {@link ChatTransport} implementations for transport-level
 * failures (network, non-2xx, malformed stream) — distinct from an in-band
 * `{ type: "error" }` event, which is a normal, well-formed turn outcome.
 */
export class ChatTransportError extends Error {
  public readonly cause?: unknown;

  public constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "ChatTransportError";
    this.cause = cause;
  }
}
