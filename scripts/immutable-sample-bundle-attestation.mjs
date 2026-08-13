import { spawnSync } from 'node:child_process';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  declaredBundleFiles,
  manifestLockfileSha256,
  manifestSourceRevision,
  sha256Bytes,
} from './pack-sample-bundles.mjs';

export const REQUIRED_NODE_VERSION = '20.19.0';
export const WORKFLOW_PATH = '.github/workflows/publish-content-addressed-sample-bundles.yml';
export const ASSET_FILES = Object.freeze({
  'sample-bundles.v2.json': 'sample-bundles.v2.json',
  'sample-bundles.tar.gz': 'sample-bundles.tar.gz',
  'sample-bundles-attestation.v1.json': 'sample-bundles-attestation.v1.json',
});

export function releaseIdFor(sourceCommit) {
  invariant(/^[a-f0-9]{40}$/.test(sourceCommit), 'Source commit must be a full lowercase SHA');
  return `sample-bundles-${sourceCommit}`;
}

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function parseArguments(argv) {
  const command = argv[0];
  const args = new Map();
  for (let index = 1; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    invariant(name?.startsWith('--') && value !== undefined, `Invalid argument: ${name ?? ''}`);
    args.set(name.slice(2), value);
  }
  return { command, args };
}

function required(args, name) {
  const value = args.get(name);
  invariant(value, `--${name} is required`);
  return value;
}

async function fileFact(filePath) {
  const contents = await readFile(filePath);
  return { bytes: contents.length, sha256: sha256Bytes(contents), contents };
}

export async function createAttestationReceipt({
  sourceCommit,
  sourceRoot,
  sourceDateEpoch,
  firstBundleRoot,
  secondBundleRoot,
  firstArchivePath,
  secondArchivePath,
  smokeReceiptPath,
  outputPath,
  workflowSha,
  workflowRunId,
}) {
  const releaseId = releaseIdFor(sourceCommit);
  invariant(process.versions.node === REQUIRED_NODE_VERSION, `Node ${REQUIRED_NODE_VERSION} is required`);
  invariant(/^[a-f0-9]{40}$/.test(workflowSha), 'Workflow SHA must be a full commit SHA');
  invariant(/^\d+$/.test(workflowRunId), 'Workflow run id must be numeric');
  invariant(Number.isSafeInteger(sourceDateEpoch) && sourceDateEpoch > 0, 'Invalid source date epoch');
  const firstManifestPath = path.join(firstBundleRoot, 'sample-bundles.v2.json');
  const secondManifestPath = path.join(secondBundleRoot, 'sample-bundles.v2.json');
  const [firstManifest, secondManifest, firstArchive, secondArchive, lockfile, smoke] =
    await Promise.all([
      fileFact(firstManifestPath),
      fileFact(secondManifestPath),
      fileFact(firstArchivePath),
      fileFact(secondArchivePath),
      fileFact(path.join(sourceRoot, 'package-lock.json')),
      fileFact(smokeReceiptPath),
    ]);
  invariant(firstManifest.contents.equals(secondManifest.contents), 'Manifest builds are not byte-identical');
  invariant(firstArchive.contents.equals(secondArchive.contents), 'Archive builds are not byte-identical');
  const manifest = JSON.parse(firstManifest.contents.toString('utf8'));
  invariant(manifestSourceRevision(manifest) === sourceCommit, 'Unexpected manifest source revision');
  invariant(manifestLockfileSha256(manifest) === lockfile.sha256, 'Manifest lockfile digest mismatch');
  const smokeDocument = JSON.parse(smoke.contents.toString('utf8'));
  if (typeof smokeDocument.summary?.failed === 'number') {
    invariant(smokeDocument.summary.failed === 0, 'Producer smoke receipt reports failures');
  }
  if (typeof smokeDocument.status === 'string') {
    invariant(/^(pass|passed|success)$/i.test(smokeDocument.status), 'Producer smoke did not pass');
  }
  const receipt = {
    format: 'honua.sdk.immutable-sample-bundle-attestation.v1',
    source: {
      repository: process.env.GITHUB_REPOSITORY ?? 'honua-io/honua-sdk-js',
      commit: sourceCommit,
      sourceDateEpoch,
      lockfile: { bytes: lockfile.bytes, sha256: lockfile.sha256 },
      node: REQUIRED_NODE_VERSION,
    },
    workflow: { path: WORKFLOW_PATH, commit: workflowSha, runId: workflowRunId },
    build: {
      cleanBuildCount: 2,
      installCommand: 'npm ci',
      bundleBuildCommand: 'npm run samples:bundles:build',
      bundleVerifyCommand: 'npm run samples:bundles:verify',
      producerSmokeCommand: 'npm run samples:bundles:smoke',
      archiveFormat: 'posix-ustar',
      archiveCompression: 'gzip-no-name-no-mtime-level-9',
      normalizedUid: 0,
      normalizedGid: 0,
      regularFileMode: '0644',
      directoryMode: '0755',
    },
    reproducibility: {
      manifestByteIdentical: true,
      archiveByteIdentical: true,
      fileCount: declaredBundleFiles(manifest).length,
    },
    producerSmoke: {
      bytes: smoke.bytes,
      sha256: smoke.sha256,
      format: smokeDocument.format ?? null,
      summary: smokeDocument.summary ?? null,
    },
    publication: {
      tag: releaseId,
      immutable: true,
      assets: {
        'sample-bundles.v2.json': { bytes: firstManifest.bytes, sha256: firstManifest.sha256 },
        'sample-bundles.tar.gz': { bytes: firstArchive.bytes, sha256: firstArchive.sha256 },
      },
    },
    attestation: {
      type: 'https://slsa.dev/provenance/v1',
      signer: 'GitHub Actions OIDC',
      subjectFiles: Object.keys(ASSET_FILES),
    },
  };
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(receipt, null, 2)}\n`);
  return receipt;
}

export function validateContentAddressedWorkflowPolicy(workflow) {
  invariant(workflow.includes('workflow_dispatch: {}'), 'Workflow dispatch must not accept inputs');
  invariant(!/(?:github\.event\.)?inputs\b|\$\{\{\s*inputs\./.test(workflow), 'Mutable inputs are forbidden');
  invariant(workflow.includes('SOURCE_COMMIT: ${{ github.sha }}'), 'Source commit must be github.sha');
  invariant(
    workflow.includes('RELEASE_ID: sample-bundles-${{ github.sha }}'),
    'Release id must be derived from the exact source commit',
  );
  invariant(workflow.includes('runs-on: ubuntu-24.04'), 'Runner must be pinned to ubuntu-24.04');
  invariant(workflow.includes(`node-version: '${REQUIRED_NODE_VERSION}'`), 'Node version is not pinned');
  invariant(!workflow.includes('sample-bundles-latest'), 'Rolling sample bundle tags are forbidden');
  invariant(!workflow.includes('--clobber'), 'Release asset clobbering is forbidden');
  invariant(!/overwrite:\s*true/.test(workflow), 'Artifact overwrites are forbidden');
  invariant(!/tar\s+-(?:[^\n]*z|[^\n]*c)[^\n]*f/.test(workflow), 'Ad hoc tar packing is forbidden');
  const actionUses = [...workflow.matchAll(/^\s*-?\s*uses:\s*([^\s#]+).*$/gm)].map((match) => match[1]);
  invariant(actionUses.length >= 6, 'Expected pinned checkout, setup, upload, and attestation actions');
  for (const action of actionUses) {
    invariant(/^[^@]+@[a-f0-9]{40}$/.test(action), `Action is not pinned to a full SHA: ${action}`);
  }
  invariant((workflow.match(/persist-credentials:\s*false/g) ?? []).length >= 3, 'Every checkout must disable credentials');
  invariant((workflow.match(/ref: \$\{\{ github\.sha \}\}/g) ?? []).length === 2, 'Two exact source checkouts are required');
  invariant((workflow.match(/samples:bundles:build/g) ?? []).length >= 2, 'Two bundle builds are required');
  invariant((workflow.match(/pack-sample-bundles\.mjs/g) ?? []).length >= 2, 'Canonical packer must run twice');
  invariant(workflow.includes('cmp --silent "$FIRST_MANIFEST" "$SECOND_MANIFEST"'), 'Manifest comparison is required');
  invariant(workflow.includes('cmp --silent "$FIRST_ARCHIVE" "$SECOND_ARCHIVE"'), 'Archive comparison is required');
  invariant(workflow.includes('release-preflight'), 'Immutable release preflight is required');
  invariant(workflow.includes('actions/attest-build-provenance@'), 'Provenance attestation is required');
  invariant(workflow.includes('gh release create "$RELEASE_ID"'), 'Release must use the fixed id');
  invariant(workflow.includes('--latest=false'), 'Historical release must not become latest');
  invariant(workflow.includes('concurrency:'), 'A publication concurrency guard is required');
  return true;
}

function ghJson(apiPath, { allowNotFound = false } = {}) {
  const result = spawnSync('gh', ['api', apiPath], { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
  if (result.status !== 0) {
    if (allowNotFound && /HTTP 404|Not Found/i.test(result.stderr)) return null;
    throw new Error(`gh api ${apiPath} failed: ${result.stderr.trim()}`);
  }
  return JSON.parse(result.stdout);
}

function resolveTagCommit(repository, tagReference) {
  let object = tagReference.object;
  for (let depth = 0; depth < 4 && object?.type === 'tag'; depth += 1) {
    object = ghJson(`repos/${repository}/git/tags/${object.sha}`).object;
  }
  invariant(object?.type === 'commit', 'Release tag does not resolve to a commit');
  return object.sha;
}

function downloadAsset(repository, assetId) {
  const result = spawnSync(
    'gh',
    ['api', '-H', 'Accept: application/octet-stream', `repos/${repository}/releases/assets/${assetId}`],
    { encoding: null, maxBuffer: 128 * 1024 * 1024 },
  );
  if (result.status !== 0) throw new Error(`Unable to download existing release asset ${assetId}`);
  return result.stdout;
}

export async function releasePreflight({
  repository,
  publicationDirectory,
  githubOutput,
  sourceCommit,
  releaseId,
}) {
  invariant(/^[^/]+\/[^/]+$/.test(repository), 'A GitHub owner/repository is required');
  invariant(process.env.GH_TOKEN || process.env.GITHUB_TOKEN, 'GH_TOKEN is required');
  invariant(releaseId === releaseIdFor(sourceCommit), 'Release id is not derived from the source commit');
  const encodedTag = encodeURIComponent(releaseId);
  const tag = ghJson(`repos/${repository}/git/ref/tags/${encodedTag}`, { allowNotFound: true });
  const release = ghJson(`repos/${repository}/releases/tags/${encodedTag}`, { allowNotFound: true });
  if (!tag && !release) {
    await appendFile(githubOutput, 'mode=create\n');
    return 'create';
  }
  invariant(tag && release, 'Historical tag/release is partially present; refusing mutation');
  invariant(resolveTagCommit(repository, tag) === sourceCommit, 'Content-addressed tag targets a different commit');
  invariant(release.draft === false, 'Historical release must not be a draft');
  const expectedNames = Object.keys(ASSET_FILES).sort();
  const actualNames = release.assets.map(({ name }) => name).sort();
  invariant(JSON.stringify(actualNames) === JSON.stringify(expectedNames), 'Historical release assets differ');
  for (const asset of release.assets) {
    const expected = await readFile(path.join(publicationDirectory, ASSET_FILES[asset.name]));
    invariant(downloadAsset(repository, asset.id).equals(expected), `Existing asset differs: ${asset.name}`);
  }
  await appendFile(githubOutput, 'mode=idempotent\n');
  return 'idempotent';
}

async function main() {
  const { command, args } = parseArguments(process.argv.slice(2));
  if (command === 'receipt') {
    await createAttestationReceipt({
      sourceCommit: required(args, 'source-commit'),
      sourceRoot: path.resolve(required(args, 'source-root')),
      sourceDateEpoch: Number(required(args, 'source-date-epoch')),
      firstBundleRoot: path.resolve(required(args, 'first-bundle-root')),
      secondBundleRoot: path.resolve(required(args, 'second-bundle-root')),
      firstArchivePath: path.resolve(required(args, 'first-archive')),
      secondArchivePath: path.resolve(required(args, 'second-archive')),
      smokeReceiptPath: path.resolve(required(args, 'smoke-receipt')),
      outputPath: path.resolve(required(args, 'output')),
      workflowSha: required(args, 'workflow-sha'),
      workflowRunId: required(args, 'workflow-run-id'),
    });
  } else if (command === 'policy') {
    const root = path.resolve(args.get('root') ?? '.');
    validateContentAddressedWorkflowPolicy(await readFile(path.join(root, WORKFLOW_PATH), 'utf8'));
    process.stdout.write('Content-addressed sample bundle workflow policy passed.\n');
  } else if (command === 'release-preflight') {
    await releasePreflight({
      repository: required(args, 'repository'),
      publicationDirectory: path.resolve(required(args, 'publication-directory')),
      githubOutput: path.resolve(required(args, 'github-output')),
      sourceCommit: required(args, 'source-commit'),
      releaseId: required(args, 'release-id'),
    });
  } else {
    throw new Error('Expected receipt, policy, or release-preflight command');
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
