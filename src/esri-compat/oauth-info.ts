import type { OAuth2Config } from "../core/auth/types.js";
import { safeInvokeCompatListener } from "./event-bus.js";
export interface OAuthInfoCompatOptions {
  appId?: string;
  portalUrl?: string;
  popup?: boolean;
  flowType?: "auto" | "implicit" | "authorization-code" | string;
  expiration?: number;
  authNamespace?: string;
  preserveUrlHash?: boolean;
}

/** Overrides accepted by {@link OAuthInfoCompat.toOAuth2Config}. */
export interface OAuthInfoToConfigOptions extends Partial<Omit<OAuth2Config, "clientId">> {
  /** Redirect URI receiving the authorization code (required in browsers). */
  redirectUri?: string;
  /** Override the `clientId` (defaults to this info's `appId`). */
  clientId?: string;
}

export type OAuthInfoLoadStatusCompat = "not-loaded" | "loading" | "loaded";

export interface OAuthInfoHandleCompat {
  remove(): void;
}

export class OAuthInfoCompat {
  public loaded: boolean;
  public loadStatus: OAuthInfoLoadStatusCompat;
  public appId: string | undefined;
  public portalUrl: string;
  public popup: boolean;
  public flowType: string;
  public expiration: number | undefined;
  public authNamespace: string | undefined;
  public preserveUrlHash: boolean;
  private readonly watchListeners: Map<string, Set<(value: unknown) => void>>;

  public constructor(options: OAuthInfoCompatOptions = {}) {
    this.loaded = false;
    this.loadStatus = "not-loaded";
    this.appId = options.appId;
    this.portalUrl = options.portalUrl ?? "https://www.arcgis.com";
    this.popup = options.popup ?? false;
    this.flowType = options.flowType ?? "auto";
    this.expiration =
      typeof options.expiration === "number" && Number.isFinite(options.expiration) ? options.expiration : undefined;
    this.authNamespace = options.authNamespace;
    this.preserveUrlHash = options.preserveUrlHash ?? false;
    this.watchListeners = new Map();
  }

  public async load(): Promise<OAuthInfoCompat> {
    if (this.loaded) {
      return this;
    }

    this.loadStatus = "loading";
    this.notifyWatchers("loadStatus", this.loadStatus);
    this.loaded = true;
    this.notifyWatchers("loaded", this.loaded);
    this.loadStatus = "loaded";
    this.notifyWatchers("loadStatus", this.loadStatus);
    return this;
  }

  public async when(callback?: (info: OAuthInfoCompat) => void): Promise<OAuthInfoCompat> {
    const info = await this.load();
    if (callback) {
      callback(info);
    }
    return info;
  }

  public watch(propertyName: string, listener: (value: unknown) => void): OAuthInfoHandleCompat {
    let listeners = this.watchListeners.get(propertyName);
    if (!listeners) {
      listeners = new Set();
      this.watchListeners.set(propertyName, listeners);
    }
    listeners.add(listener);

    return {
      remove: () => {
        listeners?.delete(listener);
      },
    };
  }

  public update(options: OAuthInfoCompatOptions): void {
    if (options.appId !== undefined) {
      this.appId = options.appId;
      this.notifyWatchers("appId", this.appId);
    }
    if (options.portalUrl !== undefined) {
      this.portalUrl = options.portalUrl;
      this.notifyWatchers("portalUrl", this.portalUrl);
    }
    if (options.popup !== undefined) {
      this.popup = options.popup;
      this.notifyWatchers("popup", this.popup);
    }
    if (options.flowType !== undefined) {
      this.flowType = options.flowType;
      this.notifyWatchers("flowType", this.flowType);
    }
    if (options.expiration !== undefined) {
      this.expiration =
        typeof options.expiration === "number" && Number.isFinite(options.expiration) ? options.expiration : undefined;
      this.notifyWatchers("expiration", this.expiration);
    }
    if (options.authNamespace !== undefined) {
      this.authNamespace = options.authNamespace;
      this.notifyWatchers("authNamespace", this.authNamespace);
    }
    if (options.preserveUrlHash !== undefined) {
      this.preserveUrlHash = options.preserveUrlHash;
      this.notifyWatchers("preserveUrlHash", this.preserveUrlHash);
    }
  }

  /**
   * Derive an {@link OAuth2Config} from this Esri-style OAuth info so it can back
   * a real `oauth2(...)` provider from `@honua/sdk-js/auth`. Endpoints default to
   * the ArcGIS Portal shape (`<portalUrl>/sharing/rest/oauth2/authorize` and
   * `/token`); pass explicit endpoints or a `redirectUri` via `overrides`.
   */
  public toOAuth2Config(overrides: OAuthInfoToConfigOptions = {}): OAuth2Config {
    const clientId = overrides.clientId ?? this.appId;
    if (!clientId) {
      throw new Error("OAuthInfoCompat.toOAuth2Config requires an appId (or an explicit clientId override).");
    }
    const redirectUri = overrides.redirectUri;
    if (!redirectUri) {
      throw new Error("OAuthInfoCompat.toOAuth2Config requires a redirectUri override.");
    }
    const portalBase = this.portalUrl.replace(/\/+$/, "");
    const { redirectUri: _redirectUri, clientId: _clientId, ...rest } = overrides;
    return {
      authorizationEndpoint: `${portalBase}/sharing/rest/oauth2/authorize`,
      tokenEndpoint: `${portalBase}/sharing/rest/oauth2/token`,
      clientId,
      redirectUri,
      mode: this.popup ? "popup" : "redirect",
      ...(this.expiration !== undefined ? { extraAuthorizationParams: { expiration: String(this.expiration) } } : {}),
      ...rest,
    };
  }

  public clone(): OAuthInfoCompat {
    return new OAuthInfoCompat(this.toJSON());
  }

  public toJSON(): OAuthInfoCompatOptions {
    return {
      appId: this.appId,
      portalUrl: this.portalUrl,
      popup: this.popup,
      flowType: this.flowType,
      expiration: this.expiration,
      authNamespace: this.authNamespace,
      preserveUrlHash: this.preserveUrlHash,
    };
  }

  public destroy(): void {
    this.watchListeners.clear();
  }

  private notifyWatchers(propertyName: string, value: unknown): void {
    const listeners = this.watchListeners.get(propertyName);
    if (!listeners) {
      return;
    }

    for (const listener of listeners) {
      safeInvokeCompatListener(listener, value);
    }
  }
}
