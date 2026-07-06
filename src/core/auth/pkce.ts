/**
 * PKCE (RFC 7636) primitives built exclusively on WebCrypto.
 *
 * `globalThis.crypto` (the WebCrypto API) is available in browsers and in
 * Node ≥20, so no `node:crypto` import — and therefore no bundler/runtime
 * branch — is needed. This keeps the auth flow dependency-free and identical
 * across environments.
 *
 * @packageDocumentation
 */

function requireWebCrypto(): Crypto {
  const cryptoRef = globalThis.crypto;
  if (!cryptoRef?.subtle) {
    throw new Error(
      "WebCrypto (globalThis.crypto.subtle) is unavailable. OAuth2 PKCE requires a browser or Node.js >= 20.",
    );
  }
  return cryptoRef;
}

/** Base64url-encode raw bytes (no padding), per RFC 7636 §A. */
function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  const base64 = typeof btoa === "function" ? btoa(binary) : Buffer.from(bytes).toString("base64");
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Cryptographically-random base64url string derived from `byteLength` bytes. */
function randomBase64Url(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  requireWebCrypto().getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

/**
 * A PKCE code verifier + its S256 challenge. The verifier is high-entropy
 * (32 random bytes → 43-char base64url string, within the RFC's 43–128 range);
 * the challenge is `BASE64URL(SHA-256(verifier))`.
 */
export interface PkcePair {
  codeVerifier: string;
  codeChallenge: string;
  codeChallengeMethod: "S256";
}

/** Create a fresh PKCE verifier/challenge pair using SHA-256 (S256). */
export async function createPkcePair(): Promise<PkcePair> {
  const codeVerifier = randomBase64Url(32);
  const digest = await requireWebCrypto().subtle.digest("SHA-256", new TextEncoder().encode(codeVerifier));
  return {
    codeVerifier,
    codeChallenge: base64UrlEncode(new Uint8Array(digest)),
    codeChallengeMethod: "S256",
  };
}

/** Random, unguessable `state` value for CSRF protection on the redirect. */
export function createStateToken(): string {
  return randomBase64Url(16);
}
