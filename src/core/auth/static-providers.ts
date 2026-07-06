/**
 * Static (non-interactive) {@link HonuaAuthProvider} built-ins for callers that
 * already hold a long-lived credential.
 *
 * @packageDocumentation
 */

import type { HonuaAuthProvider } from "../types.js";

/**
 * Provider that attaches a static API key as `X-API-Key` on every request.
 * Equivalent to `new HonuaClient({ apiKey })` but composable as an
 * {@link HonuaAuthProvider}.
 */
export function apiKeyAuth(apiKey: string): HonuaAuthProvider {
  return {
    getCredentials: () => ({ apiKey }),
  };
}

/**
 * Provider that attaches a static bearer token as `Authorization: Bearer …`.
 * Equivalent to `new HonuaClient({ bearerToken })` but composable as an
 * {@link HonuaAuthProvider}.
 */
export function bearerTokenAuth(token: string): HonuaAuthProvider {
  return {
    getCredentials: () => ({ bearerToken: token }),
  };
}
