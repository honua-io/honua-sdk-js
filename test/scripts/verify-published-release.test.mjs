import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  DEFAULT_REGISTRY,
  PROVENANCE_PREDICATE_TYPE,
  PUBLISH_PREDICATE_TYPE,
  RECEIPT_FORMAT,
  attestationsUrl,
  packumentUrl,
  parseVerifyPublishedReleaseArgs,
  planPublishedReleaseTargets,
  receiptJson,
  releaseTagFor,
  resolveDistTag,
  subjectPurl,
  verifyPublishedRelease,
} from "../../scripts/verify-published-release.mjs";

// "Publish succeeded" has never been evidence that consumers can install the
// release (#1337 AC6): 0.0.19 published while `@honua/react` 404'd, `latest`
// pointed at 0.0.6 for weeks, and three release tags named the wrong commit --
// all with green workflows. These tests drive the verifier against a fake
// registry so every one of those failures is proven to fail closed, and prove
// the receipt #39 consumes is deterministic.

const REPOSITORY = "honua-io/honua-sdk-js";
const SEALED_COMMIT = "1".repeat(40);
const OWN_TAG_COMMIT = "2".repeat(40);
const VERSION = "0.1.7-beta.0";
const CREATE_APP_VERSION = "0.1.2";
const SEALED_TAG = `js-sdk-v${VERSION}`;
const NOW = () => new Date("2026-08-24T00:00:00.000Z");

const manifest = JSON.parse(fs.readFileSync(path.resolve("config/release-artifacts.v1.json"), "utf8"));

function versionFor(versionSource) {
  if (versionSource === "packages/create-honua-app/package.json") return CREATE_APP_VERSION;
  return VERSION;
}

function planReal(overrides = {}) {
  return planPublishedReleaseTargets({
    manifest,
    sealedTag: SEALED_TAG,
    sealedCommit: SEALED_COMMIT,
    readPackageVersion: versionFor,
    resolveTagCommit: () => OWN_TAG_COMMIT,
    ...overrides,
  });
}

/** Tarball bytes are per-package so a swapped tarball cannot pass by accident. */
function tarballFor(npmName, version) {
  return Buffer.from(`tarball:${npmName}@${version}`, "utf8");
}

function provenanceStatement(target, tarball, overrides = {}) {
  const statement = {
    _type: "https://in-toto.io/Statement/v1",
    subject: [
      {
        name: subjectPurl(target.npmName, target.version),
        digest: { sha512: createHash("sha512").update(tarball).digest("hex") },
      },
    ],
    predicateType: PROVENANCE_PREDICATE_TYPE,
    predicate: {
      buildDefinition: {
        buildType: "https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1",
        externalParameters: {
          workflow: {
            ref: `refs/tags/${target.tag}`,
            repository: `https://github.com/${REPOSITORY}`,
            path: target.workflow,
          },
        },
        resolvedDependencies: [
          {
            uri: `git+https://github.com/${REPOSITORY}@refs/tags/${target.tag}`,
            digest: { gitCommit: target.commit },
          },
        ],
      },
      runDetails: { builder: { id: "https://github.com/actions/runner/github-hosted" } },
    },
  };
  return overrides.mutate ? (overrides.mutate(statement), statement) : statement;
}

function publishStatement(target, tarball, overrides = {}) {
  const statement = {
    _type: "https://in-toto.io/Statement/v1",
    subject: [
      {
        name: subjectPurl(target.npmName, target.version),
        digest: { sha512: createHash("sha512").update(tarball).digest("hex") },
      },
    ],
    predicateType: PUBLISH_PREDICATE_TYPE,
    predicate: { name: target.npmName, version: target.version, registry: DEFAULT_REGISTRY },
  };
  return overrides.mutate ? (overrides.mutate(statement), statement) : statement;
}

function envelope(statement) {
  return {
    predicateType: statement.predicateType,
    bundle: {
      mediaType: "application/vnd.dev.sigstore.bundle+json;version=0.2",
      dsseEnvelope: {
        payloadType: "application/vnd.in-toto+json",
        payload: Buffer.from(JSON.stringify(statement), "utf8").toString("base64"),
      },
    },
  };
}

/**
 * A registry that answers only what the verifier asks for. `mutate` edits the
 * built fixture so each test changes exactly one fact.
 */
function fakeRegistry(targets, mutate = () => {}) {
  const packuments = new Map();
  const attestations = new Map();
  const tarballs = new Map();

  for (const target of targets) {
    const tarball = tarballFor(target.npmName, target.version);
    const tarballUrl = `https://registry.npmjs.org/${target.npmName}/-/tarball-${target.version}.tgz`;
    tarballs.set(tarballUrl, tarball);
    packuments.set(packumentUrl(DEFAULT_REGISTRY, target.npmName), {
      name: target.npmName,
      "dist-tags": { [target.distTag]: target.version },
      versions: {
        [target.version]: {
          name: target.npmName,
          version: target.version,
          dist: {
            tarball: tarballUrl,
            integrity: `sha512-${createHash("sha512").update(tarball).digest("base64")}`,
            shasum: createHash("sha1").update(tarball).digest("hex"),
          },
        },
      },
    });
    attestations.set(attestationsUrl(DEFAULT_REGISTRY, target.npmName, target.version), {
      attestations: [envelope(provenanceStatement(target, tarball)), envelope(publishStatement(target, tarball))],
    });
  }

  const registry = {
    packuments,
    attestations,
    tarballs,
    envelope,
    provenanceStatement,
    publishStatement,
    tarballFor,
  };
  mutate(registry);

  return async (url) => {
    if (registry.packuments.has(url)) {
      return { ok: true, status: 200, json: async () => registry.packuments.get(url) };
    }
    if (registry.attestations.has(url)) {
      return { ok: true, status: 200, json: async () => registry.attestations.get(url) };
    }
    if (registry.tarballs.has(url)) {
      const bytes = registry.tarballs.get(url);
      return {
        ok: true,
        status: 200,
        arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
      };
    }
    return { ok: false, status: 404, json: async () => ({ error: "Not found" }) };
  };
}

async function verify(mutate = () => {}, planOverrides = {}) {
  const { targets, errors } = planReal(planOverrides);
  return await verifyPublishedRelease({
    targets,
    sealedTag: SEALED_TAG,
    sealedCommit: SEALED_COMMIT,
    repository: REPOSITORY,
    fetchImpl: fakeRegistry(targets, mutate),
    planningErrors: errors,
    now: NOW,
  });
}

function artifactOf(receipt, npmName) {
  const artifact = receipt.artifacts.find((entry) => entry.npmName === npmName);
  assert.ok(artifact, `receipt has no entry for ${npmName}`);
  return artifact;
}

function failedCheck(receipt, npmName, checkId) {
  const check = artifactOf(receipt, npmName).checks.find((entry) => entry.id === checkId);
  assert.ok(check, `${npmName} has no "${checkId}" check`);
  return check;
}

test("the dist tag matches the one publish-js-sdk.yml computes", () => {
  // Pre-1.0 every release is a prerelease but must own `latest`; post-1.0 a
  // prerelease keeps its own channel and must NOT own latest.
  assert.equal(resolveDistTag("0.1.7-beta.0"), "latest");
  assert.equal(resolveDistTag("0.1.7"), "latest");
  assert.equal(resolveDistTag("1.0.0"), "latest");
  assert.equal(resolveDistTag("1.1.0-beta.3"), "beta");
  assert.equal(resolveDistTag("2.0.0-rc.1"), "rc");
  assert.equal(releaseTagFor("js-sdk-", "0.1.7-beta.0"), "js-sdk-v0.1.7-beta.0");
});

test("the plan binds sealed-cut artifacts to the sealed commit and the rest to their own tags", () => {
  const { targets, errors } = planReal();
  assert.deepEqual(errors, []);
  assert.equal(targets.length, manifest.included.length);

  const sdk = targets.find((target) => target.npmName === "@honua/sdk");
  assert.equal(sdk.commit, SEALED_COMMIT);
  assert.equal(sdk.tag, SEALED_TAG);

  // @honua/mcp-server and create-honua-app publish from their own Release
  // Please tags, which name the version-bump commit rather than the resealed
  // one. The manifest says so and the plan must honour it instead of asserting
  // a binding that does not exist.
  const mcp = targets.find((target) => target.npmName === "@honua/mcp-server");
  assert.equal(mcp.commit, OWN_TAG_COMMIT);
  assert.equal(mcp.tag, `mcp-server-v${VERSION}`);
  const createApp = targets.find((target) => target.npmName === "create-honua-app");
  assert.equal(createApp.tag, `create-honua-app-v${CREATE_APP_VERSION}`);
  assert.equal(createApp.distTag, "latest");
});

test("a tag that cannot be resolved fails closed instead of being skipped", () => {
  const { targets, errors } = planReal({
    resolveTagCommit: (tag) => {
      throw new Error(`fatal: Needed a single revision: ${tag}`);
    },
  });
  assert.equal(targets.length, 6);
  assert.equal(errors.length, 2);
  assert.ok(
    errors.every((error) => error.includes("Fetch the release tags")),
    errors.join("\n"),
  );
});

test("a sealed tag that does not match the version in the tree is refused", () => {
  const { errors } = planPublishedReleaseTargets({
    manifest,
    sealedTag: "js-sdk-v0.1.6-beta.0",
    sealedCommit: SEALED_COMMIT,
    readPackageVersion: versionFor,
    resolveTagCommit: () => OWN_TAG_COMMIT,
  });
  assert.ok(
    errors.some((error) => error.includes("the cut is inconsistent")),
    errors.join("\n"),
  );
});

test("a short or missing commit is refused before any network call", () => {
  const { errors } = planPublishedReleaseTargets({
    manifest,
    sealedTag: SEALED_TAG,
    sealedCommit: "abc123",
    readPackageVersion: versionFor,
    resolveTagCommit: () => OWN_TAG_COMMIT,
  });
  assert.ok(
    errors.some((error) => error.includes("40-character commit sha")),
    errors.join("\n"),
  );
});

test("a fully published, attested, correctly sourced cut verifies", async () => {
  const receipt = await verify();
  assert.equal(receipt.status, "verified", JSON.stringify(receipt.failures, null, 2));
  assert.equal(receipt.format, RECEIPT_FORMAT);
  assert.equal(receipt.artifacts.length, manifest.included.length);
  assert.deepEqual(receipt.failures, []);

  const sdk = artifactOf(receipt, "@honua/sdk");
  assert.equal(sdk.status, "verified");
  assert.equal(sdk.sourceRevision, SEALED_COMMIT);
  assert.match(sdk.integrity, /^sha512-/u);
  assert.deepEqual(
    sdk.checks.map((entry) => entry.id),
    [
      "registry-version",
      "dist-tag",
      "dist-integrity",
      "publish-attestation",
      "provenance-attestation",
      "provenance-subject",
      "provenance-builder",
      "source-revision",
    ],
  );
});

test("a package the registry never received fails the cut", async () => {
  // The 0.0.19 shape exactly: five packages land, @honua/react 404s, and the
  // release is reported as complete.
  const receipt = await verify((registry) => {
    registry.packuments.delete(packumentUrl(DEFAULT_REGISTRY, "@honua/react"));
  });
  assert.equal(receipt.status, "failed");
  assert.equal(artifactOf(receipt, "@honua/react").status, "failed");
  assert.equal(artifactOf(receipt, "@honua/sdk").status, "verified");
  assert.equal(failedCheck(receipt, "@honua/react", "registry-packument").status, "fail");
});

test("a package published at a different version fails the cut", async () => {
  const receipt = await verify((registry) => {
    const url = packumentUrl(DEFAULT_REGISTRY, "@honua/geometry");
    const packument = registry.packuments.get(url);
    packument.versions = { "0.1.6-beta.0": packument.versions[VERSION] };
  });
  assert.equal(receipt.status, "failed");
  assert.match(failedCheck(receipt, "@honua/geometry", "registry-version").detail, /has no 0\.1\.7-beta\.0/u);
});

test("a stale dist-tag fails the cut", async () => {
  // `latest` pointing at an older version while a newer one exists is invisible
  // to `npm publish` and is what every fresh consumer installs.
  const receipt = await verify((registry) => {
    registry.packuments.get(packumentUrl(DEFAULT_REGISTRY, "@honua/sdk-js"))["dist-tags"].latest = "0.0.6";
  });
  assert.equal(receipt.status, "failed");
  assert.match(failedCheck(receipt, "@honua/sdk-js", "dist-tag").detail, /points at 0\.0\.6/u);
});

test("a tarball whose bytes do not match the advertised integrity fails the cut", async () => {
  const receipt = await verify((registry) => {
    const url = packumentUrl(DEFAULT_REGISTRY, "@honua/sdk");
    const dist = registry.packuments.get(url).versions[VERSION].dist;
    registry.tarballs.set(dist.tarball, Buffer.from("tampered", "utf8"));
  });
  assert.equal(receipt.status, "failed");
  assert.match(failedCheck(receipt, "@honua/sdk", "dist-integrity").detail, /tarball hashes to sha512-/u);
});

test("a version with no attestations at all fails the cut", async () => {
  const receipt = await verify((registry) => {
    registry.attestations.delete(attestationsUrl(DEFAULT_REGISTRY, "@honua/app-platform", VERSION));
  });
  assert.equal(receipt.status, "failed");
  assert.match(failedCheck(receipt, "@honua/app-platform", "attestations").detail, /responded 404/u);
});

test("a missing npm publish attestation fails the cut", async () => {
  const receipt = await verify((registry) => {
    const url = attestationsUrl(DEFAULT_REGISTRY, "@honua/sdk", VERSION);
    const held = registry.attestations.get(url);
    held.attestations = held.attestations.filter((entry) => entry.predicateType !== PUBLISH_PREDICATE_TYPE);
  });
  assert.equal(receipt.status, "failed");
  assert.equal(failedCheck(receipt, "@honua/sdk", "publish-attestation").status, "fail");
});

test("provenance for a different tarball fails the cut", async () => {
  // Binds the attestation to the exact bytes the registry serves, so a
  // provenance recycled from another artifact cannot vouch for this one.
  const receipt = await verify((registry) => {
    const url = attestationsUrl(DEFAULT_REGISTRY, "@honua/sdk", VERSION);
    const target = {
      npmName: "@honua/sdk",
      version: VERSION,
      tag: SEALED_TAG,
      commit: SEALED_COMMIT,
      workflow: ".github/workflows/publish-js-sdk.yml",
    };
    const statement = registry.provenanceStatement(target, Buffer.from("other bytes", "utf8"));
    registry.attestations.get(url).attestations[0] = registry.envelope(statement);
  });
  assert.equal(receipt.status, "failed");
  assert.match(failedCheck(receipt, "@honua/sdk", "provenance-subject").detail, /is not the served tarball's sha512/u);
});

test("provenance from another repository fails the cut", async () => {
  const receipt = await verify((registry) => {
    const url = attestationsUrl(DEFAULT_REGISTRY, "@honua/sdk", VERSION);
    const target = {
      npmName: "@honua/sdk",
      version: VERSION,
      tag: SEALED_TAG,
      commit: SEALED_COMMIT,
      workflow: ".github/workflows/publish-js-sdk.yml",
    };
    const statement = registry.provenanceStatement(target, registry.tarballFor("@honua/sdk", VERSION), {
      mutate: (built) => {
        built.predicate.buildDefinition.externalParameters.workflow.repository =
          "https://github.com/attacker/honua-sdk-js";
      },
    });
    registry.attestations.get(url).attestations[0] = registry.envelope(statement);
  });
  assert.equal(receipt.status, "failed");
  assert.match(failedCheck(receipt, "@honua/sdk", "provenance-builder").detail, /attacker/u);
});

test("provenance from a workflow the manifest does not name fails the cut", async () => {
  const receipt = await verify((registry) => {
    const url = attestationsUrl(DEFAULT_REGISTRY, "@honua/sdk", VERSION);
    const target = {
      npmName: "@honua/sdk",
      version: VERSION,
      tag: SEALED_TAG,
      commit: SEALED_COMMIT,
      workflow: ".github/workflows/publish-js-sdk.yml",
    };
    const statement = registry.provenanceStatement(target, registry.tarballFor("@honua/sdk", VERSION), {
      mutate: (built) => {
        built.predicate.buildDefinition.externalParameters.workflow.path = ".github/workflows/manual-publish.yml";
      },
    });
    registry.attestations.get(url).attestations[0] = registry.envelope(statement);
  });
  assert.equal(receipt.status, "failed");
  assert.match(failedCheck(receipt, "@honua/sdk", "provenance-builder").detail, /manual-publish\.yml/u);
});

test("an artifact built from a commit the sealed tag does not name fails the cut", async () => {
  // The #1337 regression seen from the consumer's side: the tag moved, or the
  // publish ran from the unsealed version-bump commit, and the registry is the
  // only place that still records which.
  const unsealed = "3".repeat(40);
  const receipt = await verify((registry) => {
    const url = attestationsUrl(DEFAULT_REGISTRY, "@honua/sdk-js", VERSION);
    const target = {
      npmName: "@honua/sdk-js",
      version: VERSION,
      tag: SEALED_TAG,
      commit: unsealed,
      workflow: ".github/workflows/publish-js-sdk.yml",
    };
    const statement = registry.provenanceStatement(target, registry.tarballFor("@honua/sdk-js", VERSION));
    registry.attestations.get(url).attestations[0] = registry.envelope(statement);
  });
  assert.equal(receipt.status, "failed");
  assert.match(
    failedCheck(receipt, "@honua/sdk-js", "source-revision").detail,
    new RegExp(`provenance names source commit ${unsealed}`, "u"),
  );
});

const SDK_TARGET = {
  npmName: "@honua/sdk",
  version: VERSION,
  tag: SEALED_TAG,
  commit: SEALED_COMMIT,
  workflow: ".github/workflows/publish-js-sdk.yml",
};

/** Replace the publish attestation npm holds for one package. */
function replacePublishAttestation(registry, npmName, build) {
  const url = attestationsUrl(DEFAULT_REGISTRY, npmName, VERSION);
  const held = registry.attestations.get(url);
  const index = held.attestations.findIndex((entry) => entry.predicateType === PUBLISH_PREDICATE_TYPE);
  held.attestations[index] = build(registry.tarballFor(npmName, VERSION));
}

test("a publish attestation whose envelope carries no payload fails the cut", async () => {
  // The outer `predicateType` is unsigned registry metadata. An entry that
  // claims to be a publish attestation but carries nothing signed must not
  // count as one.
  const receipt = await verify((registry) => {
    replacePublishAttestation(registry, "@honua/sdk", () => ({
      predicateType: PUBLISH_PREDICATE_TYPE,
      bundle: { dsseEnvelope: { payloadType: "application/vnd.in-toto+json" } },
    }));
  });
  assert.equal(receipt.status, "failed");
  assert.match(failedCheck(receipt, "@honua/sdk", "publish-attestation").detail, /no dsseEnvelope payload/u);
});

test("a publish attestation whose payload names another predicate fails the cut", async () => {
  const receipt = await verify((registry) => {
    // The registry entry still advertises the publish predicate; only the
    // signed payload inside disagrees.
    replacePublishAttestation(registry, "@honua/sdk", (tarball) => ({
      ...registry.envelope({
        ...registry.publishStatement(SDK_TARGET, tarball),
        predicateType: PROVENANCE_PREDICATE_TYPE,
      }),
      predicateType: PUBLISH_PREDICATE_TYPE,
    }));
  });
  assert.equal(receipt.status, "failed");
  assert.match(
    failedCheck(receipt, "@honua/sdk", "publish-attestation").detail,
    /but the statement says https:\/\/slsa\.dev\/provenance\/v1/u,
  );
});

test("a publish attestation for another tarball fails the cut", async () => {
  const receipt = await verify((registry) => {
    replacePublishAttestation(registry, "@honua/sdk", () =>
      registry.envelope(registry.publishStatement(SDK_TARGET, Buffer.from("other bytes", "utf8"))),
    );
  });
  assert.equal(receipt.status, "failed");
  assert.match(
    failedCheck(receipt, "@honua/sdk", "publish-attestation").detail,
    /is not the served tarball's sha512/u,
  );
});

test("a publish attestation with no subject at all fails the cut", async () => {
  const receipt = await verify((registry) => {
    replacePublishAttestation(registry, "@honua/sdk", (tarball) =>
      registry.envelope(
        registry.publishStatement(SDK_TARGET, tarball, {
          mutate: (built) => {
            built.subject = [];
          },
        }),
      ),
    );
  });
  assert.equal(receipt.status, "failed");
  assert.match(failedCheck(receipt, "@honua/sdk", "publish-attestation").detail, /<no subject>/u);
});

test("the guarded branch recovery publish verifies against the branch ref it really used", async () => {
  // publish-js-sdk.yml supports a non-dry-run recovery publish from a branch
  // (allow_branch_publish, with release_version and source_revision pinned).
  // npm then records refs/heads/trunk in provenance. Requiring the tag ref
  // there would fail every recovered artifact *after* it is already on the
  // registry, so the caller declares the ref it published from.
  const receipt = await verify(
    (registry) => {
      const sealed = manifest.included
        .filter((artifact) => artifact.sourceBinding === "sealed-js-sdk-tag")
        .map((artifact) => artifact.npmName);
      for (const npmName of sealed) {
        const url = attestationsUrl(DEFAULT_REGISTRY, npmName, VERSION);
        const held = registry.attestations.get(url);
        held.attestations[0] = registry.envelope(
          registry.provenanceStatement(
            { npmName, version: VERSION, tag: SEALED_TAG, commit: SEALED_COMMIT, workflow: ".github/workflows/publish-js-sdk.yml" },
            registry.tarballFor(npmName, VERSION),
            {
              mutate: (built) => {
                built.predicate.buildDefinition.externalParameters.workflow.ref = "refs/heads/trunk";
              },
            },
          ),
        );
      }
    },
    { publishRef: "refs/heads/trunk" },
  );
  assert.equal(receipt.status, "verified", JSON.stringify(receipt.failures, null, 2));
  assert.equal(artifactOf(receipt, "@honua/sdk").sourceRef, "refs/heads/trunk");
  // The commit binding is untouched: a branch ref proves nothing on its own.
  assert.equal(artifactOf(receipt, "@honua/sdk").sourceRevision, SEALED_COMMIT);
  // Artifacts that publish from their own Release Please tag through their own
  // workflow are unaffected by the SDK run's ref.
  assert.equal(artifactOf(receipt, "@honua/mcp-server").sourceRef, `refs/tags/mcp-server-v${VERSION}`);
});

test("a branch recovery still fails when the provenance names the wrong commit", async () => {
  const unsealed = "4".repeat(40);
  const receipt = await verify(
    (registry) => {
      const url = attestationsUrl(DEFAULT_REGISTRY, "@honua/sdk", VERSION);
      registry.attestations.get(url).attestations[0] = registry.envelope(
        registry.provenanceStatement(
          { ...SDK_TARGET, commit: unsealed },
          registry.tarballFor("@honua/sdk", VERSION),
          {
            mutate: (built) => {
              built.predicate.buildDefinition.externalParameters.workflow.ref = "refs/heads/trunk";
            },
          },
        ),
      );
    },
    { publishRef: "refs/heads/trunk" },
  );
  assert.equal(receipt.status, "failed");
  assert.match(failedCheck(receipt, "@honua/sdk", "source-revision").detail, new RegExp(unsealed, "u"));
});

test("an arbitrary --publish-ref is refused rather than verified against", () => {
  for (const ref of ["refs/tags/js-sdk-v0.0.1", "refs/pull/1/merge", "trunk"]) {
    const { errors } = planReal({ publishRef: ref });
    assert.ok(
      errors.some((error) => error.includes("--publish-ref")),
      `${ref}: ${errors.join("\n")}`,
    );
  }
  // The sealed tag's own ref is always acceptable and is the default.
  assert.deepEqual(planReal({ publishRef: `refs/tags/${SEALED_TAG}` }).errors, []);
  assert.equal(
    planReal().targets.find((target) => target.npmName === "@honua/sdk").expectedRef,
    `refs/tags/${SEALED_TAG}`,
  );
});

test("an artifact built from a ref other than its release tag fails the cut", async () => {
  const receipt = await verify((registry) => {
    const url = attestationsUrl(DEFAULT_REGISTRY, "@honua/sdk-js", VERSION);
    const target = {
      npmName: "@honua/sdk-js",
      version: VERSION,
      tag: SEALED_TAG,
      commit: SEALED_COMMIT,
      workflow: ".github/workflows/publish-js-sdk.yml",
    };
    const statement = registry.provenanceStatement(target, registry.tarballFor("@honua/sdk-js", VERSION), {
      mutate: (built) => {
        built.predicate.buildDefinition.externalParameters.workflow.ref = "refs/heads/trunk";
      },
    });
    registry.attestations.get(url).attestations[0] = registry.envelope(statement);
  });
  assert.equal(receipt.status, "failed");
  assert.match(failedCheck(receipt, "@honua/sdk-js", "source-revision").detail, /refs\/heads\/trunk/u);
});

test("an unreachable registry fails closed rather than passing", async () => {
  const { targets, errors } = planReal();
  const receipt = await verifyPublishedRelease({
    targets,
    sealedTag: SEALED_TAG,
    sealedCommit: SEALED_COMMIT,
    repository: REPOSITORY,
    fetchImpl: async () => {
      throw new Error("getaddrinfo ENOTFOUND registry.npmjs.org");
    },
    planningErrors: errors,
    now: NOW,
  });
  assert.equal(receipt.status, "failed");
  assert.equal(receipt.artifacts.length, manifest.included.length);
  assert.ok(receipt.artifacts.every((artifact) => artifact.status === "failed"));
  assert.ok(receipt.failures.every((failure) => failure.includes("ENOTFOUND")));
});

test("planning errors reach the receipt even when every reachable artifact verifies", async () => {
  const receipt = await verify(() => {}, {
    resolveTagCommit: () => {
      throw new Error("fatal: bad revision");
    },
  });
  assert.equal(receipt.status, "failed");
  assert.equal(receipt.artifacts.length, 6);
  assert.ok(receipt.artifacts.every((artifact) => artifact.status === "verified"));
  assert.equal(receipt.failures.length, 2);
});

test("an empty cut is a failure, not a vacuous pass", async () => {
  const receipt = await verifyPublishedRelease({
    targets: [],
    sealedTag: SEALED_TAG,
    sealedCommit: SEALED_COMMIT,
    repository: REPOSITORY,
    fetchImpl: async () => {
      throw new Error("no call expected");
    },
    now: NOW,
  });
  assert.equal(receipt.status, "failed");
});

test("the receipt is deterministic and ordered so #39 can diff it", async () => {
  const first = receiptJson(await verify());
  const second = receiptJson(await verify());
  assert.equal(first, second);

  const parsed = JSON.parse(first);
  assert.deepEqual(
    parsed.artifacts.map((artifact) => artifact.npmName),
    [...parsed.artifacts.map((artifact) => artifact.npmName)].sort(),
  );
  assert.equal(parsed.verifiedAt, "2026-08-24T00:00:00.000Z");
  assert.equal(parsed.sealedCommit, SEALED_COMMIT);
  assert.equal(parsed.manifest, "config/release-artifacts.v1.json");
  assert.ok(first.endsWith("\n"));
});

test("the CLI requires both the tag and the sealed commit", () => {
  assert.throws(() => parseVerifyPublishedReleaseArgs([]), /requires --tag/u);
  assert.throws(() => parseVerifyPublishedReleaseArgs(["--tag", SEALED_TAG]), /requires --commit/u);
  assert.throws(() => parseVerifyPublishedReleaseArgs(["--nope", "x"]), /Unknown verify-published-release/u);
  const options = parseVerifyPublishedReleaseArgs(["--tag", SEALED_TAG, "--commit", SEALED_COMMIT]);
  assert.equal(options.registry, DEFAULT_REGISTRY);
  assert.equal(options.tag, SEALED_TAG);
  assert.equal(options.publishRef, undefined);

  const recovery = parseVerifyPublishedReleaseArgs([
    "--tag",
    SEALED_TAG,
    "--commit",
    SEALED_COMMIT,
    "--publish-ref",
    "refs/heads/trunk",
  ]);
  assert.equal(recovery.publishRef, "refs/heads/trunk");
});
