import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readFile,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { constants as zlibConstants, gunzipSync, gzipSync } from "node:zlib";
import { parse as parseYaml } from "yaml";

import {
  ACTIONS,
  ACTION_COMMITS,
  RUN_BODY_SHA256,
  classifyReleaseState,
  createReceipts,
  normalizeSmoke,
  parseUniqueJson,
  parseCanonicalArchive,
  validateDeterministicReceipt,
  validateManifest,
  validateRunReceipt,
  validateWorkflowDocument,
  validateWorkflowFile,
} from "../../scripts/immutable-sample-bundle-attestation.mjs";
import {
  pack,
  canonicalGzip,
  snapshotRegularFile,
} from "../../scripts/pack-sample-bundles.mjs";

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const WORKFLOW = path.join(
  ROOT,
  ".github/workflows/publish-content-addressed-sample-bundles.yml",
);
const SOURCE = "a".repeat(40);
const EPOCH = 1_786_614_242;
const LOCK_BYTES = Buffer.from('{"lockfileVersion":3}\n');
const LOCK_SHA = createHash("sha256").update(LOCK_BYTES).digest("hex");

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function clone(value) {
  return structuredClone(value);
}

function fileRecord(relativePath, bytes) {
  const sha = digest(bytes);
  return {
    path: relativePath,
    bytes: bytes.length,
    sha256: sha,
    integrity: `sha256-${Buffer.from(sha, "hex").toString("base64")}`,
    mediaType: "text/plain",
  };
}

function fixtureManifest(
  fileBytes = Buffer.from("immutable bytes\n"),
  relativePath = "index.html",
  sampleId = "alpha",
) {
  return {
    format: "honua.sdk.sample-bundles.v2",
    schemaVersion: 2,
    build: { node: ">=20.19.0", lockfileSha256: LOCK_SHA },
    samples: [
      {
        id: sampleId,
        entrypoint: "index.html",
        dataMode: "fixture",
        configDefaults: {},
        runtimeHosting: "self-contained",
        runnability: "standalone",
        hostFixtureRoutes: [],
        support: {
          tier: "supported",
          track: "stable",
          validationProfile: "browser",
        },
        lifecycle: { state: "active", reason: null },
        builtFrom: { commit: SOURCE, packageVersion: "1.0.0" },
        files: [fileRecord(relativePath, fileBytes)],
      },
    ],
    excluded: [
      {
        id: "excluded",
        category: "not-runtime",
        reason: "not a runtime sample",
      },
    ],
  };
}

function fixtureSmoke(sampleId = "alpha") {
  return {
    format: "honua.sdk.sample-bundle-browser-smoke.v1",
    generatedAt: new Date(EPOCH * 1000).toISOString(),
    manifest: {
      format: "honua.sdk.sample-bundles.v2",
      schemaVersion: 2,
      commit: SOURCE,
    },
    summary: { total: 1, passed: 1, failed: 0 },
    results: [
      {
        id: sampleId,
        title: "Alpha",
        passed: true,
        requestCount: 2,
        network: { offOriginRequestCount: 0, clientErrorResponseCount: 0 },
        staticJourney: null,
        liveProbe: null,
        failures: [],
        screenshot: null,
      },
    ],
  };
}

async function fixtureRoot(relativePath = "index.html", sampleId = "alpha") {
  const root = await mkdtemp(path.join(os.tmpdir(), "immutable-bundle-"));
  const bundleRoot = path.join(root, "bundles");
  await mkdir(path.join(bundleRoot, sampleId), { recursive: true });
  const bytes = Buffer.from("immutable bytes\n");
  const manifest = fixtureManifest(bytes, relativePath, sampleId);
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(
    path.join(bundleRoot, "sample-bundles.v2.json"),
    manifestBytes,
  );
  const target = path.join(bundleRoot, sampleId, ...relativePath.split("/"));
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, bytes);
  return { root, bundleRoot, manifest, manifestBytes, bytes };
}

async function canonicalFixture(
  relativePath = "index.html",
  sampleId = "alpha",
) {
  const fixture = await fixtureRoot(relativePath, sampleId);
  const archivePath = path.join(fixture.root, "sample-bundles.tar.gz");
  const metadataPath = path.join(fixture.root, "pack.json");
  const metadata = await pack({
    bundleRoot: fixture.bundleRoot,
    output: archivePath,
    sourceCommit: SOURCE,
    sourceDateEpoch: EPOCH,
  });
  await writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
  return {
    ...fixture,
    archivePath,
    archive: await readFile(archivePath),
    metadataPath,
    metadata,
  };
}

function recalculateChecksum(header) {
  header.fill(0x20, 148, 156);
  const checksum = header
    .reduce((sum, byte) => sum + byte, 0)
    .toString(8)
    .padStart(6, "0");
  header.write(checksum, 148, 6, "ascii");
  header[154] = 0;
  header[155] = 0x20;
}

function tarEntries(tar) {
  const entries = [];
  let offset = 0;
  while (!tar.subarray(offset, offset + 512).every((byte) => byte === 0)) {
    const header = tar.subarray(offset, offset + 512);
    const size = Number.parseInt(
      header.subarray(124, 135).toString("ascii"),
      8,
    );
    const length = 512 + size + ((512 - (size % 512)) % 512);
    entries.push(Buffer.from(tar.subarray(offset, offset + length)));
    offset += length;
  }
  return entries;
}

function mutatedArchive(archive, mutate) {
  const tar = Buffer.from(gunzipSync(archive));
  mutate(tar);
  return canonicalGzip(tar);
}

function alternateDeflateArchive(archive) {
  const result = gzipSync(gunzipSync(archive), {
    level: 9,
    mtime: 0,
    strategy: zlibConstants.Z_HUFFMAN_ONLY,
  });
  result[8] = 0;
  result[9] = 3;
  return result;
}

async function publicationFixture(
  relativePath = "index.html",
  sampleId = "alpha",
  smoke = fixtureSmoke(sampleId),
) {
  const fixture = await canonicalFixture(relativePath, sampleId);
  const smokeBytes = Buffer.from(`${JSON.stringify(smoke, null, 2)}\n`);
  const smokePath = path.join(fixture.root, "browser-smoke.v1.json");
  const lockPath = path.join(fixture.root, "package-lock.json");
  const deterministicPath = path.join(
    fixture.root,
    "sample-bundles-attestation.v1.json",
  );
  const runPath = path.join(
    fixture.root,
    "sample-bundles-run-attestation.v1.json",
  );
  await writeFile(smokePath, smokeBytes);
  await writeFile(lockPath, LOCK_BYTES);
  await createReceipts({
    manifest: path.join(fixture.bundleRoot, "sample-bundles.v2.json"),
    archive: fixture.archivePath,
    packMetadata: fixture.metadataPath,
    smokeReceipt: smokePath,
    lockfile: lockPath,
    deterministicReceipt: deterministicPath,
    runReceipt: runPath,
    sourceCommit: SOURCE,
    sourceDateEpoch: EPOCH,
    repository: "honua-io/honua-sdk-js",
    workflowRef: "refs/heads/trunk",
    runId: "123",
    runAttempt: "2",
    runnerName: "GitHub Actions 1",
    runnerEnvironment: "github-hosted",
    runnerOs: "Linux",
    runnerArch: "X64",
    runnerImage: "ubuntu24",
    runnerImageVersion: "20260801.1",
  });
  const staged = path.join(fixture.root, "staged");
  await mkdir(staged);
  const files = {
    "sample-bundles.v2.json": fixture.manifestBytes,
    "sample-bundles.tar.gz": fixture.archive,
    "sample-bundles-attestation.v1.json": await readFile(deterministicPath),
    "sample-bundles-run-attestation.v1.json": await readFile(runPath),
    "browser-smoke.v1.json": smokeBytes,
    "pack-metadata.v1.json": await readFile(fixture.metadataPath),
  };
  for (const [name, bytes] of Object.entries(files))
    await writeFile(path.join(staged, name), bytes);
  return { ...fixture, staged, files };
}

async function bindRawSmokeMutation(fixture, smoke) {
  const smokeBytes = Buffer.from(`${JSON.stringify(smoke, null, 2)}\n`);
  const deterministicPath = path.join(
    fixture.staged,
    "sample-bundles-attestation.v1.json",
  );
  const runPath = path.join(
    fixture.staged,
    "sample-bundles-run-attestation.v1.json",
  );
  const deterministic = JSON.parse(await readFile(deterministicPath, "utf8"));
  deterministic.smoke.rawSha256 = digest(smokeBytes);
  const deterministicBytes = Buffer.from(
    `${JSON.stringify(deterministic, null, 2)}\n`,
  );
  const run = JSON.parse(await readFile(runPath, "utf8"));
  run.deterministicReceiptSha256 = digest(deterministicBytes);
  await writeFile(
    path.join(fixture.staged, "browser-smoke.v1.json"),
    smokeBytes,
  );
  await writeFile(deterministicPath, deterministicBytes);
  await writeFile(runPath, `${JSON.stringify(run, null, 2)}\n`);
}

async function bindArchiveMutation(fixture, archive) {
  const deterministicPath = path.join(
    fixture.staged,
    "sample-bundles-attestation.v1.json",
  );
  const runPath = path.join(
    fixture.staged,
    "sample-bundles-run-attestation.v1.json",
  );
  const deterministic = JSON.parse(await readFile(deterministicPath, "utf8"));
  deterministic.publication.assets["sample-bundles.tar.gz"] = {
    bytes: archive.length,
    sha256: digest(archive),
  };
  const deterministicBytes = Buffer.from(
    `${JSON.stringify(deterministic, null, 2)}\n`,
  );
  const run = JSON.parse(await readFile(runPath, "utf8"));
  run.deterministicReceiptSha256 = digest(deterministicBytes);
  await writeFile(path.join(fixture.staged, "sample-bundles.tar.gz"), archive);
  await writeFile(deterministicPath, deterministicBytes);
  await writeFile(runPath, `${JSON.stringify(run, null, 2)}\n`);
}

async function restoreBoundReceipts(fixture) {
  for (const name of [
    "sample-bundles-attestation.v1.json",
    "sample-bundles-run-attestation.v1.json",
  ])
    await writeFile(path.join(fixture.staged, name), fixture.files[name]);
}

async function privilegedPython() {
  const workflow = parseYaml(await readFile(WORKFLOW, "utf8"));
  const run = workflow.jobs["attest-and-publish"].steps.find(
    (step) => step.name === "Validate all bytes before tokens",
  ).run;
  const match = /python3 - <<'PY'\n([\s\S]+)\nPY\n?$/u.exec(run);
  assert.ok(match, "privileged inline Python heredoc is missing");
  return match[1];
}

async function runPrivilegedValidator(fixture) {
  const python = process.platform === "win32" ? "python" : "python3";
  return execFileSync(python, ["-c", await privilegedPython()], {
    cwd: fixture.root,
    env: {
      ...process.env,
      SOURCE_COMMIT: SOURCE,
      EXPECTED_LOCKFILE_SHA256: LOCK_SHA,
      GITHUB_REPOSITORY: "honua-io/honua-sdk-js",
      GITHUB_RUN_ID: "123",
      GITHUB_RUN_ATTEMPT: "2",
    },
    stdio: "pipe",
  });
}

function duplicateRoot(bytes, key) {
  assert.equal(bytes[0], "{".charCodeAt(0), "JSON fixture must be an object");
  return Buffer.concat([
    Buffer.from(`{${JSON.stringify(key)}:null,`),
    bytes.subarray(1),
  ]);
}

function duplicateNested(bytes, needle, key, replacement = "null") {
  const text = bytes.toString("utf8");
  assert.ok(
    text.includes(needle),
    `missing duplicate fixture needle ${needle}`,
  );
  return Buffer.from(
    text.replace(needle, `${needle}${JSON.stringify(key)}:${replacement},`),
  );
}

function replaceJson(bytes, needle, replacement) {
  const text = bytes.toString("utf8");
  assert.ok(text.includes(needle), `missing JSON fixture needle ${needle}`);
  return Buffer.from(text.replace(needle, replacement));
}

function coverageSmokeJourney() {
  const mounted = (protocol) => ({
    protocol,
    sourceId: `${protocol}-elevation`,
    sourceMounted: true,
    layerMounted: true,
  });
  const protocol = (name) => ({
    mounted: mounted(name),
    cancellation: { status: "cancelled", activeProtocol: name },
    degradation: {
      status: "degraded",
      code: "InvalidParameterValue",
      activeProtocol: name,
    },
  });
  return {
    ogc: protocol("ogc"),
    wcs: protocol("wcs"),
    requestProof: {
      allVirtualFixture: true,
      ogcSuccess: true,
      ogcCancellation: true,
      ogcDegradation: true,
      wcsSuccess: true,
      wcsCancellation: true,
      wcsDegradation: true,
    },
    beforeDispose: {
      ready: true,
      phase: "degraded",
      fixtureDigest:
        "8c7b5b3f8bd31bca2df07c4a70254d75e70d63838c2f77e033def3c1b8d2acff",
      ogcByteLength: 281_908,
      wcsByteLength: 281_908,
      imageWidth: 320,
      imageHeight: 220,
      centerPixelValue: 450,
      centerPixelColor: [221, 174, 82],
      cancellationCount: 2,
      degradationCount: 2,
      requestCount: 12,
      objectUrlsUnique: true,
      switchedObjectUrlRevoked: true,
      activeObjectUrl: "blob:http://127.0.0.1:1234/canonical",
      protocol: "wcs",
      sourceId: "wcs-elevation",
      sourceMounted: true,
      layerMounted: true,
    },
    disposal: {
      disposed: true,
      ready: false,
      sourceId: null,
      activeObjectUrl: null,
      sourceCleanupVerified: true,
      mapRemoved: true,
      canvasCount: 0,
      revokedBothObjectUrls: true,
      revokedObjectUrlCount: 2,
    },
    visibleEvidence: {
      canvasCount: 1,
      legend: "0 m to 600 m",
      pixel: "450 m",
    },
  };
}

test("all actions are exact commit pins and attestation uses the verified object", () => {
  assert.equal(
    ACTIONS.attestBuildProvenance,
    "actions/attest-build-provenance@4d101475d8b20a2381f78447822ac1eab6504dd8",
  );
  for (const [repository, commit] of ACTION_COMMITS) {
    assert.match(repository, /^[a-z0-9-]+\/[a-z0-9-]+$/u);
    assert.match(commit, /^[0-9a-f]{40}$/u);
  }
});

test("the actual workflow passes parsed structural policy", async () => {
  await validateWorkflowFile(WORKFLOW);
});

test("the pinned lockfile digest still matches the committed lockfile", async () => {
  // The privileged publish job never checks out source, so it can only judge
  // the manifest's `build.lockfileSha256` against a constant carried in the
  // workflow file itself. That constant therefore goes stale on every
  // dependency bump, and until this guard existed it went stale *silently* —
  // publication only discovered it at dispatch, months later
  // (honua-io/honua-sdk-js#1325). Deliberately a hard failure: the pin has to
  // move in the same change that moves the lockfile.
  const actual = createHash("sha256")
    .update(await readFile(path.join(ROOT, "package-lock.json")))
    .digest("hex");
  const workflow = parseYaml(await readFile(WORKFLOW, "utf8"));
  const pinned = workflow.jobs["attest-and-publish"].steps[1].env
    .EXPECTED_LOCKFILE_SHA256;
  assert.equal(
    pinned,
    actual,
    `package-lock.json now hashes to ${actual}. Update EXPECTED_LOCKFILE_SHA256 in ` +
      `.github/workflows/publish-content-addressed-sample-bundles.yml and the bound copy in ` +
      `scripts/immutable-sample-bundle-attestation.mjs, or sample-bundle publication will fail at dispatch.`,
  );
  // The policy validator binds the same constant; both copies must agree.
  await validateWorkflowFile(WORKFLOW);
});

test("receipts are generated from a checkout with no installed dependencies", async (context) => {
  // The publisher runs `receipt` out of the pristine `governance/` checkout,
  // which is deliberately never `npm ci`-installed, so the receipt path must
  // resolve against builtins alone. A static `yaml` import made every
  // publication die with ERR_MODULE_NOT_FOUND before it produced a single
  // receipt (honua-io/honua-sdk-js#1325, run 31972413231).
  const scratch = await mkdtemp(path.join(os.tmpdir(), "honua-governance-"));
  context.after(() => rm(scratch, { recursive: true, force: true }));
  // Only `scripts/` has to be a real copy — it is what module resolution walks
  // up from, and nothing above the scratch directory provides `node_modules`.
  // Data roots the graph reads at import time are symlinked, so the tree stays
  // faithful to a full checkout without copying 65 MB of samples.
  execFileSync("cp", [
    "-R",
    path.join(ROOT, "scripts"),
    path.join(scratch, "scripts"),
  ]);
  await symlink(path.join(ROOT, "samples"), path.join(scratch, "samples"));

  // Prove the isolation is real rather than a vacuous pass: a bare specifier
  // genuinely cannot resolve from there.
  assert.throws(() =>
    execFileSync(
      process.execPath,
      ["--input-type=module", "-e", "await import('yaml');"],
      { cwd: scratch, stdio: "pipe" },
    ),
  );

  const entrypoint = path.join(
    scratch,
    "scripts/immutable-sample-bundle-attestation.mjs",
  );
  let status = 0;
  let stderr = "";
  try {
    execFileSync(process.execPath, [entrypoint, "receipt"], {
      cwd: scratch,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    status = error.status;
    stderr = String(error.stderr);
  }

  // It must fail on its arguments — that is proof the whole module graph
  // loaded — and never on module resolution.
  assert.equal(status, 1);
  assert.doesNotMatch(stderr, /ERR_MODULE_NOT_FOUND/u);
  assert.match(stderr, /--manifest is required/u);
});

test("structural policy rejects syntax mutations rather than comments", async () => {
  const workflow = parseYaml(await readFile(WORKFLOW, "utf8"));
  const mutations = {
    "global permission": (value) => (value.permissions.contents = "read"),
    "extra job": (value) =>
      (value.jobs.extra = clone(value.jobs["build-and-smoke"])),
    "wrong runner": (value) =>
      (value.jobs["build-and-smoke"]["runs-on"] = "ubuntu-latest"),
    "widened privileged permission": (value) =>
      (value.jobs["attest-and-publish"].permissions.packages = "write"),
    "wrong dependency": (value) =>
      (value.jobs["attest-and-publish"].needs = "other"),
    "unpinned action": (value) =>
      (value.jobs["build-and-smoke"].steps[1].uses = "actions/checkout@v4"),
    "old attest commit": (value) =>
      (value.jobs["attest-and-publish"].steps[3].uses =
        "actions/attest-build-provenance@43d14bc2b83dec42d39ecae14e916627a18bb661"),
    "extra checkout": (value) =>
      value.jobs["build-and-smoke"].steps.splice(
        4,
        0,
        clone(value.jobs["build-and-smoke"].steps[1]),
      ),
    "early SHA bypass": (value) =>
      (value.jobs["build-and-smoke"].steps[0].run = "true"),
    "comment-only run mutation": (value) =>
      (value.jobs["build-and-smoke"].steps[5].run += "\n# harmless-looking"),
    "no-op run mutation": (value) =>
      (value.jobs["build-and-smoke"].steps[6].run += "\ntrue"),
    "privileged additive run mutation": (value) =>
      (value.jobs["attest-and-publish"].steps[1].run += "\n:"),
    "rolling target": (value) =>
      (value.jobs["attest-and-publish"].steps[7].run +=
        "\necho sample-bundles-latest"),
    "late SHA after create": (value) => {
      const step = value.jobs["attest-and-publish"].steps[7];
      const gate =
        'CURRENT_SHA="$($GH api "repos/$GITHUB_REPOSITORY/commits/trunk" --jq .sha)"\n    test "$CURRENT_SHA" = "$SOURCE_COMMIT"';
      step.run = `${step.run.replace(gate, "")}\n${gate}\n`;
    },
  };
  for (const [label, mutate] of Object.entries(mutations)) {
    const changed = clone(workflow);
    mutate(changed);
    assert.throws(() => validateWorkflowDocument(changed), undefined, label);
  }
});

test("every governed shell body is bound to an exact SHA-256", async () => {
  const workflow = parseYaml(await readFile(WORKFLOW, "utf8"));
  const actual = Object.fromEntries(
    Object.entries(workflow.jobs).flatMap(([jobName, job]) =>
      job.steps
        .filter((step) => typeof step.run === "string")
        .map((step) => [`${jobName}/${step.name}`, digest(step.run)]),
    ),
  );
  assert.deepEqual(actual, RUN_BODY_SHA256);
});

test("action resolver requires exact commit objects and verified attest commit", async () => {
  const workflow = parseYaml(await readFile(WORKFLOW, "utf8"));
  const exact = (_repository, commit) => ({
    type: "commit",
    sha: commit,
    verified: true,
  });
  assert.equal(
    validateWorkflowDocument(workflow, { resolveAction: exact }),
    true,
  );
  assert.throws(() =>
    validateWorkflowDocument(workflow, {
      resolveAction: (_repository, commit) => ({
        type: "tag",
        sha: commit,
        verified: true,
      }),
    }),
  );
  assert.throws(() =>
    validateWorkflowDocument(workflow, {
      resolveAction: (_repository, commit) => ({
        type: "commit",
        sha: commit,
        verified: false,
      }),
    }),
  );
});

test("packer builds byte-identical canonical archives and native tar reads them", async (context) => {
  const first = await canonicalFixture();
  context.after(() => rm(first.root, { recursive: true, force: true }));
  const secondPath = path.join(first.root, "second.tar.gz");
  const opened = [];
  await pack({
    bundleRoot: first.bundleRoot,
    output: secondPath,
    sourceCommit: SOURCE,
    sourceDateEpoch: EPOCH,
    afterOpen: ({ filePath }) => opened.push(filePath),
  });
  assert.deepEqual(await readFile(secondPath), first.archive);
  assert.deepEqual(
    [...first.archive.subarray(0, 10)],
    [0x1f, 0x8b, 0x08, 0, 0, 0, 0, 0, 0, 3],
  );
  assert.equal(opened.length, 2);
  assert.deepEqual(
    parseCanonicalArchive(first.archive, {
      manifestBytes: first.manifestBytes,
      manifest: first.manifest,
      sourceDateEpoch: EPOCH,
    }),
    { fileCount: 2, memberCount: 3 },
  );
  const listing = execFileSync("tar", ["-tzf", first.archivePath], {
    encoding: "utf8",
  })
    .trim()
    .split(/\r?\n/u)
    .map((entry) => entry.replace(/\/$/u, ""));
  assert.deepEqual(listing, [
    "alpha",
    "alpha/index.html",
    "sample-bundles.v2.json",
  ]);
});

test("open-once snapshot rejects pathname and type swaps", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "snapshot-swap-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const target = path.join(root, "target");
  const saved = path.join(root, "saved");
  await writeFile(target, "original");
  await assert.rejects(
    snapshotRegularFile(target, {
      afterOpen: async () => {
        await rename(target, saved);
        await writeFile(target, "replaced");
      },
    }),
  );
  await unlink(target);
  await rename(saved, target);
  await assert.rejects(
    snapshotRegularFile(target, {
      afterOpen: async () => {
        await rename(target, saved);
        await mkdir(target);
      },
    }),
  );
});

test("canonical parser rejects native tar, path, type, metadata, ordering, and gzip mutations", async (context) => {
  const fixture = await canonicalFixture();
  context.after(() => rm(fixture.root, { recursive: true, force: true }));
  const mutateHeader = (change, index = 0) =>
    mutatedArchive(fixture.archive, (tar) => {
      const entries = tarEntries(tar);
      const header = entries[index].subarray(0, 512);
      change(header);
      recalculateChecksum(header);
      Buffer.concat([...entries, Buffer.alloc(1024)]).copy(tar);
    });
  const writeName = (value) => (header) => {
    header.fill(0, 0, 100);
    header.write(value, 0, "utf8");
  };
  const mutations = [
    mutateHeader(writeName("/absolute/")),
    mutateHeader(writeName("../traversal/")),
    mutateHeader(writeName("back\\slash/")),
    mutateHeader(writeName("control\u0001/")),
    mutateHeader((header) => (header[156] = "2".charCodeAt(0))),
    mutateHeader((header) => (header[156] = "x".charCodeAt(0))),
    mutateHeader((header) => (header[156] = "L".charCodeAt(0))),
    mutateHeader((header) => (header[156] = "3".charCodeAt(0))),
    mutateHeader((header) => (header[156] = "6".charCodeAt(0))),
    mutateHeader((header) => header.write("0000777", 100, "ascii")),
    mutateHeader((header) => header.write("0000001", 108, "ascii")),
    mutateHeader((header) => header.write("0000001", 116, "ascii")),
    mutateHeader((header) => header.write("00000000001", 136, "ascii")),
    mutateHeader((header) => header.write("target", 157, "ascii")),
    mutateHeader((header) => (header[500] = 1)),
    mutateHeader((header) => (header[511] = 1)),
    mutatedArchive(fixture.archive, (tar) => {
      const entries = tarEntries(tar);
      Buffer.concat([
        entries[1],
        entries[0],
        ...entries.slice(2),
        Buffer.alloc(1024),
      ]).copy(tar);
    }),
    mutatedArchive(fixture.archive, (tar) => {
      const entries = tarEntries(tar);
      Buffer.concat([
        entries[0],
        entries[0],
        ...entries.slice(1),
        Buffer.alloc(1024),
      ]).copy(tar);
    }),
  ];
  const badGzip = Buffer.from(fixture.archive);
  badGzip[3] = 8;
  mutations.push(badGzip);
  mutations.push(alternateDeflateArchive(fixture.archive));
  for (const archive of mutations)
    assert.throws(() => parseCanonicalArchive(archive, fixture));
});

test("actual privileged inline validator accepts canonical bytes and rejects hostile archives", async (context) => {
  const fixture = await publicationFixture();
  context.after(() => rm(fixture.root, { recursive: true, force: true }));
  assert.match((await runPrivilegedValidator(fixture)).toString(), /PASS/u);
  const archivePath = path.join(fixture.staged, "sample-bundles.tar.gz");
  const mutateHeader = (change, index = 0) =>
    mutatedArchive(fixture.archive, (tar) => {
      const entries = tarEntries(tar);
      const header = entries[index].subarray(0, 512);
      change(header);
      recalculateChecksum(header);
      Buffer.concat([...entries, Buffer.alloc(1024)]).copy(tar);
    });
  const hostile = [
    mutateHeader((header) => (header[500] = 1)),
    mutateHeader((header) => (header[511] = 1)),
    mutateHeader((header) => (header[156] = "x".charCodeAt(0))),
    mutateHeader((header) => (header[156] = "L".charCodeAt(0))),
    mutateHeader((header) => header.write("bsdtar", 265, "ascii")),
    alternateDeflateArchive(fixture.archive),
    mutatedArchive(fixture.archive, (tar) => {
      const entries = tarEntries(tar);
      entries[1][512] ^= 1;
      Buffer.concat([...entries, Buffer.alloc(1024)]).copy(tar);
    }),
  ];
  for (const archive of hostile) {
    await bindArchiveMutation(fixture, archive);
    await assert.rejects(runPrivilegedValidator(fixture));
    await restoreBoundReceipts(fixture);
  }
  await writeFile(archivePath, fixture.archive);
});

test("actual privileged inline validator rejects bound hostile nested smoke bytes", async (context) => {
  const smoke = fixtureSmoke("coverages-wcs-basic");
  smoke.results[0].staticJourney = coverageSmokeJourney();
  const fixture = await publicationFixture(
    "index.html",
    "coverages-wcs-basic",
    smoke,
  );
  context.after(() => rm(fixture.root, { recursive: true, force: true }));
  assert.match((await runPrivilegedValidator(fixture)).toString(), /PASS/u);
  const mutations = [
    (value) => (value.results[0].staticJourney.ogc.mounted.extra = true),
    (value) => (value.results[0].staticJourney.ogc.cancellation = null),
    (value) =>
      (value.results[0].staticJourney.requestProof.wcsSuccess = "true"),
    (value) => (value.results[0].staticJourney.beforeDispose.phase = "ready"),
    (value) => (value.results[0].staticJourney.visibleEvidence.pixel = "451 m"),
  ];
  for (const mutate of mutations) {
    const changed = clone(smoke);
    mutate(changed);
    await bindRawSmokeMutation(fixture, changed);
    await assert.rejects(runPrivilegedValidator(fixture));
    await restoreBoundReceipts(fixture);
  }
});

test("actual privileged inline validator rejects root and nested duplicates in all five JSON documents", async (context) => {
  const fixture = await publicationFixture();
  context.after(() => rm(fixture.root, { recursive: true, force: true }));
  const cases = [
    [
      "sample-bundles.v2.json",
      "format",
      (bytes) => duplicateNested(bytes, '"build": {\n', "node"),
    ],
    [
      "browser-smoke.v1.json",
      "format",
      (bytes) => duplicateNested(bytes, '"results": [\n    {\n', "id"),
    ],
    [
      "sample-bundles-attestation.v1.json",
      "schema",
      (bytes) => duplicateNested(bytes, '"source": {\n', "commit"),
    ],
    [
      "sample-bundles-run-attestation.v1.json",
      "schema",
      (bytes) => duplicateNested(bytes, '"workflow": {\n', "ref"),
    ],
    [
      "pack-metadata.v1.json",
      "schema",
      (bytes) =>
        replaceJson(
          bytes,
          `"sourceCommit": "${SOURCE}"`,
          '"sourceCommit": {"value":1,"value":2}',
        ),
    ],
  ];
  for (const [name, rootKey, nestedMutation] of cases) {
    const original = fixture.files[name];
    for (const hostile of [
      duplicateRoot(original, rootKey),
      nestedMutation(original),
    ]) {
      await writeFile(path.join(fixture.staged, name), hostile);
      await assert.rejects(runPrivilegedValidator(fixture));
    }
    await writeFile(path.join(fixture.staged, name), original);
  }
});

test("canonical ustar name-prefix split is unique in both validators", async (context) => {
  const first = "a".repeat(40);
  const second = "b".repeat(40);
  const leaf = `${"c".repeat(30)}.txt`;
  const relativePath = `${first}/${second}/${leaf}`;
  const fixture = await publicationFixture(relativePath);
  context.after(() => rm(fixture.root, { recursive: true, force: true }));
  assert.match((await runPrivilegedValidator(fixture)).toString(), /PASS/u);
  const hostile = mutatedArchive(fixture.archive, (tar) => {
    const entries = tarEntries(tar);
    const header = entries[3].subarray(0, 512);
    header.fill(0, 0, 100);
    header.write(`${second}/${leaf}`, 0, "utf8");
    header.fill(0, 345, 500);
    header.write(`alpha/${first}`, 345, "utf8");
    recalculateChecksum(header);
    Buffer.concat([...entries, Buffer.alloc(1024)]).copy(tar);
  });
  assert.throws(() =>
    parseCanonicalArchive(hostile, {
      manifestBytes: fixture.manifestBytes,
      manifest: fixture.manifest,
      sourceDateEpoch: EPOCH,
    }),
  );
  await bindArchiveMutation(fixture, hostile);
  await assert.rejects(runPrivilegedValidator(fixture));
});

test("native PAX and platform tar streams are hostile fixtures for both validators", async (context) => {
  const fixture = await publicationFixture();
  context.after(() => rm(fixture.root, { recursive: true, force: true }));
  const nativeRoot = path.join(fixture.root, "native");
  await mkdir(nativeRoot);
  await writeFile(path.join(nativeRoot, `${"n".repeat(140)}.txt`), "native\n");
  const formats = [
    ["pax", ["--format", "pax"]],
    process.platform === "win32"
      ? ["bsdtar", []]
      : ["gnu", ["--format", "gnu"]],
  ];
  for (const [format, formatArguments] of formats) {
    const tarPath = path.join(fixture.root, `native-${format}.tar`);
    execFileSync(
      "tar",
      [...formatArguments, "-cf", tarPath, "-C", nativeRoot, "."],
      { stdio: "pipe" },
    );
    const archive = gzipSync(await readFile(tarPath), { level: 9, mtime: 0 });
    archive[8] = 0;
    archive[9] = 3;
    assert.throws(() =>
      parseCanonicalArchive(archive, {
        manifestBytes: fixture.manifestBytes,
        manifest: fixture.manifest,
        sourceDateEpoch: EPOCH,
      }),
    );
    await bindArchiveMutation(fixture, archive);
    await assert.rejects(runPrivilegedValidator(fixture));
    await restoreBoundReceipts(fixture);
  }
});

test("manifest and nested smoke schemas reject extras, wrong types, enums, and ranges", () => {
  const manifest = fixtureManifest();
  validateManifest(manifest, {
    sourceCommit: SOURCE,
    lockfileSha256: LOCK_SHA,
  });
  const manifestMutations = [
    (value) => (value.extra = true),
    (value) => (value.samples[0].builtFrom.commit = "b".repeat(40)),
    (value) => (value.samples[0].files[0].bytes = -1),
    (value) => (value.samples[0].files[0].path = "../escape"),
    (value) => (value.samples[0].runnability = "standalone-ish"),
    (value) => (value.build.lockfileSha256 = "0".repeat(64)),
  ];
  for (const mutate of manifestMutations) {
    const changed = clone(manifest);
    mutate(changed);
    assert.throws(() =>
      validateManifest(changed, {
        sourceCommit: SOURCE,
        lockfileSha256: LOCK_SHA,
      }),
    );
  }

  const smoke = fixtureSmoke();
  normalizeSmoke(smoke, manifest, SOURCE, EPOCH);
  const smokeMutations = [
    (value) => (value.extra = true),
    (value) => (value.results[0].network.extra = 0),
    (value) => (value.results[0].requestCount = 0),
    (value) => (value.results[0].staticJourney = {}),
    (value) => (value.results[0].liveProbe = { passed: true }),
    (value) => (value.summary.failed = 1),
    (value) => (value.results[0].failures = ["failure"]),
  ];
  for (const mutate of smokeMutations) {
    const changed = clone(smoke);
    mutate(changed);
    assert.throws(() => normalizeSmoke(changed, manifest, SOURCE, EPOCH));
  }
});

test("coverage and live smoke proofs reject hostile recursive mutations", () => {
  const coverageManifest = fixtureManifest();
  coverageManifest.samples[0].id = "coverages-wcs-basic";
  const coverage = fixtureSmoke();
  coverage.results[0].id = "coverages-wcs-basic";
  coverage.results[0].staticJourney = coverageSmokeJourney();
  normalizeSmoke(coverage, coverageManifest, SOURCE, EPOCH);
  const coverageMutations = [
    (value) => (value.results[0].staticJourney.ogc.mounted.extra = true),
    (value) => (value.results[0].staticJourney.ogc.cancellation.status = null),
    (value) =>
      (value.results[0].staticJourney.requestProof.wcsSuccess = "true"),
    (value) =>
      (value.results[0].staticJourney.beforeDispose.centerPixelColor = [
        221, 174,
      ]),
    (value) =>
      (value.results[0].staticJourney.disposal.revokedObjectUrlCount = 1),
    (value) => (value.results[0].staticJourney.visibleEvidence.pixel = "451 m"),
  ];
  for (const mutate of coverageMutations) {
    const changed = clone(coverage);
    mutate(changed);
    assert.throws(() =>
      normalizeSmoke(changed, coverageManifest, SOURCE, EPOCH),
    );
  }

  const liveManifest = fixtureManifest();
  liveManifest.samples[0].id = "service-explorer";
  liveManifest.samples[0].runtimeHosting = "external-live-endpoint";
  liveManifest.samples[0].runnability = "requires-live-endpoint";
  const live = fixtureSmoke();
  live.results[0].id = "service-explorer";
  live.results[0].liveProbe = {
    passed: true,
    origin: "https://demo.pygeoapi.io",
    status: 200,
    semantic: "geojson-feature-collection",
    featureCount: 1,
  };
  normalizeSmoke(live, liveManifest, SOURCE, EPOCH);
  for (const mutate of [
    (value) => (value.results[0].liveProbe.origin = "https://example.invalid"),
    (value) => (value.results[0].liveProbe.status = "200"),
    (value) => (value.results[0].liveProbe.featureCount = 0),
    (value) => (value.results[0].liveProbe.extra = true),
  ]) {
    const changed = clone(live);
    mutate(changed);
    assert.throws(() => normalizeSmoke(changed, liveManifest, SOURCE, EPOCH));
  }
});

test("receipts bind exact bytes, deterministic metadata, run metadata, and strict keysets", async (context) => {
  const fixture = await canonicalFixture();
  context.after(() => rm(fixture.root, { recursive: true, force: true }));
  const smokePath = path.join(fixture.root, "smoke.json");
  const lockPath = path.join(fixture.root, "package-lock.json");
  const deterministicPath = path.join(
    fixture.root,
    "sample-bundles-attestation.v1.json",
  );
  const runPath = path.join(
    fixture.root,
    "sample-bundles-run-attestation.v1.json",
  );
  await writeFile(smokePath, `${JSON.stringify(fixtureSmoke(), null, 2)}\n`);
  await writeFile(lockPath, LOCK_BYTES);
  const { deterministic, run } = await createReceipts({
    manifest: path.join(fixture.bundleRoot, "sample-bundles.v2.json"),
    archive: fixture.archivePath,
    packMetadata: fixture.metadataPath,
    smokeReceipt: smokePath,
    lockfile: lockPath,
    deterministicReceipt: deterministicPath,
    runReceipt: runPath,
    sourceCommit: SOURCE,
    sourceDateEpoch: EPOCH,
    repository: "honua-io/honua-sdk-js",
    workflowRef: "refs/heads/trunk",
    runId: "123",
    runAttempt: "2",
    runnerName: "GitHub Actions 1",
    runnerEnvironment: "github-hosted",
    runnerOs: "Linux",
    runnerArch: "X64",
    runnerImage: "ubuntu24",
    runnerImageVersion: "20260801.1",
  });
  const deterministicText = await readFile(deterministicPath, "utf8");
  assert.doesNotMatch(
    deterministicText,
    /runId|runAttempt|generatedAt|runner/u,
  );
  validateDeterministicReceipt(deterministic, {
    sourceCommit: SOURCE,
    sourceDateEpoch: EPOCH,
    lockfileSha256: LOCK_SHA,
  });
  validateRunReceipt(run, {
    sourceCommit: SOURCE,
    deterministicSha256: digest(Buffer.from(deterministicText)),
  });

  for (const mutate of [
    (value) => (value.extra = true),
    (value) => (value.build.actions.checkout = "actions/checkout@v4"),
    (value) => (value.publication.assets["sample-bundles.tar.gz"].bytes = -1),
    (value) => (value.smoke.results[0].liveProbe.status = "passed"),
  ]) {
    const changed = clone(deterministic);
    mutate(changed);
    assert.throws(() =>
      validateDeterministicReceipt(changed, {
        sourceCommit: SOURCE,
        sourceDateEpoch: EPOCH,
        lockfileSha256: LOCK_SHA,
      }),
    );
  }
  for (const mutate of [
    (value) => (value.extra = true),
    (value) => (value.sourceCommit = "b".repeat(40)),
    (value) => (value.workflow.runAttempt = 3),
    (value) => (value.runner.extra = "bad"),
    (value) => (value.actions.attestBuildProvenance = ACTIONS.checkout),
  ]) {
    const changed = clone(run);
    mutate(changed);
    assert.throws(() =>
      validateRunReceipt(changed, {
        sourceCommit: SOURCE,
        deterministicSha256: run.deterministicReceiptSha256,
      }),
    );
  }
});

test("duplicate-key JSON parsing and receipt creation fail closed recursively", async (context) => {
  assert.deepEqual(parseUniqueJson('{"safe":{"value":1}}'), {
    safe: { value: 1 },
  });
  for (const hostile of [
    '{"key":1,"key":2}',
    '{"key":1,"\\u006bey":2}',
    '{"outer":{"key":1,"key":2}}',
  ])
    assert.throws(() => parseUniqueJson(hostile), /duplicate key/u);

  const fixture = await canonicalFixture();
  context.after(() => rm(fixture.root, { recursive: true, force: true }));
  const smokePath = path.join(fixture.root, "smoke.json");
  const lockPath = path.join(fixture.root, "package-lock.json");
  const originals = {
    manifest: fixture.manifestBytes,
    smoke: Buffer.from(`${JSON.stringify(fixtureSmoke(), null, 2)}\n`),
    pack: await readFile(fixture.metadataPath),
  };
  await writeFile(smokePath, originals.smoke);
  await writeFile(lockPath, LOCK_BYTES);
  const inputs = [
    [
      path.join(fixture.bundleRoot, "sample-bundles.v2.json"),
      originals.manifest,
      [
        duplicateRoot(originals.manifest, "format"),
        duplicateNested(originals.manifest, '"build": {\n', "node"),
      ],
    ],
    [
      smokePath,
      originals.smoke,
      [
        duplicateRoot(originals.smoke, "format"),
        duplicateNested(originals.smoke, '"results": [\n    {\n', "id"),
      ],
    ],
    [
      fixture.metadataPath,
      originals.pack,
      [
        duplicateRoot(originals.pack, "schema"),
        replaceJson(
          originals.pack,
          `"sourceCommit": "${SOURCE}"`,
          '"sourceCommit": {"value":1,"value":2}',
        ),
      ],
    ],
  ];
  let receipt = 0;
  for (const [inputPath, original, hostileDocuments] of inputs) {
    for (const hostile of hostileDocuments) {
      await writeFile(inputPath, hostile);
      receipt += 1;
      await assert.rejects(
        createReceipts({
          manifest: path.join(fixture.bundleRoot, "sample-bundles.v2.json"),
          archive: fixture.archivePath,
          packMetadata: fixture.metadataPath,
          smokeReceipt: smokePath,
          lockfile: lockPath,
          deterministicReceipt: path.join(
            fixture.root,
            `duplicate-deterministic-${receipt}.json`,
          ),
          runReceipt: path.join(fixture.root, `duplicate-run-${receipt}.json`),
          sourceCommit: SOURCE,
          sourceDateEpoch: EPOCH,
          repository: "honua-io/honua-sdk-js",
          workflowRef: "refs/heads/trunk",
          runId: "123",
          runAttempt: "2",
          runnerName: "GitHub Actions 1",
          runnerEnvironment: "github-hosted",
          runnerOs: "Linux",
          runnerArch: "X64",
          runnerImage: "ubuntu24",
          runnerImageVersion: "20260801.1",
        }),
        /duplicate key/u,
      );
    }
    await writeFile(inputPath, original);
  }
});

test("release state is create, idempotent, partial, divergent, or collision and never clobber", () => {
  const expectedAssets = {
    a: { bytes: 1, sha256: "1".repeat(64) },
    b: { bytes: 2, sha256: "2".repeat(64) },
  };
  assert.equal(
    classifyReleaseState({
      releaseExists: false,
      tagTarget: null,
      expectedSource: SOURCE,
      assets: {},
      expectedAssets,
    }),
    "create",
  );
  assert.equal(
    classifyReleaseState({
      releaseExists: true,
      tagTarget: SOURCE,
      expectedSource: SOURCE,
      assets: clone(expectedAssets),
      expectedAssets,
    }),
    "idempotent",
  );
  assert.equal(
    classifyReleaseState({
      releaseExists: true,
      tagTarget: SOURCE,
      expectedSource: SOURCE,
      assets: { a: expectedAssets.a },
      expectedAssets,
    }),
    "partial",
  );
  const divergent = clone(expectedAssets);
  divergent.b.bytes = 3;
  assert.equal(
    classifyReleaseState({
      releaseExists: true,
      tagTarget: SOURCE,
      expectedSource: SOURCE,
      assets: divergent,
      expectedAssets,
    }),
    "divergent",
  );
  assert.equal(
    classifyReleaseState({
      releaseExists: true,
      tagTarget: "b".repeat(40),
      expectedSource: SOURCE,
      assets: clone(expectedAssets),
      expectedAssets,
    }),
    "collision",
  );
});
