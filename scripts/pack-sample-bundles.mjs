import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync } from 'node:zlib';

const BLOCK_SIZE = 512;
const MANIFEST_NAME = 'sample-bundles.v2.json';

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function comparePaths(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function portableRelativePath(value, label) {
  invariant(typeof value === 'string' && value.length > 0, `${label} must be a string`);
  invariant(!value.includes('\\'), `${label} must use POSIX separators: ${value}`);
  invariant(!value.startsWith('/') && !/^[A-Za-z]:/.test(value), `${label} must be relative`);
  const normalized = path.posix.normalize(value);
  invariant(normalized === value, `${label} is not normalized: ${value}`);
  invariant(!normalized.split('/').includes('..'), `${label} escapes the bundle root: ${value}`);
  invariant(!normalized.includes('\0'), `${label} contains a NUL byte`);
  return normalized;
}

export function manifestSourceRevision(manifest) {
  const explicitRevision =
    manifest.sourceRevision ??
    manifest.source?.commit ??
    manifest.sdk?.commit ??
    manifest.builtFrom?.commit;
  const sampleRevisions = new Set(
    (manifest.samples ?? []).map((sample) => sample.builtFrom?.commit).filter(Boolean),
  );
  if (explicitRevision) {
    return sampleRevisions.size === 0 ||
      (sampleRevisions.size === 1 && sampleRevisions.has(explicitRevision))
      ? explicitRevision
      : undefined;
  }
  return sampleRevisions.size === 1 ? [...sampleRevisions][0] : undefined;
}

export function manifestLockfileSha256(manifest) {
  return (
    manifest.lockfileSha256 ??
    manifest.source?.lockfileSha256 ??
    manifest.sdk?.lockfileSha256 ??
    manifest.builtFrom?.lockfileSha256 ??
    manifest.build?.lockfileSha256
  );
}

function sampleFiles(sample) {
  const entries = sample.files ?? sample.assets ?? sample.outputFiles;
  invariant(Array.isArray(entries), `Manifest sample ${sample.id ?? '<unknown>'} has no file list`);
  return entries;
}

function declaredFile(entry, sampleId) {
  if (typeof entry === 'string') {
    return { path: portableRelativePath(entry, `File in ${sampleId}`), sha256: null };
  }
  invariant(entry && typeof entry === 'object', `Invalid file declaration in ${sampleId}`);
  const relativePath = entry.path ?? entry.relativePath ?? entry.file;
  const sha256 = entry.sha256 ?? entry.digest?.sha256 ?? null;
  invariant(
    sha256 === null || /^[a-f0-9]{64}$/.test(sha256),
    `Invalid SHA-256 for ${sampleId}/${relativePath}`,
  );
  return { path: portableRelativePath(relativePath, `File in ${sampleId}`), sha256 };
}

export function declaredBundleFiles(manifest) {
  invariant(Array.isArray(manifest.samples) && manifest.samples.length > 0, 'Manifest has no samples');
  const files = [];
  const seen = new Set();
  for (const sample of manifest.samples) {
    const sampleId = portableRelativePath(sample.id, 'Sample id');
    invariant(!sampleId.includes('/'), `Sample id must be one path segment: ${sampleId}`);
    for (const entry of sampleFiles(sample)) {
      const declared = declaredFile(entry, sampleId);
      const archivePath = `${sampleId}/${declared.path}`;
      invariant(!seen.has(archivePath), `Duplicate manifest path: ${archivePath}`);
      seen.add(archivePath);
      files.push({ archivePath, sha256: declared.sha256 });
    }
  }
  return files.sort((left, right) => comparePaths(left.archivePath, right.archivePath));
}

async function scanBundleRoot(root) {
  const files = [];
  async function visit(relativeDirectory) {
    const directory = path.join(root, ...relativeDirectory.split('/').filter(Boolean));
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => comparePaths(left.name, right.name));
    for (const entry of entries) {
      const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      const absolutePath = path.join(root, ...relativePath.split('/'));
      const metadata = await lstat(absolutePath);
      invariant(!metadata.isSymbolicLink(), `Symbolic links are forbidden: ${relativePath}`);
      if (metadata.isDirectory()) {
        await visit(relativePath);
      } else {
        invariant(metadata.isFile(), `Special files are forbidden: ${relativePath}`);
        if (relativePath !== MANIFEST_NAME) files.push(relativePath);
      }
    }
  }
  await visit('');
  return files.sort(comparePaths);
}

function tarPathParts(archivePath) {
  if (Buffer.byteLength(archivePath) <= 100) return { name: archivePath, prefix: '' };
  const slashIndexes = [];
  for (let index = 0; index < archivePath.length; index += 1) {
    if (archivePath[index] === '/') slashIndexes.push(index);
  }
  for (let index = slashIndexes.length - 1; index >= 0; index -= 1) {
    const split = slashIndexes[index];
    const prefix = archivePath.slice(0, split);
    const name = archivePath.slice(split + 1);
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100) {
      return { name, prefix };
    }
  }
  throw new Error(`Path does not fit the POSIX ustar header: ${archivePath}`);
}

function writeString(target, offset, length, value, label) {
  const source = Buffer.from(value, 'utf8');
  invariant(source.length <= length, `${label} is too long for a ustar header`);
  source.copy(target, offset);
}

function writeOctal(target, offset, length, value, label) {
  invariant(Number.isSafeInteger(value) && value >= 0, `${label} must be non-negative`);
  const encoded = value.toString(8).padStart(length - 1, '0');
  invariant(encoded.length <= length - 1, `${label} does not fit a ustar header`);
  writeString(target, offset, length, `${encoded}\0`, label);
}

function tarHeader({ archivePath, type, size, mtime }) {
  const header = Buffer.alloc(BLOCK_SIZE, 0);
  const { name, prefix } = tarPathParts(archivePath);
  writeString(header, 0, 100, name, 'name');
  writeOctal(header, 100, 8, type === 'directory' ? 0o755 : 0o644, 'mode');
  writeOctal(header, 108, 8, 0, 'uid');
  writeOctal(header, 116, 8, 0, 'gid');
  writeOctal(header, 124, 12, size, 'size');
  writeOctal(header, 136, 12, mtime, 'mtime');
  header.fill(0x20, 148, 156);
  header[156] = type === 'directory' ? 0x35 : 0x30;
  writeString(header, 257, 6, 'ustar\0', 'magic');
  writeString(header, 263, 2, '00', 'version');
  writeString(header, 345, 155, prefix, 'prefix');
  let checksum = 0;
  for (const byte of header) checksum += byte;
  writeString(header, 148, 8, `${checksum.toString(8).padStart(6, '0')}\0 `, 'checksum');
  return header;
}

function directoryPaths(filePaths) {
  const directories = new Set();
  for (const filePath of filePaths) {
    let directory = path.posix.dirname(filePath);
    while (directory !== '.') {
      directories.add(`${directory}/`);
      directory = path.posix.dirname(directory);
    }
  }
  return [...directories].sort(comparePaths);
}

export async function buildCanonicalTar({ bundleRoot, files, sourceDateEpoch }) {
  invariant(
    Number.isSafeInteger(sourceDateEpoch) && sourceDateEpoch > 0,
    'sourceDateEpoch must be a positive integer',
  );
  const entries = [
    ...directoryPaths(files).map((archivePath) => ({ archivePath, type: 'directory' })),
    ...files.map((archivePath) => ({ archivePath, type: 'file' })),
  ].sort((left, right) => comparePaths(left.archivePath, right.archivePath));
  const chunks = [];
  for (const entry of entries) {
    const contents =
      entry.type === 'file'
        ? await readFile(path.join(bundleRoot, ...entry.archivePath.split('/')))
        : Buffer.alloc(0);
    chunks.push(
      tarHeader({
        archivePath: entry.archivePath,
        type: entry.type,
        size: contents.length,
        mtime: sourceDateEpoch,
      }),
    );
    if (contents.length > 0) {
      chunks.push(contents);
      const padding = (BLOCK_SIZE - (contents.length % BLOCK_SIZE)) % BLOCK_SIZE;
      if (padding > 0) chunks.push(Buffer.alloc(padding, 0));
    }
  }
  chunks.push(Buffer.alloc(BLOCK_SIZE * 2));
  return Buffer.concat(chunks);
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export function createCanonicalGzip(tarBytes) {
  // Equivalent to gzip -n, with an explicitly portable OS byte as well as zero mtime/name fields.
  const header = Buffer.from([0x1f, 0x8b, 0x08, 0, 0, 0, 0, 0, 0x02, 0xff]);
  const compressed = deflateRawSync(tarBytes, { level: 9 });
  const trailer = Buffer.alloc(8);
  trailer.writeUInt32LE(crc32(tarBytes), 0);
  trailer.writeUInt32LE(tarBytes.length >>> 0, 4);
  return Buffer.concat([header, compressed, trailer]);
}

export function sha256Bytes(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export async function createDeterministicSampleBundleArchive({
  bundleRoot,
  outputPath,
  sourceCommit,
  sourceDateEpoch,
  metadataPath = null,
}) {
  invariant(/^[a-f0-9]{40}$/.test(sourceCommit), 'sourceCommit must be a full lowercase SHA');
  const manifestBytes = await readFile(path.join(bundleRoot, MANIFEST_NAME));
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  invariant(manifestSourceRevision(manifest) === sourceCommit, `Manifest source revision is not ${sourceCommit}`);
  const declarations = declaredBundleFiles(manifest);
  const declaredPaths = declarations.map(({ archivePath }) => archivePath);
  const actualPaths = await scanBundleRoot(bundleRoot);
  invariant(
    JSON.stringify(actualPaths) === JSON.stringify(declaredPaths),
    'Bundle root files do not exactly match the manifest',
  );
  for (const declaration of declarations) {
    invariant(declaration.sha256, `Manifest omits SHA-256 for ${declaration.archivePath}`);
    const bytes = await readFile(path.join(bundleRoot, ...declaration.archivePath.split('/')));
    invariant(sha256Bytes(bytes) === declaration.sha256, `Manifest SHA-256 mismatch for ${declaration.archivePath}`);
  }
  const tarBytes = await buildCanonicalTar({ bundleRoot, files: declaredPaths, sourceDateEpoch });
  const archiveBytes = createCanonicalGzip(tarBytes);
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, archiveBytes);
  const metadata = {
    format: 'honua.sdk.sample-bundle-pack.v1',
    archiveFormat: 'posix-ustar',
    compression: 'gzip-no-name-no-mtime-level-9',
    sourceCommit,
    sourceDateEpoch,
    fileCount: declaredPaths.length,
    manifest: { bytes: manifestBytes.length, sha256: sha256Bytes(manifestBytes) },
    archive: { bytes: archiveBytes.length, sha256: sha256Bytes(archiveBytes) },
  };
  if (metadataPath) {
    await mkdir(path.dirname(metadataPath), { recursive: true });
    await writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
  }
  return metadata;
}

function parseArguments(argv) {
  const args = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    invariant(name?.startsWith('--') && value !== undefined, `Invalid argument: ${name ?? ''}`);
    args.set(name.slice(2), value);
  }
  return args;
}

async function main() {
  const args = parseArguments(process.argv.slice(2));
  invariant(args.has('input') && args.has('output'), '--input and --output are required');
  const metadata = await createDeterministicSampleBundleArchive({
    bundleRoot: path.resolve(args.get('input')),
    outputPath: path.resolve(args.get('output')),
    sourceCommit: args.get('source-commit'),
    sourceDateEpoch: Number(args.get('source-date-epoch')),
    metadataPath: args.has('metadata') ? path.resolve(args.get('metadata')) : null,
  });
  process.stdout.write(`${JSON.stringify(metadata)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
