import type { HonuaRequestInterceptor } from "../core/types.js";
import { type ClientRequestInterceptorCompat, createClientRequestInterceptors } from "./request.js";

export interface ClientConfigRequestCompat {
  timeout: number;
  useIdentity: boolean;
  trustedServers: string[];
  interceptors: ClientRequestInterceptorCompat[];
}

export interface ClientConfigCompat {
  apiKey: string | undefined;
  portalUrl: string;
  request: ClientConfigRequestCompat;
}

const DEFAULT_PORTAL_URL = "https://www.arcgis.com";

export const clientConfig: ClientConfigCompat = {
  apiKey: undefined,
  portalUrl: DEFAULT_PORTAL_URL,
  request: {
    timeout: 62_000,
    useIdentity: true,
    trustedServers: [],
    interceptors: [],
  },
};

export function resetClientConfig(): void {
  clientConfig.apiKey = undefined;
  clientConfig.portalUrl = DEFAULT_PORTAL_URL;
  clientConfig.request.timeout = 62_000;
  clientConfig.request.useIdentity = true;
  clientConfig.request.trustedServers.length = 0;
  clientConfig.request.interceptors.length = 0;
}

export function getClientConfigHonuaInterceptors(): HonuaRequestInterceptor[] {
  return createClientRequestInterceptors(clientConfig.request.interceptors);
}

/**
 * Whether a credential (portal token or API key) may be attached to requests
 * for `url`. Credentials go only to `ownOrigin` (the origin they were issued
 * for) or to a server listed in `clientConfig.request.trustedServers`. An entry
 * with a scheme (`https://gis.example.com`) matches that origin; a bare entry
 * (`gis.example.com` or `gis.example.com:8443`) matches that host over https
 * only, so trusting a plain-http server takes an explicit `http://` entry.
 */
export function isCredentialTargetTrusted(url: string, ownOrigin?: string): boolean {
  const target = parseUrl(url);
  if (!target) {
    return false;
  }
  if (ownOrigin !== undefined && parseUrl(ownOrigin)?.origin === target.origin) {
    return true;
  }
  return clientConfig.request.trustedServers.some((entry) => trustedEntryMatches(entry, target));
}

function trustedEntryMatches(entry: string, target: URL): boolean {
  const trimmed = entry.trim();
  if (trimmed.length === 0) {
    return false;
  }
  if (trimmed.includes("://")) {
    return parseUrl(trimmed)?.origin === target.origin;
  }
  return target.protocol === "https:" && trimmed.toLowerCase() === target.host.toLowerCase();
}

/** Whether `url` is an https URL on `arcgis.com` or one of its subdomains. */
export function isArcGisHostedUrl(url: string): boolean {
  const parsed = parseUrl(url);
  if (!parsed) {
    return false;
  }
  const host = parsed.hostname.toLowerCase();
  return parsed.protocol === "https:" && (host === "arcgis.com" || host.endsWith(".arcgis.com"));
}

function parseUrl(value: string): URL | undefined {
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}
