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

class IdentityManagerCompatStore {
  private readonly oauthInfosInternal: OAuthInfoCompat[];
  private readonly credentialsInternal: IdentityCredentialCompat[];

  public constructor() {
    this.oauthInfosInternal = [];
    this.credentialsInternal = [];
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

  public async getCredential(url: string): Promise<IdentityCredentialCompat> {
    return this.checkSignInStatus(url);
  }

  public destroyCredentials(): void {
    this.credentialsInternal.length = 0;
  }

  public reset(): void {
    this.oauthInfosInternal.length = 0;
    this.credentialsInternal.length = 0;
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
