/**
 * `@honua/sdk-js/auth` — pluggable {@link HonuaAuthProvider} built-ins and the
 * {@link CredentialStore} abstraction.
 *
 * These providers plug into `new HonuaClient({ auth })` and are therefore
 * attached and refreshed transparently across **all** transports the client
 * drives — every REST fetch path and every gRPC-web call (the client's auth
 * interceptor re-resolves credentials per attempt), plus the 401/403
 * force-refresh retry.
 *
 * This module is a dedicated subpath so a `HonuaClient`-only consumer never
 * pays the PKCE/token-exchange code size unless they opt in.
 *
 * @packageDocumentation
 */

export { oauth2, OAuth2Provider } from "./oauth2-provider.js";
export { clientCredentials, ClientCredentialsProvider } from "./client-credentials-provider.js";
export { apiKeyAuth, bearerTokenAuth } from "./static-providers.js";
export {
  InMemoryCredentialStore,
  sessionStorageCredentialStore,
  localStorageCredentialStore,
} from "./credential-store.js";
export { createPkcePair, createStateToken } from "./pkce.js";
export type { PkcePair } from "./pkce.js";
export type {
  ClientCredentialsConfig,
  CredentialStore,
  HonuaAuthEvent,
  HonuaAuthEventHandle,
  HonuaAuthEventListener,
  OAuth2Config,
  OAuth2SignInMode,
  OAuth2TokenResponse,
  StoredCredential,
} from "./types.js";
