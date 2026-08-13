import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  declaredBundleFiles,
  manifestLockfileSha256,
  manifestSourceRevision,
  sha256Bytes,
} from "./pack-sample-bundles.mjs";

export const REQUIRED_NODE_VERSION = "20.19.0";
export const WORKFLOW_PATH =
  ".github/workflows/publish-content-addressed-sample-bundles.yml";
export const ACTION_PINS = Object.freeze({
  checkout: "3d3c42e5aac5ba805825da76410c181273ba90b1",
  setupNode: "820762786026740c76f36085b0efc47a31fe5020",
  uploadArtifact: "ea165f8d65b6e75b540449e92b4886f43607fa02",
  downloadArtifact: "d3f86a106a0bac45b974a628896c90dbdf5c8093",
  attestBuildProvenance: "43d14bc2b83dec42d39ecae14e916627a18bb661",
});
export const RELEASE_ASSETS = Object.freeze([
  "sample-bundles.v2.json",
  "sample-bundles.tar.gz",
  "sample-bundles-attestation.v1.json",
]);

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function exactKeys(value, keys, label) {
  invariant(
    value && typeof value === "object" && !Array.isArray(value),
    `${label} must be an object`,
  );
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  invariant(
    JSON.stringify(actual) === JSON.stringify(expected),
    `${label} has an unexpected schema`,
  );
}

function parseArguments(argv) {
  const command = argv[0];
  const args = new Map();
  for (let index = 1; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    invariant(
      name?.startsWith("--") && value !== undefined,
      `Invalid argument: ${name ?? ""}`,
    );
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

export function releaseIdFor(sourceCommit) {
  invariant(
    /^[a-f0-9]{40}$/.test(sourceCommit),
    "Source commit must be a full lowercase SHA",
  );
  return `sample-bundles-${sourceCommit}`;
}

export function validateSmokeReceipt(
  smoke,
  manifest,
  sourceCommit,
  sourceDateEpoch,
) {
  exactKeys(
    smoke,
    ["format", "generatedAt", "manifest", "summary", "results"],
    "Smoke receipt",
  );
  invariant(
    smoke.format === "honua.sdk.sample-bundle-browser-smoke.v1",
    "Unexpected smoke format",
  );
  invariant(
    !Number.isNaN(Date.parse(smoke.generatedAt)),
    "Smoke generatedAt must be an ISO timestamp",
  );
  exactKeys(
    smoke.manifest,
    ["format", "schemaVersion", "commit"],
    "Smoke manifest identity",
  );
  invariant(
    smoke.manifest.format === manifest.format,
    "Smoke manifest format mismatch",
  );
  invariant(
    smoke.manifest.schemaVersion === manifest.schemaVersion,
    "Smoke schema version mismatch",
  );
  invariant(
    smoke.manifest.commit === sourceCommit,
    "Smoke source commit mismatch",
  );
  exactKeys(smoke.summary, ["total", "passed", "failed"], "Smoke summary");
  invariant(Array.isArray(smoke.results), "Smoke results must be an array");
  invariant(
    smoke.summary.total === smoke.results.length,
    "Smoke total does not match its results",
  );
  invariant(
    smoke.summary.passed === smoke.results.length,
    "Every smoke result must pass",
  );
  invariant(smoke.summary.failed === 0, "Smoke receipt reports failures");
  const expectedIds = manifest.samples
    .filter((sample) => sample.runnability !== "requires-host-fixture-service")
    .map((sample) => sample.id)
    .sort();
  const resultIds = smoke.results.map((result) => result.id);
  invariant(
    new Set(resultIds).size === resultIds.length,
    "Smoke result ids must be unique",
  );
  invariant(
    JSON.stringify([...resultIds].sort()) === JSON.stringify(expectedIds),
    "Smoke result set does not match browser-smoke-eligible bundles",
  );
  for (const result of smoke.results) {
    exactKeys(
      result,
      [
        "id",
        "title",
        "passed",
        "requestCount",
        "network",
        "staticJourney",
        "liveProbe",
        "failures",
        "screenshot",
      ],
      `Smoke result ${result.id}`,
    );
    invariant(
      result.passed === true,
      `Smoke result did not pass: ${result.id}`,
    );
    invariant(
      Number.isSafeInteger(result.requestCount) && result.requestCount > 0,
      `Invalid request count: ${result.id}`,
    );
    exactKeys(
      result.network,
      ["offOriginRequestCount", "clientErrorResponseCount"],
      `Smoke network ${result.id}`,
    );
    invariant(
      result.network.offOriginRequestCount === 0,
      `Off-origin smoke request: ${result.id}`,
    );
    invariant(
      result.network.clientErrorResponseCount === 0,
      `Client error in smoke: ${result.id}`,
    );
    invariant(
      Array.isArray(result.failures) && result.failures.length === 0,
      `Smoke failures present: ${result.id}`,
    );
    invariant(
      result.screenshot === null,
      `Unexpected smoke screenshot: ${result.id}`,
    );
  }
  return {
    format: smoke.format,
    generatedAt: new Date(sourceDateEpoch * 1000).toISOString(),
    manifest: smoke.manifest,
    summary: smoke.summary,
    resultIds,
  };
}

export async function createAttestationReceipts({
  sourceCommit,
  sourceRoot,
  sourceDateEpoch,
  firstBundleRoot,
  secondBundleRoot,
  firstArchivePath,
  secondArchivePath,
  smokeReceiptPath,
  outputPath,
  runOutputPath,
  workflowSha,
  workflowRunId,
  workflowRunAttempt,
  runnerImage,
  runnerImageVersion,
  runnerEnvironment,
  runnerOs,
  runnerArch,
}) {
  const releaseId = releaseIdFor(sourceCommit);
  invariant(
    process.versions.node === REQUIRED_NODE_VERSION,
    `Node ${REQUIRED_NODE_VERSION} is required`,
  );
  invariant(
    workflowSha === sourceCommit,
    "Workflow and source commits must be identical",
  );
  invariant(/^\d+$/.test(workflowRunId), "Workflow run id must be numeric");
  invariant(
    /^\d+$/.test(workflowRunAttempt),
    "Workflow run attempt must be numeric",
  );
  invariant(
    Number.isSafeInteger(sourceDateEpoch) && sourceDateEpoch > 0,
    "Invalid source date epoch",
  );
  for (const [label, value] of Object.entries({
    runnerImage,
    runnerImageVersion,
    runnerEnvironment,
    runnerOs,
    runnerArch,
  })) {
    invariant(
      typeof value === "string" && value.length > 0,
      `${label} is required`,
    );
  }
  const firstManifestPath = path.join(
    firstBundleRoot,
    "sample-bundles.v2.json",
  );
  const secondManifestPath = path.join(
    secondBundleRoot,
    "sample-bundles.v2.json",
  );
  const [
    firstManifest,
    secondManifest,
    firstArchive,
    secondArchive,
    lockfile,
    rawSmoke,
  ] = await Promise.all([
    fileFact(firstManifestPath),
    fileFact(secondManifestPath),
    fileFact(firstArchivePath),
    fileFact(secondArchivePath),
    fileFact(path.join(sourceRoot, "package-lock.json")),
    fileFact(smokeReceiptPath),
  ]);
  invariant(
    firstManifest.contents.equals(secondManifest.contents),
    "Manifest builds are not byte-identical",
  );
  invariant(
    firstArchive.contents.equals(secondArchive.contents),
    "Archive builds are not byte-identical",
  );
  const manifest = JSON.parse(firstManifest.contents.toString("utf8"));
  invariant(
    manifestSourceRevision(manifest) === sourceCommit,
    "Unexpected manifest source revision",
  );
  invariant(
    manifestLockfileSha256(manifest) === lockfile.sha256,
    "Manifest lockfile digest mismatch",
  );
  const normalizedSmoke = validateSmokeReceipt(
    JSON.parse(rawSmoke.contents.toString("utf8")),
    manifest,
    sourceCommit,
    sourceDateEpoch,
  );
  const actionIdentity = {
    checkout: `actions/checkout@${ACTION_PINS.checkout}`,
    setupNode: `actions/setup-node@${ACTION_PINS.setupNode}`,
    uploadArtifact: `actions/upload-artifact@${ACTION_PINS.uploadArtifact}`,
    downloadArtifact: `actions/download-artifact@${ACTION_PINS.downloadArtifact}`,
    attestBuildProvenance: `actions/attest-build-provenance@${ACTION_PINS.attestBuildProvenance}`,
  };
  const receipt = {
    format: "honua.sdk.immutable-sample-bundle-attestation.v1",
    source: {
      repository: process.env.GITHUB_REPOSITORY ?? "honua-io/honua-sdk-js",
      commit: sourceCommit,
      ref: "refs/heads/trunk",
      sourceDateEpoch,
      lockfile: { bytes: lockfile.bytes, sha256: lockfile.sha256 },
      node: REQUIRED_NODE_VERSION,
    },
    workflow: {
      path: WORKFLOW_PATH,
      commit: workflowSha,
      actions: actionIdentity,
    },
    build: {
      cleanBuildCount: 2,
      installCommand: "npm ci",
      bundleBuildCommand: "npm run samples:bundles:build",
      bundleVerifyCommand: "npm run samples:bundles:verify",
      producerSmokeCommand: "npm run samples:bundles:smoke",
      archiveFormat: "posix-ustar",
      archiveCompression: "gzip-no-name-no-mtime-level-9",
      normalizedUid: 0,
      normalizedGid: 0,
      regularFileMode: "0644",
      directoryMode: "0755",
    },
    reproducibility: {
      manifestByteIdentical: true,
      archiveByteIdentical: true,
      fileCount: declaredBundleFiles(manifest).length,
    },
    producerSmoke: normalizedSmoke,
    publication: {
      tag: releaseId,
      immutable: true,
      ownerEnforcedImmutableReleasesRequired: true,
      assets: {
        "sample-bundles.v2.json": {
          bytes: firstManifest.bytes,
          sha256: firstManifest.sha256,
        },
        "sample-bundles.tar.gz": {
          bytes: firstArchive.bytes,
          sha256: firstArchive.sha256,
        },
      },
      githubCli: {
        version: "2.93.0",
        linuxAmd64ArchiveSha256:
          "02d1290eba130e0b896f3709ffff22e1c75a51475ddb70476a85abc6b5807af0",
      },
    },
    attestation: {
      type: "https://slsa.dev/provenance/v1",
      signer: "GitHub Actions OIDC",
      signerWorkflow: `${process.env.GITHUB_REPOSITORY ?? "honua-io/honua-sdk-js"}/${WORKFLOW_PATH}`,
      subjectFiles: RELEASE_ASSETS,
      hostedRunnerRequired: true,
    },
  };
  const immutableReceiptBytes = Buffer.from(
    `${JSON.stringify(receipt, null, 2)}\n`,
  );
  const runReceipt = {
    format: "honua.sdk.sample-bundle-publisher-run.v1",
    sourceCommit,
    workflow: {
      path: WORKFLOW_PATH,
      commit: workflowSha,
      runId: workflowRunId,
      runAttempt: workflowRunAttempt,
      actions: actionIdentity,
    },
    runner: {
      hosted: runnerEnvironment === "github-hosted",
      environment: runnerEnvironment,
      image: runnerImage,
      imageVersion: runnerImageVersion,
      os: runnerOs,
      arch: runnerArch,
    },
    inputs: {
      rawSmokeReceipt: { bytes: rawSmoke.bytes, sha256: rawSmoke.sha256 },
    },
    immutableReceipt: {
      bytes: immutableReceiptBytes.length,
      sha256: sha256Bytes(immutableReceiptBytes),
    },
  };
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, immutableReceiptBytes);
  await writeFile(runOutputPath, `${JSON.stringify(runReceipt, null, 2)}\n`);
  return { receipt, runReceipt };
}

export function classifyPublicationState(state, expected) {
  invariant(
    expected?.sourceCommit && expected?.assets,
    "Expected publication state is required",
  );
  const hasTag = state?.tagCommit !== null && state?.tagCommit !== undefined;
  const hasRelease = state?.release !== null && state?.release !== undefined;
  if (!hasTag && !hasRelease) return "create";
  invariant(hasTag && hasRelease, "Tag/release is partially present");
  invariant(state.tagCommit === expected.sourceCommit, "Tag target collision");
  invariant(state.release.draft === false, "Release must not be a draft");
  const expectedNames = Object.keys(expected.assets).sort();
  const actualNames = state.release.assets.map((asset) => asset.name).sort();
  invariant(
    JSON.stringify(actualNames) === JSON.stringify(expectedNames),
    "Release asset set differs",
  );
  for (const asset of state.release.assets) {
    const expectedAsset = expected.assets[asset.name];
    invariant(
      asset.bytes === expectedAsset.bytes,
      `Release asset size differs: ${asset.name}`,
    );
    invariant(
      asset.sha256 === expectedAsset.sha256,
      `Release asset digest differs: ${asset.name}`,
    );
  }
  return "idempotent";
}

export function validateContentAddressedWorkflowPolicy(workflow) {
  invariant(
    workflow.includes("workflow_dispatch: {}"),
    "Workflow dispatch must not accept inputs",
  );
  invariant(
    !/(?:github\.event\.)?inputs\b|\$\{\{\s*inputs\./.test(workflow),
    "Mutable inputs are forbidden",
  );
  invariant(
    /^permissions: \{\}$/m.test(workflow),
    "Global permissions must be empty",
  );
  invariant(
    workflow.includes("group: publish-content-addressed-sample-bundles"),
    "Concurrency must be global",
  );
  invariant(
    workflow.includes("SOURCE_COMMIT: ${{ github.sha }}"),
    "Source commit must be github.sha",
  );
  invariant(
    workflow.includes("RELEASE_ID: sample-bundles-${{ github.sha }}"),
    "Release id must derive from github.sha",
  );
  invariant(
    workflow.includes("runs-on: ubuntu-24.04"),
    "Runner must be pinned",
  );
  invariant(
    workflow.includes(`node-version: "${REQUIRED_NODE_VERSION}"`),
    "Node must be pinned",
  );
  invariant(
    !workflow.includes("sample-bundles-latest"),
    "Rolling tags are forbidden",
  );
  invariant(
    !workflow.includes("--clobber") && !/overwrite:\s*true/.test(workflow),
    "Overwrite is forbidden",
  );
  invariant(
    !workflow.includes("GITHUB_ENV") && !workflow.includes("GITHUB_PATH"),
    "Environment/path transfer is forbidden",
  );
  invariant(
    !/tar\s+-[^\s\n]*c[^\s\n]*f/.test(workflow),
    "Ad hoc bundle packing is forbidden",
  );
  const uses = [...workflow.matchAll(/^\s*-?\s*uses:\s*([^\s#]+).*$/gm)].map(
    (match) => match[1],
  );
  invariant(uses.length >= 7, "Expected all governed actions");
  for (const action of uses)
    invariant(
      /^[^@]+@[a-f0-9]{40}$/.test(action),
      `Unpinned action: ${action}`,
    );
  for (const [name, pin] of Object.entries(ACTION_PINS)) {
    const actionName = {
      checkout: "actions/checkout",
      setupNode: "actions/setup-node",
      uploadArtifact: "actions/upload-artifact",
      downloadArtifact: "actions/download-artifact",
      attestBuildProvenance: "actions/attest-build-provenance",
    }[name];
    invariant(
      uses.includes(`${actionName}@${pin}`),
      `Missing verified ${actionName} pin`,
    );
  }
  invariant(
    (workflow.match(/persist-credentials:\s*false/g) ?? []).length === 3,
    "Three credentialless checkouts required",
  );
  invariant(
    (workflow.match(/ref: \$\{\{ github\.sha \}\}/g) ?? []).length === 3,
    "All checkouts must use github.sha",
  );
  invariant(
    (workflow.match(/refs\/heads\/trunk/g) ?? []).length >= 3,
    "Trunk gates and attestation ref required",
  );
  invariant(
    (workflow.match(/commits\/trunk/g) ?? []).length >= 2,
    "Current trunk must be checked before build and publish",
  );
  invariant(
    (workflow.match(/samples:bundles:build/g) ?? []).length >= 2,
    "Two builds required",
  );
  invariant(
    (workflow.match(/pack-sample-bundles\.mjs/g) ?? []).length === 2,
    "Packer must run twice",
  );
  invariant(
    workflow.includes('cmp --silent "$FIRST_MANIFEST" "$SECOND_MANIFEST"'),
    "Manifest cmp required",
  );
  invariant(
    workflow.includes('cmp --silent "$FIRST_ARCHIVE" "$SECOND_ARCHIVE"'),
    "Archive cmp required",
  );
  invariant(
    (workflow.match(/\/immutable-releases/g) ?? []).length >= 2,
    "Immutable releases API must be checked before and after publish",
  );
  invariant(
    (workflow.match(/\.enabled == true and \.enforced_by_owner == true/g) ?? [])
      .length >= 2,
    "Owner enforcement must be checked before and after publish",
  );
  invariant(
    workflow.includes('--target "$SOURCE_COMMIT"'),
    "Release target must be the source commit",
  );
  invariant(
    workflow.includes("--latest=false"),
    "Content-addressed release must not be latest",
  );
  invariant(
    (workflow.match(/attestation verify/g) ?? []).length >= 2,
    "Release and run attestation verification required",
  );
  for (const flag of [
    "--signer-workflow",
    "--signer-digest",
    "--source-ref",
    "--source-digest",
    "--deny-self-hosted-runners",
    "--predicate-type",
  ]) {
    invariant(
      workflow.includes(flag),
      `Attestation verification must enforce ${flag}`,
    );
  }
  const buildStart = workflow.indexOf("  build-and-smoke:");
  const publishStart = workflow.indexOf("  attest-and-publish:");
  invariant(
    buildStart > 0 && publishStart > buildStart,
    "Separate build and publish jobs required",
  );
  const buildJob = workflow.slice(buildStart, publishStart);
  const publishJob = workflow.slice(publishStart);
  invariant(
    /permissions:\n      contents: read/.test(buildJob),
    "Build job must be read-only",
  );
  invariant(
    buildJob.includes("commits/trunk"),
    "Build job must confirm current trunk",
  );
  invariant(
    buildJob.includes('test "$GITHUB_REF" = "refs/heads/trunk"'),
    "Build job must require the trunk ref",
  );
  invariant(
    !/contents: write|id-token: write|attestations: write/.test(buildJob),
    "Build job is overprivileged",
  );
  invariant(
    /contents: write/.test(publishJob) &&
      /id-token: write/.test(publishJob) &&
      /attestations: write/.test(publishJob),
    "Publish permissions missing",
  );
  invariant(
    !/actions\/checkout@|\bnpm\b|\bnode\b|governance\/scripts|source-a|source-b/.test(
      publishJob,
    ),
    "Privileged job executes repository/build code",
  );
  invariant(
    publishJob.includes('test "$GITHUB_REF" = "refs/heads/trunk"'),
    "Publish job must require the trunk ref",
  );
  invariant(
    publishJob.indexOf("commits/trunk") <
      publishJob.indexOf("Attest exact immutable publication"),
    "Publish job must recheck current trunk before attesting",
  );
  invariant(
    publishJob.includes("actions/download-artifact@"),
    "Privileged job must redownload staged bytes",
  );
  invariant(
    (publishJob.match(/actions\/attest-build-provenance@/g) ?? []).length === 2,
    "Release and run receipts require separate attestations",
  );
  invariant(
    publishJob.indexOf("Validate staged bytes without credentials") <
      publishJob.indexOf("Expose write token"),
    "Validation must precede token exposure",
  );
  return true;
}

async function main() {
  const { command, args } = parseArguments(process.argv.slice(2));
  if (command === "receipt") {
    await createAttestationReceipts({
      sourceCommit: required(args, "source-commit"),
      sourceRoot: path.resolve(required(args, "source-root")),
      sourceDateEpoch: Number(required(args, "source-date-epoch")),
      firstBundleRoot: path.resolve(required(args, "first-bundle-root")),
      secondBundleRoot: path.resolve(required(args, "second-bundle-root")),
      firstArchivePath: path.resolve(required(args, "first-archive")),
      secondArchivePath: path.resolve(required(args, "second-archive")),
      smokeReceiptPath: path.resolve(required(args, "smoke-receipt")),
      outputPath: path.resolve(required(args, "output")),
      runOutputPath: path.resolve(required(args, "run-output")),
      workflowSha: required(args, "workflow-sha"),
      workflowRunId: required(args, "workflow-run-id"),
      workflowRunAttempt: required(args, "workflow-run-attempt"),
      runnerImage: required(args, "runner-image"),
      runnerImageVersion: required(args, "runner-image-version"),
      runnerEnvironment: required(args, "runner-environment"),
      runnerOs: required(args, "runner-os"),
      runnerArch: required(args, "runner-arch"),
    });
  } else if (command === "policy") {
    const root = path.resolve(args.get("root") ?? ".");
    validateContentAddressedWorkflowPolicy(
      await readFile(path.join(root, WORKFLOW_PATH), "utf8"),
    );
    process.stdout.write(
      "Content-addressed sample bundle workflow policy passed.\n",
    );
  } else {
    throw new Error("Expected receipt or policy command");
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
