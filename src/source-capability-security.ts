const MAX_PEER_IDENTIFIER_LENGTH = 214;
const MAX_SCOPE_IDENTIFIER_LENGTH = 128;
const MAX_REFERENCE_LENGTH = 256;
const PEER_IDENTIFIER_PATTERN = /^(?:[a-z0-9][a-z0-9._-]*|@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*)$/;
const SCOPE_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*(?:(?::|\/)[A-Za-z0-9][A-Za-z0-9._-]*)*$/;
const OBVIOUS_AUTHORIZATION_PATTERN = /\b(?:bearer|basic)\s+[A-Za-z0-9+/_.=-]+/i;
const SENSITIVE_ASSIGNMENT_PATTERN =
  /(?:^|[\s?&#;,])(?:authorization|access[_-]?token|refresh[_-]?token|id[_-]?token|api[_-]?key|client[_-]?secret|password|passwd|credential|signature|sig)=/i;
const SENSITIVE_WORD_PATTERN = /(?:^|[^a-z0-9])(?:secret|password|passwd|credential|private[_-]?key)(?:$|[^a-z0-9])/i;
const PRIVATE_KEY_PATTERN = /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/;
const JWT_PATTERN = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/;
const AWS_ACCESS_KEY_PATTERN = /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/;
const SENSITIVE_EXTENSION_KEYS = [
  "authorization",
  "proxyauthorization",
  "cookie",
  "setcookie",
  "token",
  "accesstoken",
  "refreshtoken",
  "idtoken",
  "apikey",
  "clientsecret",
  "password",
  "passwd",
  "secret",
  "credential",
  "credentials",
  "privatekey",
  "signature",
  "signedurl",
  "sas",
  "prototype",
  "constructor",
] as const;

/** Validate an evidence locator/label and reject common credential-bearing forms. */
export function validateCapabilityEvidenceReference(value: unknown, path: string): asserts value is string {
  validateBoundedText(value, path, MAX_REFERENCE_LENGTH);
  assertNoObviousCredential(value, path);
  if (!/^[\x20-\x7e]+$/.test(value)) {
    throw new TypeError(`${path} must contain printable ASCII only`);
  }
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(value) || value.includes("?") || value.includes("#")) {
    throw new TypeError(`${path} must be a stable evidence identity, not a raw or parameterized URL`);
  }
}

/** Validate a package/runtime peer identity, not an installed credential value. */
export function validateCapabilityPeerIdentifier(value: unknown, path: string): asserts value is string {
  validateBoundedText(value, path, MAX_PEER_IDENTIFIER_LENGTH);
  if (!PEER_IDENTIFIER_PATTERN.test(value)) {
    throw new TypeError(`${path} must be a structural package or runtime peer identifier`);
  }
  assertNoObviousCredential(value, path);
}

/** Validate an authorization scope name, not a token or authorization header. */
export function validateCapabilityScopeIdentifier(value: unknown, path: string): asserts value is string {
  validateBoundedText(value, path, MAX_SCOPE_IDENTIFIER_LENGTH);
  if (!SCOPE_IDENTIFIER_PATTERN.test(value)) {
    throw new TypeError(`${path} must be a structural authorization scope identifier`);
  }
  assertNoObviousCredential(value, path);
}

/** Reject credential-shaped keys and values anywhere inside extension metadata. */
export function assertNoSensitiveCapabilityExtension(value: unknown, path: string): void {
  const stack: Array<{ readonly value: unknown; readonly path: string }> = [{ value, path }];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (typeof current.value === "string") {
      assertNoObviousCredential(current.value, current.path);
      continue;
    }
    if (current.value === null || typeof current.value !== "object") continue;
    if (Array.isArray(current.value)) {
      for (let index = 0; index < current.value.length; index++) {
        stack.push({ value: current.value[index], path: `${current.path}[${index}]` });
      }
      continue;
    }
    for (const [key, child] of Object.entries(current.value)) {
      const normalizedKey = key.toLowerCase().replaceAll(/[^a-z0-9]/g, "");
      if (key === "__proto__" || SENSITIVE_EXTENSION_KEYS.includes(normalizedKey as never)) {
        throw new TypeError(`${current.path} contains a credential-sensitive extension key`);
      }
      // Do not echo caller-controlled metadata keys if a descendant is rejected.
      stack.push({ value: child, path: `${current.path} member` });
    }
  }
}

function assertNoObviousCredential(value: string, path: string): void {
  if (
    OBVIOUS_AUTHORIZATION_PATTERN.test(value) ||
    SENSITIVE_ASSIGNMENT_PATTERN.test(value) ||
    SENSITIVE_WORD_PATTERN.test(value) ||
    PRIVATE_KEY_PATTERN.test(value) ||
    JWT_PATTERN.test(value) ||
    AWS_ACCESS_KEY_PATTERN.test(value)
  ) {
    throw new TypeError(`${path} must not contain credential-shaped data`);
  }
}

function validateBoundedText(value: unknown, path: string, maximum: number): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum) {
    throw new TypeError(`${path} must be non-empty bounded text`);
  }
  if (value.trim() !== value) throw new TypeError(`${path} must not contain leading or trailing whitespace`);
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) throw new TypeError(`${path} must not contain control characters`);
  }
}
