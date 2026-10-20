import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { normalizeMcpWorkspaceNotes, normalizeReleasePleaseWorkspaceNotes } from "../../scripts/lib/release-please-workspace-notes.mjs";

const baseSha = "a".repeat(40);
const headSha = "b".repeat(40);
const nextSha = "c".repeat(40);
const oldTree = "d".repeat(40);
const newTree = "e".repeat(40);
const repository = "honua-io/honua-sdk-js";
const branch = "release-please--branches--trunk";
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

function harness(options = {}) {
  const data = fixture();
  if (options.mutate) options.mutate(data);
  let currentHead = headSha;
  let currentBody = data.body;
  let snapshotReads = 0;
  const mutations = [];
  const files = {
    "mcp/package.json": data.mcp, "mcp/package-lock.json": data.mcpLock, "package.json": data.sdk,
    "config/mcp-sdk-peer-policy.v1.json": data.policy, "release-please-config.json": data.releaseConfig,
    "mcp/CHANGELOG.md": data.changelog,
  };
  const rest = () => ({
    number: 2074, body: currentBody, title: "chore: release trunk", state: "open", updated_at: "2026-10-13T07:00:00Z",
    user: { login: options.author ?? "github-actions", type: "Bot" },
    head: { ref: branch, sha: currentHead, repo: { full_name: repository } },
    base: { ref: "trunk", sha: baseSha, repo: { full_name: repository } },
  });
  const request = async (url, input = {}) => {
    const { pathname, searchParams } = new URL(url);
    if (input.method && input.method !== "GET" && pathname !== "/graphql") mutations.push({ pathname, ...input });
    if (pathname.endsWith("/pulls")) {
      snapshotReads += 1;
      if (snapshotReads >= (options.raceOnSnapshot ?? (options.headRace ? 2 : Infinity))) currentHead = "f".repeat(40);
      return [rest()];
    }
    if (pathname === "/graphql") return { data: { repository: { nameWithOwner: repository, pullRequest: {
      number: 2074, body: currentBody, title: "chore: release trunk", state: "OPEN", updatedAt: "2026-10-13T07:00:00Z",
      headRefName: branch, headRefOid: currentHead, headRepository: { nameWithOwner: repository },
      baseRefName: "trunk", baseRefOid: baseSha, baseRepository: { nameWithOwner: repository },
      author: { login: options.author ?? "github-actions", __typename: "Bot" },
      closingIssuesReferences: { nodes: [], pageInfo: { hasNextPage: false } },
    } } } };
    if (pathname.includes("/contents/")) {
      const path = pathname.split("/contents/")[1];
      const value = path === "mcp/package.json" && searchParams.get("ref") === baseSha ? data.baseMcp : files[path];
      return { type: "file", encoding: "base64", content: Buffer.from(typeof value === "string" ? value : JSON.stringify(value)).toString("base64") };
    }
    if (pathname.includes("/git/ref/heads/")) {
      const name = pathname.split("/git/ref/heads/")[1];
      return { ref: `refs/heads/${name}`, object: { type: "commit", sha: name === "trunk" ? (options.baseRace ? "f".repeat(40) : baseSha) : currentHead } };
    }
    if (pathname.endsWith(`/git/commits/${headSha}`)) return { sha: headSha, tree: { sha: oldTree } };
    if (pathname.endsWith("/git/trees")) return { sha: newTree };
    if (pathname.endsWith("/git/commits")) return { sha: nextSha, tree: { sha: newTree }, parents: [{ sha: headSha }] };
    if (pathname.endsWith(`/git/refs/heads/${branch}`)) {
      currentHead = nextSha;
      return { object: { sha: currentHead } };
    }
    if (pathname.endsWith("/pulls/2074")) {
      currentBody = JSON.parse(input.body).body;
      return rest();
    }
    throw new Error(`Unexpected request ${pathname}`);
  };
  return { request, mutations, data };
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
});
