/**
 * Anonymous-safe Share access states and denial helpers.
 *
 * Mirrors the server's anonymous Share endpoints: unknown, expired, revoked,
 * forbidden, or no-longer-covered tokens all collapse to a single, identical
 * denial that never discloses item identity, title, or existence. Browser code
 * consumes one explicit state model rather than inferring access from HTTP
 * status codes or—worse—leaking a private title into a "not allowed" message.
 *
 * @module
 */

import type { HonuaEmbedRedemption, HonuaPublicLinkResolution } from "./types.js";

/**
 * Why an anonymous Share read was denied. These are intentionally coarse so the
 * reason never acts as an existence/identity oracle: `not-found` covers unknown
 * items, revoked/unknown tokens, and items whose tier no longer covers the
 * access path; `expired` covers tokens past their TTL; `forbidden` covers a
 * surface that exists but is not anonymously readable through the attempted
 * mechanism.
 */
export type HonuaShareDenialReason = "not-found" | "expired" | "forbidden";

/** The mechanism an anonymous read was attempted through. */
export type HonuaShareAccessKind = "public-link" | "public-content" | "embed";

/**
 * Granted anonymous Share state — the resolved presentation projection plus the
 * access kind it was reached through.
 */
export interface HonuaShareAccessGranted<TResolution> {
  readonly status: "granted";
  readonly kind: HonuaShareAccessKind;
  readonly resolution: TResolution;
}

/**
 * Denied anonymous Share state. Carries only a coarse {@link reason} and an
 * opaque, identity-free {@link message}. It deliberately exposes no item id,
 * title, or any field that could confirm a private item exists.
 */
export interface HonuaShareAccessDenied {
  readonly status: "denied";
  readonly kind: HonuaShareAccessKind;
  readonly reason: HonuaShareDenialReason;
  /** Opaque, anonymous-safe denial message. Never includes item identity. */
  readonly message: string;
}

/** Discriminated anonymous Share access state. */
export type HonuaShareAccessState<TResolution> = HonuaShareAccessGranted<TResolution> | HonuaShareAccessDenied;

/** Anonymous Share access state for a public-link / public-content read. */
export type HonuaPublicLinkAccessState = HonuaShareAccessState<HonuaPublicLinkResolution>;

/** Anonymous Share access state for an embed redemption. */
export type HonuaEmbedAccessState = HonuaShareAccessState<HonuaEmbedRedemption>;

/**
 * Constant, identity-free denial messages keyed by access kind. These mirror
 * the server's fixed denial bodies so the browser never has to synthesize a
 * message from item data. They are byte-stable per kind so a denial response
 * cannot be distinguished by message content.
 */
export const HONUA_SHARE_DENIAL_MESSAGES: Readonly<Record<HonuaShareAccessKind, string>> = {
  "public-link": "Link not found or expired.",
  "public-content": "Shared item not found.",
  embed: "Embed token not found or expired.",
} as const;

/**
 * Builds an anonymous-safe denial state. The message is always sourced from
 * {@link HONUA_SHARE_DENIAL_MESSAGES} and never from caller-supplied item data,
 * so private titles cannot leak through this path.
 */
export function denyShareAccess(kind: HonuaShareAccessKind, reason: HonuaShareDenialReason): HonuaShareAccessDenied {
  return {
    status: "denied",
    kind,
    reason,
    message: HONUA_SHARE_DENIAL_MESSAGES[kind] ?? HONUA_SHARE_DENIAL_MESSAGES["public-content"],
  };
}

/** Builds a granted Share access state from a resolved presentation projection. */
export function grantShareAccess<TResolution>(
  kind: HonuaShareAccessKind,
  resolution: TResolution,
): HonuaShareAccessGranted<TResolution> {
  return { status: "granted", kind, resolution };
}

/** Narrowing guard for the denied state. */
export function isShareAccessDenied<TResolution>(
  state: HonuaShareAccessState<TResolution>,
): state is HonuaShareAccessDenied {
  return state.status === "denied";
}

/** Narrowing guard for the granted state. */
export function isShareAccessGranted<TResolution>(
  state: HonuaShareAccessState<TResolution>,
): state is HonuaShareAccessGranted<TResolution> {
  return state.status === "granted";
}

/**
 * Maps an anonymous Share endpoint HTTP status to a denial state. The server
 * collapses unknown/expired/revoked/forbidden into a uniform `404`, so any
 * non-2xx status becomes a `not-found` denial unless it is a `403`
 * (`forbidden`) or `410` (`expired`). This keeps browser callers from leaking
 * an existence oracle by branching on richer statuses.
 */
export function denialFromHttpStatus(kind: HonuaShareAccessKind, status: number): HonuaShareAccessDenied {
  if (status === 403) return denyShareAccess(kind, "forbidden");
  if (status === 410) return denyShareAccess(kind, "expired");
  return denyShareAccess(kind, "not-found");
}
