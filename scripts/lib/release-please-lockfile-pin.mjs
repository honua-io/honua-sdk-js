import process from "node:process";

import { githubRequest, loadCurrentPullRequestDisposition } from "./github-pr-issue-disposition.mjs";
import {
  assertMechanicalVersionBump,
  BOUND_PIN_PATHS,
  inspectLockfilePin,
  lockfileDigest,
  LOCKFILE_PATH,
  MANIFEST_PATH,
  manifestVersion,
  PIN_COMMIT_MESSAGE,
  writePinnedDigest,
} from "./lockfile-pin.mjs";
import { validatePullRequestDisposition } from "./pr-issue-disposition.mjs";
import {
  assertMatchingReleasePleaseSnapshots,
  findCurrentReleasePleasePullRequest,
  RELEASE_PLEASE_EXEMPTION,
  RELEASE_PLEASE_HEAD,
} from "./release-please-disposition-check.mjs";

export { PIN_COMMIT_MESSAGE };

const SHA_PATTERN = /^[0-9a-f]{40}$/u;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const BLOB_MODE = /^100(?:644|755)$/u;

function apiRoot() {
  return process.env.GITHUB_API_URL ?? "https://api.github.com";
}

function assertSha(value, label) {
  if (!SHA_PATTERN.test(value)) throw new Error(`${label} must be a full lowercase commit SHA.`);
}

async function loadExactReleasePleasePullRequest(repository, trustedPolicySha, request) {
  const rest = await findCurrentReleasePleasePullRequest(repository, request);
  if (!rest) return null;
  const current = await loadCurrentPullRequestDisposition(
    { repository, pullRequestNumber: rest.pullRequestNumber },
    request,
  );
  assertMatchingReleasePleaseSnapshots(rest, current);
  if (current.baseSha !== trustedPolicySha) {
    throw new Error("The current Release Please base does not match the trusted trunk policy revision.");
  }
  const disposition = validatePullRequestDisposition(current);
  if (disposition.status !== "exempt" || disposition.exemption !== RELEASE_PLEASE_EXEMPTION) {
    throw new Error(`Pull request #${current.pullRequestNumber} is not exact Release Please automation.`);
  }
  return current;
}

async function assertReleaseBranchHead(repository, expectedHeadSha, request) {
  const ref = await request(
    `${apiRoot()}/repos/${repository}/git/ref/heads/${encodeURIComponent(RELEASE_PLEASE_HEAD)}`,
  );
  if (
    ref?.ref !== `refs/heads/${RELEASE_PLEASE_HEAD}` ||
    ref?.object?.type !== "commit" ||
    ref?.object?.sha !== expectedHeadSha
  ) {
    throw new Error(`Release Please branch no longer resolves to the validated head ${expectedHeadSha}.`);
  }
}

function decodeBase64(payload, filePath) {
  if (payload?.encoding !== "base64" || typeof payload?.content !== "string") {
    throw new Error(`GitHub returned ${filePath} in an unusable encoding.`);
  }
  return Buffer.from(payload.content, "base64");
}

/**
 * Read one committed file at an exact revision.
 *
 * The contents API stops inlining bytes past 1 MB, so fall through to the blob
 * API on the `none` encoding rather than letting a growing lockfile silently
 * turn every release into a failure nobody can read.
 */
async function readFileAtRevision(repository, revision, filePath, request) {
  const url = new URL(`${apiRoot()}/repos/${repository}/contents/${filePath}`);
  url.searchParams.set("ref", revision);
  const payload = await request(url.toString());
  if (payload?.type !== "file" || payload?.path !== filePath || !SHA_PATTERN.test(String(payload?.sha ?? ""))) {
    throw new Error(`GitHub returned malformed metadata for ${filePath} at ${revision}.`);
  }
  if (payload.encoding === "none") {
    const blob = await request(`${apiRoot()}/repos/${repository}/git/blobs/${payload.sha}`);
    if (blob?.sha !== payload.sha) throw new Error(`GitHub returned the wrong blob for ${filePath}.`);
    return { bytes: decodeBase64(blob, filePath), blobSha: payload.sha };
  }
  return { bytes: decodeBase64(payload, filePath), blobSha: payload.sha };
}

/**
 * The tree mode a path already carries, so rewriting content never changes it.
 *
 * Walked one directory at a time from the root tree: `git/trees/<sha>:<path>`
 * would need a colon and slashes preserved in a path segment, and a recursive
 * listing of a repository this size can come back truncated.
 */
async function readBlobMode(repository, treeSha, filePath, request) {
  const segments = filePath.split("/");
  let currentTree = treeSha;
  for (let index = 0; index < segments.length; index += 1) {
    const tree = await request(`${apiRoot()}/repos/${repository}/git/trees/${currentTree}`);
    if (tree?.truncated === true) throw new Error(`GitHub truncated the tree containing ${filePath}.`);
    const entry = (Array.isArray(tree?.tree) ? tree.tree : []).find((candidate) => candidate?.path === segments[index]);
    const last = index === segments.length - 1;
    if (!SHA_PATTERN.test(String(entry?.sha ?? "")) || entry.type !== (last ? "blob" : "tree")) {
      throw new Error(`${filePath} is not an ordinary file in tree ${treeSha}.`);
    }
    if (last) {
      if (!BLOB_MODE.test(String(entry.mode ?? ""))) {
        throw new Error(`${filePath} is not an ordinary file in tree ${treeSha}.`);
      }
      return entry.mode;
    }
    currentTree = entry.sha;
  }
  throw new Error(`${filePath} is not an ordinary file in tree ${treeSha}.`);
}

async function createPinCommit(repository, input, request) {
  const { headSha, headTreeSha, files } = input;
  const tree = [];
  for (const file of files) {
    const blob = await request(`${apiRoot()}/repos/${repository}/git/blobs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: Buffer.from(file.text, "utf8").toString("base64"), encoding: "base64" }),
    });
    assertSha(String(blob?.sha ?? ""), `Created blob for ${file.path}`);
    tree.push({ path: file.path, mode: file.mode, type: "blob", sha: blob.sha });
  }
  const created = await request(`${apiRoot()}/repos/${repository}/git/trees`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ base_tree: headTreeSha, tree }),
  });
  assertSha(String(created?.sha ?? ""), "Created tree");
  if (created.sha === headTreeSha) throw new Error("The pinned-digest tree is identical to the release head tree.");
  const commit = await request(`${apiRoot()}/repos/${repository}/git/commits`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: PIN_COMMIT_MESSAGE, tree: created.sha, parents: [headSha] }),
  });
  assertSha(String(commit?.sha ?? ""), "Created commit");
  if (commit?.tree?.sha !== created.sha || commit?.parents?.[0]?.sha !== headSha || commit.parents.length !== 1) {
    throw new Error("GitHub did not create the exact single-parent pinned-digest commit.");
  }
  const updated = await request(
    `${apiRoot()}/repos/${repository}/git/refs/heads/${encodeURIComponent(RELEASE_PLEASE_HEAD)}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      // Never force: a fast-forward-only update is what makes a concurrent
      // Release Please regeneration lose this race safely instead of being
      // overwritten by a pin computed for a branch that no longer exists.
      body: JSON.stringify({ sha: commit.sha, force: false }),
    },
  );
  if (updated?.ref !== `refs/heads/${RELEASE_PLEASE_HEAD}` || updated?.object?.sha !== commit.sha) {
    throw new Error("GitHub did not fast-forward the Release Please branch onto the pinned-digest commit.");
  }
  return commit.sha;
}

async function assertPinCommitChangedOnlyBoundFiles(repository, headSha, pinnedSha, request) {
  const comparison = await request(`${apiRoot()}/repos/${repository}/compare/${headSha}...${pinnedSha}`);
  const changed = (Array.isArray(comparison?.files) ? comparison.files : []).map((file) => file?.filename).sort();
  if (
    comparison?.status !== "ahead" ||
    comparison?.ahead_by !== 1 ||
    comparison?.behind_by !== 0 ||
    JSON.stringify(changed) !== JSON.stringify([...BOUND_PIN_PATHS].sort())
  ) {
    throw new Error(
      `The pinned-digest commit must be exactly one commit changing only ${BOUND_PIN_PATHS.join(" and ")}.`,
    );
  }
}

/**
 * Re-pin the sample-bundle lockfile digest on the exact Release Please branch.
 *
 * Release Please's whole job is to bump versions, which rewrites
 * `package-lock.json`, which moves its digest -- so every release pull request
 * breaks the pin by construction and the failure propagates to trunk through
 * `release-please-ci`'s dispatch-and-await (honua-io/honua-sdk-js#1357). The
 * answer is not to relax the guard, which is what binds sample-bundle
 * publication to an exact lockfile, but to give the one deliberate, mechanical
 * lockfile change a path through it.
 *
 * Two properties make that safe:
 *
 *  1. The new digest is only ever computed for a lockfile proven to equal the
 *     *trusted trunk* lockfile modulo first-party `version` strings. A release
 *     branch therefore cannot smuggle a dependency change past the guard: any
 *     other lockfile difference aborts here, and dependency changes that
 *     arrived through trunk already faced the guard on their own pull request.
 *  2. Both bound copies are rewritten in the same commit, so the workflow
 *     constant and the policy validator can never disagree.
 *
 * It re-applies on every Release Please run, so a regenerated (force-pushed)
 * bot branch simply gets pinned again in the same workflow run, before
 * canonical CI is dispatched for it.
 */
export async function syncReleasePleaseLockfilePin(input, request = githubRequest) {
  const repository = String(input?.repository ?? "");
  const trustedPolicySha = String(input?.trustedPolicySha ?? "");
  if (!REPOSITORY_PATTERN.test(repository)) throw new Error("A valid repository owner/name pair is required.");
  assertSha(trustedPolicySha, "Trusted policy revision");

  const current = await loadExactReleasePleasePullRequest(repository, trustedPolicySha, request);
  if (!current) return { status: "not-found", repository, trustedPolicySha };
  await assertReleaseBranchHead(repository, current.headSha, request);

  const [baseLockfile, baseManifest, headLockfile, headManifest] = await Promise.all([
    readFileAtRevision(repository, trustedPolicySha, LOCKFILE_PATH, request),
    readFileAtRevision(repository, trustedPolicySha, MANIFEST_PATH, request),
    readFileAtRevision(repository, current.headSha, LOCKFILE_PATH, request),
    readFileAtRevision(repository, current.headSha, MANIFEST_PATH, request),
  ]);

  const baseVersion = manifestVersion(baseManifest.bytes.toString("utf8"), `${MANIFEST_PATH} on trunk`);
  const headVersion = manifestVersion(
    headManifest.bytes.toString("utf8"),
    `${MANIFEST_PATH} on ${RELEASE_PLEASE_HEAD}`,
  );
  const bump = assertMechanicalVersionBump({
    baseLockfileText: baseLockfile.bytes.toString("utf8"),
    headLockfileText: headLockfile.bytes.toString("utf8"),
    baseVersion,
    headVersion,
  });

  const headCommit = await request(`${apiRoot()}/repos/${repository}/git/commits/${current.headSha}`);
  if (headCommit?.sha !== current.headSha) throw new Error("GitHub returned the wrong Release Please head commit.");
  assertSha(String(headCommit?.tree?.sha ?? ""), "Release Please head tree");

  const boundFiles = [];
  for (const boundPath of BOUND_PIN_PATHS) {
    const [file, mode] = await Promise.all([
      readFileAtRevision(repository, current.headSha, boundPath, request),
      readBlobMode(repository, headCommit.tree.sha, boundPath, request),
    ]);
    boundFiles.push({ path: boundPath, text: file.bytes.toString("utf8"), mode });
  }
  const boundTexts = Object.fromEntries(boundFiles.map((file) => [file.path, file.text]));
  const digest = lockfileDigest(headLockfile.bytes);
  const before = inspectLockfilePin({ lockfile: headLockfile.bytes, boundTexts });
  const result = {
    repository,
    pullRequestNumber: current.pullRequestNumber,
    trustedPolicySha,
    baseVersion: bump.baseVersion,
    headVersion: bump.headVersion,
    lockfileSha256: digest,
  };
  if (before.status === "in-sync") {
    return { ...result, status: "already-pinned", headSha: current.headSha, previousHeadSha: current.headSha };
  }

  const rewritten = boundFiles.map((file) => ({
    ...file,
    text: writePinnedDigest(file.text, file.path, digest),
  }));
  const pinnedSha = await createPinCommit(
    repository,
    { headSha: current.headSha, headTreeSha: headCommit.tree.sha, files: rewritten },
    request,
  );
  await assertPinCommitChangedOnlyBoundFiles(repository, current.headSha, pinnedSha, request);

  const verification = await Promise.all(
    BOUND_PIN_PATHS.map(async (boundPath) => [
      boundPath,
      (await readFileAtRevision(repository, pinnedSha, boundPath, request)).bytes.toString("utf8"),
    ]),
  );
  const after = inspectLockfilePin({
    lockfile: (await readFileAtRevision(repository, pinnedSha, LOCKFILE_PATH, request)).bytes,
    boundTexts: Object.fromEntries(verification),
  });
  if (after.status !== "in-sync") throw new Error(after.message);

  return { ...result, status: "pinned", previousHeadSha: current.headSha, headSha: pinnedSha };
}
