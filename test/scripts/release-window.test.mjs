import assert from "node:assert/strict";
import fs from "node:fs";
import { it } from "node:test";

import { GENERATED_FILES, GENERATED_PREFIXES, isGeneratedReleasePath } from "../../scripts/lib/generated-release-paths.mjs";
import { refreshPullRequest } from "../../scripts/lib/refresh-release-window.mjs";
import { evaluateReleaseWindow, loadReleaseWindows, readAllPages } from "../../scripts/lib/release-window.mjs";

const repository = "honua-io/honua-sdk-js";
const automation = JSON.parse(fs.readFileSync(new URL("../fixtures/pr-issue-disposition/release-please-pr-382.json", import.meta.url)));
const input = { ...automation, pullRequestNumber: 2533, authorLogin: "mike", authorType: "User",
  headRefName: "fix/source", title: "fix: source", body: "Refs #2532 (slice; live validation remains)", closingIssueNumbers: [] };
const draft = { draft: true, tag_name: "js-sdk-v0.4.0", created_at: "2026-11-14T00:00:00Z" };
const now = Date.parse("2026-11-14T01:00:00Z");
const missingTag = () => { throw Object.assign(new Error("Not Found"), { status: 404 }); };

function restSnapshot(current, files) {
  return { state: "open", title: current.title, body: current.body, updated_at: current.updatedAt,
    head: { sha: current.headSha }, base: { sha: current.baseSha, ref: "trunk" }, changed_files: files.length };
}

function graphqlSnapshot(current) {
  return { data: { repository: { nameWithOwner: repository, pullRequest: {
    number: current.pullRequestNumber, body: current.body, title: current.title, state: "OPEN", updatedAt: current.updatedAt,
    headRefName: current.headRefName, headRefOid: current.headSha, baseRefName: current.baseRefName, baseRefOid: current.baseSha,
    headRepository: { nameWithOwner: current.headRepository }, baseRepository: { nameWithOwner: repository },
    author: { login: current.authorLogin, __typename: current.authorType },
    closingIssuesReferences: { nodes: [], pageInfo: { hasNextPage: false } },
  } } } };
}

function fakeGitHub({ current = input, files = [{ filename: "src/client.ts", status: "modified" }], releases = [draft], tagged = false,
  rest = restSnapshot(current, files), releaseError } = {}) {
  const calls = [];
  const request = async (url, options = {}) => {
    const endpoint = new URL(url);
    const body = options.body && JSON.parse(options.body);
    calls.push({ endpoint, options, body });
    if (endpoint.pathname.endsWith("/graphql")) {
      if (body.query.includes("issueOrPullRequest")) {
        return { data: { repository: { nameWithOwner: repository, issueOrPullRequest: { __typename: "Issue", number: 2532, state: "OPEN" } } } };
      }
      return graphqlSnapshot(current);
    }
    if (endpoint.pathname.endsWith("/releases")) { if (releaseError) throw releaseError; return releases; }
    if (endpoint.pathname.includes("/git/ref/tags/")) return tagged ? { object: { sha: "a".repeat(40) } } : missingTag();
    if (endpoint.pathname.endsWith("/files")) return files;
    if (endpoint.pathname.endsWith("/check-runs")) return { id: 7 };
    if (endpoint.pathname.endsWith("/check-runs/7")) return body;
    if (endpoint.pathname.endsWith(`/pulls/${current.pullRequestNumber}`)) return rest;
    throw new Error(`Unexpected request: ${url}`);
  };
  return { request, calls };
}

it("holds source changes, reports draft tag and age, then clears after publication/deletion or tagging", async () => {
  const active = fakeGitHub();
  const held = await evaluateReleaseWindow(input, { now }, active.request);
  assert.equal(held.allowed, false);
  assert.match(held.summary, /js-sdk-v0.4.0 \(draft age 60 minutes\)/);
  for (const options of [{ releases: [] }, { releases: [{ ...draft, draft: false }] }, { tagged: true }]) {
    assert.equal((await evaluateReleaseWindow(input, {}, fakeGitHub(options).request)).allowed, true);
  }
});

it("allows generated paths on any branch, including regeneration, but never trusts a branch name alone", async () => {
  const generated = [...GENERATED_FILES, ...GENERATED_PREFIXES.map((prefix) => `${prefix}nested/output.json`)];
  for (const headRefName of ["fix/evidence", "automation/derived-artifacts-123-1"]) {
    const current = { ...input, headRefName };
    const files = generated.map((filename) => ({ filename, status: "modified" }));
    assert.equal((await evaluateReleaseWindow(current, {}, fakeGitHub({ current, files }).request)).allowed, true);
    assert.equal((await evaluateReleaseWindow(current, {}, fakeGitHub({ current }).request)).allowed, false);
  }
});

it("blocks source deletions and source-to-generated renames, accepts generated renames", async () => {
  for (const file of [{ filename: "src/deleted.ts", status: "removed" },
    { filename: "api-report/client.md", previous_filename: "src/client.ts", status: "renamed" },
    { filename: "api-report/client.md", status: "renamed" }]) {
    assert.equal((await evaluateReleaseWindow(input, {}, fakeGitHub({ files: [file] }).request)).allowed, false);
  }
  const files = [{ filename: "api-report/new.md", previous_filename: "api-report/old.md", status: "renamed" }];
  assert.equal((await evaluateReleaseWindow(input, {}, fakeGitHub({ files }).request)).allowed, true);
});

it("allows only the existing authenticated same-repository Release Please exception", async () => {
  assert.equal((await evaluateReleaseWindow(automation, {}, fakeGitHub().request)).allowed, true);
  for (const override of [{ authorType: "User" }, { headRepository: "attacker/fork" }, { authorLogin: "impostor[bot]" }]) {
    const current = { ...automation, ...override };
    assert.equal((await evaluateReleaseWindow(current, {}, fakeGitHub({ current }).request)).allowed, false);
  }
});

it("paginates releases and files and fails closed on truncation, movement or API errors", async () => {
  let pages = 0;
  const values = await readAllPages("https://api.github.com/example", async (url) => {
    pages += 1;
    return new URL(url).searchParams.get("page") === "1" ? Array(100).fill({}) : [draft];
  });
  assert.equal(pages, 2);
  assert.equal(values.length, 101);
  await assert.rejects(readAllPages("https://api.github.com/example", async () => Array(100).fill({})), /3000/);
  await assert.rejects(readAllPages("https://api.github.com/example", async () => ({})), /malformed/);
  for (const rest of [{ ...restSnapshot(input, []), changed_files: 20 },
    { ...restSnapshot(input, []), head: { sha: "e".repeat(40) } }]) {
    await assert.rejects(evaluateReleaseWindow(input, {}, fakeGitHub({ files: [], rest }).request), /incomplete|changed/);
  }
  await assert.rejects(loadReleaseWindows(repository, fakeGitHub({ releaseError: new Error("rate limited") }).request), /rate limited/);
  await assert.rejects(loadReleaseWindows(repository, async (url) => {
    if (url.includes("/releases")) return [draft];
    throw Object.assign(new Error("Forbidden"), { status: 403 });
  }), /Forbidden/);
});

it("ignores non-SDK drafts and validates every active SDK draft", async () => {
  const windows = await loadReleaseWindows(repository, fakeGitHub({ releases: [
    { ...draft, tag_name: "mcp-server-v1.0.0" }, draft, { ...draft, tag_name: "js-sdk-v0.5.0-rc.1" },
  ] }).request);
  assert.deepEqual(windows.map((release) => release.tag_name), ["js-sdk-v0.4.0", "js-sdk-v0.5.0-rc.1"]);
});

it("refreshes the exact PR head from held to passed without merging or weakening disposition", async () => {
  for (const releases of [[draft], []]) {
    const api = fakeGitHub({ releases });
    const result = await refreshPullRequest({ repository, pullRequestNumber: input.pullRequestNumber }, {}, api.request);
    assert.equal(result.allowed, releases.length === 0);
    const created = api.calls.find((call) => call.options.method === "POST" && call.endpoint.pathname.endsWith("/check-runs"));
    assert.equal(created.body.head_sha, input.headSha);
    assert.equal(created.body.name, "PR Issue Disposition");
    assert.equal(created.body.status, "in_progress");
    assert.equal(api.calls.at(-1).body.conclusion, releases.length ? "failure" : "success");
    assert.equal(api.calls.filter((call) => call.options.method && call.endpoint.pathname !== "/graphql" &&
      !call.endpoint.pathname.includes("/check-runs")).length, 0);
  }
  const current = { ...input, body: "missing issue footer" };
  const invalid = fakeGitHub({ current, releases: [] });
  const result = await refreshPullRequest({ repository, pullRequestNumber: current.pullRequestNumber }, {}, invalid.request);
  assert.equal(result.allowed, false);
  assert.equal(invalid.calls.at(-1).body.conclusion, "failure");
});

it("replaces stale green with failure when release reads fail", async () => {
  const api = fakeGitHub({ releaseError: new Error("rate limited") });
  const result = await refreshPullRequest({ repository, pullRequestNumber: input.pullRequestNumber }, {}, api.request);
  assert.equal(result.allowed, false);
  assert.match(result.summary, /rate limited/);
  assert.equal(api.calls.at(-1).body.conclusion, "failure");
});

it("keeps generated paths identical to the producer and tag sealer shell allowlists", () => {
  const expected = [...GENERATED_FILES, ...GENERATED_PREFIXES.map((prefix) => `${prefix}*`)].sort();
  for (const workflow of ["release-please", "regenerate-derived-artifacts"]) {
    const text = fs.readFileSync(new URL(`../../.github/workflows/${workflow}.yml`, import.meta.url), "utf8");
    const patterns = text.match(/case "\$\{?changed_path\}?" in\s*([\s\S]+?)\)/)?.[1];
    assert.ok(patterns);
    assert.deepEqual(patterns.replaceAll("\\", "").split("|").map((part) => part.trim()).sort(), expected);
  }
  assert.equal(isGeneratedReleasePath("src/client.ts"), false);
  assert.equal(isGeneratedReleasePath("docs/native-app-conversion.md"), false);
});


it("publishes combined checks only from trusted trunk code with draft visibility", () => {
  const workflow = fs.readFileSync(new URL("../../.github/workflows/release-window-refresh.yml", import.meta.url), "utf8");
  assert.match(workflow, /pull_request_target:/);
  assert.match(workflow, /contents: write/);
  assert.match(workflow, /checks: write/);
  assert.match(workflow, /ref: trunk/);
  assert.match(workflow, /persist-credentials: false/);
  assert.doesNotMatch(workflow, /pull_request\.head\.(sha|ref)|npm (ci|install)|secrets\./);
  assert.match(workflow, /node scripts\/check-release-window\.mjs --refresh/);
  assert.match(workflow, /types: \[published, deleted\]/);
  assert.match(workflow, /cron: '\*\/10 \* \* \* \*'/);
});
