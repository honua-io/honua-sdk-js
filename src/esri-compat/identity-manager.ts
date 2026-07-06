import type { HonuaAuthCredentials, HonuaAuthProvider } from "../core/types.js";
import { OAuthInfoCompat, type OAuthInfoCompatOptions } from "./oauth-info.js";

export interface IdentityCredentialCompat {
  server: string;
  token: string;
  expires?: number;
  userId?: string;
}

export interface IdentityTokenRegistrationCompat {
  server: string;
  token: string;
  expires?: number;
  userId?: string;
}

/**
 * A real OAuth2 engine backing a server in {@link IdentityManagerCompatStore}.
 * Any built-in provider from `@honua/sdk-js/auth` (e.g. `oauth2(...)`) satisfies
 * this: it is a {@link HonuaAuthProvider} with an optional interactive
 * `signIn()`. Binding one makes `getCredential(url)` drive the actual PKCE /
 * refresh flow (obtain a token, register it, return it) instead of only reading
 * pre-seeded tokens — so migrated `IdentityManager.registerOAuthInfos(...)` +
 * `IdentityManager.getCredential(...)` code paths work end to end.
 */
export interface IdentityManagerOAuth2Engine extends HonuaAuthProvider {
  signIn?(): Promise<unknown>;
}

interface BoundEngine {
  server: string;
  engine: IdentityManagerOAuth2Engine;
}

class IdentityManagerCompatStore {
  private readonly oauthInfosInternal: OAuthInfoCompat[];
  private readonly credentialsInternal: IdentityCredentialCompat[];
  private readonly engines: BoundEngine[];

  public constructor() {
    this.oauthInfosInternal = [];
    this.credentialsInternal = [];
    this.engines = [];
  }

  public get oauthInfos(): readonly OAuthInfoCompat[] {
    return this.oauthInfosInternal.map((info) => info.clone());
  }

  public get credentials(): readonly IdentityCredentialCompat[] {
    return this.credentialsInternal.map((credential) => ({ ...credential }));
  }

  public registerOAuthInfos(infos: readonly (OAuthInfoCompat | OAuthInfoCompatOptions)[]): void {
    this.oauthInfosInternal.length = 0;
    for (const info of infos) {
      this.oauthInfosInternal.push(info instanceof OAuthInfoCompat ? info.clone() : new OAuthInfoCompat(info));
    }
  }

  public registerToken(token: IdentityTokenRegistrationCompat): void {
    const next: IdentityCredentialCompat = {
      server: token.server,
      token: token.token,
      expires: typeof token.expires === "number" && Number.isFinite(token.expires) ? token.expires : undefined,
      userId: token.userId,
    };

    const deduped: IdentityCredentialCompat[] = [];
    let replaced = false;
    for (const existing of this.credentialsInternal) {
      if (isSameCredentialServer(existing.server, next.server)) {
        if (!replaced) {
          deduped.push(next);
          replaced = true;
        }
        continue;
      }
      deduped.push(existing);
    }

    if (!replaced) {
      deduped.push(next);
    }

    this.credentialsInternal.length = 0;
    this.credentialsInternal.push(...deduped);
  }

  public findCredential(url: string): IdentityCredentialCompat | undefined {
    const match = this.findCredentialEntry(url);
    if (!match || isCredentialExpired(match)) {
      return undefined;
    }
    return { ...match };
  }

  public async checkSignInStatus(url: string): Promise<IdentityCredentialCompat> {
    const credential = this.findCredentialEntry(url);
    if (!credential) {
      throw new Error("No registered credential for requested server.");
    }
    if (isCredentialExpired(credential)) {
      throw new Error("Registered credential for requested server has expired.");
    }
    return { ...credential };
  }

  /**
   * Bind a real OAuth2 engine (e.g. `oauth2(...)` from `@honua/sdk-js/auth`) to
   * a server URL. Once bound, {@link getCredential} for a URL under that server
   * drives the engine's silent-refresh / interactive sign-in flow instead of
   * only reading a pre-registered token.
   *
   * @example
   * ```ts
   * import { oauth2 } from "@honua/sdk-js/auth";
   * import { identityManager, OAuthInfoCompat } from "@honua/sdk-js/esri-compat";
   *
   * const info = new OAuthInfoCompat({ appId: "app", portalUrl: "https://portal.example" });
   * identityManager.registerOAuthInfos([info]);
   * identityManager.registerOAuth2Engine(
   *   info.portalUrl,
   *   oauth2(info.toOAuth2Config({ redirectUri: `${location.origin}/callback` })),
   * );
   * const credential = await identityManager.getCredential("https://portal.example/sharing/rest");
   * ```
   */
  public registerOAuth2Engine(server: string, engine: IdentityManagerOAuth2Engine): void {
    const normalized = normalizeServerUrl(server) ?? server;
    const existing = this.engines.findIndex(
      (bound) => (normalizeServerUrl(bound.server) ?? bound.server) === normalized,
    );
    if (existing >= 0) {
      this.engines.splice(existing, 1);
    }
    this.engines.push({ server, engine });
  }

  /**
   * Resolve a credential for `url`. Returns a valid pre-registered token when
   * one exists; otherwise, if a real OAuth2 engine is bound for the server,
   * drives it (silent refresh, or interactive `signIn()` when the engine throws
   * `interaction_required`), registers the resulting token, and returns it.
   */
  public async getCredential(url: string): Promise<IdentityCredentialCompat> {
    const existing = this.findCredentialEntry(url);
    if (existing && !isCredentialExpired(existing)) {
      return { ...existing };
    }

    const engine = this.findEngine(url);
    if (!engine) {
      return this.checkSignInStatus(url);
    }

    const credential = await this.resolveThroughEngine(engine, url);
    this.registerToken(credential);
    return { ...credential };
  }

  public destroyCredentials(): void {
    this.credentialsInternal.length = 0;
  }

  public reset(): void {
    this.oauthInfosInternal.length = 0;
    this.credentialsInternal.length = 0;
    this.engines.length = 0;
  }

  private findEngine(url: string): BoundEngine | undefined {
    const normalized = normalizeServerUrl(url);
    if (!normalized) {
      return undefined;
    }
    for (let index = this.engines.length - 1; index >= 0; index -= 1) {
      const bound = this.engines[index];
      if (!bound) {
        continue;
      }
      const server = normalizeServerUrl(bound.server);
      if (!server) {
        continue;
      }
      if (normalized === server || normalized.startsWith(`${server}/`)) {
        return bound;
      }
    }
    return undefined;
  }

  private async resolveThroughEngine(bound: BoundEngine, url: string): Promise<IdentityCredentialCompat> {
    const context = { reason: "initial" as const, forceRefresh: false };
    let credentials: HonuaAuthCredentials | string | null | undefined;
    try {
      credentials = await bound.engine.getCredentials(context);
    } catch (error) {
      if (isInteractionRequired(error) && bound.engine.signIn) {
        await bound.engine.signIn();
        credentials = await bound.engine.getCredentials(context);
      } else {
        throw error;
      }
    }
    const token = tokenFromCredentials(credentials);
    if (!token) {
      throw new Error("OAuth2 engine did not return a usable token for the requested server.");
    }
    const expires = expiresFromCredentials(credentials);
    return {
      server: bound.server,
      token,
      ...(expires !== undefined ? { expires } : {}),
    };
  }

  private findCredentialEntry(url: string): IdentityCredentialCompat | undefined {
    const normalized = normalizeServerUrl(url);
    if (!normalized) {
      return undefined;
    }

    for (let index = this.credentialsInternal.length - 1; index >= 0; index -= 1) {
      const credential = this.credentialsInternal[index];
      if (!credential) {
        continue;
      }
      const server = normalizeServerUrl(credential.server);
      if (!server) {
        continue;
      }
      if (normalized === server || normalized.startsWith(`${server}/`)) {
        return credential;
      }
    }

    return undefined;
  }
}

export const identityManager = new IdentityManagerCompatStore();

function normalizeServerUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    const pathname = url.pathname.endsWith("/") ? url.pathname.slice(0, -1) : url.pathname;
    return `${url.protocol}//${url.host}${pathname}`;
  } catch {
    return undefined;
  }
}

function isCredentialExpired(credential: IdentityCredentialCompat): boolean {
  return (
    typeof credential.expires === "number" && Number.isFinite(credential.expires) && credential.expires <= Date.now()
  );
}

function isSameCredentialServer(left: string, right: string): boolean {
  const leftNormalized = normalizeServerUrl(left);
  const rightNormalized = normalizeServerUrl(right);
  if (leftNormalized && rightNormalized) {
    return leftNormalized === rightNormalized;
  }
  return left === right;
}

function isInteractionRequired(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { name?: string }).name === "HonuaAuthError" &&
    (error as { code?: string }).code === "interaction_required"
  );
}

function tokenFromCredentials(credentials: HonuaAuthCredentials | string | null | undefined): string | undefined {
  if (!credentials) {
    return undefined;
  }
  if (typeof credentials === "string") {
    return credentials.length > 0 ? credentials : undefined;
  }
  if (credentials.bearerToken) {
    return credentials.bearerToken;
  }
  if (credentials.authorization) {
    // Strip a leading "Bearer " scheme so the stored token matches what Esri
    // clients expect in the `token` field.
    return credentials.authorization.replace(/^Bearer\s+/i, "");
  }
  return credentials.apiKey;
}

function expiresFromCredentials(credentials: HonuaAuthCredentials | string | null | undefined): number | undefined {
  if (!credentials || typeof credentials === "string" || credentials.expiresAt === undefined) {
    return undefined;
  }
  const { expiresAt } = credentials;
  if (expiresAt instanceof Date) {
    return Number.isFinite(expiresAt.getTime()) ? expiresAt.getTime() : undefined;
  }
  if (typeof expiresAt === "number") {
    return Number.isFinite(expiresAt) ? expiresAt : undefined;
  }
  const parsed = Date.parse(expiresAt);
  return Number.isFinite(parsed) ? parsed : undefined;
}
