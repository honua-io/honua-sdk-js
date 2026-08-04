import { HonuaOfflineRegionError } from "./types.js";

/**
 * Deterministic identity primitives shared by every offline module.
 *
 * Manifest identity, snapshot resource identity, and the read path all have to
 * agree byte-for-byte on what "the same selection" means, so the canonical
 * serialization and the digest live in one module rather than being reimplemented
 * per layer. Nothing here reads storage or accepts a request URL.
 */

const encoder = new TextEncoder();

/** Code-unit ordering, the deterministic sort used by every persisted identity. */
export function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Serialize `value` with sorted own keys and no `undefined` members.
 *
 * The output is the digest pre-image for region and resource identity, so it is
 * deliberately strict: an `undefined` anywhere would silently disappear from the
 * identity and let two different selections collide.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) {
      throw new HonuaOfflineRegionError("invalid-manifest", "Offline identity cannot contain undefined values.", {
        path: "identity",
      });
    }
    return encoded;
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries: Array<readonly [string, unknown]> = [];
  for (const key in value as Record<string, unknown>) {
    if (Object.hasOwn(value as object, key)) entries.push([key, (value as Record<string, unknown>)[key]]);
  }
  entries.sort(([left], [right]) => compareCodeUnits(left, right));
  return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`).join(",")}}`;
}

/** Portable Web Crypto SHA-256 over UTF-8 text or raw bytes. */
export async function sha256(value: string | Uint8Array): Promise<`sha256:${string}`> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new HonuaOfflineRegionError(
      "invalid-manifest",
      "Offline region identity and integrity require Web Crypto SHA-256.",
      { path: "crypto" },
    );
  }
  const bytes = typeof value === "string" ? encoder.encode(value) : value;
  const digestInput: BufferSource =
    bytes.buffer instanceof ArrayBuffer
      ? (bytes as unknown as BufferSource)
      : (Uint8Array.from(bytes) as unknown as BufferSource);
  const digest = await subtle.digest("SHA-256", digestInput);
  return `sha256:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

/** Domain-separated digest of a canonical identity object. */
export async function identityDigest(namespace: string, value: unknown): Promise<`sha256:${string}`> {
  return sha256(`${namespace}:v1:${canonicalJson(value)}`);
}
