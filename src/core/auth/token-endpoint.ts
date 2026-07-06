/**
 * Shared helpers for talking to an OAuth2 token endpoint and turning responses
 * into {@link StoredCredential}s. Used by both the PKCE and client-credentials
 * providers.
 *
 * @packageDocumentation
 */

import { HonuaAuthError } from "../errors.js";
import type { HonuaAuthCredentials } from "../types.js";
import type { OAuth2TokenResponse, StoredCredential } from "./types.js";

/**
 * Project a {@link StoredCredential} into the {@link HonuaAuthCredentials} shape
 * the client attaches to requests. Non-`Bearer` token types are emitted as a
 * full `Authorization` value; the expiry drives the client's own refresh skew.
 */
export function toHonuaCredentials(credential: StoredCredential): HonuaAuthCredentials {
  const result: HonuaAuthCredentials = {};
  if (credential.tokenType && credential.tokenType.toLowerCase() !== "bearer") {
    result.authorization = `${credential.tokenType} ${credential.accessToken}`;
  } else {
    result.bearerToken = credential.accessToken;
  }
  if (credential.expiresAt !== undefined) {
    result.expiresAt = credential.expiresAt;
  }
  return result;
}

/** Resolve `serviceKey`, defaulting to `${clientId}@${endpoint origin}`. */
export function resolveServiceKey(serviceKey: string | undefined, clientId: string, endpoint: string): string {
  if (serviceKey) {
    return serviceKey;
  }
  let origin = endpoint;
  try {
    origin = new URL(endpoint).origin;
  } catch {
    // Non-absolute endpoint (tests) — fall back to the raw string.
  }
  return `${clientId}@${origin}`;
}

/** Default clock-skew tolerance (ms) applied to credential expiry checks. */
export const DEFAULT_CLOCK_SKEW_MS = 60_000;

/** True when a credential is missing or within `skewMs` of (or past) expiry. */
export function isCredentialExpiring(credential: StoredCredential | undefined, skewMs: number): boolean {
  if (!credential) {
    return true;
  }
  if (credential.expiresAt === undefined) {
    return false;
  }
  return credential.expiresAt - Date.now() <= skewMs;
}

/** Map a token response into a {@link StoredCredential} (clock-skew tolerant). */
export function credentialFromTokenResponse(
  response: OAuth2TokenResponse,
  previous?: StoredCredential,
): StoredCredential {
  const credential: StoredCredential = {
    accessToken: response.access_token,
  };
  if (response.token_type) {
    credential.tokenType = response.token_type;
  }
  // Some authorization servers omit a rotated refresh token on refresh; keep
  // the previous one so silent refresh keeps working (RFC 6749 §6).
  const refreshToken = response.refresh_token ?? previous?.refreshToken;
  if (refreshToken) {
    credential.refreshToken = refreshToken;
  }
  if (typeof response.expires_in === "number" && Number.isFinite(response.expires_in)) {
    credential.expiresAt = Date.now() + response.expires_in * 1000;
  }
  const scope = response.scope ?? previous?.scope;
  if (scope) {
    credential.scope = scope;
  }
  if (response.id_token) {
    credential.idToken = response.id_token;
  }
  return credential;
}

/**
 * POST an `application/x-www-form-urlencoded` grant to the token endpoint and
 * return the parsed {@link StoredCredential}.
 *
 * Errors are normalized to {@link HonuaAuthError}: an `invalid_grant` OAuth
 * error (expired/revoked/invalid grant → re-auth needed) maps to code
 * `invalid_grant`; every other transport/HTTP/parse failure maps to
 * `refresh_failed` (transient, retry may succeed).
 */
export async function requestToken(options: {
  fetchFn: typeof fetch;
  tokenEndpoint: string;
  params: Record<string, string>;
  previous?: StoredCredential;
  signal?: AbortSignal;
}): Promise<StoredCredential> {
  const body = new URLSearchParams(options.params);
  let response: Response;
  try {
    response = await options.fetchFn(options.tokenEndpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: body.toString(),
      ...(options.signal ? { signal: options.signal } : {}),
    });
  } catch (cause) {
    throw new HonuaAuthError("refresh_failed", "Token request failed at the transport layer.", { cause });
  }

  const text = await response.text();
  let payload: unknown;
  try {
    payload = text ? JSON.parse(text) : {};
  } catch (cause) {
    throw new HonuaAuthError(
      "refresh_failed",
      `Token endpoint returned a non-JSON response (HTTP ${response.status}).`,
      {
        cause,
      },
    );
  }

  if (!response.ok) {
    const oauthError = isObject(payload) && typeof payload.error === "string" ? payload.error : undefined;
    const description =
      isObject(payload) && typeof payload.error_description === "string" ? payload.error_description : undefined;
    const message = `Token endpoint rejected the grant (HTTP ${response.status}${oauthError ? `, ${oauthError}` : ""})${
      description ? `: ${description}` : ""
    }`;
    if (oauthError === "invalid_grant") {
      throw new HonuaAuthError("invalid_grant", message, { cause: payload });
    }
    throw new HonuaAuthError("refresh_failed", message, { cause: payload });
  }

  if (!isObject(payload) || typeof payload.access_token !== "string") {
    throw new HonuaAuthError("refresh_failed", "Token endpoint response is missing an access_token.", {
      cause: payload,
    });
  }

  return credentialFromTokenResponse(payload as unknown as OAuth2TokenResponse, options.previous);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
