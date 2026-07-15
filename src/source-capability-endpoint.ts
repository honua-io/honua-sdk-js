import { PROTOCOLS } from "./contract/types.js";
import { canonicalStringify, sha256, toJsonValue } from "./query-planner/canonical.js";
import { assertPlainCapabilityObject, snapshotCapabilityJson } from "./source-capability-json.js";
import {
  assertNoObviousCapabilityCredential,
  validateCapabilityEvidenceReference,
} from "./source-capability-security.js";
import {
  CAPABILITY_SOURCE_ENDPOINT_FINGERPRINT_DOMAIN,
  type CapabilitySourceEndpointIdentity,
  type Sha256,
} from "./source-capability-types.js";

const ENDPOINT_IDENTITY_JSON_LIMITS = { depth: 2, nodes: 8, bytes: 4_096 } as const;
const MAX_ENDPOINT_LENGTH = 2_048;
const MAX_PROTOCOL_LENGTH = 256;
const EXTENSION_ID_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9_-]*\.)+[A-Za-z0-9][A-Za-z0-9_-]*$/;

/**
 * Derive a credential-free, domain-separated endpoint digest. The raw endpoint
 * and source discriminator never enter capability transport or diagnostics.
 */
export function createCapabilitySourceEndpointFingerprint(identity: CapabilitySourceEndpointIdentity): Sha256 {
  const safeIdentity = snapshotCapabilityJson(
    identity,
    "Capability source endpoint identity",
    ENDPOINT_IDENTITY_JSON_LIMITS,
  ) as CapabilitySourceEndpointIdentity;
  assertPlainCapabilityObject(safeIdentity, "Capability source endpoint identity", [
    "endpoint",
    "protocol",
    "sourceId",
  ]);
  const endpoint = normalizeCredentialFreeEndpoint(safeIdentity.endpoint);
  if (
    typeof safeIdentity.protocol !== "string" ||
    safeIdentity.protocol.length > MAX_PROTOCOL_LENGTH ||
    (!(PROTOCOLS as readonly string[]).includes(safeIdentity.protocol) &&
      !EXTENSION_ID_PATTERN.test(safeIdentity.protocol))
  ) {
    throw new TypeError("Capability source endpoint identity.protocol must be a known protocol or extension id");
  }
  if (safeIdentity.sourceId !== undefined) {
    validateCapabilityEvidenceReference(safeIdentity.sourceId, "Capability source endpoint identity.sourceId");
  }
  const projection = {
    kind: "honua.capability-source-endpoint",
    version: "1.0",
    endpoint,
    protocol: safeIdentity.protocol,
    ...(safeIdentity.sourceId === undefined ? {} : { sourceId: safeIdentity.sourceId }),
  };
  return sha256(
    `${CAPABILITY_SOURCE_ENDPOINT_FINGERPRINT_DOMAIN}\n${canonicalStringify(toJsonValue(projection))}`,
  ) as Sha256;
}

function normalizeCredentialFreeEndpoint(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_ENDPOINT_LENGTH ||
    value.trim() !== value ||
    hasForbiddenEndpointCharacter(value)
  ) {
    throw new TypeError("Capability source endpoint identity.endpoint must be a bounded absolute HTTP(S) URL");
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new TypeError("Capability source endpoint identity.endpoint must be a bounded absolute HTTP(S) URL");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new TypeError("Capability source endpoint identity.endpoint must use HTTP(S)");
  }
  if (parsed.username.length > 0 || parsed.password.length > 0) {
    throw new TypeError("Capability source endpoint identity.endpoint must not contain URL credentials");
  }
  // Capability identity is the stable service/resource root. Query material is
  // neither necessary nor safe: it can contain signed URLs or opaque tokens.
  if (parsed.href.includes("?") || parsed.href.includes("#")) {
    throw new TypeError("Capability source endpoint identity.endpoint must not contain query or fragment data");
  }
  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(parsed.pathname);
  } catch {
    throw new TypeError("Capability source endpoint identity.endpoint path must use valid percent encoding");
  }
  assertNoObviousCapabilityCredential(value, "Capability source endpoint identity.endpoint");
  assertNoObviousCapabilityCredential(decodedPath, "Capability source endpoint identity.endpoint path");
  parsed.pathname = parsed.pathname.replaceAll(/%[0-9a-f]{2}/gi, (sequence) => {
    const character = String.fromCharCode(Number.parseInt(sequence.slice(1), 16));
    return /^[A-Za-z0-9._~-]$/.test(character) ? character : sequence.toUpperCase();
  });
  while (parsed.pathname.length > 1 && parsed.pathname.endsWith("/")) {
    parsed.pathname = parsed.pathname.slice(0, -1);
  }
  return parsed.toString();
}

function hasForbiddenEndpointCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f || value[index] === "\\") return true;
  }
  return false;
}
