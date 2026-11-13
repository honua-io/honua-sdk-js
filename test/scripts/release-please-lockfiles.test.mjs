import { prepareReleasePleaseCandidates } from "../../scripts/lib/release-please-candidates.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { normalizeCandidateLockfiles, normalizeReleasePleaseLockfiles } from "../../scripts/lib/release-please-lockfiles.mjs";

const BASE = "1".repeat(40);
const HEAD = "2".repeat(40);
const NEXT = "3".repeat(40);
const TREE = "4".repeat(40);
const BRANCH = "release-please--branches--trunk--components--mcp-server";
const REPO = "honua-io/honua-sdk-js";

function files(sdkVersion = "0.3.3") {
  const sdk = { name: "@honua/sdk-js", version: sdkVersion, dependencies: { external: "^1.0.0" } };
  const mcp = { name: "@honua/mcp-server", version: "0.3.2", dependencies: { "@honua/sdk-js": "file:.." } };
  const external = { version: "1.2.3", resolved: "https://registry.npmjs.org/external/-/external-1.2.3.tgz", integrity: "sha512-keep" };
  return Object.fromEntries(Object.entries({
    "package.json": sdk,
    "package-lock.json": { name: sdk.name, version: sdkVersion, lockfileVersion: 3, packages: {
      "": { ...sdk, version: "0.3.4" }, "node_modules/external": external,
    } },
    "mcp/package.json": mcp,
    "mcp/package-lock.json": { name: mcp.name, version: mcp.version, lockfileVersion: 3, packages: {
      "": mcp, "..": { ...sdk, version: "0.3.4" }, "node_modules/external": external,
    } },
  }).map(([path, value]) => [path, `${JSON.stringify(value, null, 2)}\n`]));
}

test("MCP-only candidate corrects local SDK versions without changing component versions or dependency data", () => {
  const original = files();
  const changes = normalizeCandidateLockfiles(original);
  assert.deepEqual(changes.map(({ path }) => path), ["package-lock.json", "mcp/package-lock.json"]);
  for (const { path, content } of changes) {
    const before = JSON.parse(original[path]);
    const after = JSON.parse(content);
    if (path === "package-lock.json") before.packages[""].version = "0.3.3";
    else before.packages[".."].version = "0.3.3";
    assert.deepEqual(after, before);
  }
  const corrected = { ...original, ...Object.fromEntries(changes.map(({ path, content }) => [path, content])) };
  assert.deepEqual(normalizeCandidateLockfiles(corrected), []);
});

test("root SDK release preserves its actual new version and requires no correction", () => {
  assert.deepEqual(normalizeCandidateLockfiles(files("0.3.4")), []);
});

test("root SDK release advances stale local metadata to the actual new manifest version", () => {
  const source = files("0.3.4");
  for (const path of ["package-lock.json", "mcp/package-lock.json"]) {
    const lock = JSON.parse(source[path]);
    if (path === "package-lock.json") {
      lock.version = "0.3.3";
      lock.packages[""].version = "0.3.3";
    } else lock.packages[".."].version = "0.3.3";
    source[path] = JSON.stringify(lock);
  }
  const corrected = Object.fromEntries(normalizeCandidateLockfiles(source).map(({ path, content }) => [path, JSON.parse(content)]));
  assert.equal(corrected["package-lock.json"].version, "0.3.4");
  assert.equal(corrected["package-lock.json"].packages[""].version, "0.3.4");
  assert.equal(corrected["mcp/package-lock.json"].packages[".."].version, "0.3.4");
  assert.equal(corrected["mcp/package-lock.json"].version, "0.3.2");
});

test("mismatched MCP release versions and missing local SDK identity fail closed", () => {
  for (const change of [(lock) => { lock.version = "0.3.9"; }, (lock) => { delete lock.packages[".."]; }]) {
    const source = files();
    const lock = JSON.parse(source["mcp/package-lock.json"]);
    change(lock);
    source["mcp/package-lock.json"] = JSON.stringify(lock);
    assert.throws(() => normalizeCandidateLockfiles(source), /MCP/);
  }
});

function harness(options = {}) {
  const calls = [];
  let graphqlReads = 0;
  const source = files(options.sdkVersion);
  const pullRequest = {
    number: 2405, body: "generated body", title: "chore(trunk): release mcp-server 0.3.2", state: "OPEN", updatedAt: "now",
    headRefName: BRANCH, headRefOid: HEAD, baseRefName: "trunk", baseRefOid: BASE,
    headRepository: { nameWithOwner: REPO }, baseRepository: { nameWithOwner: REPO },
    author: { __typename: "Bot", login: "honua-io-bot" },
    closingIssuesReferences: { nodes: [], pageInfo: { hasNextPage: false } },
    ...options.metadata,
  };
  const request = async (url, init = {}) => {
    const parsed = new URL(url);
    const path = parsed.pathname.replace(`/repos/${REPO}`, "");
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ path, method: init.method ?? "GET", body });
    if (path === "/graphql") {
      graphqlReads++;
      return { data: { repository: { nameWithOwner: REPO, pullRequest: {
        ...pullRequest, ...(options.moveAfterRead && graphqlReads > (options.moveAfterRead === true ? 2 : options.moveAfterRead) ? { headRefOid: NEXT } : {}),
      } } } };
    }
    if (path === "/pulls") return parsed.searchParams.get("head") === `honua-io:${BRANCH}` ? [{ number: 2405, head: { sha: HEAD } }] : [];
    if (path.startsWith("/contents/")) {
      assert.equal(parsed.searchParams.get("ref"), HEAD);
      return { type: "file", encoding: "base64", content: Buffer.from(source[path.slice(10)]).toString("base64") };
    }
    if (path.startsWith("/git/ref/heads/")) {
      const branch = path.slice(15);
      return { ref: `refs/heads/${branch}`, object: { type: "commit", sha: branch === "trunk" ? BASE : HEAD } };
    }
    if (path === `/git/commits/${HEAD}`) return { sha: HEAD, tree: { sha: TREE } };
    if (path === "/git/trees") return { sha: TREE };
    if (path === "/git/commits") return { sha: NEXT, tree: { sha: TREE }, parents: [{ sha: options.commitParent ?? HEAD }] };
    if (path === `/git/refs/heads/${BRANCH}`) {
      if (options.refFailure) throw new Error("Non-fast-forward update rejected");
      return { object: { sha: options.updatedHead ?? NEXT } };
    }
    throw new Error(`Unexpected request ${url}`);
  };
  return { request, calls };
}

const INPUT = { repository: REPO, trustedPolicySha: BASE };

test("trusted candidate is read at exact head and corrected with a non-force child commit", async () => {
  const { request, calls } = harness();
  assert.deepEqual(await normalizeReleasePleaseLockfiles(INPUT, request), [{ pullRequestNumber: 2405, headSha: NEXT, status: "normalized" }]);
  const tree = calls.find(({ path, method }) => path === "/git/trees" && method === "POST");
  assert.deepEqual(tree.body.tree.map(({ path }) => path), ["package-lock.json", "mcp/package-lock.json"]);
  assert.deepEqual(calls.find(({ path }) => path === "/git/commits").body.parents, [HEAD]);
  assert.deepEqual(calls.find(({ method }) => method === "PATCH").body, { sha: NEXT, force: false });
});

test("aligned SDK release candidate does not perform any writes", async () => {
  const { request, calls } = harness({ sdkVersion: "0.3.4" });
  const result = await normalizeReleasePleaseLockfiles(INPUT, request);
  assert.equal(result[0].status, "unchanged");
  assert.ok(calls.every(({ method, path }) => method === "GET" || path === "/graphql"));
});

test("untrusted or moved candidate cannot update a branch", async () => {
  for (const options of [
    { metadata: { author: { __typename: "User", login: "honua-io-bot" } } },
    { metadata: { headRepository: { nameWithOwner: "other/fork" } } },
    { metadata: { baseRefOid: NEXT } },
    { moveAfterRead: true },
  ]) {
    const { request, calls } = harness(options);
    await assert.rejects(normalizeReleasePleaseLockfiles(INPUT, request));
    assert.ok(calls.every(({ method, path }) => method === "GET" || path === "/graphql"));
  }
});

test("workflow prepares candidates only after successful generation using trusted policy", () => {
  const workflow = readFileSync(".github/workflows/release-please.yml", "utf8");
  const hook = workflow.slice(workflow.indexOf("  release-please-refresh:"), workflow.indexOf("  release-please-ci:"));
  assert.match(hook, /needs: release-please/u);
  assert.match(hook, /needs.release-please.result == 'success'/u);
  assert.match(hook, /ref: \$\{\{ github.sha \}\}/u);
  assert.match(hook, /persist-credentials: false/u);
  assert.match(hook, /working-directory: trusted-refresh-policy/u);
  assert.match(hook, /node scripts\/refresh-release-please-base.mjs/u);
  assert.doesNotMatch(workflow, /RELEASE_PLEASE_PRS_CREATED/u);
});

test("lock normalization rejects a commit with the wrong parent before publishing", async () => {
  const { request, calls } = harness({ commitParent: BASE });
  await assert.rejects(normalizeReleasePleaseLockfiles(INPUT, request), /Invalid normalized candidate commit/);
  assert.ok(calls.some(({ path }) => path === "/git/commits"));
  assert.ok(calls.every(({ method }) => method !== "PATCH"));
});

test("lock normalization rechecks candidate metadata after creating Git objects", async () => {
  const { request, calls } = harness({ moveAfterRead: 4 });
  await assert.rejects(normalizeReleasePleaseLockfiles(INPUT, request), /metadata moved/);
  assert.ok(calls.some(({ path }) => path === "/git/commits"));
  assert.ok(calls.every(({ method }) => method !== "PATCH"));
});

test("lock normalization does not report success for rejected or unconfirmed ref updates", async () => {
  for (const options of [{ refFailure: true }, { updatedHead: HEAD }]) {
    const { request, calls } = harness(options);
    await assert.rejects(normalizeReleasePleaseLockfiles(INPUT, request), /rejected|not confirmed/);
    assert.deepEqual(calls.filter(({ method }) => method === "PATCH").map(({ body }) => body), [{ sha: NEXT, force: false }]);
  }
});


test("orchestration rejects replaced lock candidates before reading files or mutating", async () => {
  for (const expected of [
    { pullRequestNumber: 2405, headSha: NEXT, status: "already-current" },
    { pullRequestNumber: 2406, headSha: HEAD, status: "already-current" },
    { status: "not-found" },
  ]) {
    const { request, calls } = harness();
    await assert.rejects(prepareReleasePleaseCandidates(INPUT, {
      refresh: async ({ headRefName }) => headRefName === BRANCH ? expected : { status: "not-found" },
      locks: (input) => normalizeReleasePleaseLockfiles(input, request),
      mcpNotes: async () => { throw new Error("Notes must not run after candidate drift"); },
    }), /moved before normalization/);
    assert.ok(!calls.some(({ path }) => path.startsWith("/contents/")));
    assert.ok(calls.every(({ method, path }) => method === "GET" || path === "/graphql"));
  }
});
