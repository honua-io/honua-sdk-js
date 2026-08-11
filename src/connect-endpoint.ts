import { canonicalizeUrlQuery, hasCredentialQuery } from "./connect-url-safety.js";
import type { ConnectProtocolHint } from "./connect.js";
import type { HonuaClient } from "./core/client.js";
import { HonuaAbortError, HonuaDiscoveryError } from "./core/errors.js";

export function isPmtilesSchemeInput(input: string | URL): boolean {
  return input instanceof URL ? input.protocol.toLowerCase() === "pmtiles:" : /^pmtiles:\/\//i.test(input);
}

function connectEndpointText(input: string | URL): string {
  if (!(input instanceof URL) || input.protocol.toLowerCase() !== "pmtiles:") return input.toString();
  const nestedProtocol = input.hostname.toLowerCase();
  if (
    (nestedProtocol !== "http" && nestedProtocol !== "https") ||
    input.username ||
    input.password ||
    input.port ||
    !input.pathname.startsWith("//")
  ) {
    return input.toString();
  }
  return `pmtiles://${nestedProtocol}:${input.pathname}${input.search}${input.hash}`;
}

/** @internal Shared by the kernel authorization gate and focused protocol connectors. */
export function validateConnectEndpoint(input: string | URL, hint: ConnectProtocolHint = "auto"): string {
  let endpoint: URL;
  let raw = connectEndpointText(input);
  if (/^pmtiles:\/\//i.test(raw)) {
    if (hint !== "auto" && hint !== "pmtiles") {
      throw new HonuaDiscoveryError(
        "invalid-endpoint",
        'A "pmtiles://" asset marker is only valid with protocol "auto" or "pmtiles".',
        { protocol: hint, resolvedProtocol: "pmtiles" },
      );
    }
    raw = raw.slice("pmtiles://".length);
    if (/^pmtiles:\/\//i.test(raw)) {
      throw new HonuaDiscoveryError(
        "invalid-endpoint",
        "PMTiles asset URLs must contain exactly one pmtiles:// marker.",
      );
    }
  }
  try {
    endpoint = new URL(raw);
  } catch {
    throw new HonuaDiscoveryError("invalid-endpoint", "connect() endpoints must be absolute HTTP(S) URLs.");
  }
  if (endpoint.protocol !== "https:" && endpoint.protocol !== "http:") {
    throw new HonuaDiscoveryError("invalid-endpoint", "connect() endpoints must use HTTP or HTTPS.");
  }
  const formatQueryIsRemovable =
    endpoint.searchParams.size > 0 &&
    [...endpoint.searchParams].every(
      ([name, value]) =>
        (name.toLowerCase() === "f" || name.toLowerCase() === "format") &&
        (value.toLowerCase() === "json" || value.toLowerCase() === "pjson"),
    );
  const rasterServiceQueryIsAllowed = isWmsWmtsServiceQuery(endpoint, hint);
  if (
    endpoint.username ||
    endpoint.password ||
    hasCredentialQuery(endpoint.searchParams) ||
    (endpoint.search && !formatQueryIsRemovable && !rasterServiceQueryIsAllowed) ||
    endpoint.hash
  ) {
    throw new HonuaDiscoveryError(
      "invalid-endpoint",
      "connect() endpoints must not contain credentials, identity-bearing query parameters, or fragments; configure authentication through clientOptions.",
    );
  }
  if (formatQueryIsRemovable) endpoint.search = "";
  else if (rasterServiceQueryIsAllowed) canonicalizeUrlQuery(endpoint);
  while (endpoint.pathname.length > 1 && endpoint.pathname.endsWith("/")) {
    endpoint.pathname = endpoint.pathname.slice(0, -1);
  }
  const normalized = endpoint.toString();
  return normalized.endsWith("/") ? normalized.slice(0, -1) : normalized;
}

function isWmsWmtsServiceQuery(endpoint: URL, hint: ConnectProtocolHint): boolean {
  const params = endpoint.searchParams;
  if (params.size === 0 || (hint !== "auto" && hint !== "wms" && hint !== "wmts")) return false;
  const values = new Map<string, string>();
  for (const [rawName, rawValue] of params) {
    const name = rawName.toLowerCase();
    if (name === "service" || name === "request" || name === "version") {
      if (values.has(name)) return false;
      values.set(name, rawValue);
    }
  }
  const service = values.get("service")?.toLowerCase();
  if (service !== undefined && service !== "wms" && service !== "wmts") return false;
  const pathService = endpoint.pathname.split("/").filter(Boolean).at(-1)?.toLowerCase();
  const hintedService = hint === "wms" || hint === "wmts" ? hint : undefined;
  const structuralService = service === "wms" || service === "wmts" ? service : undefined;
  const endpointService = pathService === "wms" || pathService === "wmts" ? pathService : undefined;
  const protocol = structuralService ?? hintedService ?? endpointService;
  if (protocol !== "wms" && protocol !== "wmts") return false;
  if (structuralService && hintedService && structuralService !== hintedService) return false;
  if (endpointService && hintedService && endpointService !== hintedService) return false;
  const request = values.get("request")?.toLowerCase();
  if (request !== undefined && request !== "getcapabilities") return false;
  const version = values.get("version");
  return version === undefined || (protocol === "wms" ? version === "1.3.0" : version === "1.0.0");
}

export function assertClientEndpoint(client: HonuaClient, endpoint: string): void {
  const clientEndpoint = validateConnectEndpoint(client.serverBaseUrl);
  if (clientEndpoint !== endpoint) {
    throw new HonuaDiscoveryError(
      "invalid-endpoint",
      "The injected HonuaClient base URL must exactly match the connect() endpoint.",
      { endpoint, clientEndpoint },
    );
  }
}

export function awaitAbortable<T>(value: T | Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  const pending = Promise.resolve(value);
  if (!signal) return pending;
  if (signal.aborted) {
    void pending.catch(() => undefined);
    throw new HonuaAbortError();
  }
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", abort);
      callback();
    };
    const abort = () => finish(() => reject(new HonuaAbortError()));
    signal.addEventListener("abort", abort, { once: true });
    pending.then(
      (result) => finish(() => resolve(result)),
      (error: unknown) => finish(() => reject(error)),
    );
  });
}
