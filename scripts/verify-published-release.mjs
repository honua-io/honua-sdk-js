#!/usr/bin/env node

// Post-publish registry verification (honua-io/honua-sdk-js#1337, AC6).
//
// Publishing succeeding is not evidence that the right bytes reached consumers.
// Every registry incident this repository has had was invisible to the publish
// step that caused it: `@honua/react` and `@honua/geometry` were documented and
// 404ing, `latest` pointed at 0.0.6 for weeks while newer versions existed, and
// three releases produced tags that named the wrong commit. In each case the
// workflow was green.
//
// This script closes that loop. For every artifact config/release-artifacts.v1.json
// includes in the coordinated cut, it asks the registry -- not the publisher --
// whether the release actually landed, and proves four independent things:
//
//   1. VERSION      the version in the tree is published, and the dist-tag the
//                   publish workflow computes for it resolves to that version.
//   2. INTEGRITY    the tarball the registry serves hashes to the `dist.integrity`
//                   and `dist.shasum` the registry advertises.
//   3. PROVENANCE   npm holds a Sigstore SLSA provenance attestation and an npm
//                   publish attestation whose subject is that exact tarball
//                   digest, produced by this repository and by the publish
//                   workflow the manifest names.
//   4. SOURCE SHA   the provenance's source revision is the commit the release
//                   tag names -- for the SDK family, the sealed commit
//                   release-please.yml created the tag on.
//
// It fails closed: an unreachable registry, a missing field, a malformed
// attestation, or an unparseable envelope is a failure, never a skip. A
// deterministic JSON receipt is written either way so honua-io/honua-sdk-js#39
// can consume the outcome of a release it did not run.
//
// The network layer is injectable (`fetchImpl`), and the planning step reads
// versions and tag commits through injected callbacks, so the whole policy is
// unit-tested offline (test/scripts/verify-published-release.test.mjs).

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const RECEIPT_FORMAT = "honua.sdk.published-release-verification.v1";
export const RECEIPT_SCHEMA_VERSION = 1;
export const MANIFEST_PATH = "config/release-artifacts.v1.json";
export const DEFAULT_REGISTRY = "https://registry.npmjs.org";
export const PROVENANCE_PREDICATE_TYPE = "https://slsa.dev/provenance/v1";
export const PUBLISH_PREDICATE_TYPE = "https://github.com/npm/attestation/tree/main/specs/publish/v0.1";

const COMMIT_PATTERN = /^[0-9a-f]{40}$/u;
const INTEGRITY_PATTERN = /^sha512-[A-Za-z0-9+/]+={0,2}$/u;

/**
 * The dist-tag `publish-js-sdk.yml`'s `resolve_dist_tag` computes. Kept
 * identical on purpose: verifying against a differently-derived tag would prove
 * nothing about what the workflow actually did (the 0.0.6-stale-latest incident
 * is exactly a dist-tag that nobody checked afterwards).
 */
export function resolveDistTag(version) {
  if (version.startsWith("0.")) return "latest";
  if (version.includes("-")) return version.slice(version.indexOf("-") + 1).split(".")[0];
  return "latest";
}

/** Release Please tag for a component prefix, e.g. `js-sdk-` + `1.2.3` -> `js-sdk-v1.2.3`. */
export function releaseTagFor(prefix, version) {
  return `${prefix}v${version}`;
}

export function packumentUrl(registry, npmName) {
  return `${registry}/${npmName.replaceAll("/", "%2F")}`;
}

export function attestationsUrl(registry, npmName, version) {
  return `${registry}/-/npm/v1/attestations/${npmName.replaceAll("/", "%2F")}@${version}`;
}

/** The in-toto subject name npm records for a published tarball. */
export function subjectPurl(npmName, version) {
  return `pkg:npm/${npmName.replaceAll("@", "%40")}@${version}`;
}

/**
 * Decide what must be verified, before touching the network.
 *
 * Every included artifact is checked at the version its `versionSource` carries
 * in the checked-out tree. Artifacts bound to the sealed cut must resolve to
 * `sealedCommit`; the rest are bound to the commit their own Release Please tag
 * names, which is resolved through `resolveTagCommit` and is a hard failure
 * when it cannot be resolved.
 *
 * @returns {{targets: object[], errors: string[]}}
 */
export function planPublishedReleaseTargets({
  manifest,
  sealedTag,
  sealedCommit,
  readPackageVersion,
  resolveTagCommit,
}) {
  const errors = [];
  const targets = [];

  if (!COMMIT_PATTERN.test(sealedCommit ?? "")) {
    errors.push(`--commit must be a full 40-character commit sha, got "${sealedCommit ?? ""}"`);
  }
  const sealedPrefix = manifest?.cut?.sealedTagPrefix;
  if (typeof sealedPrefix !== "string" || !sealedTag?.startsWith(sealedPrefix)) {
    errors.push(`--tag "${sealedTag ?? ""}" is not a ${sealedPrefix} release tag`);
  }

  for (const artifact of manifest?.included ?? []) {
    let version;
    try {
      version = readPackageVersion(artifact.versionSource);
    } catch (error) {
      errors.push(
        `cannot read the published version of "${artifact.npmName}" from ${artifact.versionSource}: ${messageOf(error)}`,
      );
      continue;
    }
    if (typeof version !== "string" || version.length === 0) {
      errors.push(`${artifact.versionSource} carries no version for "${artifact.npmName}"`);
      continue;
    }

    const sealed = artifact.sourceBinding === "sealed-js-sdk-tag";
    const tag = sealed ? sealedTag : releaseTagFor(artifact.publish.releaseTagPrefix, version);
    if (sealed && tag !== releaseTagFor(artifact.publish.releaseTagPrefix, version)) {
      errors.push(
        `"${artifact.npmName}" is at ${version} but the sealed tag under verification is ${sealedTag}; the cut is inconsistent`,
      );
      continue;
    }

    let commit = sealedCommit;
    if (!sealed) {
      try {
        commit = resolveTagCommit(tag);
      } catch (error) {
        errors.push(
          `cannot resolve the commit ${tag} names, so "${artifact.npmName}" cannot be verified: ${messageOf(error)}. Fetch the release tags before running this gate.`,
        );
        continue;
      }
      if (!COMMIT_PATTERN.test(commit ?? "")) {
        errors.push(`${tag} did not resolve to a commit sha for "${artifact.npmName}"`);
        continue;
      }
    }

    targets.push({
      id: artifact.id,
      npmName: artifact.npmName,
      version,
      distTag: resolveDistTag(version),
      tag,
      commit,
      workflow: artifact.publish.workflow,
      sourceBinding: artifact.sourceBinding,
    });
  }

  targets.sort((left, right) => left.npmName.localeCompare(right.npmName));
  return { targets, errors };
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

async function fetchJson(fetchImpl, url) {
  const response = await fetchImpl(url, { headers: { accept: "application/json" } });
  if (!response?.ok) {
    throw new Error(`GET ${url} responded ${response?.status ?? "<no status>"}`);
  }
  return await response.json();
}

async function fetchBytes(fetchImpl, url) {
  const response = await fetchImpl(url, { headers: { accept: "application/octet-stream" } });
  if (!response?.ok) {
    throw new Error(`GET ${url} responded ${response?.status ?? "<no status>"}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

/** Decode the in-toto statement inside a Sigstore DSSE envelope. */
export function decodeAttestationStatement(attestation) {
  const payload = attestation?.bundle?.dsseEnvelope?.payload;
  if (typeof payload !== "string" || payload.length === 0) {
    throw new Error("attestation carries no dsseEnvelope payload");
  }
  const statement = JSON.parse(Buffer.from(payload, "base64").toString("utf8"));
  if (typeof statement !== "object" || statement === null) {
    throw new Error("attestation payload is not an in-toto statement");
  }
  return statement;
}

function check(id, description, evaluate) {
  try {
    const detail = evaluate();
    return { id, description, status: "pass", detail: detail ?? "ok" };
  } catch (error) {
    return { id, description, status: "fail", detail: messageOf(error) };
  }
}

function expect(condition, message) {
  if (!condition) throw new Error(message);
}

/**
 * Verify one planned target against the registry.
 *
 * Everything the registry says is treated as a claim to be checked against the
 * bytes it also serves; nothing is trusted because the field exists.
 */
async function verifyTarget(target, { registry, repository, fetchImpl }) {
  const checks = [];
  let packument;
  try {
    packument = await fetchJson(fetchImpl, packumentUrl(registry, target.npmName));
  } catch (error) {
    checks.push({
      id: "registry-packument",
      description: "the registry serves a packument for this package",
      status: "fail",
      detail: messageOf(error),
    });
    return finishTarget(target, checks, {});
  }

  const release = packument?.versions?.[target.version];
  checks.push(
    check("registry-version", `${target.npmName}@${target.version} is published`, () => {
      expect(
        release !== undefined,
        `the registry has no ${target.version}; published versions: ${Object.keys(packument?.versions ?? {}).join(", ") || "<none>"}`,
      );
      return target.version;
    }),
  );
  if (release === undefined) return finishTarget(target, checks, {});

  checks.push(
    check("dist-tag", `dist-tag "${target.distTag}" resolves to ${target.version}`, () => {
      const actual = packument?.["dist-tags"]?.[target.distTag];
      expect(
        actual === target.version,
        `dist-tag "${target.distTag}" points at ${actual ?? "<unset>"}, not ${target.version}`,
      );
      return target.distTag;
    }),
  );

  const integrity = release?.dist?.integrity;
  const tarballUrl = release?.dist?.tarball;
  let tarball;
  checks.push(
    await checkAsync("dist-integrity", "the served tarball hashes to the advertised integrity", async () => {
      expect(typeof tarballUrl === "string" && tarballUrl.length > 0, "dist.tarball is missing");
      expect(
        typeof integrity === "string" && INTEGRITY_PATTERN.test(integrity),
        `dist.integrity is missing or not a sha512 SRI value: ${integrity ?? "<missing>"}`,
      );
      tarball = await fetchBytes(fetchImpl, tarballUrl);
      const actual = `sha512-${createHash("sha512").update(tarball).digest("base64")}`;
      expect(actual === integrity, `tarball hashes to ${actual}, registry advertises ${integrity}`);
      const shasum = release?.dist?.shasum;
      if (typeof shasum === "string" && shasum.length > 0) {
        const actualShasum = createHash("sha1").update(tarball).digest("hex");
        expect(actualShasum === shasum, `tarball sha1 is ${actualShasum}, registry advertises ${shasum}`);
      }
      return integrity;
    }),
  );
  if (tarball === undefined) {
    return finishTarget(target, checks, { integrity, tarball: tarballUrl });
  }
  const tarballSha512Hex = createHash("sha512").update(tarball).digest("hex");

  let attestations;
  try {
    attestations = await fetchJson(fetchImpl, attestationsUrl(registry, target.npmName, target.version));
  } catch (error) {
    checks.push({
      id: "attestations",
      description: "npm holds attestations for this version",
      status: "fail",
      detail: `${messageOf(error)} — an unattested release cannot be verified and is not publishable`,
    });
    return finishTarget(target, checks, { integrity, tarball: tarballUrl });
  }

  const entries = Array.isArray(attestations?.attestations) ? attestations.attestations : [];
  checks.push(
    check("publish-attestation", "npm recorded a publish attestation", () => {
      const found = entries.find((entry) => entry.predicateType === PUBLISH_PREDICATE_TYPE);
      expect(found !== undefined, `no ${PUBLISH_PREDICATE_TYPE} attestation`);
      return PUBLISH_PREDICATE_TYPE;
    }),
  );

  const provenanceEntry = entries.find((entry) => entry.predicateType === PROVENANCE_PREDICATE_TYPE);
  let statement;
  checks.push(
    check("provenance-attestation", "a SLSA provenance attestation is present and decodable", () => {
      expect(provenanceEntry !== undefined, `no ${PROVENANCE_PREDICATE_TYPE} attestation`);
      statement = decodeAttestationStatement(provenanceEntry);
      expect(
        statement.predicateType === PROVENANCE_PREDICATE_TYPE,
        `envelope declares ${PROVENANCE_PREDICATE_TYPE} but the statement says ${statement.predicateType}`,
      );
      return PROVENANCE_PREDICATE_TYPE;
    }),
  );
  if (!statement) return finishTarget(target, checks, { integrity, tarball: tarballUrl });

  checks.push(
    check("provenance-subject", "the provenance is bound to the exact published tarball", () => {
      const subjects = Array.isArray(statement.subject) ? statement.subject : [];
      const expectedName = subjectPurl(target.npmName, target.version);
      const subject = subjects.find((entry) => entry?.name === expectedName);
      expect(
        subject !== undefined,
        `provenance names ${subjects.map((entry) => entry?.name).join(", ") || "<no subject>"}, not ${expectedName}`,
      );
      expect(
        subject.digest?.sha512 === tarballSha512Hex,
        `provenance subject digest ${subject.digest?.sha512 ?? "<missing>"} is not the served tarball's sha512`,
      );
      return expectedName;
    }),
  );

  const build = statement.predicate?.buildDefinition;
  const expectedRepositoryUrl = `https://github.com/${repository}`;
  checks.push(
    check("provenance-builder", "the provenance was produced by this repository's publish workflow", () => {
      const workflow = build?.externalParameters?.workflow;
      expect(workflow !== undefined, "provenance carries no externalParameters.workflow");
      expect(
        workflow.repository === expectedRepositoryUrl,
        `provenance names repository ${workflow.repository ?? "<missing>"}, not ${expectedRepositoryUrl}`,
      );
      expect(
        workflow.path === target.workflow,
        `provenance names workflow ${workflow.path ?? "<missing>"}, but ${MANIFEST_PATH} declares ${target.workflow}`,
      );
      return `${workflow.path}@${workflow.ref ?? "<no ref>"}`;
    }),
  );

  checks.push(
    check("source-revision", `the published artifact was built from ${target.commit}`, () => {
      const workflowRef = build?.externalParameters?.workflow?.ref;
      const expectedRef = `refs/tags/${target.tag}`;
      expect(
        workflowRef === expectedRef,
        `provenance was built from ${workflowRef ?? "<missing>"}, not ${expectedRef}`,
      );
      const dependencies = Array.isArray(build?.resolvedDependencies) ? build.resolvedDependencies : [];
      const commits = dependencies
        .map((dependency) => dependency?.digest?.gitCommit)
        .filter((value) => typeof value === "string");
      expect(commits.length > 0, "provenance resolves no source commit");
      expect(
        commits.includes(target.commit),
        `provenance names source commit ${commits.join(", ")}, but ${target.tag} names ${target.commit}`,
      );
      return target.commit;
    }),
  );

  return finishTarget(target, checks, { integrity, tarball: tarballUrl, sourceRevision: target.commit });
}

async function checkAsync(id, description, evaluate) {
  try {
    const detail = await evaluate();
    return { id, description, status: "pass", detail: detail ?? "ok" };
  } catch (error) {
    return { id, description, status: "fail", detail: messageOf(error) };
  }
}

function finishTarget(target, checks, extras) {
  const failures = checks.filter((entry) => entry.status === "fail");
  return {
    id: target.id,
    npmName: target.npmName,
    version: target.version,
    distTag: target.distTag,
    tag: target.tag,
    sourceBinding: target.sourceBinding,
    sourceRevision: extras.sourceRevision ?? null,
    workflow: target.workflow,
    tarball: extras.tarball ?? null,
    integrity: extras.integrity ?? null,
    status: failures.length === 0 ? "verified" : "failed",
    checks,
  };
}

/**
 * Verify every planned target and return the receipt.
 *
 * Deterministic: targets are already sorted, checks run in a fixed order, and
 * the only non-input value is `now()`, which the caller supplies.
 */
export async function verifyPublishedRelease({
  targets,
  sealedTag,
  sealedCommit,
  registry = DEFAULT_REGISTRY,
  repository,
  fetchImpl = fetch,
  planningErrors = [],
  now = () => new Date(),
}) {
  const artifacts = [];
  for (const target of targets) {
    artifacts.push(await verifyTarget(target, { registry, repository, fetchImpl }));
  }
  const failures = [
    ...planningErrors,
    ...artifacts.flatMap((artifact) =>
      artifact.checks
        .filter((entry) => entry.status === "fail")
        .map((entry) => `${artifact.npmName}@${artifact.version}: ${entry.description} — ${entry.detail}`),
    ),
  ];
  return {
    format: RECEIPT_FORMAT,
    schemaVersion: RECEIPT_SCHEMA_VERSION,
    status: failures.length === 0 && artifacts.length > 0 ? "verified" : "failed",
    verifiedAt: now().toISOString(),
    registry,
    repository,
    sealedTag,
    sealedCommit,
    manifest: MANIFEST_PATH,
    artifacts,
    failures,
  };
}

/** Stable serialization; the receipt is an input to honua-io/honua-sdk-js#39. */
export function receiptJson(receipt) {
  return `${JSON.stringify(receipt, null, 2)}\n`;
}

export function parseVerifyPublishedReleaseArgs(argv) {
  const options = { registry: DEFAULT_REGISTRY, receipt: "test-results/published-release-verification.v1.json" };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === "--tag") options.tag = value;
    else if (flag === "--commit") options.commit = value;
    else if (flag === "--registry") options.registry = value;
    else if (flag === "--receipt") options.receipt = value;
    else throw new Error(`Unknown verify-published-release argument: ${flag}`);
    index += 1;
  }
  if (!options.tag) throw new Error("verify-published-release requires --tag <release tag>");
  if (!options.commit) throw new Error("verify-published-release requires --commit <sealed commit sha>");
  return options;
}

function readPackageVersionFrom(root) {
  return (relativePath) => JSON.parse(fs.readFileSync(path.join(root, relativePath), "utf8")).version;
}

function resolveTagCommitWith(root) {
  return (tag) =>
    execFileSync("git", ["rev-parse", "--verify", `${tag}^{commit}`], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
}

async function main(argv) {
  const options = parseVerifyPublishedReleaseArgs(argv);
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, MANIFEST_PATH), "utf8"));
  const { targets, errors } = planPublishedReleaseTargets({
    manifest,
    sealedTag: options.tag,
    sealedCommit: options.commit,
    readPackageVersion: readPackageVersionFrom(ROOT),
    resolveTagCommit: resolveTagCommitWith(ROOT),
  });

  const receipt = await verifyPublishedRelease({
    targets,
    sealedTag: options.tag,
    sealedCommit: options.commit,
    registry: options.registry,
    repository: manifest.repository,
    planningErrors: errors,
  });

  const receiptPath = path.resolve(ROOT, options.receipt);
  fs.mkdirSync(path.dirname(receiptPath), { recursive: true });
  fs.writeFileSync(receiptPath, receiptJson(receipt));

  for (const artifact of receipt.artifacts) {
    process.stdout.write(
      `${artifact.status === "verified" ? "OK  " : "FAIL"} ${artifact.npmName}@${artifact.version}\n`,
    );
  }
  process.stdout.write(`receipt: ${options.receipt}\n`);

  if (receipt.status !== "verified") {
    process.stderr.write(`\nPublished release verification FAILED for ${options.tag}:\n`);
    for (const failure of receipt.failures) {
      process.stderr.write(`- ${failure}\n`);
    }
    if (receipt.artifacts.length === 0) {
      process.stderr.write("- no artifact was verified at all\n");
    }
    process.exitCode = 1;
  }
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  await main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  });
}
