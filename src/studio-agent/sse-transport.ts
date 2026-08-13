/**
 * The real chat transport, plus the capabilities probe that gates it.
 *
 * **Origin.** Ported verbatim from `honua-studio`'s
 * `src/chat/sse-transport.ts` and `src/chat/capabilities-client.ts`
 * (honua-studio#6, AD-4/AD-8), both zero-import, DOM-free, and node-tested.
 *
 * {@link SseChatTransport} streams `POST {baseUrl}/v1/studio/ai/chat` per
 * honua-server's SSE contract, bearer-attached via a token source (never the
 * model's own credentials — those stay server-side). Cancellation is a plain
 * `AbortController.abort()` on the `fetch` — the proxy's own documented
 * cancellation convention ("closing the client connection ... stops the
 * upstream call and ends the SSE stream").
 *
 * @module
 */
import {
  SSE_EVENT_NAME_TO_TYPE,
  type StudioAiCapabilitiesResponse,
  type StudioAiChatEvent,
  type StudioAiChatRequest,
  type StudioAiTokenSource,
} from "./ai-contract.js";
import { SseFrameParser } from "./sse-parser.js";
import { type ChatTransport, ChatTransportError } from "./transport.js";

export interface SseChatTransportOptions {
  /** The proxy's base — e.g. `"/api"` or `"https://demo.honua.io/api"`. @default "/api" */
  readonly baseUrl?: string;
  readonly auth?: StudioAiTokenSource;
  /** Override for tests. Defaults to `globalThis.fetch`. */
  readonly fetchImpl?: typeof fetch;
}

function parseChatEventFrame(data: string, sseEventName: string): StudioAiChatEvent | undefined {
  const type = SSE_EVENT_NAME_TO_TYPE[sseEventName];
  // An SSE comment/keepalive frame, or an event name this contract doesn't
  // know — ignore rather than fail the whole stream.
  if (!type) return undefined;
  if (!data) return { type };
  try {
    const body = JSON.parse(data) as Record<string, unknown>;
    // The server-authoritative discriminant is the SSE `event:` line (see
    // ai-contract.ts's module doc) — `type` from the JSON body is
    // deliberately overwritten with it, never trusted on its own, so a
    // mismatched/missing body `type` field can never desync the parser.
    return { ...body, type } as StudioAiChatEvent;
  } catch {
    return { type: "error", errorMessage: "Malformed event payload from the Studio AI proxy." };
  }
}

/** Streams one chat turn against a real honua-server AI proxy over SSE. */
export class SseChatTransport implements ChatTransport {
  readonly #options: SseChatTransportOptions;

  public constructor(options: SseChatTransportOptions = {}) {
    this.#options = options;
  }

  public async *streamChat(request: StudioAiChatRequest, signal: AbortSignal): AsyncGenerator<StudioAiChatEvent> {
    const baseUrl = this.#options.baseUrl ?? "/api";
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "text/event-stream",
    };
    if (this.#options.auth) {
      const token = await this.#options.auth.getAccessToken();
      if (token) headers.authorization = `Bearer ${token}`;
    }
    const fetchImpl = this.#options.fetchImpl ?? fetch.bind(globalThis);

    let response: Response;
    try {
      response = await fetchImpl(`${baseUrl}/v1/studio/ai/chat`, {
        method: "POST",
        headers,
        body: JSON.stringify(request),
        signal,
      });
    } catch (error) {
      if (signal.aborted) return;
      throw new ChatTransportError(`Could not reach the Studio AI proxy at ${baseUrl}/v1/studio/ai/chat.`, error);
    }

    if (!response.ok) {
      throw new ChatTransportError(`Studio AI proxy responded ${response.status} for the chat request.`);
    }
    if (!response.body) {
      throw new ChatTransportError("Studio AI proxy response had no body to stream.");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const parser = new SseFrameParser();
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        for (const frame of parser.push(chunk)) {
          const event = parseChatEventFrame(frame.data, frame.event);
          if (event) yield event;
        }
      }
    } catch (error) {
      if (signal.aborted) return;
      throw new ChatTransportError("Studio AI proxy stream failed.", error);
    } finally {
      try {
        reader.releaseLock();
      } catch {
        // Already released (stream errored/closed) — fine to ignore.
      }
    }
  }
}

export interface FetchStudioAiCapabilitiesOptions {
  readonly baseUrl?: string;
  readonly auth?: StudioAiTokenSource;
  readonly fetchImpl?: typeof fetch;
}

interface ApiResponseEnvelope<T> {
  readonly success: boolean;
  readonly data: T;
}

function isEnvelope<T>(value: unknown): value is ApiResponseEnvelope<T> {
  return typeof value === "object" && value !== null && "success" in value && "data" in value;
}

/**
 * Fetches and unwraps the `ApiResponse<StudioAiCapabilitiesResponse>`
 * envelope `GET {baseUrl}/v1/studio/ai/capabilities` returns. Lets a client
 * discover configured providers' context length and tool support without any
 * provider-specific code.
 */
export async function fetchStudioAiCapabilities(
  options: FetchStudioAiCapabilitiesOptions = {},
): Promise<StudioAiCapabilitiesResponse> {
  const baseUrl = options.baseUrl ?? "/api";
  const headers: Record<string, string> = { accept: "application/json" };
  if (options.auth) {
    const token = await options.auth.getAccessToken();
    if (token) headers.authorization = `Bearer ${token}`;
  }
  const fetchImpl = options.fetchImpl ?? fetch.bind(globalThis);
  let response: Response;
  try {
    response = await fetchImpl(`${baseUrl}/v1/studio/ai/capabilities`, { headers });
  } catch (error) {
    throw new ChatTransportError(`Could not reach the Studio AI proxy at ${baseUrl}/v1/studio/ai/capabilities.`, error);
  }
  if (!response.ok) {
    throw new ChatTransportError(`Studio AI capabilities request failed (${response.status}).`);
  }
  const body = (await response.json()) as unknown;
  return isEnvelope<StudioAiCapabilitiesResponse>(body) ? body.data : (body as StudioAiCapabilitiesResponse);
}
