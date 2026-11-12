import { githubRequest, loadCurrentPullRequestDisposition } from "./github-pr-issue-disposition.mjs";
import { automationExemption } from "./pr-issue-disposition.mjs";

const SHA = /^[0-9a-f]{40}$/u;
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;
const BRANCHES = ["release-please--branches--trunk", ...["js-sdk", "mcp-server", "create-honua-app"]
  .map((component) => `release-please--branches--trunk--components--${component}`)];
const PATHS = ["package.json", "package-lock.json", "mcp/package.json", "mcp/package-lock.json"];

function requireThat(condition, message) {
  if (!condition) throw new Error(message);
}

function validatePackage(manifest, lock, name) {
  requireThat(manifest?.name === name && VERSION.test(manifest.version), `Invalid ${name} manifest identity.`);
  requireThat(lock?.name === name && lock.lockfileVersion === 3 && lock.packages?.[""]?.name === name,
    `Invalid ${name} lockfile identity.`);
}

/** Correct local version metadata only; component manifests are the authority. */
export function normalizeCandidateLockfiles(files) {
  const [sdk, sdkLock, mcp, mcpLock] = PATHS.map((path) => JSON.parse(files[path]));
  validatePackage(sdk, sdkLock, "@honua/sdk-js");
  validatePackage(mcp, mcpLock, "@honua/mcp-server");
  requireThat(mcpLock.version === mcp.version && mcpLock.packages[""].version === mcp.version,
    "MCP package and lock versions disagree; refusing to rewrite component release versions.");
  requireThat(mcpLock.packages[".."]?.name === sdk.name, "MCP local SDK lock entry is missing or has the wrong identity.");
  const changes = [];
  const replace = (path, lock, update) => {
    const before = JSON.stringify(lock);
    update();
    if (JSON.stringify(lock) !== before) changes.push({ path, mode: "100644", type: "blob", content: `${JSON.stringify(lock, null, 2)}\n` });
  };
  replace("package-lock.json", sdkLock, () => {
    sdkLock.version = sdk.version;
    sdkLock.packages[""].version = sdk.version;
  });
  replace("mcp/package-lock.json", mcpLock, () => { mcpLock.packages[".."].version = sdk.version; });
  return changes;
}

function candidateContext(input, request) {
  requireThat(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(input.repository) && SHA.test(input.trustedPolicySha),
    "Lock normalization requires an exact repository and trusted policy revision.");
  return { ...input, request, api: `${process.env.GITHUB_API_URL ?? "https://api.github.com"}/repos/${input.repository}` };
}

async function loadCandidate(context, number) {
  const snapshot = await loadCurrentPullRequestDisposition({ repository: context.repository, pullRequestNumber: number }, context.request);
  requireThat(automationExemption(snapshot) === "Release Please automation" && BRANCHES.includes(snapshot.headRefName),
    "Candidate does not match Release Please automation identity.");
  requireThat(snapshot.baseSha === context.trustedPolicySha, "Candidate base moved from trusted workflow revision.");
  return snapshot;
}

async function findCandidate(context, branch) {
  const query = new URLSearchParams({ state: "open", base: "trunk", head: `${context.repository.split("/")[0]}:${branch}`, per_page: "2" });
  const rows = await context.request(`${context.api}/pulls?${query}`);
  requireThat(Array.isArray(rows) && rows.length <= 1, "Ambiguous Release Please candidates.");
  if (rows.length === 0) return null;
  const snapshot = await loadCandidate(context, rows[0].number);
  requireThat(snapshot.headRefName === branch && snapshot.headSha === rows[0].head?.sha,
    "Candidate discovery and current metadata disagree.");
  return snapshot;
}

async function readCandidateFiles(context, snapshot) {
  const entries = await Promise.all(PATHS.map(async (path) => {
    const file = await context.request(`${context.api}/contents/${path}?ref=${snapshot.headSha}`);
    requireThat(file?.type === "file" && file.encoding === "base64" && typeof file.content === "string",
      `Invalid exact-source file ${path}.`);
    return [path, Buffer.from(file.content, "base64").toString("utf8")];
  }));
  return Object.fromEntries(entries);
}

async function assertCurrent(context, snapshot) {
  const current = await loadCandidate(context, snapshot.pullRequestNumber);
  requireThat(JSON.stringify(current) === JSON.stringify(snapshot), "Candidate metadata moved before normalization.");
  for (const [branch, expected] of [["trunk", context.trustedPolicySha], [snapshot.headRefName, snapshot.headSha]]) {
    const ref = await context.request(`${context.api}/git/ref/heads/${branch}`);
    requireThat(ref?.ref === `refs/heads/${branch}` && ref.object?.type === "commit" && ref.object.sha === expected,
      "Candidate branch moved before normalization.");
  }
}

function write(context, path, payload) {
  return context.request(`${context.api}/${path}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
  });
}

async function commitChanges(context, snapshot, changes) {
  await assertCurrent(context, snapshot);
  const parent = await context.request(`${context.api}/git/commits/${snapshot.headSha}`);
  requireThat(parent?.sha === snapshot.headSha && SHA.test(parent.tree?.sha), "Invalid candidate parent tree.");
  const tree = await write(context, "git/trees", { base_tree: parent.tree.sha, tree: changes });
  requireThat(SHA.test(tree?.sha), "Invalid normalized lockfile tree.");
  const commit = await write(context, "git/commits", {
    message: "chore: align generated local lock versions with candidate manifests", tree: tree.sha, parents: [snapshot.headSha],
  });
  requireThat(SHA.test(commit?.sha) && commit.tree?.sha === tree.sha && commit.parents?.length === 1 &&
    commit.parents[0].sha === snapshot.headSha, "Invalid normalized lockfile commit.");
  await assertCurrent(context, snapshot);
  const updated = await context.request(`${context.api}/git/refs/heads/${snapshot.headRefName}`, {
    method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sha: commit.sha, force: false }),
  });
  requireThat(updated?.object?.sha === commit.sha, "Normalized candidate head update was not confirmed.");
  return commit.sha;
}

/** Normalize the bounded set of authenticated release candidates, without executing candidate code. */
export async function normalizeReleasePleaseLockfiles(input, request = githubRequest) {
  const context = candidateContext(input, request);
  const results = [];
  for (const branch of BRANCHES) {
    const candidate = await findCandidate(context, branch);
    if (!candidate) continue;
    const changes = normalizeCandidateLockfiles(await readCandidateFiles(context, candidate));
    const headSha = changes.length ? await commitChanges(context, candidate, changes) : candidate.headSha;
    results.push({ pullRequestNumber: candidate.pullRequestNumber, headSha, status: changes.length ? "normalized" : "unchanged" });
  }
  return results;
}
