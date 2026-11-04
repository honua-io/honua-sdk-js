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
