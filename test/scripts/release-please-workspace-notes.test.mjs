import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";

import { normalizeMcpWorkspaceNotes, normalizeReleasePleaseWorkspaceNotes, normalizeMcpComponentReleaseNotes } from "../../scripts/lib/release-please-workspace-notes.mjs";

const baseSha = "a".repeat(40);
const headSha = "b".repeat(40);
const nextSha = "c".repeat(40);
const oldTree = "d".repeat(40);
const newTree = "e".repeat(40);
const repository = "honua-io/honua-sdk-js";
const branch = "release-please--branches--trunk";
const componentBranch = `${branch}--components--mcp-server`;
const dependencyNotes = `### Dependencies

* The following workspace dependencies were updated
  * devDependencies
    * @honua/sdk-js bumped from file:.. to 0.2.0
  * peerDependencies
    * @honua/sdk-js bumped from ^0.1.17 || ^0.2.0 to ^0.2.0
  * dependencies
    * another-package bumped from 1.0.0 to 1.1.0
`;
const historical = `## [0.1.19](https://example.test/older)
${dependencyNotes}`;

function fixture() {
  const mcp = { name: "@honua/mcp-server", version: "0.2.0", devDependencies: { "@honua/sdk-js": "file:.." }, peerDependencies: { "@honua/sdk-js": "^0.1.17 || ^0.2.0" } };
  return {
    baseMcp: { ...structuredClone(mcp), version: "0.1.19" }, mcp,
    mcpLock: { version: "0.2.0", packages: { "": structuredClone(mcp) } },
    sdk: { name: "@honua/sdk-js", version: "0.2.0" },
    policy: { schema: "honua.mcp-sdk-peer-policy/v1", sdk: "@honua/sdk-js", range: "^0.1.17 || ^0.2.0" },
    releaseConfig: { plugins: [{ type: "node-workspace", updatePeerDependencies: false }] },
    changelog: `# Changelog\n\n## [0.2.0](https://example.test/current)\n${dependencyNotes}\n${historical}`,
    body: `<details><summary>mcp-server: 0.2.0</summary>\n${dependencyNotes}</details>\n<details><summary>js-sdk: 0.2.0</summary>\n${dependencyNotes}</details>`,
  };
}

function componentFixture() {
  return { ...fixture(), layout: "component",
    body: `:robot: I have created a release *beep* *boop*\n---\n\n## [0.2.0](https://example.test/current)\n${dependencyNotes}\n---\nThis PR was generated with [Release Please](https://github.com/googleapis/release-please).`,
  };
}

describe("managed MCP workspace notes", () => {
  it("uses actual declarations and preserves unrelated and historical dependency notes", () => {
    const input = fixture();
    const result = normalizeMcpWorkspaceNotes(input);
    assert.match(result.changelog, /@honua\/sdk-js retained at file:\.\./);
    assert.match(result.changelog, /@honua\/sdk-js retained at \^0\.1\.17 \|\| \^0\.2\.0/);
    assert.match(result.changelog, /another-package bumped from 1\.0\.0 to 1\.1\.0/);
    assert.match(result.changelog, /The following workspace dependencies were updated or retained/);
    assert.ok(result.changelog.endsWith(historical));
    assert.ok(result.body.endsWith(input.body.slice(input.body.indexOf("<details><summary>js-sdk:"))));
    assert.deepEqual(normalizeMcpWorkspaceNotes({ ...input, ...result }), result);
  });
  it("normalizes a plain component body without rewriting its wrapper or changelog history", () => {
    const input = fixture();
    input.layout = "component";
    const prefix = ":robot: I have created a release *beep* *boop*\n---\n\n";
    const footer = "\n---\nThis PR was generated with [Release Please](https://github.com/googleapis/release-please).";
    input.body = `${prefix}## [0.2.0](https://example.test/current)\n${dependencyNotes}${footer}`;
    const result = normalizeMcpWorkspaceNotes(input);
    assert.match(result.body, /@honua\/sdk-js retained at file:\.\./);
    assert.match(result.body, /@honua\/sdk-js retained at \^0\.1\.17 \|\| \^0\.2\.0/);
    assert.ok(result.body.startsWith(prefix));
    assert.ok(result.body.endsWith(footer));
    assert.ok(result.changelog.endsWith(historical));
    assert.deepEqual(normalizeMcpWorkspaceNotes({ ...input, ...result }), result);
    for (const body of [input.body.replace("[0.2.0]", "[9.9.9]"), input.body + "\n" + historical,
      input.body.replace(footer, ""), input.body + footer, input.body + "<details>"]) {
      assert.throws(() => normalizeMcpWorkspaceNotes({ ...input, body }));
    }
    assert.throws(() => normalizeMcpWorkspaceNotes({ ...input, layout: "combined" }));
  });
  it("does not touch historical notes when MCP itself is not released", () => {
    const input = fixture();
    input.baseMcp.version = input.mcp.version;
    input.body = "An SDK-only release";
    input.changelog = historical;
    assert.deepEqual(normalizeMcpWorkspaceNotes(input), { body: input.body, changelog: input.changelog });
  });
  it("preserves genuine SDK dependency updates while correcting retained peer declarations", () => {
    const input = fixture();
    input.baseMcp.devDependencies["@honua/sdk-js"] = "0.1.18";
    input.mcp.devDependencies["@honua/sdk-js"] = "0.2.0";
    input.mcpLock.packages[""].devDependencies["@honua/sdk-js"] = "0.2.0";
    input.body = input.body.replaceAll("from file:..", "from 0.1.18");
    input.changelog = input.changelog.replaceAll("from file:..", "from 0.1.18");
    assert.match(normalizeMcpWorkspaceNotes(input).body, /devDependencies\n    \* @honua\/sdk-js bumped from 0\.1\.18 to 0\.2\.0/);
  });
  for (const [name, mutate] of [
    ["incorrect current heading", (input) => { input.changelog = input.changelog.replace("## [0.2.0]", "## [0.2.1]"); }],
    ["missing current body", (input) => { input.body = "no current MCP section"; }],
    ["duplicate current body", (input) => { input.body += input.body; }],
    ["unclosed current body", (input) => { input.body = input.body.replaceAll("</details>", ""); }],
    ["incorrect prior declaration", (input) => { input.changelog = input.changelog.replace("from file:..", "from file:../wrong"); }],
    ["malformed dependency indentation", (input) => { input.changelog = input.changelog.replace("    * @honua", " * @honua"); }],
    ["duplicate dependency category", (input) => { input.changelog = input.changelog.replace("  * peerDependencies", "  * devDependencies"); }],
    ["lock dependency disagreement", (input) => { input.mcpLock.packages[""].devDependencies["@honua/sdk-js"] = "0.2.0"; }],
    ["lock version disagreement", (input) => { input.mcpLock.version = "0.1.19"; }],
    ["policy narrowing", (input) => { input.mcp.peerDependencies["@honua/sdk-js"] = "^0.2.0"; }],
    ["policy updater enabled", (input) => { input.releaseConfig.plugins[0].updatePeerDependencies = true; }],
  ]) it(`refuses ${name}`, () => {
    const input = fixture();
    mutate(input);
    assert.throws(() => normalizeMcpWorkspaceNotes(input));
  });
});

function candidateFiles(data) {
  return {
    "mcp/package.json": data.mcp, "mcp/package-lock.json": data.mcpLock, "package.json": data.sdk,
    "config/mcp-sdk-peer-policy.v1.json": data.policy, "release-please-config.json": data.releaseConfig,
    "mcp/CHANGELOG.md": data.changelog,
  };
}

/** The PR snapshot reports a published ref head only after `lagReads` snapshot reads, as GitHub does. */
function candidateHead(initial, lagReads = 0) {
  let ref = initial;
  let reported = initial;
  let pendingReads = 0;
  return {
    ref: () => ref,
    reported: () => reported,
    move(sha) { ref = sha; reported = sha; },
    publish(sha) { ref = sha; pendingReads = lagReads; if (pendingReads === 0) reported = sha; },
    read() { pendingReads = Math.max(0, pendingReads - 1); if (pendingReads === 0) reported = ref; },
  };
}

function harness(options = {}) {
  const data = options.branch === componentBranch ? componentFixture() : fixture();
  const candidateBranch = options.branch ?? branch;
  const title = options.title ?? (candidateBranch === componentBranch ? "chore(trunk): release mcp-server 0.2.0" : "chore: release trunk");
  if (options.mutate) options.mutate(data);
  const head = candidateHead(headSha, options.headSyncLagReads);
  let currentBody = data.body;
  let snapshotReads = 0;
  const mutations = [];
  const calls = [];
  const rest = () => ({
    number: 2074, body: currentBody, title, state: "open", updated_at: "2026-10-13T07:00:00Z",
    user: { login: options.author ?? "github-actions", type: "Bot" },
    head: { ref: candidateBranch, sha: head.reported(), repo: { full_name: options.headRepository ?? repository } },
    base: { ref: "trunk", sha: options.baseSha ?? baseSha, repo: { full_name: repository } },
  });
  const request = async (url, input = {}) => {
    const { pathname, searchParams } = new URL(url);
    calls.push({ pathname, searchParams });
    if (input.method && input.method !== "GET" && pathname !== "/graphql") mutations.push({ pathname, ...input });
    if (pathname.endsWith("/pulls")) {
      snapshotReads += 1;
      if (snapshotReads === options.bodyRaceOnSnapshot) currentBody += "\nconcurrent edit";
      if (snapshotReads >= (options.raceOnSnapshot ?? (options.headRace ? 2 : Infinity))) head.move("f".repeat(40));
      head.read();
      return options.absent ? [] : options.ambiguous ? [rest(), rest()] : [rest()];
    }
    if (pathname === "/graphql") return { data: { repository: { nameWithOwner: repository, pullRequest: {
      number: 2074, body: currentBody, title, state: "OPEN", updatedAt: "2026-10-13T07:00:00Z",
      headRefName: options.graphqlBranch ?? candidateBranch, headRefOid: head.reported(), headRepository: { nameWithOwner: options.headRepository ?? repository },
      baseRefName: "trunk", baseRefOid: options.baseSha ?? baseSha, baseRepository: { nameWithOwner: repository },
      author: { login: options.author ?? "github-actions", __typename: "Bot" },
      closingIssuesReferences: { nodes: [], pageInfo: { hasNextPage: false } },
    } } } };
    if (pathname.includes("/contents/")) {
      assert.ok([headSha, baseSha].includes(searchParams.get("ref")));
      const path = pathname.split("/contents/")[1];
      const value = path === "mcp/package.json" && searchParams.get("ref") === baseSha ? data.baseMcp : candidateFiles(data)[path];
      return { type: "file", encoding: "base64", content: Buffer.from(typeof value === "string" ? value : JSON.stringify(value)).toString("base64") };
    }
    if (pathname.includes("/git/ref/heads/")) {
      const name = pathname.split("/git/ref/heads/")[1];
      return { ref: `refs/heads/${name}`, object: { type: "commit", sha: name === "trunk" ? (options.baseRace ? "f".repeat(40) : baseSha) : options.refRace ? "f".repeat(40) : head.ref() } };
    }
    if (pathname.endsWith(`/git/commits/${headSha}`)) return { sha: headSha, tree: { sha: oldTree } };
    if (pathname.endsWith("/git/trees")) return { sha: newTree };
    if (pathname.endsWith("/git/commits")) return { sha: nextSha, tree: { sha: newTree }, parents: [{ sha: options.commitParent ?? headSha }] };
    if (pathname.endsWith(`/git/refs/heads/${candidateBranch}`)) {
      if (options.refFailure) throw new Error("Non-fast-forward update rejected");
      head.publish(options.updatedHead ?? nextSha);
      return { object: { sha: head.ref() } };
    }
    if (pathname.endsWith("/pulls/2074")) {
      currentBody = JSON.parse(input.body).body;
      return rest();
    }
    throw new Error(`Unexpected request ${pathname}`);
  };
  return { request, mutations, calls, data };
}

describe("trusted generated-note publication", () => {
  const input = { repository, trustedPolicySha: baseSha, headSha };
  it("writes only generated changelog content and forwards the new exact head to CI", async () => {
    const { request, mutations } = harness();
    assert.deepEqual(await normalizeReleasePleaseWorkspaceNotes(input, request), { status: "normalized", headSha: nextSha });
    const tree = JSON.parse(mutations.find((call) => call.pathname.endsWith("/git/trees")).body);
    assert.equal(tree.base_tree, oldTree);
    assert.equal(tree.tree.length, 1);
    assert.equal(tree.tree[0].path, "mcp/CHANGELOG.md");
    assert.ok(tree.tree[0].content.endsWith(historical));
    const ref = JSON.parse(mutations.find((call) => call.pathname.includes("/git/refs/")).body);
    assert.deepEqual(ref, { sha: nextSha, force: false });
    const body = JSON.parse(mutations.at(-1).body).body;
    assert.match(body, /retained at \^0\.1\.17 \|\| \^0\.2\.0/);
  });
  it("makes no API mutation when generated notes already agree", async () => {
    const { request, mutations } = harness({ mutate(data) { Object.assign(data, normalizeMcpWorkspaceNotes(data)); } });
    assert.deepEqual(await normalizeReleasePleaseWorkspaceNotes(input, request), { status: "unchanged", headSha });
    assert.equal(mutations.length, 0);
  });
  for (const options of [{ headRace: true }, { baseRace: true }, { author: "untrusted-bot" }, { mutate(data) { data.mcpLock.version = "0.0.0"; } }]) {
    it(`refuses unsafe input before any write: ${JSON.stringify(options)}`, async () => {
      const { request, mutations } = harness(options);
      await assert.rejects(normalizeReleasePleaseWorkspaceNotes(input, request));
      assert.equal(mutations.length, 0);
    });
  }
  it("recovers a corrected changelog with a stale PR body without another commit", async () => {
    const { request, mutations } = harness({ mutate(data) { data.changelog = normalizeMcpWorkspaceNotes(data).changelog; } });
    assert.deepEqual(await normalizeReleasePleaseWorkspaceNotes(input, request), { status: "normalized", headSha });
    assert.equal(mutations.length, 1);
    assert.ok(mutations[0].pathname.endsWith("/pulls/2074"));
  });
  it("does not move a branch that changes after creating unpublished Git objects", async () => {
    const { request, mutations } = harness({ raceOnSnapshot: 3 });
    await assert.rejects(normalizeReleasePleaseWorkspaceNotes(input, request));
    assert.ok(mutations.some((call) => call.pathname.endsWith("/git/trees")));
    assert.ok(mutations.every((call) => !call.pathname.includes("/git/refs/") && !call.pathname.endsWith("/pulls/2074")));
  });
  it("rejects a commit with the wrong parent before publishing notes", async () => {
    const { request, mutations } = harness({ commitParent: baseSha });
    await assert.rejects(normalizeReleasePleaseWorkspaceNotes(input, request), /Invalid normalized candidate commit/);
    assert.ok(mutations.some((call) => call.pathname.endsWith("/git/commits")));
    assert.ok(mutations.every((call) => call.method !== "PATCH"));
  });
  it("waits for the pull request to report the new head before publishing the body", async () => {
    const waits = [];
    const { request, mutations } = harness({ headSyncLagReads: 2 });
    assert.deepEqual(await normalizeReleasePleaseWorkspaceNotes({ ...input, wait: async (ms) => { waits.push(ms); } }, request),
      { status: "normalized", headSha: nextSha });
    assert.equal(waits.length, 1);
    assert.ok(mutations.at(-1).pathname.endsWith("/pulls/2074"));
  });
  it("fails closed when the pull request never reports the new head", async () => {
    const { request, mutations } = harness({ headSyncLagReads: Infinity });
    await assert.rejects(normalizeReleasePleaseWorkspaceNotes({ ...input, wait: async () => {} }, request),
      /did not report the normalized candidate head/);
    assert.ok(mutations.every((call) => !call.pathname.endsWith("/pulls/2074")));
  });
  it("fails closed when the pull request reports a third head after the update", async () => {
    const { request, mutations } = harness({ headSyncLagReads: 1, raceOnSnapshot: 4 });
    await assert.rejects(normalizeReleasePleaseWorkspaceNotes({ ...input, wait: async () => {} }, request),
      /unexpected candidate head/);
    assert.ok(mutations.every((call) => !call.pathname.endsWith("/pulls/2074")));
  });
  it("does not update the body after rejected or unconfirmed ref updates", async () => {
    for (const options of [{ refFailure: true }, { updatedHead: headSha }]) {
      const { request, mutations } = harness(options);
      await assert.rejects(normalizeReleasePleaseWorkspaceNotes(input, request), /rejected|not confirmed/);
      const updates = mutations.filter((call) => call.method === "PATCH");
      assert.equal(updates.length, 1);
      assert.ok(updates[0].pathname.endsWith(`/git/refs/heads/${branch}`));
      assert.deepEqual(JSON.parse(updates[0].body), { sha: nextSha, force: false });
    }
  });

});


describe("trusted MCP component notes", () => {
  const input = { repository, trustedPolicySha: baseSha };
  it("discovers the exact component and changes only newest notes with a non-force child commit", async () => {
    const { request, mutations, calls } = harness({ branch: componentBranch });
    assert.deepEqual(await normalizeMcpComponentReleaseNotes(input, request), { status: "normalized", headSha: nextSha });
    for (const call of calls.filter((call) => call.pathname.endsWith("/pulls"))) {
      assert.equal(call.searchParams.get("head"), `honua-io:${componentBranch}`);
    }
    const tree = JSON.parse(mutations.find((call) => call.pathname.endsWith("/git/trees")).body);
    assert.equal(tree.tree.length, 1);
    assert.equal(tree.tree[0].path, "mcp/CHANGELOG.md");
    assert.ok(tree.tree[0].content.endsWith(historical));
    const ref = mutations.find((call) => call.pathname.includes("/git/refs/"));
    assert.ok(ref.pathname.endsWith(componentBranch));
    assert.deepEqual(JSON.parse(ref.body), { sha: nextSha, force: false });
    const body = JSON.parse(mutations.at(-1).body).body;
    assert.match(body, /retained at file:\.\./);
    assert.match(body, /retained at \^0\.1\.17 \|\| \^0\.2\.0/);
    assert.match(body, /another-package bumped from 1\.0\.0 to 1\.1\.0/);
  });
  it("does nothing if the component candidate is absent", async () => {
    const { request, mutations } = harness({ absent: true });
    assert.deepEqual(await normalizeMcpComponentReleaseNotes(input, request), { status: "absent" });
    assert.equal(mutations.length, 0);
  });
  it("recovers a body-only correction without touching any Git object", async () => {
    const { request, mutations } = harness({ branch: componentBranch, mutate(data) {
      data.changelog = normalizeMcpWorkspaceNotes(data).changelog;
    } });
    assert.deepEqual(await normalizeMcpComponentReleaseNotes(input, request), { status: "normalized", headSha });
    assert.equal(mutations.length, 1);
    assert.ok(mutations[0].pathname.endsWith("/pulls/2074"));
  });
  it("is idempotent for already-correct component notes", async () => {
    const { request, mutations } = harness({ branch: componentBranch, mutate(data) {
      Object.assign(data, normalizeMcpWorkspaceNotes(data));
    } });
    assert.deepEqual(await normalizeMcpComponentReleaseNotes(input, request), { status: "unchanged", headSha });
    assert.equal(mutations.length, 0);
  });
  for (const [name, options] of [
    ["wrong authenticated branch", { branch }],
    ["unknown bot branch", { branch: "automation/manual-release" }],
    ["unauthenticated author", { author: "untrusted-bot" }],
    ["manual title", { title: "chore: manually release MCP" }],
    ["fork", { headRepository: "attacker/honua-sdk-js" }],
    ["ambiguous candidates", { ambiguous: true }],
    ["REST/GraphQL branch mismatch", { graphqlBranch: branch }],
    ["stale trusted base", { baseSha: "f".repeat(40) }],
    ["moving candidate", { raceOnSnapshot: 3 }],
    ["moving branch ref", { refRace: true }],
    ["moving body", { bodyRaceOnSnapshot: 3 }],
    ["moving trunk ref", { baseRace: true }],
    ["malformed component body", { mutate(data) { data.body = "no release heading"; } }],
  ]) it(`rejects ${name} before mutation`, async () => {
    const { request, mutations } = harness({ branch: componentBranch, ...options });
    await assert.rejects(normalizeMcpComponentReleaseNotes(input, request));
    assert.equal(mutations.length, 0);
  });
  it("refuses caller-supplied branches outside the internal allowlist", async () => {
    const { request, calls } = harness();
    await assert.rejects(normalizeReleasePleaseWorkspaceNotes({ ...input, headSha, headRefName: "manual/mcp" }, request), /Unsupported exact/);
    assert.equal(calls.length, 0);
  });
  it("rechecks the component after creating objects before publishing its ref or body", async () => {
    const { request, mutations } = harness({ branch: componentBranch, raceOnSnapshot: 4 });
    await assert.rejects(normalizeMcpComponentReleaseNotes(input, request));
    assert.ok(mutations.some((call) => call.pathname.endsWith("/git/trees")));
    assert.ok(mutations.every((call) => !call.pathname.includes("/git/refs/") && !call.pathname.endsWith("/pulls/2074")));
  });
});


it("refuses an untrusted workflow before discovering any component candidate", () => {
  const result = spawnSync(process.execPath, ["scripts/normalize-release-please-mcp-notes.mjs"], {
    cwd: new URL("../../", import.meta.url), encoding: "utf8",
    env: { ...process.env, GITHUB_EVENT_NAME: "pull_request", GITHUB_REF: "refs/heads/trunk",
      GITHUB_SHA: baseSha, TRUSTED_POLICY_SHA: baseSha, GITHUB_API_URL: "http://127.0.0.1:1" },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /only for a trunk push or manual dispatch/);
  assert.equal(result.stdout, "");
});


it("pins MCP rediscovery to the post-lock number, head and absence before mutation", async () => {
  for (const expected of [
    { pullRequestNumber: 2074, headSha: nextSha, status: "already-current" },
    { pullRequestNumber: 2075, headSha, status: "already-current" },
    { status: "not-found" },
  ]) {
    const { request, mutations, calls } = harness({ branch: componentBranch });
    await assert.rejects(normalizeMcpComponentReleaseNotes({ repository, trustedPolicySha: baseSha,
      expectedCandidates: [{ ...expected, headRefName: componentBranch }],
    }, request), /moved before normalization/);
    assert.deepEqual(mutations, []);
    assert.ok(!calls.some(({ pathname }) => pathname.includes("/contents/")));
  }
  const { request, mutations } = harness({ branch: componentBranch, absent: true });
  await assert.rejects(normalizeMcpComponentReleaseNotes({ repository, trustedPolicySha: baseSha,
    expectedCandidates: [{ headRefName: componentBranch, pullRequestNumber: 2074, headSha }],
  }, request), /moved before normalization/);
  assert.deepEqual(mutations, []);
});
