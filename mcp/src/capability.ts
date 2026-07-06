import { jsonText } from "./helpers.js";

/**
 * Platform-free capability degradation (issue #369).
 *
 * `@honua/mcp-server` runs in two modes: against a Honua-enhanced deployment
 * (which exposes extra surfaces such as OGC API – Styles) and — the platform-free
 * front door — against ANY plain public Esri FeatureServer / OGC endpoint that
 * has none of those surfaces. A tool that depends on a Honua-only surface must
 * NEVER crash, hang, or return misleading empty data on a plain target. Instead
 * it detects the missing surface and reports a clear, structured "not available
 * on this target" result — the same skip-with-reason honesty the certification
 * suite uses.
 *
 * Probing helpers throw {@link CapabilityUnavailableError} when a surface is
 * absent; the tool/resource layer catches it and returns
 * {@link capabilityUnavailable}, a non-error tool result carrying
 * `available: false` plus a human-readable reason.
 */
export class CapabilityUnavailableError extends Error {
  readonly code = "CAPABILITY_UNAVAILABLE";
  /** Human label of the missing surface, e.g. "OGC API - Styles". */
  readonly surface: string;
  /** Why the surface was judged unavailable (status / parse / shape). */
  readonly reason: string;

  constructor(surface: string, reason: string) {
    super(`${surface} is not available on this target: ${reason}`);
    this.name = "CapabilityUnavailableError";
    this.surface = surface;
    this.reason = reason;
  }
}

/** Machine-readable body of a graceful capability-degradation result. */
export interface CapabilityUnavailablePayload {
  available: false;
  surface: string;
  reason: string;
  /** What a client can do instead on a plain public endpoint. */
  guidance: string;
}

/**
 * Build a structured "not available on this target" tool/resource result. The
 * result is deliberately NOT an MCP error: a plain FeatureServer legitimately
 * lacks the surface, so degradation is an honest, expected outcome — not a
 * failure. Clients branch on `available === false`.
 */
export function capabilityUnavailablePayload(
  surface: string,
  reason: string,
  guidance: string,
): CapabilityUnavailablePayload {
  return { available: false, surface, reason, guidance };
}

/** Convenience: the {@link capabilityUnavailablePayload} body wrapped as tool text content. */
export function capabilityUnavailable(surface: string, reason: string, guidance: string) {
  return jsonText(capabilityUnavailablePayload(surface, reason, guidance));
}
