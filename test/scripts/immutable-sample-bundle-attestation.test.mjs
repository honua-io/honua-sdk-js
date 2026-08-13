import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { gunzipSync } from 'node:zlib';
import {
  buildCanonicalTar,
  createCanonicalGzip,
  createDeterministicSampleBundleArchive,
  sha256Bytes,
} from '../../scripts/pack-sample-bundles.mjs';
import {
  RELEASE_ASSETS,
  WORKFLOW_PATH,
  classifyPublicationState,
  createAttestationReceipts,
  validateSmokeReceipt,
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

async function createFixture(root, { lockfileSha256 = 'a'.repeat(64) } = {}) {
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
    format: 'honua.sdk.sample-bundles.v2',
    schemaVersion: 2,
    sourceRevision: fixtureSourceCommit,
    build: { node: '>=20.19.0', lockfileSha256 },
    samples: [
      {
        id: 'alpha',
        runnability: 'standalone',
        builtFrom: { commit: fixtureSourceCommit, packageVersion: '0.0.0' },
        files: declarations,
      },
    ],
  };
  await writeFile(path.join(root, 'sample-bundles.v2.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

async function packFixture(root, outputPath) {
  return createDeterministicSampleBundleArchive({
    bundleRoot: root,
    outputPath,
    sourceCommit: fixtureSourceCommit,
    sourceDateEpoch,
  });
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
    const first = await packFixture(firstRoot, firstArchive);
    const second = await packFixture(secondRoot, secondArchive);
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
    const nativeTar = spawnSync('tar', ['-tzf', firstArchive], { encoding: 'utf8' });
    assert.equal(nativeTar.status, 0, nativeTar.stderr);
    assert.match(nativeTar.stdout, /alpha\/assets\/short\.js/);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test('canonical tar consumes one immutable byte snapshot instead of reopening paths', async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'honua-bundle-snapshot-'));
  try {
    const filePath = path.join(temporaryRoot, 'alpha.txt');
    await writeFile(filePath, 'first');
    const snapshot = await readFile(filePath);
    await writeFile(filePath, 'second');
    const tar = buildCanonicalTar({
      fileSnapshots: new Map([['alpha.txt', snapshot]]),
      sourceDateEpoch,
    });
    const archive = createCanonicalGzip(tar);
    assert.equal(gunzipSync(archive).includes(Buffer.from('first')), true);
    assert.equal(gunzipSync(archive).includes(Buffer.from('second')), false);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test('canonical packer rejects undeclared files, source drift, and mixed revisions', async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'honua-bundle-negative-'));
  try {
    await createFixture(temporaryRoot);
    await writeFile(path.join(temporaryRoot, 'alpha', 'undeclared.js'), 'unexpected');
    await assert.rejects(packFixture(temporaryRoot, path.join(temporaryRoot, '..', 'negative.tar.gz')), /do not exactly match/);
    await assert.rejects(
      createDeterministicSampleBundleArchive({
        bundleRoot: temporaryRoot,
        outputPath: path.join(temporaryRoot, '..', 'negative.tar.gz'),
        sourceCommit: 'f'.repeat(40),
        sourceDateEpoch,
      }),
      /Manifest source revision/,
    );
    await rm(path.join(temporaryRoot, 'alpha', 'undeclared.js'));
    const manifestPath = path.join(temporaryRoot, 'sample-bundles.v2.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    manifest.samples[0].builtFrom.commit = 'f'.repeat(40);
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    await assert.rejects(packFixture(temporaryRoot, path.join(temporaryRoot, '..', 'mixed.tar.gz')), /Manifest source revision/);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test('manifest validation rejects duplicate and unsafe archive paths', async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'honua-bundle-paths-'));
  try {
    const manifest = await createFixture(temporaryRoot);
    const manifestPath = path.join(temporaryRoot, 'sample-bundles.v2.json');
    manifest.samples[0].files.push({ ...manifest.samples[0].files[0] });
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    await assert.rejects(packFixture(temporaryRoot, path.join(temporaryRoot, '..', 'duplicate.tar.gz')), /Duplicate manifest path/);
    manifest.samples[0].files.pop();
    manifest.samples[0].files[0].path = '../escape.js';
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    await assert.rejects(packFixture(temporaryRoot, path.join(temporaryRoot, '..', 'escape.tar.gz')), /not normalized|escapes/);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test('bundle scan rejects links and special files where the platform supports them', async (context) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'honua-bundle-types-'));
  try {
    await createFixture(temporaryRoot);
    const linkPath = path.join(temporaryRoot, 'alpha', 'linked.js');
    try {
      await symlink(path.join(temporaryRoot, 'alpha', 'assets', 'short.js'), linkPath);
      await assert.rejects(packFixture(temporaryRoot, path.join(temporaryRoot, '..', 'link.tar.gz')), /Symbolic links are forbidden/);
      await rm(linkPath);
    } catch (error) {
      if (error?.code !== 'EPERM') throw error;
      context.diagnostic('Symlink creation is not permitted on this platform');
    }
    if (process.platform !== 'win32') {
      const fifo = path.join(temporaryRoot, 'alpha', 'fixture.fifo');
      assert.equal(spawnSync('mkfifo', [fifo]).status, 0);
      await assert.rejects(packFixture(temporaryRoot, path.join(temporaryRoot, '..', 'fifo.tar.gz')), /Special files are forbidden/);
    }
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test('released receipt is deterministic while per-run receipt carries run identity', async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'honua-bundle-receipt-'));
  try {
    const sourceRoot = path.join(temporaryRoot, 'source');
    const firstRoot = path.join(temporaryRoot, 'first');
    const secondRoot = path.join(temporaryRoot, 'second');
    await mkdir(sourceRoot);
    await mkdir(firstRoot);
    await mkdir(secondRoot);
    const lockfile = Buffer.from('{"lockfileVersion":3}\n');
    await writeFile(path.join(sourceRoot, 'package-lock.json'), lockfile);
    await createFixture(firstRoot, { lockfileSha256: sha256Bytes(lockfile) });
    await createFixture(secondRoot, { lockfileSha256: sha256Bytes(lockfile) });
    const firstArchive = path.join(temporaryRoot, 'first.tar.gz');
    const secondArchive = path.join(temporaryRoot, 'second.tar.gz');
    await packFixture(firstRoot, firstArchive);
    await packFixture(secondRoot, secondArchive);
    const smokePath = path.join(temporaryRoot, 'smoke.json');
    await writeFile(
      smokePath,
      JSON.stringify({
        format: 'honua.sdk.sample-bundle-browser-smoke.v1',
        generatedAt: '2099-01-01T00:00:00.000Z',
        manifest: { format: 'honua.sdk.sample-bundles.v2', schemaVersion: 2, commit: fixtureSourceCommit },
        summary: { total: 1, passed: 1, failed: 0 },
        results: [
          {
            id: 'alpha',
            title: 'Alpha',
            passed: true,
            requestCount: 1,
            network: { offOriginRequestCount: 0, clientErrorResponseCount: 0 },
            staticJourney: null,
            liveProbe: null,
            failures: [],
            screenshot: null,
          },
        ],
      }),
    );
    const invoke = async (suffix, runId, runAttempt) => {
      const outputPath = path.join(temporaryRoot, `receipt-${suffix}.json`);
      const runOutputPath = path.join(temporaryRoot, `run-${suffix}.json`);
      await createAttestationReceipts({
        sourceCommit: fixtureSourceCommit,
        sourceRoot,
        sourceDateEpoch,
        firstBundleRoot: firstRoot,
        secondBundleRoot: secondRoot,
        firstArchivePath: firstArchive,
        secondArchivePath: secondArchive,
        smokeReceiptPath: smokePath,
        outputPath,
        runOutputPath,
        workflowSha: fixtureSourceCommit,
        workflowRunId: runId,
        workflowRunAttempt: runAttempt,
        runnerImage: 'ubuntu24',
        runnerImageVersion: '20260801.1',
        runnerEnvironment: 'github-hosted',
        runnerOs: 'Linux',
        runnerArch: 'X64',
      });
      return { receipt: await readFile(outputPath), run: await readFile(runOutputPath, 'utf8') };
    };
    const first = await invoke('a', '100', '1');
    const second = await invoke('b', '200', '2');
    assert.deepEqual(first.receipt, second.receipt);
    assert.notEqual(first.run, second.run);
    assert.doesNotMatch(first.receipt.toString(), /2099-01-01|"runId"|"runAttempt"/);
    assert.ok(first.receipt.toString().includes(new Date(sourceDateEpoch * 1000).toISOString()));
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test('smoke validation rejects schema, source, count, and result-set drift', () => {
  const manifest = {
    format: 'honua.sdk.sample-bundles.v2',
    schemaVersion: 2,
    samples: [{ id: 'alpha', runnability: 'standalone' }],
  };
  const valid = {
    format: 'honua.sdk.sample-bundle-browser-smoke.v1',
    generatedAt: '2024-01-01T00:00:00.000Z',
    manifest: { format: manifest.format, schemaVersion: 2, commit: fixtureSourceCommit },
    summary: { total: 1, passed: 1, failed: 0 },
    results: [
      {
        id: 'alpha',
        title: 'Alpha',
        passed: true,
        requestCount: 1,
        network: { offOriginRequestCount: 0, clientErrorResponseCount: 0 },
        staticJourney: null,
        liveProbe: null,
        failures: [],
        screenshot: null,
      },
    ],
  };
  assert.equal(validateSmokeReceipt(valid, manifest, fixtureSourceCommit, sourceDateEpoch).summary.failed, 0);
  const mutations = [
    { ...structuredClone(valid), extra: true },
    { ...structuredClone(valid), manifest: { ...valid.manifest, commit: 'f'.repeat(40) } },
    { ...structuredClone(valid), summary: { total: 2, passed: 1, failed: 0 } },
    { ...structuredClone(valid), results: [{ ...valid.results[0], id: 'beta' }] },
  ];
  for (const mutation of mutations) {
    assert.throws(() => validateSmokeReceipt(mutation, manifest, fixtureSourceCommit, sourceDateEpoch));
  }
});

test('publication state permits create and exact idempotence only', () => {
  const expected = {
    sourceCommit: fixtureSourceCommit,
    assets: Object.fromEntries(RELEASE_ASSETS.map((name, index) => [name, { bytes: index + 1, sha256: `${index}`.repeat(64) }])),
  };
  const exactRelease = {
    draft: false,
    assets: Object.entries(expected.assets).map(([name, facts]) => ({ name, ...facts })),
  };
  assert.equal(classifyPublicationState({ tagCommit: null, release: null }, expected), 'create');
  assert.equal(classifyPublicationState({ tagCommit: fixtureSourceCommit, release: exactRelease }, expected), 'idempotent');
  assert.throws(() => classifyPublicationState({ tagCommit: fixtureSourceCommit, release: null }, expected), /partially/);
  assert.throws(() => classifyPublicationState({ tagCommit: null, release: exactRelease }, expected), /partially/);
  assert.throws(
    () => classifyPublicationState({ tagCommit: 'f'.repeat(40), release: exactRelease }, expected),
    /collision/,
  );
  const divergent = structuredClone(exactRelease);
  divergent.assets[0].sha256 = 'f'.repeat(64);
  assert.throws(() => classifyPublicationState({ tagCommit: fixtureSourceCommit, release: divergent }, expected), /digest/);
  const partial = structuredClone(exactRelease);
  partial.assets.pop();
  assert.throws(() => classifyPublicationState({ tagCommit: fixtureSourceCommit, release: partial }, expected), /asset set/);
});

test('content-addressed workflow satisfies immutable publication policy', async () => {
  const workflow = await readFile(path.join(repositoryRoot, WORKFLOW_PATH), 'utf8');
  assert.equal(validateContentAddressedWorkflowPolicy(workflow), true);
});

test('workflow policy rejects executable mutable and unsafe variants', async () => {
  const workflow = await readFile(path.join(repositoryRoot, WORKFLOW_PATH), 'utf8');
  const mutations = [
    workflow.replace('workflow_dispatch: {}', 'workflow_dispatch:\n    inputs:\n      source: {}'),
    workflow.replace('SOURCE_COMMIT: ${{ github.sha }}', 'SOURCE_COMMIT: trunk'),
    workflow.replace(/actions\/checkout@[a-f0-9]{40}/, 'actions/checkout@v4'),
    workflow.replace('RELEASE_ID: sample-bundles-${{ github.sha }}', 'RELEASE_ID: sample-bundles-latest'),
    workflow.replace('--latest=false \\', '--latest=false \\\n            --clobber \\'),
    workflow.replace('node governance/scripts/pack-sample-bundles.mjs', 'tar -czf "$FIRST_ARCHIVE" source-a/.artifacts/sample-bundles'),
    workflow.replace('cmp --silent "$FIRST_ARCHIVE" "$SECOND_ARCHIVE"', 'test -s "$FIRST_ARCHIVE"'),
    workflow.replace('permissions: {}', 'permissions:\n  contents: write'),
    workflow.replace('group: publish-content-addressed-sample-bundles', 'group: sample-bundles-${{ github.sha }}'),
    workflow.replace("jq -e '.enabled == true and .enforced_by_owner == true'", "jq -e '.enabled == true'"),
    workflow.replace('--target "$SOURCE_COMMIT"', '--target trunk'),
    workflow.replaceAll('commits/trunk', 'commits/not-trunk'),
    workflow.replace('test "$GITHUB_REF" = "refs/heads/trunk"', 'test -n "$GITHUB_REF"'),
    workflow.replace('name: Validate staged bytes without credentials', 'name: Validate staged bytes without credentials\n        env:\n          GITHUB_ENV: /tmp/env'),
  ];
  for (const [index, mutation] of mutations.entries()) {
    assert.notEqual(mutation, workflow);
    assert.throws(() => validateContentAddressedWorkflowPolicy(mutation), `Mutation ${index} passed policy`);
  }
});
