#!/usr/bin/env node

import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MANIFEST_NAME = "sample-bundles.v2.json";
const SHA256 = /^[0-9a-f]{64}$/u;
const COMMIT = /^[0-9a-f]{40}$/u;
const CONTROL = /[\0-\x1f\x7f]/u;

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function compareUtf8(left, right) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

const CRC32_TABLE = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1)
    value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes)
    value = CRC32_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

/**
 * Emit the one canonical gzip representation used by immutable sample bundles.
 * Its DEFLATE payload is a sequence of maximum-size stored blocks. This avoids
 * zlib-version heuristics entirely while retaining a standards-compliant gzip
 * stream whose bytes can be reproduced independently in the privileged job.
 */
export function canonicalGzip(bytes) {
  invariant(Buffer.isBuffer(bytes), "canonical gzip input must be bytes");
  const blocks = [];
  if (bytes.length === 0) blocks.push(Buffer.from([1, 0, 0, 0xff, 0xff]));
  for (let offset = 0; offset < bytes.length; offset += 65_535) {
    const length = Math.min(65_535, bytes.length - offset);
    const block = Buffer.alloc(5 + length);
    block[0] = offset + length === bytes.length ? 1 : 0;
    block.writeUInt16LE(length, 1);
    block.writeUInt16LE(0xffff ^ length, 3);
    bytes.copy(block, 5, offset, offset + length);
    blocks.push(block);
  }
  const trailer = Buffer.alloc(8);
  trailer.writeUInt32LE(crc32(bytes), 0);
  trailer.writeUInt32LE(bytes.length >>> 0, 4);
  return Buffer.concat([
    Buffer.from([0x1f, 0x8b, 0x08, 0, 0, 0, 0, 0, 0, 3]),
    ...blocks,
    trailer,
  ]);
}

function safeArchivePath(value) {
  invariant(
    typeof value === "string" && value.length > 0,
    "archive path is empty",
  );
  invariant(
    !CONTROL.test(value),
    `archive path contains a control character: ${JSON.stringify(value)}`,
  );
  invariant(
    !value.includes("\\"),
    `archive path contains a backslash: ${value}`,
  );
  invariant(
    !value.startsWith("/") && !/^[A-Za-z]:/u.test(value),
    `archive path is absolute: ${value}`,
  );
  const parts = value.split("/");
  invariant(
    parts.every((part) => part && part !== "." && part !== ".."),
    `archive path traverses: ${value}`,
  );
  return value;
}

function parseArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    invariant(
      key?.startsWith("--") && value !== undefined,
      `invalid argument sequence at ${key ?? "end"}`,
    );
    invariant(!values.has(key.slice(2)), `duplicate argument ${key}`);
    values.set(key.slice(2), value);
  }
  return values;
}

function required(values, name) {
  const value = values.get(name);
  invariant(value, `--${name} is required`);
  return value;
}

function sameIdentity(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

/**
 * Capture one immutable byte snapshot. The path is opened once with no-follow,
 * the same handle supplies both fstats and all bytes, and the pathname is
 * checked after the read so rename/symlink/type swaps fail rather than silently
 * changing the packed object.
 */
export async function snapshotRegularFile(filePath, { afterOpen } = {}) {
  const noFollow = constants.O_NOFOLLOW ?? 0;
  const handle = await open(filePath, constants.O_RDONLY | noFollow);
  try {
    const before = await handle.stat({ bigint: true });
    invariant(
      before.isFile(),
      `bundle member is not a regular file: ${filePath}`,
    );
    invariant(
      before.size >= 0n && before.size <= BigInt(Number.MAX_SAFE_INTEGER),
      `bundle member is too large: ${filePath}`,
    );
    if (afterOpen) await afterOpen({ filePath, handle, before });

    const bytes = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(
        bytes,
        offset,
        bytes.length - offset,
        offset,
      );
      invariant(
        bytesRead > 0,
        `bundle member changed size while reading: ${filePath}`,
      );
      offset += bytesRead;
    }
    const extra = Buffer.alloc(1);
    const { bytesRead: extraBytes } = await handle.read(extra, 0, 1, offset);
    invariant(
      extraBytes === 0,
      `bundle member grew while reading: ${filePath}`,
    );

    const after = await handle.stat({ bigint: true });
    invariant(
      after.isFile() && sameIdentity(before, after),
      `bundle member identity changed while reading: ${filePath}`,
    );
    const pathname = await lstat(filePath, { bigint: true });
    invariant(
      pathname.isFile() && sameIdentity(after, pathname),
      `bundle member pathname was replaced while reading: ${filePath}`,
    );
    return bytes;
  } finally {
    await handle.close();
  }
}

function exactKeys(value, expected, label) {
  invariant(
    value && typeof value === "object" && !Array.isArray(value),
    `${label} must be an object`,
  );
  invariant(
    JSON.stringify(Object.keys(value).sort()) ===
      JSON.stringify([...expected].sort()),
    `${label} keyset drifted`,
  );
}

function manifestMembers(manifest) {
  exactKeys(
    manifest,
    ["format", "schemaVersion", "build", "samples", "excluded"],
    "manifest",
  );
  invariant(
    manifest.format === "honua.sdk.sample-bundles.v2" &&
      manifest.schemaVersion === 2,
    "manifest identity drifted",
  );
  invariant(
    Array.isArray(manifest.samples) && manifest.samples.length > 0,
    "manifest has no samples",
  );
  const files = new Map();
  for (const sample of manifest.samples) {
    invariant(
      typeof sample?.id === "string" &&
        /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(sample.id),
      "manifest sample id is invalid",
    );
    invariant(
      Array.isArray(sample.files) && sample.files.length > 0,
      `${sample.id}: manifest has no files`,
    );
    for (const file of sample.files) {
      invariant(
        typeof file?.path === "string" &&
          Number.isSafeInteger(file.bytes) &&
          file.bytes >= 0,
        `${sample.id}: file record is invalid`,
      );
      invariant(
        SHA256.test(file.sha256),
        `${sample.id}/${file.path}: SHA-256 is invalid`,
      );
      const archivePath = safeArchivePath(`${sample.id}/${file.path}`);
      invariant(
        !files.has(archivePath),
        `duplicate manifest path: ${archivePath}`,
      );
      files.set(archivePath, { bytes: file.bytes, sha256: file.sha256 });
    }
  }
  return files;
}

function splitUstarPath(value) {
  const bytes = Buffer.byteLength(value);
  if (bytes <= 100) return { name: value, prefix: "" };
  const separators = [...value.matchAll(/\//gu)].map((match) => match.index);
  for (let index = separators.length - 1; index >= 0; index -= 1) {
    const prefix = value.slice(0, separators[index]);
    const name = value.slice(separators[index] + 1);
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100)
      return { name, prefix };
  }
  throw new Error(`archive path cannot be represented as ustar: ${value}`);
}

function putString(header, offset, length, value) {
  const bytes = Buffer.from(value, "utf8");
  invariant(bytes.length <= length, `ustar field overflow: ${value}`);
  bytes.copy(header, offset);
}

function putOctal(header, offset, length, value) {
  invariant(
    Number.isSafeInteger(value) && value >= 0,
    `invalid ustar numeric value: ${value}`,
  );
  const encoded = value.toString(8).padStart(length - 1, "0");
  invariant(
    encoded.length === length - 1,
    `ustar numeric field overflow: ${value}`,
  );
  putString(header, offset, length - 1, encoded);
  header[offset + length - 1] = 0;
}

function tarHeader({ archivePath, type, size, mode, mtime }) {
  const { name, prefix } = splitUstarPath(
    type === "5" ? archivePath.slice(0, -1) : archivePath,
  );
  const header = Buffer.alloc(512);
  putString(header, 0, 100, name);
  putOctal(header, 100, 8, mode);
  putOctal(header, 108, 8, 0);
  putOctal(header, 116, 8, 0);
  putOctal(header, 124, 12, size);
  putOctal(header, 136, 12, mtime);
  header.fill(0x20, 148, 156);
  header[156] = type.charCodeAt(0);
  putString(header, 257, 6, "ustar");
  putString(header, 263, 2, "00");
  putOctal(header, 329, 8, 0);
  putOctal(header, 337, 8, 0);
  putString(header, 345, 155, prefix);
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  const encoded = checksum.toString(8).padStart(6, "0");
  putString(header, 148, 6, encoded);
  header[154] = 0;
  header[155] = 0x20;
  return header;
}

function parentDirectories(filePaths) {
  const directories = new Set();
  for (const filePath of filePaths) {
    const parts = filePath.split("/");
    for (let index = 1; index < parts.length; index += 1)
      directories.add(`${parts.slice(0, index).join("/")}/`);
  }
  return directories;
}

function createTar(entries, mtime) {
  const blocks = [];
  for (const entry of entries) {
    blocks.push(
      tarHeader({
        archivePath: entry.path,
        type: entry.type,
        size: entry.bytes?.length ?? 0,
        mode: entry.type === "5" ? 0o755 : 0o644,
        mtime,
      }),
    );
    if (entry.type === "0") {
      blocks.push(entry.bytes);
      const remainder = entry.bytes.length % 512;
      if (remainder !== 0) blocks.push(Buffer.alloc(512 - remainder));
    }
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

export async function pack({
  bundleRoot,
  output,
  sourceCommit,
  sourceDateEpoch,
  afterOpen,
}) {
  invariant(
    COMMIT.test(sourceCommit),
    "source commit must be a full lowercase Git SHA",
  );
  const mtime = Number(sourceDateEpoch);
  invariant(
    Number.isSafeInteger(mtime) && mtime > 0,
    "source date epoch must be a positive integer",
  );

  const manifestPath = path.join(bundleRoot, MANIFEST_NAME);
  const manifestBytes = await snapshotRegularFile(manifestPath, { afterOpen });
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  const expected = manifestMembers(manifest);
  invariant(
    manifest.samples.every(
      (sample) => sample.builtFrom?.commit === sourceCommit,
    ),
    "manifest source commit drifted",
  );

  const files = new Map([[MANIFEST_NAME, manifestBytes]]);
  for (const [archivePath, record] of [...expected].sort(([left], [right]) =>
    compareUtf8(left, right),
  )) {
    const bytes = await snapshotRegularFile(
      path.join(bundleRoot, ...archivePath.split("/")),
      { afterOpen },
    );
    invariant(
      bytes.length === record.bytes,
      `${archivePath}: byte count drifted from manifest`,
    );
    invariant(
      sha256(bytes) === record.sha256,
      `${archivePath}: SHA-256 drifted from manifest`,
    );
    files.set(archivePath, bytes);
  }

  const entries = [
    ...[...parentDirectories(files.keys())].map((entryPath) => ({
      path: entryPath,
      type: "5",
    })),
    ...[...files].map(([entryPath, bytes]) => ({
      path: entryPath,
      type: "0",
      bytes,
    })),
  ].sort((left, right) => compareUtf8(left.path, right.path));
  const tar = createTar(entries, mtime);
  const archive = canonicalGzip(tar);
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, archive, { flag: "wx", mode: 0o644 });
  return {
    schema: "honua.sdk.sample-bundle-pack.v1",
    sourceCommit,
    sourceDateEpoch: mtime,
    manifestSha256: sha256(manifestBytes),
    archiveSha256: sha256(archive),
    archiveBytes: archive.length,
    fileCount: files.size,
    memberCount: entries.length,
  };
}

async function main() {
  const args = parseArguments(process.argv.slice(2));
  const result = await pack({
    bundleRoot: path.resolve(required(args, "bundle-root")),
    output: path.resolve(required(args, "output")),
    sourceCommit: required(args, "source-commit"),
    sourceDateEpoch: required(args, "source-date-epoch"),
  });
  const metadata = args.get("metadata");
  if (metadata)
    await writeFile(
      path.resolve(metadata),
      `${JSON.stringify(result, null, 2)}\n`,
      { flag: "wx", mode: 0o644 },
    );
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
) {
  main().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
