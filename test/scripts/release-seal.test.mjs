import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  evaluateReleaseSeal,
  parseReleaseSealArgs,
  receiptFiles,
  releaseTagVersion,
  SEALED_VERSION_STAMPS,
} from "../../scripts/release-seal.mjs";

const digest = "a".repeat(64);
const otherDigest = "b".repeat(64);
const revision = "1".repeat(40);
const sealingRevision = "2".repeat(40);
const bumpRevision = "3".repeat(40);
const version = "0.1.2-beta.0";
const tag = `js-sdk-v${version}`;

function sealedInputs(overrides = {}) {
  return {
    packageVersion: version,
    tag,
    tagRevision: revision,
    revision,
    sourceDigest: digest,
    versionStamps: SEALED_VERSION_STAMPS.map((stamp) => ({ ...stamp, version })),
    receipts: [
      { path: "samples/evidence/maplibre-quickstart/receipts/browser.v1.json", sourceDigest: digest, sourceRevision: sealingRevision },
      { path: "samples/evidence/service-explorer/receipts/browser.v1.json", sourceDigest: digest, sourceRevision: sealingRevision },
    ],
    receiptRevisions: [{ revision: sealingRevision }],
    ...overrides,
  };
}

function problemsMatching(result, pattern) {
  return result.problems.filter((problem) => pattern.test(problem));
}

test("a resealed release tag satisfies the release seal", () => {
  const result = evaluateReleaseSeal(sealedInputs());
  assert.deepEqual(result.problems, []);
  assert.equal(result.ok, true);
});

test("release tag versions tolerate the historic doubled v prefix", () => {
  assert.equal(releaseTagVersion("js-sdk-v0.1.2-beta.0"), "0.1.2-beta.0");
  assert.equal(releaseTagVersion("js-sdk-vv0.0.5-alpha.0"), "0.0.5-alpha.0");
  assert.equal(releaseTagVersion("js-sdk-1.0.0"), "1.0.0");
  assert.throws(() => releaseTagVersion("mcp-server-v0.1.0"), /must start with js-sdk-/);
  assert.throws(() => releaseTagVersion("js-sdk-latest"), /does not name a version/);
  assert.throws(() => releaseTagVersion(undefined), /must start with js-sdk-/);
});

test("the release seal refuses to run under derived-artifact relaxation", () => {
  for (const signal of ["1", "true", "YES", "on"]) {
    const result = evaluateReleaseSeal(sealedInputs({ relaxSignal: signal }));
    assert.equal(result.ok, false);
    assert.equal(problemsMatching(result, /HONUA_DERIVED_ARTIFACTS_RELAX/).length, 1);
  }
  assert.equal(evaluateReleaseSeal(sealedInputs({ relaxSignal: "" })).ok, true);
  assert.equal(evaluateReleaseSeal(sealedInputs({ relaxSignal: "0" })).ok, true);
});

// The observed #768 failure: the version-bump commit's artifacts still
// self-report the previous release, so every stamped projection is reported.
test("derived artifacts that self-report the previous version fail the seal", () => {
  const result = evaluateReleaseSeal(
    sealedInputs({
      versionStamps: SEALED_VERSION_STAMPS.map((stamp) => ({ ...stamp, version: "0.1.1-beta.0" })),
    }),
  );
  assert.equal(result.ok, false);
  assert.equal(result.problems.length, SEALED_VERSION_STAMPS.length);
  for (const stamp of SEALED_VERSION_STAMPS) {
    assert.equal(problemsMatching(result, new RegExp(`^${stamp.path}: ${stamp.field} is 0\\.1\\.1-beta\\.0 `)).length, 1);
  }
  assert.match(result.problems[0], /the release is 0\.1\.2-beta\.0/);
});

test("a missing or unreadable version stamp fails the seal", () => {
  const stamps = SEALED_VERSION_STAMPS.map((stamp) => ({ ...stamp, version }));
  const missingField = evaluateReleaseSeal(
    sealedInputs({ versionStamps: [{ ...stamps[0], version: undefined }, ...stamps.slice(1)] }),
  );
  assert.equal(missingField.ok, false);
  assert.equal(problemsMatching(missingField, /catalog\.version is missing$/).length, 1);

  const unreadable = evaluateReleaseSeal(
    sealedInputs({ versionStamps: [{ ...stamps[0], version: undefined, problem: "derived artifact is missing" }, ...stamps.slice(1)] }),
  );
  assert.equal(unreadable.ok, false);
  assert.equal(problemsMatching(unreadable, /derived artifact is missing$/).length, 1);
});

// The other half of #768: the bump commit re-stales every receipt because
// package.json is inside the evidence-neutral source digest.
test("receipts sealed to another tree are reported once, not once per receipt", () => {
  const receipts = [
    { path: "samples/evidence/maplibre-quickstart/receipts/browser.v1.json", sourceDigest: otherDigest, sourceRevision: bumpRevision },
    { path: "samples/evidence/maplibre-quickstart/receipts/console.v1.json", sourceDigest: otherDigest, sourceRevision: bumpRevision },
    { path: "samples/evidence/service-explorer/receipts/browser.v1.json", sourceDigest: otherDigest, sourceRevision: bumpRevision },
  ];
  const result = evaluateReleaseSeal(sealedInputs({ receipts, receiptRevisions: [] }));
  assert.equal(result.ok, false);
  assert.equal(result.problems.length, 1);
  assert.match(result.problems[0], /^3 of 3 sample gate receipts are sealed to another tree/);
  assert.match(result.problems[0], /declares bbbbbbbbbbbb, this commit is aaaaaaaaaaaa/);
});

test("an empty receipt set cannot pass as sealed", () => {
  const result = evaluateReleaseSeal(sealedInputs({ receipts: [], receiptRevisions: [] }));
  assert.equal(result.ok, false);
  assert.equal(problemsMatching(result, /no sample gate receipts were found/).length, 1);
});

test("an unresolvable sealing revision is reported once per revision", () => {
  const result = evaluateReleaseSeal(
    sealedInputs({
      receiptRevisions: [
        { revision: sealingRevision, problem: "source revision does not name an existing commit" },
      ],
    }),
  );
  assert.equal(result.ok, false);
  assert.equal(result.problems.length, 1);
  assert.match(result.problems[0], new RegExp(`^sample gate receipts sealed by ${sealingRevision}: source revision`));
});

test("a receipt without a full-commit sourceRevision fails the seal", () => {
  for (const sourceRevision of [undefined, "", "trunk", sealingRevision.slice(0, 12)]) {
    const result = evaluateReleaseSeal(
      sealedInputs({
        receipts: [
          { path: "samples/evidence/maplibre-quickstart/receipts/browser.v1.json", sourceDigest: digest, sourceRevision },
        ],
        receiptRevisions: [],
      }),
    );
    assert.equal(problemsMatching(result, /sourceRevision .* is not a full commit SHA/).length, 1, String(sourceRevision));
  }
});

test("an unreadable receipt is reported with its path", () => {
  const result = evaluateReleaseSeal(
    sealedInputs({
      receipts: [
        { path: "samples/evidence/maplibre-quickstart/receipts/browser.v1.json", problem: "is not readable JSON: bad" },
      ],
      receiptRevisions: [],
    }),
  );
  assert.equal(result.ok, false);
  assert.equal(problemsMatching(result, /^samples\/evidence\/.*browser\.v1\.json: is not readable JSON/).length, 1);
});

test("the tag must name the package version and point at the verified commit", () => {
  const wrongVersion = evaluateReleaseSeal(sealedInputs({ tag: "js-sdk-v0.1.1-beta.0" }));
  assert.equal(wrongVersion.ok, false);
  assert.equal(problemsMatching(wrongVersion, /names version 0\.1\.1-beta\.0 but package\.json declares 0\.1\.2-beta\.0/).length, 1);

  const wrongCommit = evaluateReleaseSeal(sealedInputs({ tagRevision: bumpRevision }));
  assert.equal(wrongCommit.ok, false);
  assert.equal(problemsMatching(wrongCommit, /points at 3+ instead of the verified commit 1+/).length, 1);

  const missingTag = evaluateReleaseSeal(sealedInputs({ tagRevision: null }));
  assert.equal(missingTag.ok, false);
  assert.equal(problemsMatching(missingTag, /does not resolve to a commit in this checkout/).length, 1);

  // A branch-recovery publish passes no tag; the rest of the seal still applies.
  const untagged = evaluateReleaseSeal(sealedInputs({ tag: undefined, tagRevision: undefined }));
  assert.equal(untagged.ok, true);
});

test("a declared release version must match package.json", () => {
  const skewed = evaluateReleaseSeal(sealedInputs({ expectVersion: "0.1.1-beta.0" }));
  assert.equal(skewed.ok, false);
  assert.equal(problemsMatching(skewed, /^expected release version 0\.1\.1-beta\.0 but package\.json declares/).length, 1);
  assert.equal(evaluateReleaseSeal(sealedInputs({ expectVersion: version })).ok, true);
});

test("an unusable package version or source digest fails the seal", () => {
  const badVersion = evaluateReleaseSeal(sealedInputs({ packageVersion: "0.1", tag: undefined }));
  assert.equal(badVersion.ok, false);
  assert.equal(problemsMatching(badVersion, /package\.json version is not a release version/).length, 1);

  const badDigest = evaluateReleaseSeal(sealedInputs({ sourceDigest: undefined }));
  assert.equal(badDigest.ok, false);
  assert.equal(problemsMatching(badDigest, /evidence-neutral source digest is unavailable/).length, 1);
  // No per-receipt staleness noise when the digest itself is unknown.
  assert.equal(problemsMatching(badDigest, /sealed to another tree/).length, 0);
});

test("a dirty or shallow checkout is surfaced as its own problem", () => {
  const result = evaluateReleaseSeal(
    sealedInputs({ checkoutProblem: "evidence-neutral checkout is not release-clean: found ?? scripts/x.mjs" }),
  );
  assert.equal(result.ok, false);
  assert.equal(problemsMatching(result, /^evidence-neutral checkout is not release-clean/).length, 1);
});

test("release seal arguments are parsed strictly", () => {
  assert.deepEqual(parseReleaseSealArgs(["check"]), { command: "check", options: {} });
  assert.deepEqual(parseReleaseSealArgs(["check", "--tag", tag, "--expect-version", version]), {
    command: "check",
    options: { tag, expectVersion: version },
  });
  assert.throws(() => parseReleaseSealArgs(["check", "--tag"]), /--tag requires a value/);
  assert.throws(() => parseReleaseSealArgs(["check", "--tag", "--expect-version"]), /--tag requires a value/);
  assert.throws(() => parseReleaseSealArgs(["check", "--force"]), /Unknown release-seal argument: --force/);
});

// Repository-shape guards: the seal is only meaningful while these paths and
// fields exist. Version equality is deliberately NOT asserted here -- between a
// version-bump merge and its reseal, trunk legitimately fails that check, and
// that transient state must not fail unit tests.
test("every sealed version stamp exists in the tree and carries a version string", () => {
  for (const stamp of SEALED_VERSION_STAMPS) {
    const artifact = JSON.parse(fs.readFileSync(path.resolve(stamp.path), "utf8"));
    const value = stamp.field.split(".").reduce((node, key) => node?.[key], artifact);
    assert.match(value ?? "", /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/, `${stamp.path}: ${stamp.field}`);
  }
});

// Extract a shell `case` allowlist of generated paths from a workflow file.
// Both release-please.yml and regenerate-derived-artifacts.yml gate on the same
// set: the second produces those commits, the first decides a release may
// publish from them and may move its tag onto them.
function generatedPathAllowlist(workflow) {
  const lines = fs.readFileSync(path.resolve(".github/workflows", workflow), "utf8").split("\n");
  const start = lines.findIndex((line) => line.includes("changed_path") && line.includes("case "));
  assert.ok(start >= 0, `${workflow}: no generated-path case statement`);
  const patterns = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (line.startsWith("*)")) return new Set(patterns);
    for (const token of line.replace(/\\$/, "").split("|")) {
      const pattern = token.trim().replace(/\)$/, "");
      if (pattern.length > 0) patterns.push(pattern);
    }
  }
  throw new Error(`${workflow}: unterminated generated-path case statement`);
}

test("the release and regeneration generated-path allowlists agree", () => {
  const release = generatedPathAllowlist("release-please.yml");
  const regeneration = generatedPathAllowlist("regenerate-derived-artifacts.yml");
  assert.ok(release.size >= 10, `expected a populated allowlist, got ${release.size}`);
  assert.deepEqual([...release].sort(), [...regeneration].sort());
});

test("committed gate receipts are discoverable and declare a sealing revision", () => {
  const files = receiptFiles(process.cwd());
  assert.ok(files.length >= 4, `expected committed gate receipts, found ${files.length}`);
  for (const file of files) {
    assert.match(file, /^samples\/evidence\/[^/]+\/receipts\/[^/]+\.json$/);
    const receipt = JSON.parse(fs.readFileSync(path.resolve(file), "utf8"));
    assert.match(receipt.sourceDigest, /^[a-f0-9]{64}$/, file);
    assert.match(receipt.sourceRevision, /^[a-f0-9]{40}$/, file);
  }
});
