import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const MCP_PEER_RECEIPT_PATH = "config/mcp-pinned-peer.v1.json";
const SCHEMA = "honua.mcp-pinned-peer/v1";
const REGISTRY = "https://registry.npmjs.org";
const LIMIT = 32 * 1024 * 1024;

function invariant(value, message) {
  if (!value) throw new Error(message);
}

async function boundedBytes(response) {
  invariant(response.ok && response.body, `MCP tarball request failed with HTTP ${response.status}`);
  const declared = Number(response.headers.get("content-length"));
  invariant(!Number.isFinite(declared) || declared <= LIMIT, "MCP tarball exceeds the byte limit");
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      invariant(length <= LIMIT, "MCP tarball exceeds the byte limit");
      chunks.push(Buffer.from(value));
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
  return Buffer.concat(chunks);
}

/** Read only package/package.json, never extract registry files into the workspace. */
export function peerReceiptFromTarball({ name, version, integrity, tarball, peerDependencies }, bytes) {
  invariant(bytes.length <= LIMIT, "MCP tarball exceeds the byte limit");
  invariant(/^sha512-[A-Za-z0-9+/]{86}==$/.test(integrity), "MCP tarball requires exact SHA512 integrity");
  invariant(`sha512-${createHash("sha512").update(bytes).digest("base64")}` === integrity,
    "MCP tarball bytes do not match the recorded integrity");
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "honua-mcp-peer-"));
  let raw;
  try {
    const file = path.join(temp, "package.tgz");
    fs.writeFileSync(file, bytes);
    raw = execFileSync("tar", ["-xzOf", file, "package/package.json"], {
      encoding: "utf8", timeout: 30_000, maxBuffer: 256 * 1024,
    });
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
  const packaged = JSON.parse(raw);
  invariant(packaged.name === name && packaged.version === version, "MCP tarball package identity mismatch");
  const sdkPeerRange = packaged.peerDependencies?.["@honua/sdk-js"];
  invariant(typeof sdkPeerRange === "string" && sdkPeerRange.length > 0, "MCP tarball must declare the SDK peer");
  invariant(sdkPeerRange === peerDependencies?.["@honua/sdk-js"],
    "MCP registry peer differs from the integrity-verified tarball package.json");
  return {
    schema: SCHEMA,
    pin: `${name}@${version}`,
    integrity,
    tarball,
    packageJsonSha256: createHash("sha256").update(raw).digest("hex"),
    sdkPeerRange,
  };
}

/** Fetch without redirects or inherited credentials and bind the peer to verified package bytes. */
export async function verifyMcpPeerArtifact(manifest, { fetchFn = fetch } = {}) {
  const url = new URL(manifest.tarball);
  invariant(url.origin === REGISTRY && !url.username && !url.password && !url.search && !url.hash,
    "MCP tarball must use the public npm registry without credentials or redirects");
  const response = await fetchFn(url.href, { redirect: "error", signal: AbortSignal.timeout(30_000) });
  return peerReceiptFromTarball(manifest, await boundedBytes(response));
}

/** Offline identity binding only; the live lane rechecks the actual public tarball. */
export function verifyRecordedMcpPeer(receipt, { pin, integrity }) {
  invariant(receipt?.schema === SCHEMA && receipt.pin === pin && receipt.integrity === integrity,
    "MCP peer receipt must match the exact generated pin and integrity; run canonical sync:mcp-pin");
  invariant(/^sha512-[A-Za-z0-9+/]{86}==$/.test(receipt.integrity) &&
    /^[0-9a-f]{64}$/.test(receipt.packageJsonSha256) &&
    typeof receipt.sdkPeerRange === "string" && receipt.sdkPeerRange.length > 0,
    "MCP peer receipt requires integrity-verified package metadata");
  return receipt.sdkPeerRange;
}
