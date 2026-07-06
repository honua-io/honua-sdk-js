/**
 * OAuth2 client-credentials provider (RFC 6749 §4.4).
 *
 * For confidential **Node/server** clients only — the `clientSecret` must never
 * ship to a browser. There is no interactive step; tokens are fetched from the
 * token endpoint on demand and refreshed by re-requesting the grant when they
 * expire (client-credentials grants do not issue refresh tokens). Refresh is
 * single-flight so N concurrent requests share one token-endpoint round-trip.
 *
 * @packageDocumentation
 */

import type { HonuaAuthCredentials, HonuaAuthProviderContext } from "../types.js";
// HonuaAuthCredentials is the declared return type of getCredentials.
import { InMemoryCredentialStore } from "./credential-store.js";
import {
  DEFAULT_CLOCK_SKEW_MS,
  isCredentialExpiring,
  requestToken,
  resolveServiceKey,
  toHonuaCredentials,
} from "./token-endpoint.js";
import type {
  ClientCredentialsConfig,
  CredentialStore,
  HonuaAuthEvent,
  HonuaAuthEventListener,
  StoredCredential,
} from "./types.js";

/** OAuth2 client-credentials provider. Construct via {@link clientCredentials}. */
export class ClientCredentialsProvider {
  private readonly config: ClientCredentialsConfig;
  private readonly store: CredentialStore;
  private readonly serviceKey: string;
  private readonly clockSkewMs: number;
  private readonly fetchFn: typeof fetch;
  private readonly listeners = new Set<HonuaAuthEventListener>();
  private refreshInFlight: Promise<StoredCredential> | undefined;

  public constructor(config: ClientCredentialsConfig) {
    this.config = config;
    this.store = config.store ?? new InMemoryCredentialStore();
    this.serviceKey = resolveServiceKey(config.serviceKey, config.clientId, config.tokenEndpoint);
    this.clockSkewMs = config.clockSkewMs ?? DEFAULT_CLOCK_SKEW_MS;
    this.fetchFn = (config.fetchFn ?? fetch).bind(globalThis);
    if (config.onEvent) {
      this.listeners.add(config.onEvent);
    }
  }

  /** {@link HonuaAuthProvider.getCredentials}: fetch/refresh a bearer token. */
  public async getCredentials(
    context: HonuaAuthProviderContext = { reason: "manual", forceRefresh: false },
  ): Promise<HonuaAuthCredentials | undefined> {
    const current = await this.store.get(this.serviceKey);
    if (!context.forceRefresh && current && !isCredentialExpiring(current, this.clockSkewMs)) {
      return toHonuaCredentials(current);
    }
    const fetched = await this.fetchSingleFlight();
    return toHonuaCredentials(fetched);
  }

  /** Drop the cached token; the next call re-requests the grant. */
  public async signOut(): Promise<void> {
    await this.store.delete(this.serviceKey);
    this.refreshInFlight = undefined;
    this.emit({ type: "signed-out" });
  }

  public on(listener: HonuaAuthEventListener): { remove(): void } {
    this.listeners.add(listener);
    return {
      remove: () => {
        this.listeners.delete(listener);
      },
    };
  }

  private fetchSingleFlight(): Promise<StoredCredential> {
    if (this.refreshInFlight) {
      return this.refreshInFlight;
    }
    const inFlight = this.fetchToken().finally(() => {
      if (this.refreshInFlight === inFlight) {
        this.refreshInFlight = undefined;
      }
    });
    this.refreshInFlight = inFlight;
    return inFlight;
  }

  private async fetchToken(): Promise<StoredCredential> {
    const previous = await this.store.get(this.serviceKey);
    const credential = await requestToken({
      fetchFn: this.fetchFn,
      tokenEndpoint: this.config.tokenEndpoint,
      params: {
        grant_type: "client_credentials",
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
        ...(this.config.scopes && this.config.scopes.length > 0 ? { scope: this.config.scopes.join(" ") } : {}),
        ...this.config.extraTokenParams,
      },
      previous,
    });
    await this.store.set(this.serviceKey, credential);
    this.emit({ type: previous ? "token-refreshed" : "signed-in", credential });
    return credential;
  }

  private emit(event: HonuaAuthEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // Listener errors must not break the auth flow.
      }
    }
  }
}

/**
 * Create an OAuth2 client-credentials {@link HonuaAuthProvider} for Node/server
 * use. Do not use in a browser — the client secret would be exposed.
 *
 * @example
 * ```ts
 * import { clientCredentials } from "@honua/sdk-js/auth";
 * const auth = clientCredentials({
 *   tokenEndpoint: "https://idp.example/token",
 *   clientId: process.env.CLIENT_ID!,
 *   clientSecret: process.env.CLIENT_SECRET!,
 *   scopes: ["honua.read"],
 * });
 * ```
 */
export function clientCredentials(config: ClientCredentialsConfig): ClientCredentialsProvider {
  return new ClientCredentialsProvider(config);
}
