import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";

export function mcpArtifact(version = "0.1.16", peer = "^0.1.15", name = "@honua/mcp-server") {
  const manifest = { name, version, peerDependencies: peer === undefined ? {} : { "@honua/sdk-js": peer } };
  const raw = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  const header = Buffer.alloc(512);
  header.write("package/package.json", 0);
  header.write("0000644\0", 100);
  header.write("0000000\0", 108);
  header.write("0000000\0", 116);
  header.write(`${raw.length.toString(8).padStart(11, "0")}\0`, 124);
  header.write("00000000000\0", 136);
  header.fill(32, 148, 156);
  header.write("0", 156);
  header.write("ustar\0", 257);
  header.write("00", 263);
  const sum = header.reduce((total, value) => total + value, 0);
  header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
  const bytes = gzipSync(Buffer.concat([header, raw, Buffer.alloc((512 - raw.length % 512) % 512), Buffer.alloc(1024)]));
  const integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
  return { bytes, manifest, integrity, packageJsonSha256: createHash("sha256").update(raw).digest("hex"),
    tarball: `https://registry.npmjs.org/@honua/mcp-server/-/mcp-server-${version}.tgz` };
}
