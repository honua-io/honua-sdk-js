import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readFile,
  rename,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { gunzipSync, gzipSync } from "node:zlib";
import { parse as parseYaml } from "yaml";

import {
  ACTIONS,
  ACTION_COMMITS,
  classifyReleaseState,
  createReceipts,
  normalizeSmoke,
  parseCanonicalArchive,
  validateDeterministicReceipt,
  validateManifest,
  validateRunReceipt,
  validateWorkflowDocument,
  validateWorkflowFile,
} from "../../scripts/immutable-sample-bundle-attestation.mjs";
import {
  pack,
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

function fixtureManifest(fileBytes = Buffer.from("immutable bytes\n")) {
  return {
    format: "honua.sdk.sample-bundles.v2",
    schemaVersion: 2,
    build: { node: ">=20.19.0", lockfileSha256: LOCK_SHA },
    samples: [
      {
        id: "alpha",
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
        files: [fileRecord("index.html", fileBytes)],
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

function fixtureSmoke() {
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
        id: "alpha",
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

async function fixtureRoot() {
  const root = await mkdtemp(path.join(os.tmpdir(), "immutable-bundle-"));
  const bundleRoot = path.join(root, "bundles");
  await mkdir(path.join(bundleRoot, "alpha"), { recursive: true });
  const bytes = Buffer.from("immutable bytes\n");
  const manifest = fixtureManifest(bytes);
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(
    path.join(bundleRoot, "sample-bundles.v2.json"),
    manifestBytes,
  );
  await writeFile(path.join(bundleRoot, "alpha/index.html"), bytes);
  return { root, bundleRoot, manifest, manifestBytes, bytes };
}

async function canonicalFixture() {
  const fixture = await fixtureRoot();
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
  const result = gzipSync(tar, { level: 9, mtime: 0 });
  result[9] = 3;
  return result;
}

test("all actions are exact commit pins and attestation uses the verified object", () => {
  assert.equal(
    ACTIONS.attestBuildProvenance,
    "actions/attest-build-provenance@977bb373ede98d70efdf65b84cb5f73e068dcc2a",
  );
  for (const [repository, commit] of ACTION_COMMITS) {
    assert.match(repository, /^[a-z0-9-]+\/[a-z0-9-]+$/u);
    assert.match(commit, /^[0-9a-f]{40}$/u);
  }
});

test("the actual workflow passes parsed structural policy", async () => {
  await validateWorkflowFile(WORKFLOW);
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
    [0x1f, 0x8b, 0x08, 0, 0, 0, 0, 0, 2, 3],
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
  for (const archive of mutations)
    assert.throws(() => parseCanonicalArchive(archive, fixture));
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
