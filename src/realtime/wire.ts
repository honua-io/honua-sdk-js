/**
 * Wire-decoding and failure-tagging helpers shared by every raw realtime
 * transport adapter (`sse.ts`, `websocket.ts`). Extracted so the two
 * transports decode the same default JSON event vocabulary and classify
 * failures through the exact same `HonuaRealtimeResumeError` taxonomy
 * instead of maintaining two copies of the same parsing logic.
 *
 * @module
 */

import { isHonuaSdkError } from "../core/error-envelope.js";
import { HonuaRealtimeResumeError } from "./resumable.js";
import type { RealtimeFeatureEvent } from "./types.js";

/**
 * Default JSON envelope decoder shared by the SSE and WebSocket transports.
 * Accepts a bare `{ type: ... }` event, a `{ event: { type: ... } } }`
 * wrapper, or a `{ kind: ... }` alias for `type`.
 */
export function decodeDefaultRealtimeEnvelope<TFeature = unknown>(payload: unknown): RealtimeFeatureEvent<TFeature> {
  if (!isRecord(payload)) {
    throw new HonuaRealtimeResumeError("invalid-event", "Realtime payload must be a JSON object.");
  }
  if (typeof payload.type === "string") {
    return normalizeRealtimeErrorEvent(payload as unknown as RealtimeFeatureEvent<TFeature>);
  }
  if (isRecord(payload.event) && typeof payload.event.type === "string") {
    return normalizeRealtimeErrorEvent(payload.event as unknown as RealtimeFeatureEvent<TFeature>);
  }
  if (typeof payload.kind === "string") {
    return normalizeRealtimeErrorEvent({ ...payload, type: payload.kind } as unknown as RealtimeFeatureEvent<TFeature>);
  }
  throw new HonuaRealtimeResumeError("invalid-event", "Realtime payload is missing an event type.");
}

/**
 * Never trust a structural tag received over the wire. A server could spoof
 * the common envelope while retaining unsanitized context and no `toJSON`.
 * Only a locally constructed realtime error is already inside the boundary.
 */
export function normalizeRealtimeErrorEvent<TFeature>(
  event: RealtimeFeatureEvent<TFeature>,
): RealtimeFeatureEvent<TFeature> {
  if (event.type !== "error") return event;
  const code = event.terminal ? "invalid-event" : "transport-gap";
  if (event.error instanceof HonuaRealtimeResumeError && isHonuaSdkError(event.error) && event.error.code === code)
    return event;
  return {
    ...event,
    error: realtimeFailure(
      code,
      event.terminal
        ? "Realtime stream reported a terminal protocol failure."
        : "Realtime stream reported a reconnectable transport failure.",
      event.error,
    ),
  };
}

export type RealtimeTransportFailureCode = "consumer-failed" | "delivery-failed" | "invalid-event" | "transport-gap";

export function realtimeFailure(
  code: RealtimeTransportFailureCode,
  message: string,
  cause: unknown,
): HonuaRealtimeResumeError {
  return cause instanceof HonuaRealtimeResumeError && isHonuaSdkError(cause) && cause.code === code
    ? cause
    : new HonuaRealtimeResumeError(code, message, { cause });
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
