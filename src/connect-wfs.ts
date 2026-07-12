/** Internal WFS 2.0 metadata projection for connect(). */

import type { ConnectDiscoverySourceSnapshot, ConnectOptions } from "./connect.js";
import type { DiscoveryCacheIdentity, DiscoveryCapabilityEvidence, DiscoveryProvenance } from "./contract/discovery.js";
import { PROTOCOL_DEFAULT_CAPABILITIES, type SourceLocator } from "./contract/types.js";
import type { HonuaClient } from "./core/client.js";
import {
  HonuaAbortError,
  HonuaAuthError,
  HonuaDiscoveryError,
  HonuaHttpError,
  HonuaNetworkError,
  HonuaTimeoutError,
  HonuaWfsExceptionError,
} from "./core/errors.js";
import type { WfsCapabilitiesOperation, WfsCapabilitiesSnapshot } from "./core/wfs-capabilities.js";

const WFS_VERSION = "2.0.0";
const JSON_OUTPUT_FORMATS = new Set([
  "application/json",
  "application/geo+json",
  "application/vnd.geo+json",
  "json",
  "geojson",
]);

export interface WfsDiscoveryResult {
  readonly retrievedAt: string;
  readonly evidence: readonly DiscoveryCapabilityEvidence[];
  readonly sources: readonly ConnectDiscoverySourceSnapshot[];
}

export async function discoverWfsSources(
  client: HonuaClient,
  identity: DiscoveryCacheIdentity,
  options: ConnectOptions,
): Promise<WfsDiscoveryResult> {
  const root = client.wfs(identity.endpoint, { version: WFS_VERSION });
  if (options.refresh === true) root.refresh();
  let snapshot: WfsCapabilitiesSnapshot;
  try {
    snapshot = await root.capabilities(options.signal ? { signal: options.signal } : undefined);
  } catch (error) {
    if (
      error instanceof HonuaAbortError ||
      error instanceof HonuaAuthError ||
      error instanceof HonuaHttpError ||
      error instanceof HonuaNetworkError ||
      error instanceof HonuaTimeoutError ||
      error instanceof HonuaWfsExceptionError
    ) {
      throw error;
    }
    throw new HonuaDiscoveryError("invalid-endpoint", "WFS GetCapabilities metadata could not be parsed.", undefined, {
      cause: error,
    });
  }
  if (snapshot.version !== WFS_VERSION) {
    throw new HonuaDiscoveryError(
      "invalid-endpoint",
      `WFS discovery requires version ${WFS_VERSION}; received ${snapshot.version ?? "no version"}.`,
      { expectedVersion: WFS_VERSION, receivedVersion: snapshot.version },
    );
  }
  validateOperationUrls(snapshot, identity.endpoint);
  const featureTypes = selectFeatureTypes(snapshot, options.typeName);
  const retrievedAt = new Date().toISOString();
  const provenance: readonly DiscoveryProvenance[] = Object.freeze([
    Object.freeze({ source: identity.endpoint, retrievedAt }),
  ]);
  const getFeature = snapshot.operations.get("GetFeature");
  const hasQueryContract =
    getFeature?.methods.includes("GET") === true &&
    getFeature.methods.includes("POST") &&
    Boolean(getFeature.getUrl) &&
    Boolean(getFeature.postUrl) &&
    getFeature.outputFormats.some((format) => JSON_OUTPUT_FORMATS.has(format.toLowerCase()));
  const transaction = snapshot.operations.get("Transaction");
  const sources = featureTypes.map((featureType) => {
    const prefix = featureType.name.includes(":")
      ? featureType.name.slice(0, featureType.name.indexOf(":"))
      : undefined;
    const featureNamespace = prefix ? snapshot.namespaces.get(prefix) : undefined;
    const canEdit =
      transaction?.methods.includes("POST") === true && Boolean(transaction.postUrl) && featureNamespace !== undefined;
    const capabilities = [
      ...(hasQueryContract ? (["query", "stream"] as const) : []),
      ...(canEdit ? (["applyEdits"] as const) : []),
    ];
    const evidence: readonly DiscoveryCapabilityEvidence[] = Object.freeze([
      Object.freeze({
        kind: "metadata" as const,
        capabilities: Object.freeze(capabilities),
        scope: Object.freeze([...PROTOCOL_DEFAULT_CAPABILITIES.wfs]),
        provenance,
      }),
    ]);
    const locator: SourceLocator = Object.freeze({
      url: identity.endpoint,
      typeName: featureType.name,
      ...(featureNamespace ? { featureNamespace } : {}),
      ...(featureType.defaultCrs ? { srsName: featureType.defaultCrs } : {}),
    });
    return Object.freeze({
      id: featureType.name,
      locator,
      ...(featureType.title ? { title: featureType.title } : {}),
      ...(featureType.defaultCrs ? { crs: Object.freeze([featureType.defaultCrs]) } : {}),
      evidence,
    });
  });
  return Object.freeze({ retrievedAt, evidence: Object.freeze([]), sources: Object.freeze(sources) });
}

function selectFeatureTypes(
  snapshot: WfsCapabilitiesSnapshot,
  selectedTypeName: string | undefined,
): WfsCapabilitiesSnapshot["featureTypes"] {
  if (snapshot.featureTypes.length === 0) {
    throw new HonuaDiscoveryError("invalid-endpoint", "WFS GetCapabilities advertised no feature types.");
  }
  const names = new Set<string>();
  for (const featureType of snapshot.featureTypes) {
    if (!featureType.name || names.has(featureType.name)) {
      throw new HonuaDiscoveryError("invalid-endpoint", "WFS feature-type names must be unique non-empty strings.", {
        typeName: featureType.name,
      });
    }
    names.add(featureType.name);
  }
  if (!selectedTypeName) return snapshot.featureTypes;
  const selected = snapshot.featureTypes.find((featureType) => featureType.name === selectedTypeName);
  if (!selected) {
    throw new HonuaDiscoveryError("ambiguous-source", `WFS feature type "${selectedTypeName}" was not advertised.`, {
      typeName: selectedTypeName,
      sourceIds: snapshot.featureTypes.map((featureType) => featureType.name),
    });
  }
  return Object.freeze([selected]);
}

function validateOperationUrls(snapshot: WfsCapabilitiesSnapshot, endpoint: string): void {
  const endpointUrl = new URL(endpoint);
  for (const operation of snapshot.operations.values()) {
    validateOperationUrl(operation, operation.getUrl, endpointUrl, "GET");
    validateOperationUrl(operation, operation.postUrl, endpointUrl, "POST");
  }
}

function validateOperationUrl(
  operation: WfsCapabilitiesOperation,
  advertised: string | undefined,
  endpoint: URL,
  method: "GET" | "POST",
): void {
  if (!advertised) return;
  let resolved: URL;
  try {
    resolved = new URL(advertised, endpoint);
  } catch {
    throw new HonuaDiscoveryError("invalid-endpoint", `WFS ${operation.name} ${method} URL is invalid.`, {
      operation: operation.name,
      method,
    });
  }
  if (
    resolved.origin !== endpoint.origin ||
    resolved.username ||
    resolved.password ||
    resolved.hash ||
    resolved.search
  ) {
    throw new HonuaDiscoveryError(
      "invalid-endpoint",
      `WFS ${operation.name} ${method} URL must be same-origin and contain no credentials, query, or fragment.`,
      { operation: operation.name, method },
    );
  }
}
