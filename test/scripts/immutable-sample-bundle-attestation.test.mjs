import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { gunzipSync } from 'node:zlib';
import { createDeterministicSampleBundleArchive, sha256Bytes } from '../../scripts/pack-sample-bundles.mjs';
import {
  WORKFLOW_PATH,
  validateContentAddressedWorkflowPolicy,
} from '../../scripts/immutable-sample-bundle-attestation.mjs';

const repositoryRoot = path.resolve(import.meta.dirname, '..', '..');
const sourceDateEpoch = 1_726_000_000;
const fixtureSourceCommit = '2'.repeat(40);

function tarString(buffer, offset, length) {
  const zero = buffer.indexOf(0, offset);
  const end = zero === -1 || zero > offset + length ? offset + length : zero;
  return buffer.subarray(offset, end).toString();
}

function tarOctal(buffer, offset, length) {
  return Number.parseInt(tarString(buffer, offset, length).trim() || '0', 8);
}

function tarEntries(gzipBytes) {
  const tar = gunzipSync(gzipBytes);
  const entries = [];
  for (let offset = 0; offset + 512 <= tar.length; ) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = tarString(header, 0, 100);
    const prefix = tarString(header, 345, 155);
    const size = tarOctal(header, 124, 12);
    entries.push({
      path: prefix ? `${prefix}/${name}` : name,
      mode: tarOctal(header, 100, 8),
      uid: tarOctal(header, 108, 8),
      gid: tarOctal(header, 116, 8),
      mtime: tarOctal(header, 136, 12),
      type: String.fromCharCode(header[156]),
      magic: header.subarray(257, 263).toString('binary'),
    });
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return entries;
}

async function createFixture(root) {
  const files = new Map([
    ['alpha/assets/short.js', Buffer.from('export const answer = 42;\n')],
    [`alpha/${'deep/'.repeat(20)}asset.css`, Buffer.from('body { color: #123; }\n')],
  ]);
  const declarations = [];
  for (const [relativePath, contents] of [...files].reverse()) {
    const absolutePath = path.join(root, ...relativePath.split('/'));
    await mkdir(path.dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, contents);
    declarations.push({
      path: relativePath.slice('alpha/'.length),
      bytes: contents.length,
      sha256: sha256Bytes(contents),
    });
  }
  const manifest = {
    schemaVersion: 2,
    sourceRevision: fixtureSourceCommit,
    lockfileSha256: 'a'.repeat(64),
    samples: [{ id: 'alpha', files: declarations }],
  };
  await writeFile(path.join(root, 'sample-bundles.v2.json'), `${JSON.stringify(manifest, null, 2)}\n`);
}

test('canonical packer is reproducible and normalizes ustar and gzip metadata', async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'honua-bundle-pack-'));
  try {
    const firstRoot = path.join(temporaryRoot, 'first');
    const secondRoot = path.join(temporaryRoot, 'second');
    await mkdir(firstRoot);
    await mkdir(secondRoot);
    await createFixture(firstRoot);
    await createFixture(secondRoot);
    await utimes(path.join(secondRoot, 'alpha', 'assets', 'short.js'), new Date(), new Date());
    const firstArchive = path.join(temporaryRoot, 'first.tar.gz');
    const secondArchive = path.join(temporaryRoot, 'second.tar.gz');
    const first = await createDeterministicSampleBundleArchive({
      bundleRoot: firstRoot,
      outputPath: firstArchive,
      sourceCommit: fixtureSourceCommit,
      sourceDateEpoch,
    });
    const second = await createDeterministicSampleBundleArchive({
      bundleRoot: secondRoot,
      outputPath: secondArchive,
      sourceCommit: fixtureSourceCommit,
      sourceDateEpoch,
    });
    const firstBytes = await readFile(firstArchive);
    const secondBytes = await readFile(secondArchive);
    assert.deepEqual(firstBytes, secondBytes);
    assert.deepEqual(first, second);
    assert.deepEqual([...firstBytes.subarray(0, 10)], [31, 139, 8, 0, 0, 0, 0, 0, 2, 255]);
    const entries = tarEntries(firstBytes);
    assert.deepEqual(entries.map(({ path: entryPath }) => entryPath), [...entries.map(({ path: entryPath }) => entryPath)].sort());
    assert.ok(entries.some(({ path: entryPath }) => Buffer.byteLength(entryPath) > 100));
    for (const entry of entries) {
      assert.equal(entry.uid, 0);
      assert.equal(entry.gid, 0);
      assert.equal(entry.mtime, sourceDateEpoch);
      assert.equal(entry.magic, 'ustar\0');
      assert.equal(entry.mode, entry.type === '5' ? 0o755 : 0o644);
    }
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test('canonical packer rejects undeclared files and source drift', async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'honua-bundle-negative-'));
  try {
    await createFixture(temporaryRoot);
    await writeFile(path.join(temporaryRoot, 'alpha', 'undeclared.js'), 'unexpected');
    await assert.rejects(
      createDeterministicSampleBundleArchive({
        bundleRoot: temporaryRoot,
        outputPath: path.join(temporaryRoot, '..', 'negative.tar.gz'),
        sourceCommit: fixtureSourceCommit,
        sourceDateEpoch,
      }),
      /do not exactly match/,
    );
    await assert.rejects(
      createDeterministicSampleBundleArchive({
        bundleRoot: temporaryRoot,
        outputPath: path.join(temporaryRoot, '..', 'negative.tar.gz'),
        sourceCommit: 'f'.repeat(40),
        sourceDateEpoch,
      }),
      /Manifest source revision/,
    );
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test('canonical packer rejects mixed per-sample source revisions', async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'honua-bundle-revision-'));
  try {
    await createFixture(temporaryRoot);
    const manifestPath = path.join(temporaryRoot, 'sample-bundles.v2.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    manifest.samples[0].builtFrom = { commit: 'f'.repeat(40) };
    manifest.sourceRevision = fixtureSourceCommit;
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    await assert.rejects(
      createDeterministicSampleBundleArchive({
        bundleRoot: temporaryRoot,
        outputPath: path.join(temporaryRoot, '..', 'mixed-revision.tar.gz'),
        sourceCommit: fixtureSourceCommit,
        sourceDateEpoch,
      }),
      /Manifest source revision/,
    );
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test('content-addressed workflow satisfies immutable publication policy', async () => {
  const workflow = await readFile(path.join(repositoryRoot, WORKFLOW_PATH), 'utf8');
  assert.equal(validateContentAddressedWorkflowPolicy(workflow), true);
});

test('workflow policy rejects mutable and unsafe publication variants', async () => {
  const workflow = await readFile(path.join(repositoryRoot, WORKFLOW_PATH), 'utf8');
  const mutations = [
    workflow.replace('workflow_dispatch: {}', 'workflow_dispatch:\n    inputs:\n      source: {}'),
    workflow.replace('SOURCE_COMMIT: ${{ github.sha }}', 'SOURCE_COMMIT: trunk'),
    workflow.replace(/@[a-f0-9]{40}/, '@v4'),
    workflow.replace('permissions:\n  contents: read', 'permissions:\n  contents: write'),
    `${workflow}\n# sample-bundles-latest\n`,
    `${workflow}\n# gh release upload --clobber\n`,
    `${workflow}\n# tar -czf sample-bundles.tar.gz .\n`,
    workflow.replace('cmp --silent "$FIRST_ARCHIVE" "$SECOND_ARCHIVE"', 'test -s "$FIRST_ARCHIVE"'),
  ];
  for (const mutation of mutations) assert.throws(() => validateContentAddressedWorkflowPolicy(mutation));
});
