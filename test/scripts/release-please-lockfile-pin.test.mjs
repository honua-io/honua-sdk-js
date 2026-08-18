import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  BOUND_PIN_PATHS,
  lockfileDigest,
  PIN_POLICY_PATH,
  PIN_WORKFLOW_PATH,
  readPinnedDigest,
  writePinnedDigest,
} from "../../scripts/lib/lockfile-pin.mjs";
import { RELEASE_PLEASE_HEAD } from "../../scripts/lib/release-please-disposition-check.mjs";
import {
  PIN_COMMIT_MESSAGE,
  syncReleasePleaseLockfilePin,
} from "../../scripts/lib/release-please-lockfile-pin.mjs";

const repository = "honua-io/honua-sdk-js";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const fixture = JSON.parse(
  fs.readFileSync(path.join(root, "test/fixtures/pr-issue-disposition/release-please-pr-382.json"), "utf8"),
);
const trustedPolicySha = fixture.baseSha;
const headSha = fixture.headSha;
const pinnedSha = "b".repeat(40);
const headTreeSha = "1".repeat(40);
const STALE_PIN = "0".repeat(64);

const BASE_LOCKFILE = `${JSON.stringify(
  {
    name: "@honua/sdk-js",
    version: "0.1.7-beta.0",
    lockfileVersion: 3,
    packages: {
      "": { name: "@honua/sdk-js", version: "0.1.7-beta.0", dependencies: { left: "^1.0.0" } },
      "node_modules/left": {
        version: "1.0.0",
        resolved: "https://registry.npmjs.org/left/-/left-1.0.0.tgz",
        integrity: `sha512-${"B".repeat(86)}==`,
      },
    },
  },
  null,
  2,
)}\n`;

function bumpedLockfile(mutate = () => {}) {
  const next = JSON.parse(BASE_LOCKFILE);
  next.version = "0.1.8-beta.0";
  next.packages[""].version = "0.1.8-beta.0";
  mutate(next);
  return `${JSON.stringify(next, null, 2)}\n`;
}

function boundText(boundPath, digest) {
  const template =
    boundPath === PIN_WORKFLOW_PATH
      ? `jobs:\n  attest-and-publish:\n    steps:\n      - env:\n          EXPECTED_LOCKFILE_SHA256: ${"0".repeat(64)}\n`
      : `export const NODE_VERSION = "20.19.0";\nexport const EXPECTED_LOCKFILE_SHA256 =\n  "${"0".repeat(64)}";\n`;
  return writePinnedDigest(template, boundPath, digest);
}

function restPull(snapshot) {
  return {
    number: snapshot.pullRequestNumber,
    body: snapshot.body,
    title: snapshot.title,
    state: snapshot.state.toLowerCase(),
    updated_at: snapshot.updatedAt,
    user: { login: snapshot.authorLogin, type: snapshot.authorType },
    head: { ref: snapshot.headRefName, sha: snapshot.headSha, repo: { full_name: snapshot.headRepository } },
    base: { ref: snapshot.baseRefName, sha: snapshot.baseSha, repo: { full_name: snapshot.baseRepository } },
  };
}

function graphqlPayload(snapshot) {
  return {
    data: {
      repository: {
        nameWithOwner: snapshot.repository,
        pullRequest: {
          number: snapshot.pullRequestNumber,
          body: snapshot.body,
          title: snapshot.title,
          state: snapshot.state,
          updatedAt: snapshot.updatedAt,
          headRefName: snapshot.headRefName,
          headRefOid: snapshot.headSha,
          headRepository: { nameWithOwner: snapshot.headRepository },
          baseRefName: snapshot.baseRefName,
          baseRefOid: snapshot.baseSha,
          baseRepository: { nameWithOwner: snapshot.baseRepository },
          author: { __typename: snapshot.authorType, login: snapshot.authorLogin },
          closingIssuesReferences: { nodes: [], pageInfo: { hasNextPage: false } },
        },
      },
    },
  };
}

/**
 * A GitHub stand-in holding one file tree per revision, so the synchroniser's
 * writes are observable as the tree it would actually create.
 */
function harness(options = {}) {
  const headLockfile = options.headLockfile ?? bumpedLockfile();
  const pinnedDigest = lockfileDigest(Buffer.from(headLockfile));
  const files = new Map([
    [
      trustedPolicySha,
      new Map([
        ["package-lock.json", BASE_LOCKFILE],
        ["package.json", `${JSON.stringify({ version: options.baseVersion ?? "0.1.7-beta.0" })}\n`],
      ]),
    ],
    [
      headSha,
      new Map([
        ["package-lock.json", headLockfile],
        ["package.json", `${JSON.stringify({ version: options.headVersion ?? "0.1.8-beta.0" })}\n`],
        ...BOUND_PIN_PATHS.map((boundPath) => [
          boundPath,
          boundText(boundPath, options.alreadyPinned ? pinnedDigest : STALE_PIN),
        ]),
      ]),
    ],
  ]);
  const calls = [];
  const writes = { blobs: new Map(), trees: [], commits: [], refUpdates: [] };
  let nextBlob = 0;

  const request = async (url, requestOptions = {}) => {
    const method = requestOptions.method ?? "GET";
    const parsed = new URL(url);
    const { pathname } = parsed;
    calls.push({ method, pathname });

    if (pathname.endsWith("/graphql")) return graphqlPayload(fixture);
    if (pathname.endsWith("/pulls")) return options.noPullRequest ? [] : [restPull(fixture)];
    if (pathname.endsWith(`/git/ref/heads/${RELEASE_PLEASE_HEAD}`)) {
      return {
        ref: `refs/heads/${RELEASE_PLEASE_HEAD}`,
        object: { type: "commit", sha: options.releaseBranchHead ?? headSha },
      };
    }
    if (pathname.includes("/contents/")) {
      const filePath = decodeURIComponent(pathname.split("/contents/")[1]);
      const revision = parsed.searchParams.get("ref");
      const content = files.get(revision)?.get(filePath);
      if (content === undefined) throw new Error(`missing ${filePath} at ${revision}`);
      return {
        type: "file",
        path: filePath,
        sha: "f".repeat(40),
        encoding: "base64",
        content: Buffer.from(content, "utf8").toString("base64"),
      };
    }
    if (method === "GET" && pathname.includes("/git/commits/")) {
      return { sha: pathname.split("/git/commits/")[1], tree: { sha: headTreeSha } };
    }
    if (method === "GET" && pathname.includes("/git/trees/")) {
      const tree = pathname.split("/git/trees/")[1];
      const entries = {
        [headTreeSha]: [
          { path: ".github", type: "tree", sha: "2".repeat(40), mode: "040000" },
          { path: "scripts", type: "tree", sha: "3".repeat(40), mode: "040000" },
        ],
        ["2".repeat(40)]: [{ path: "workflows", type: "tree", sha: "4".repeat(40), mode: "040000" }],
        ["4".repeat(40)]: [
          { path: path.basename(PIN_WORKFLOW_PATH), type: "blob", sha: "5".repeat(40), mode: "100644" },
        ],
        ["3".repeat(40)]: [
          { path: path.basename(PIN_POLICY_PATH), type: "blob", sha: "6".repeat(40), mode: "100644" },
        ],
      }[tree];
      if (!entries) throw new Error(`missing tree ${tree}`);
      return { sha: tree, truncated: false, tree: entries };
    }
    if (method === "POST" && pathname.endsWith("/git/blobs")) {
      nextBlob += 1;
      const sha = String(nextBlob).repeat(40).slice(0, 40);
      writes.blobs.set(sha, Buffer.from(JSON.parse(requestOptions.body).content, "base64").toString("utf8"));
      return { sha };
    }
    if (method === "POST" && pathname.endsWith("/git/trees")) {
      const body = JSON.parse(requestOptions.body);
      writes.trees.push(body);
      const pinned = new Map(files.get(headSha));
      for (const entry of body.tree) pinned.set(entry.path, writes.blobs.get(entry.sha));
      files.set(pinnedSha, pinned);
      return { sha: "7".repeat(40) };
    }
    if (method === "POST" && pathname.endsWith("/git/commits")) {
      const body = JSON.parse(requestOptions.body);
      writes.commits.push(body);
      return { sha: pinnedSha, tree: { sha: body.tree }, parents: body.parents.map((sha) => ({ sha })) };
    }
    if (method === "PATCH" && pathname.endsWith(`/git/refs/heads/${RELEASE_PLEASE_HEAD}`)) {
      const body = JSON.parse(requestOptions.body);
      writes.refUpdates.push(body);
      return { ref: `refs/heads/${RELEASE_PLEASE_HEAD}`, object: { type: "commit", sha: body.sha } };
    }
    if (pathname.includes("/compare/")) {
      return (
        options.comparison ?? {
          status: "ahead",
          ahead_by: 1,
          behind_by: 0,
          files: BOUND_PIN_PATHS.map((boundPath) => ({ filename: boundPath })),
        }
      );
    }
    throw new Error(`unexpected ${method} ${pathname}`);
  };

  return { request, calls, writes, files, pinnedDigest };
}

describe("the Release Please lockfile digest synchroniser", () => {
  it("re-pins both bound copies in one fast-forward commit", async () => {
    const stub = harness();
    const result = await syncReleasePleaseLockfilePin({ repository, trustedPolicySha }, stub.request);

    assert.equal(result.status, "pinned");
    assert.equal(result.previousHeadSha, headSha);
    assert.equal(result.headSha, pinnedSha);
    assert.equal(result.lockfileSha256, stub.pinnedDigest);
    assert.equal(result.baseVersion, "0.1.7-beta.0");
    assert.equal(result.headVersion, "0.1.8-beta.0");

    // Both copies move together, in the same commit, and nothing else moves.
    assert.equal(stub.writes.trees.length, 1);
    assert.equal(stub.writes.trees[0].base_tree, headTreeSha);
    assert.deepEqual(
      stub.writes.trees[0].tree.map((entry) => entry.path).sort(),
      [...BOUND_PIN_PATHS].sort(),
    );
    for (const entry of stub.writes.trees[0].tree) {
      assert.equal(entry.mode, "100644");
      assert.equal(readPinnedDigest(stub.writes.blobs.get(entry.sha), entry.path), stub.pinnedDigest);
    }
    assert.deepEqual(stub.writes.commits, [
      { message: PIN_COMMIT_MESSAGE, tree: "7".repeat(40), parents: [headSha] },
    ]);
    // Never force: a concurrent Release Please regeneration must win this race
    // rather than be overwritten by a pin computed for a branch that is gone.
    assert.deepEqual(stub.writes.refUpdates, [{ sha: pinnedSha, force: false }]);
  });

  it("does nothing when the release head is already pinned", async () => {
    const stub = harness({ alreadyPinned: true });
    const result = await syncReleasePleaseLockfilePin({ repository, trustedPolicySha }, stub.request);
    assert.equal(result.status, "already-pinned");
    assert.equal(result.headSha, headSha);
    assert.equal(stub.writes.commits.length, 0);
    assert.equal(stub.writes.refUpdates.length, 0);
  });

  it("reports no work when no Release Please pull request is open", async () => {
    const stub = harness({ noPullRequest: true });
    const result = await syncReleasePleaseLockfilePin({ repository, trustedPolicySha }, stub.request);
    assert.equal(result.status, "not-found");
    assert.equal(stub.writes.commits.length, 0);
  });

  // The reason this shape is safe rather than a hole: the digest is only ever
  // recomputed for a lockfile proven to equal trusted trunk's modulo
  // first-party version strings, so a release branch cannot carry a dependency
  // change through the guard (#1357).
  it("refuses to recompute a digest for a release branch carrying a dependency change", async () => {
    const stub = harness({
      headLockfile: bumpedLockfile((next) => {
        next.packages["node_modules/honua-undeclared-dependency"] = {
          version: "1.0.0",
          resolved: "https://registry.npmjs.org/honua-undeclared-dependency/-/honua-undeclared-dependency-1.0.0.tgz",
          integrity: `sha512-${"A".repeat(86)}==`,
        };
      }),
    });
    await assert.rejects(
      () => syncReleasePleaseLockfilePin({ repository, trustedPolicySha }, stub.request),
      /undeclared lockfile change/u,
    );
    assert.equal(stub.writes.blobs.size, 0);
    assert.equal(stub.writes.refUpdates.length, 0);
  });

  it("refuses when the release branch head moved under it", async () => {
    const stub = harness({ releaseBranchHead: "c".repeat(40) });
    await assert.rejects(
      () => syncReleasePleaseLockfilePin({ repository, trustedPolicySha }, stub.request),
      /no longer resolves to the validated head/u,
    );
    assert.equal(stub.writes.refUpdates.length, 0);
  });

  it("refuses when the base is not the trusted trunk policy revision", async () => {
    const stub = harness();
    await assert.rejects(
      () => syncReleasePleaseLockfilePin({ repository, trustedPolicySha: "d".repeat(40) }, stub.request),
      /base does not match the trusted trunk policy revision/u,
    );
  });

  it("refuses when the created commit touched anything but the bound files", async () => {
    const stub = harness({
      comparison: {
        status: "ahead",
        ahead_by: 1,
        behind_by: 0,
        files: [...BOUND_PIN_PATHS, "package.json"].map((filename) => ({ filename })),
      },
    });
    await assert.rejects(
      () => syncReleasePleaseLockfilePin({ repository, trustedPolicySha }, stub.request),
      /exactly one commit changing only/u,
    );
  });

  it("rejects a malformed repository or trusted revision", async () => {
    const stub = harness();
    await assert.rejects(
      () => syncReleasePleaseLockfilePin({ repository: "nope", trustedPolicySha }, stub.request),
      /owner\/name pair/u,
    );
    await assert.rejects(
      () => syncReleasePleaseLockfilePin({ repository, trustedPolicySha: "abc" }, stub.request),
      /full lowercase commit SHA/u,
    );
  });
});
