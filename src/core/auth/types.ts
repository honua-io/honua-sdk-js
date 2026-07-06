/**
 * Shared types for the built-in {@link HonuaAuthProvider} implementations
 * (`oauth2`, `clientCredentials`, `apiKeyAuth`, `bearerTokenAuth`) and the
 * pluggable {@link CredentialStore}.
 *
 * @packageDocumentation
 */

import type { HonuaAuthError } from "../errors.js";

/**
 * A persisted OAuth2 credential. Access/refresh tokens plus expiry are stored
 * in a {@link CredentialStore}; the SDK only ever attaches `accessToken` as a
 * bearer credential and uses `refreshToken`/`expiresAt` to drive silent
 * refresh.
 */
export interface StoredCredential {
  /** The bearer access token attached to outgoing requests. */
  accessToken: string;
  /** Token type from the token response; defaults to `Bearer`. */
  tokenType?: string;
  /** Refresh token, when the authorization server issued one. */
  refreshToken?: string;
  /** Absolute expiry as epoch milliseconds (from `expires_in`). */
  expiresAt?: number;
  /** Granted scope string, if the token response narrowed it. */
  scope?: string;
  /** OpenID Connect ID token, when present (never sent to resource servers). */
  idToken?: string;
}

/**
 * Pluggable credential persistence. The default is an in-memory store scoped to
 * the provider instance. Browser adapters (`sessionStorageCredentialStore`,
 * `localStorageCredentialStore`) are explicit opt-in because Web Storage is
 * readable by any script on the origin (XSS exfiltration risk) — see
 * `docs/auth.md`.
 *
 * Keys are namespaced per origin/service by the provider so tokens for one
 * service are never returned for another.
 */
export interface CredentialStore {
  get(key: string): StoredCredential | undefined | Promise<StoredCredential | undefined>;
  set(key: string, value: StoredCredential): void | Promise<void>;
  delete(key: string): void | Promise<void>;
}

/** Lifecycle events emitted by the OAuth2 / client-credentials providers. */
export type HonuaAuthEvent =
  | { type: "signed-in"; credential: StoredCredential }
  | { type: "token-refreshed"; credential: StoredCredential }
  | { type: "refresh-failed"; error: HonuaAuthError }
  | { type: "signed-out" };

/** Listener registered with `provider.on(...)`. */
export type HonuaAuthEventListener = (event: HonuaAuthEvent) => void;

/** Handle returned by `provider.on(...)`; call `remove()` to unsubscribe. */
export interface HonuaAuthEventHandle {
  remove(): void;
}

/** Interactive sign-in mode for the OAuth2 authorization-code + PKCE flow. */
export type OAuth2SignInMode = "redirect" | "popup";

/**
 * Configuration for the OAuth2 authorization-code + PKCE provider produced by
 * {@link oauth2}. Only WebCrypto is used for PKCE (Node ≥20 exposes
 * `globalThis.crypto`); no new hard dependencies are introduced.
 */
export interface OAuth2Config {
  /** Authorization endpoint (where the browser is redirected to sign in). */
  authorizationEndpoint: string;
  /** Token endpoint (code exchange + refresh). */
  tokenEndpoint: string;
  /** Public client identifier. */
  clientId: string;
  /** Registered redirect URI that receives the authorization `code`+`state`. */
  redirectUri: string;
  /** Requested scopes. */
  scopes?: readonly string[];
  /** Interactive mode. Defaults to `redirect`. */
  mode?: OAuth2SignInMode;
  /**
   * Credential store. Defaults to an in-memory store. Scoped per
   * origin/service via {@link OAuth2Config.serviceKey}.
   */
  store?: CredentialStore;
  /**
   * Stable key that scopes stored credentials to this service. Defaults to
   * `${clientId}@${origin of tokenEndpoint}` so tokens are never shared across
   * services or origins.
   */
  serviceKey?: string;
  /**
   * Clock-skew tolerance in milliseconds. A credential is treated as expiring
   * this long before its real expiry so a refresh happens before requests fail.
   * Defaults to 60_000.
   */
  clockSkewMs?: number;
  /** Optional revocation endpoint (RFC 7009) called on `signOut()`. */
  revocationEndpoint?: string;
  /** Extra query params appended to the authorization request. */
  extraAuthorizationParams?: Record<string, string>;
  /** Extra body params appended to token/refresh requests. */
  extraTokenParams?: Record<string, string>;
  /** Popup window features string (popup mode). */
  popupFeatures?: string;
  /** Override `fetch` (Node/tests). Defaults to `globalThis.fetch`. */
  fetchFn?: typeof fetch;
  /**
   * Window used for redirect/popup + transaction persistence. Defaults to
   * `globalThis.window`. Injectable for tests / non-DOM hosts.
   */
  windowRef?: Window;
  /** Auth lifecycle listener. */
  onEvent?: HonuaAuthEventListener;
}

/**
 * Configuration for the OAuth2 client-credentials provider produced by
 * {@link clientCredentials}. Intended for confidential Node clients — the
 * client secret must never ship to a browser.
 */
export interface ClientCredentialsConfig {
  tokenEndpoint: string;
  clientId: string;
  clientSecret: string;
  scopes?: readonly string[];
  store?: CredentialStore;
  serviceKey?: string;
  clockSkewMs?: number;
  extraTokenParams?: Record<string, string>;
  fetchFn?: typeof fetch;
  onEvent?: HonuaAuthEventListener;
}

/** Raw OAuth2 token endpoint response shape (RFC 6749 §5.1). */
export interface OAuth2TokenResponse {
  access_token: string;
  token_type?: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
  id_token?: string;
}
