import type { IncomingMessage, ServerResponse } from "node:http";
import type { NlCompletionRequest, NlCompletionResponse } from "../../src/nl-map-control/index.js";
export type LiveModelResponse = NlCompletionResponse & {
  readonly clarification?: string;
  readonly modelIdentity?: { readonly provider: string; readonly model: string };
};
export function createLiveModelHandler(options: {
  readonly authenticate: (request: IncomingMessage) => boolean | Promise<boolean>;
  readonly complete: (request: NlCompletionRequest, signal: AbortSignal) => Promise<LiveModelResponse>;
  readonly origin: string;
  readonly timeoutMs?: number;
}): (request: IncomingMessage, response: ServerResponse) => Promise<void>;
export function openAiCompatibleCompletion(options: {
  readonly endpoint: string;
  readonly apiKey: string;
  readonly model: string;
  readonly fetchImpl?: typeof fetch;
}): (request: NlCompletionRequest, signal: AbortSignal) => Promise<LiveModelResponse>;
