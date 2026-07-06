/**
 * OAuth2 authorization-code + PKCE provider.
 *
 * Implements {@link HonuaAuthProvider} (so it drops straight into
 * `new HonuaClient({ auth })` and is attached/refreshed on every fetch and
 * gRPC-web call) *and* exposes the interactive surface a browser app drives:
 * `signIn()` (redirect or popup), `handleRedirectCallback()`, `signOut()`.
 *
 * Design highlights:
 * - S256 PKCE + unguessable `state` (CSRF), validated on the redirect.
 * - Silent refresh via `refresh_token` with a documented fallback
 *   (`interaction_required`) when no refresh token is available.
 * - Clock-skew-tolerant expiry so a refresh happens *before* requests 401.
 * - **Single-flight refresh**: N concurrent `getCredentials()` calls that all
 *   observe an expiring token share exactly one token-endpoint round-trip.
 *
 * @packageDocumentation
 */

import { HonuaAuthError } from "../errors.js";
import type { HonuaAuthCredentials, HonuaAuthProviderContext, HonuaAuthRevocationContext } from "../types.js";
import { InMemoryCredentialStore } from "./credential-store.js";
import { type PkcePair, createPkcePair, createStateToken } from "./pkce.js";
import {
  DEFAULT_CLOCK_SKEW_MS,
  isCredentialExpiring,
  requestToken,
  resolveServiceKey,
  toHonuaCredentials,
} from "./token-endpoint.js";
import type {
  CredentialStore,
  HonuaAuthEvent,
  HonuaAuthEventHandle,
  HonuaAuthEventListener,
  OAuth2Config,
  OAuth2SignInMode,
  StoredCredential,
} from "./types.js";

interface PkceTransaction {
  codeVerifier: string;
  state: string;
  redirectUri: string;
  createdAt: number;
}

const TRANSACTION_NAMESPACE = "honua.auth.txn";

/**
 * OAuth2 authorization-code + PKCE provider. Construct via {@link oauth2}.
 */
export class OAuth2Provider {
  private readonly config: OAuth2Config;
  private readonly store: CredentialStore;
  private readonly serviceKey: string;
  private readonly clockSkewMs: number;
  private readonly mode: OAuth2SignInMode;
  private readonly fetchFn: typeof fetch;
  private readonly listeners = new Set<HonuaAuthEventListener>();
  /** Single-flight guard: one in-flight refresh shared by all callers. */
  private refreshInFlight: Promise<StoredCredential> | undefined;
  /** In-memory transaction fallback when no Web Storage is available. */
  private memoryTransaction: PkceTransaction | undefined;

  public constructor(config: OAuth2Config) {
    this.config = config;
    this.store = config.store ?? new InMemoryCredentialStore();
    this.serviceKey = resolveServiceKey(config.serviceKey, config.clientId, config.tokenEndpoint);
    this.clockSkewMs = config.clockSkewMs ?? DEFAULT_CLOCK_SKEW_MS;
    this.mode = config.mode ?? "redirect";
    this.fetchFn = (config.fetchFn ?? fetch).bind(globalThis);
    if (config.onEvent) {
      this.listeners.add(config.onEvent);
    }
  }

  // ── HonuaAuthProvider surface ────────────────────────────────

  /**
   * Resolve credentials for an outgoing request. Returns the current access
   * token, silently refreshing it first when it is expiring (or when
   * `context.forceRefresh` is set, e.g. after a 401). Throws
   * {@link HonuaAuthError} `interaction_required` when there is no token and no
   * refresh token — the app must call {@link OAuth2Provider.signIn}.
   */
  public async getCredentials(
    context: HonuaAuthProviderContext = { reason: "manual", forceRefresh: false },
  ): Promise<HonuaAuthCredentials | undefined> {
    const current = await this.store.get(this.serviceKey);
    const needsRefresh = context.forceRefresh || isCredentialExpiring(current, this.clockSkewMs);
    if (!needsRefresh && current) {
      return toHonuaCredentials(current);
    }
    if (current?.refreshToken) {
      const refreshed = await this.refreshSingleFlight(current);
      return toHonuaCredentials(refreshed);
    }
    throw new HonuaAuthError(
      "interaction_required",
      current
        ? "Access token expired and no refresh token is available; call signIn() to re-authenticate."
        : "No credential available; call signIn() to start the OAuth2 authorization-code flow.",
    );
  }

  /** {@link HonuaAuthProvider.revokeCredentials} — clears + optionally revokes. */
  public async revokeCredentials(
    _credentials: HonuaAuthCredentials,
    _context: HonuaAuthRevocationContext,
  ): Promise<void> {
    await this.signOut();
  }

  // ── Interactive flow ─────────────────────────────────────────

  /**
   * Start interactive sign-in. In `redirect` mode this navigates the current
   * window to the authorization endpoint and returns a promise that never
   * resolves (the page unloads); complete the flow by calling
   * {@link OAuth2Provider.handleRedirectCallback} when the app reloads at the
   * redirect URI. In `popup` mode it opens a popup, waits for the redirect back,
   * exchanges the code, and resolves with the stored credential.
   */
  public async signIn(): Promise<StoredCredential | undefined> {
    const pkce = await createPkcePair();
    const state = createStateToken();
    const transaction: PkceTransaction = {
      codeVerifier: pkce.codeVerifier,
      state,
      redirectUri: this.config.redirectUri,
      createdAt: Date.now(),
    };
    const authorizeUrl = this.buildAuthorizeUrl(pkce, state);

    if (this.mode === "popup") {
      return this.signInPopup(authorizeUrl, transaction);
    }

    this.saveTransaction(transaction);
    const win = this.requireWindow();
    win.location.assign(authorizeUrl);
    // The redirect unloads the page; never resolves.
    return new Promise<never>(() => {});
  }

  /**
   * Whether `url` (or the current window location) looks like an OAuth2 redirect
   * callback (carries `code`+`state` or an `error`). Call this on app load to
   * decide whether to invoke {@link OAuth2Provider.handleRedirectCallback}.
   */
  public isRedirectCallback(url?: string): boolean {
    const target = this.parseUrl(url);
    if (!target) {
      return false;
    }
    return target.searchParams.has("error") || (target.searchParams.has("code") && target.searchParams.has("state"));
  }

  /**
   * Complete the redirect leg: validate `state`, exchange the authorization
   * `code` (+ PKCE verifier) for tokens, persist them, and emit `signed-in`.
   */
  public async handleRedirectCallback(url?: string): Promise<StoredCredential> {
    const target = this.parseUrl(url);
    if (!target) {
      throw new HonuaAuthError("interaction_required", "No redirect callback URL is available to process.");
    }
    const params = target.searchParams;
    const authError = params.get("error");
    if (authError) {
      const description = params.get("error_description");
      this.clearTransaction();
      throw new HonuaAuthError(
        "invalid_grant",
        `Authorization server returned an error: ${authError}${description ? ` (${description})` : ""}`,
      );
    }
    const code = params.get("code");
    const state = params.get("state");
    if (!code) {
      throw new HonuaAuthError("interaction_required", "Redirect callback is missing the authorization code.");
    }
    const transaction = this.loadTransaction();
    if (!transaction) {
      throw new HonuaAuthError(
        "interaction_required",
        "No PKCE transaction is in progress; start sign-in with signIn() first.",
      );
    }
    if (!state || state !== transaction.state) {
      this.clearTransaction();
      throw new HonuaAuthError("invalid_grant", "OAuth2 state mismatch on redirect callback (possible CSRF).");
    }
    const credential = await this.exchangeCode(code, transaction);
    await this.store.set(this.serviceKey, credential);
    this.clearTransaction();
    this.emit({ type: "signed-in", credential });
    return credential;
  }

  /** Whether a (non-expired) credential is currently stored. */
  public async isSignedIn(): Promise<boolean> {
    const current = await this.store.get(this.serviceKey);
    return current !== undefined && !isCredentialExpiring(current, 0);
  }

  /** Read the raw stored credential, if any. */
  public getStoredCredential(): StoredCredential | undefined | Promise<StoredCredential | undefined> {
    return this.store.get(this.serviceKey);
  }

  /** Clear stored credentials, optionally revoke them, and emit `signed-out`. */
  public async signOut(): Promise<void> {
    const current = await this.store.get(this.serviceKey);
    await this.store.delete(this.serviceKey);
    this.clearTransaction();
    this.refreshInFlight = undefined;
    if (current && this.config.revocationEndpoint) {
      await this.revokeAtEndpoint(current).catch(() => {
        // Best-effort revocation; local sign-out already succeeded.
      });
    }
    this.emit({ type: "signed-out" });
  }

  /** Register an auth lifecycle listener. */
  public on(listener: HonuaAuthEventListener): HonuaAuthEventHandle {
    this.listeners.add(listener);
    return {
      remove: () => {
        this.listeners.delete(listener);
      },
    };
  }

  // ── internals ────────────────────────────────────────────────

  private refreshSingleFlight(current: StoredCredential): Promise<StoredCredential> {
    if (this.refreshInFlight) {
      return this.refreshInFlight;
    }
    const inFlight = this.doRefresh(current).finally(() => {
      if (this.refreshInFlight === inFlight) {
        this.refreshInFlight = undefined;
      }
    });
    this.refreshInFlight = inFlight;
    return inFlight;
  }

  private async doRefresh(current: StoredCredential): Promise<StoredCredential> {
    const refreshToken = current.refreshToken;
    if (!refreshToken) {
      throw new HonuaAuthError("interaction_required", "No refresh token is available; call signIn().");
    }
    try {
      const refreshed = await requestToken({
        fetchFn: this.fetchFn,
        tokenEndpoint: this.config.tokenEndpoint,
        params: {
          grant_type: "refresh_token",
          refresh_token: refreshToken,
          client_id: this.config.clientId,
          ...(this.config.scopes && this.config.scopes.length > 0 ? { scope: this.config.scopes.join(" ") } : {}),
          ...this.config.extraTokenParams,
        },
        previous: current,
      });
      await this.store.set(this.serviceKey, refreshed);
      this.emit({ type: "token-refreshed", credential: refreshed });
      return refreshed;
    } catch (error) {
      if (error instanceof HonuaAuthError) {
        this.emit({ type: "refresh-failed", error });
        if (error.code === "invalid_grant") {
          // The refresh token is dead; drop it so the next call surfaces
          // interaction_required instead of looping on a doomed refresh.
          await this.store.delete(this.serviceKey);
          this.emit({ type: "signed-out" });
        }
      }
      throw error;
    }
  }

  private async exchangeCode(code: string, transaction: PkceTransaction): Promise<StoredCredential> {
    return requestToken({
      fetchFn: this.fetchFn,
      tokenEndpoint: this.config.tokenEndpoint,
      params: {
        grant_type: "authorization_code",
        code,
        redirect_uri: transaction.redirectUri,
        client_id: this.config.clientId,
        code_verifier: transaction.codeVerifier,
        ...this.config.extraTokenParams,
      },
    });
  }

  private async revokeAtEndpoint(credential: StoredCredential): Promise<void> {
    const endpoint = this.config.revocationEndpoint;
    if (!endpoint) {
      return;
    }
    const token = credential.refreshToken ?? credential.accessToken;
    await this.fetchFn(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token, client_id: this.config.clientId }).toString(),
    });
  }

  private buildAuthorizeUrl(pkce: PkcePair, state: string): string {
    const url = new URL(this.config.authorizationEndpoint);
    const params = url.searchParams;
    params.set("response_type", "code");
    params.set("client_id", this.config.clientId);
    params.set("redirect_uri", this.config.redirectUri);
    params.set("state", state);
    params.set("code_challenge", pkce.codeChallenge);
    params.set("code_challenge_method", pkce.codeChallengeMethod);
    if (this.config.scopes && this.config.scopes.length > 0) {
      params.set("scope", this.config.scopes.join(" "));
    }
    for (const [key, value] of Object.entries(this.config.extraAuthorizationParams ?? {})) {
      params.set(key, value);
    }
    return url.toString();
  }

  private async signInPopup(authorizeUrl: string, transaction: PkceTransaction): Promise<StoredCredential> {
    const win = this.requireWindow();
    const popup = win.open(authorizeUrl, "honua-oauth", this.config.popupFeatures ?? "width=480,height=680");
    if (!popup) {
      throw new HonuaAuthError("interaction_required", "The sign-in popup was blocked by the browser.");
    }
    const redirectOrigin = new URL(transaction.redirectUri, win.location?.href ?? transaction.redirectUri).origin;
    const callback = await new Promise<{ code: string; state: string }>((resolve, reject) => {
      const timer = setInterval(() => {
        try {
          if (popup.closed) {
            clearInterval(timer);
            reject(
              new HonuaAuthError("interaction_required", "The sign-in popup was closed before completing sign-in."),
            );
            return;
          }
          let popupUrl: URL;
          try {
            popupUrl = new URL(popup.location.href);
          } catch {
            // Cross-origin while on the authorization server — not readable yet.
            return;
          }
          if (popupUrl.origin === redirectOrigin && popupUrl.searchParams.has("code")) {
            clearInterval(timer);
            const code = popupUrl.searchParams.get("code") ?? "";
            const state = popupUrl.searchParams.get("state") ?? "";
            popup.close();
            resolve({ code, state });
          }
        } catch {
          // Ignore transient cross-origin access errors during the auth leg.
        }
      }, 200);
    });
    if (!callback.state || callback.state !== transaction.state) {
      throw new HonuaAuthError("invalid_grant", "OAuth2 state mismatch on popup callback (possible CSRF).");
    }
    const credential = await this.exchangeCode(callback.code, transaction);
    await this.store.set(this.serviceKey, credential);
    this.emit({ type: "signed-in", credential });
    return credential;
  }

  private parseUrl(url?: string): URL | undefined {
    const href = url ?? this.getWindow()?.location?.href;
    if (!href) {
      return undefined;
    }
    try {
      return new URL(href);
    } catch {
      return undefined;
    }
  }

  private getWindow(): Window | undefined {
    return this.config.windowRef ?? (globalThis as { window?: Window }).window;
  }

  private requireWindow(): Window {
    const win = this.getWindow();
    if (!win) {
      throw new HonuaAuthError(
        "interaction_required",
        "Interactive OAuth2 sign-in requires a browser window; none is available in this environment.",
      );
    }
    return win;
  }

  private transactionKey(): string {
    return `${TRANSACTION_NAMESPACE}:${this.serviceKey}`;
  }

  private sessionStorage(): Storage | undefined {
    return this.getWindow()?.sessionStorage;
  }

  private saveTransaction(transaction: PkceTransaction): void {
    const storage = this.sessionStorage();
    if (storage) {
      storage.setItem(this.transactionKey(), JSON.stringify(transaction));
      return;
    }
    this.memoryTransaction = transaction;
  }

  private loadTransaction(): PkceTransaction | undefined {
    const storage = this.sessionStorage();
    if (storage) {
      const raw = storage.getItem(this.transactionKey());
      if (!raw) {
        return undefined;
      }
      try {
        return JSON.parse(raw) as PkceTransaction;
      } catch {
        return undefined;
      }
    }
    return this.memoryTransaction;
  }

  private clearTransaction(): void {
    this.sessionStorage()?.removeItem(this.transactionKey());
    this.memoryTransaction = undefined;
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
 * Create an OAuth2 authorization-code + PKCE {@link HonuaAuthProvider}.
 *
 * @example
 * ```ts
 * import { HonuaClient } from "@honua/sdk-js/honua";
 * import { oauth2 } from "@honua/sdk-js/auth";
 *
 * const auth = oauth2({
 *   authorizationEndpoint: "https://idp.example/authorize",
 *   tokenEndpoint: "https://idp.example/token",
 *   clientId: "my-app",
 *   redirectUri: `${location.origin}/callback`,
 *   scopes: ["openid", "profile"],
 * });
 * const client = new HonuaClient({ baseUrl: "https://api.example", auth });
 *
 * // On the callback page:
 * if (auth.isRedirectCallback()) await auth.handleRedirectCallback();
 * else if (!(await auth.isSignedIn())) await auth.signIn();
 * ```
 */
export function oauth2(config: OAuth2Config): OAuth2Provider {
  return new OAuth2Provider(config);
}
