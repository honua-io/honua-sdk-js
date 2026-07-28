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
  const terminal = event.terminal === true;
  const code = terminal ? "invalid-event" : normalizeReconnectableWireCode(event.code);
  const error = realtimeFailure(
    code,
    terminal
      ? "Realtime stream reported a terminal protocol failure."
      : code === "cursor-expired"
        ? "Realtime stream reported that its resume cursor expired."
        : code === "resume-unsupported"
          ? "Realtime stream reported that resume is unsupported."
          : "Realtime stream reported a reconnectable transport failure.",
    undefined,
  );
  return {
    type: "error",
    code,
    error,
    ...(typeof event.terminal === "boolean" ? { terminal: event.terminal } : {}),
    ...(isNonNegativeFiniteNumber(event.retryAfterMs) ? { retryAfterMs: event.retryAfterMs } : {}),
    ...(isNonNegativeFiniteNumber(event.receivedAt) ? { receivedAt: event.receivedAt } : {}),
  };
}

export type RealtimeTransportFailureCode = "consumer-failed" | "delivery-failed" | "invalid-event" | "transport-gap";
export type RealtimeWireFailureCode = RealtimeTransportFailureCode | "cursor-expired" | "resume-unsupported";

export function realtimeFailure(
  code: RealtimeWireFailureCode,
  message: string,
  cause: unknown,
): HonuaRealtimeResumeError {
  return cause instanceof HonuaRealtimeResumeError && isHonuaSdkError(cause) && cause.code === code
    ? cause
    : cause === undefined
      ? new HonuaRealtimeResumeError(code, message)
      : new HonuaRealtimeResumeError(code, message, { cause });
}

function normalizeReconnectableWireCode(
  value: string | undefined,
): "cursor-expired" | "resume-unsupported" | "transport-gap" {
  return value === "cursor-expired" || value === "resume-unsupported" ? value : "transport-gap";
}

function isNonNegativeFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
