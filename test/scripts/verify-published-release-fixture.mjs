import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  DEFAULT_REGISTRY,
  PROVENANCE_PREDICATE_TYPE,
  PUBLISH_PREDICATE_TYPE,
  attestationsUrl,
  packumentUrl,
  subjectPurl,
} from "../../scripts/verify-published-release.mjs";

const REPOSITORY = "honua-io/honua-sdk-js";
const SEALED_COMMIT = "1".repeat(40);
const OWN_TAG_COMMIT = "2".repeat(40);
const VERSION = "0.1.7-beta.0";
const CREATE_APP_VERSION = "0.1.2";
const SEALED_TAG = `js-sdk-v${VERSION}`;
const NOW = () => new Date("2026-08-24T00:00:00.000Z");

const manifest = JSON.parse(fs.readFileSync(path.resolve("config/release-artifacts.v1.json"), "utf8"));

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

export {
  CREATE_APP_VERSION,
  NOW,
  OWN_TAG_COMMIT,
  REPOSITORY,
  SEALED_COMMIT,
  SEALED_TAG,
  VERSION,
  artifactOf,
  failedCheck,
  fakeRegistry,
  manifest,
};
