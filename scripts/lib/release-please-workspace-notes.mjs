import { githubRequest } from "./github-pr-issue-disposition.mjs";
import { loadExactReleasePleasePullRequest } from "./release-please-base-refresh.mjs";
import { RELEASE_PLEASE_BASE, RELEASE_PLEASE_HEAD } from "./release-please-disposition-check.mjs";
import { verifyManagedMcpPeerPolicy } from "../verify-mcp-pin.mjs";

const SDK = "@honua/sdk-js";
const CHANGELOG = "mcp/CHANGELOG.md";
const SHA = /^[0-9a-f]{40}$/u;

function requireThat(condition, message) {
  if (!condition) throw new Error(message);
}

function rewriteSection(section, base, candidate) {
  let category;
  let retained = false;
  const seen = new Set();
  const output = section.split("\n").map((line) => {
    if (line.startsWith("### ")) category = undefined;
    const categoryMatch = /^  \* (dependencies|devDependencies|peerDependencies|optionalDependencies)$/u.exec(line);
    if (categoryMatch) category = categoryMatch[1];
    const match = /^    \* @honua\/sdk-js (?:bumped from (.+) to (.+)|retained at (.+))$/u.exec(line);
    requireThat(match || !line.includes(`* ${SDK} bumped from`), "Malformed generated MCP workspace dependency note.");
    if (!match) return line;
    requireThat(category && !seen.has(category), "Ambiguous generated MCP workspace dependency notes.");
    seen.add(category);
    const before = base[category]?.[SDK];
    const after = candidate[category]?.[SDK];
    requireThat(typeof before === "string" && typeof after === "string", "Missing actual SDK dependency declaration.");
    if (match[3]) {
      requireThat(before === after && match[3] === after, "Retained MCP workspace note disagrees with actual declarations.");
      retained = true;
      return line;
    }
    requireThat(match[1] === before, "Generated MCP workspace note disagrees with the base declaration.");
    if (before === after) {
      retained = true;
      return `    * ${SDK} retained at ${after}`;
    }
    return `    * ${SDK} bumped from ${before} to ${after}`;
  }).join("\n");
  return retained
    ? output.replace("* The following workspace dependencies were updated", "* The following workspace dependency declarations were checked")
    : output;
}

/** Correct only the newly generated MCP entry; published historical notes are immutable inputs. */
export function normalizeMcpWorkspaceNotes({ baseMcp, mcp, mcpLock, sdk, policy, releaseConfig, changelog, body }) {
  verifyManagedMcpPeerPolicy({ policy, releaseConfig, sdk, mcp, mcpLock });
  requireThat(mcpLock.version === mcp.version && mcpLock.packages?.[""]?.version === mcp.version,
    "MCP package and lock versions disagree.");
  for (const category of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
    requireThat(mcp[category]?.[SDK] === mcpLock.packages[""][category]?.[SDK],
      `MCP package and lock ${category} declarations disagree.`);
  }
  if (baseMcp.version === mcp.version) return { changelog, body };
  requireThat(baseMcp.name === mcp.name && /^\d+\.\d+\.\d+$/u.test(mcp.version), "Invalid managed MCP release identity.");
  const headings = [...changelog.matchAll(/^## \[([^\]]+)\].*$/gmu)];
  requireThat(headings.length > 0 && headings[0][1] === mcp.version, "Newest MCP changelog heading does not match its package.");
  const start = headings[0].index;
  const end = headings[1]?.index ?? changelog.length;
  const title = `<details><summary>mcp-server: ${mcp.version}</summary>`;
  const bodyStart = body.indexOf(title);
  requireThat(bodyStart >= 0 && body.indexOf(title, bodyStart + title.length) < 0, "Expected exactly one current MCP release body section.");
  const bodyEnd = body.indexOf("</details>", bodyStart);
  requireThat(bodyEnd >= 0 && !body.slice(bodyStart + title.length, bodyEnd).includes("<details>"), "Malformed MCP release body section.");
  return {
    changelog: changelog.slice(0, start) + rewriteSection(changelog.slice(start, end), baseMcp, mcp) + changelog.slice(end),
    body: body.slice(0, bodyStart) + rewriteSection(body.slice(bodyStart, bodyEnd), baseMcp, mcp) + body.slice(bodyEnd),
  };
}

/** Apply generated-only corrections on the exact authenticated Release Please branch before CI dispatch. */
export async function normalizeReleasePleaseWorkspaceNotes(input, request = githubRequest) {
  const { repository, trustedPolicySha, headSha } = input;
  requireThat(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository) && SHA.test(trustedPolicySha) && SHA.test(headSha),
    "Workspace note normalization requires an exact repository and source identities.");
  const api = `${process.env.GITHUB_API_URL ?? "https://api.github.com"}/repos/${repository}`;
  const current = await loadExactReleasePleasePullRequest(repository, request);
  requireThat(current?.headSha === headSha && current.baseSha === trustedPolicySha, "Release Please notes source moved.");
  const readFile = async (path, ref) => {
    const result = await request(`${api}/contents/${path}?ref=${ref}`);
    requireThat(result?.type === "file" && result.encoding === "base64" && typeof result.content === "string",
      `Invalid exact-source file ${path}.`);
    return Buffer.from(result.content, "base64").toString("utf8");
  };
  const paths = ["mcp/package.json", "mcp/package-lock.json", "package.json", "config/mcp-sdk-peer-policy.v1.json", "release-please-config.json", CHANGELOG];
  const [baseText, ...candidateFiles] = await Promise.all([
    readFile("mcp/package.json", trustedPolicySha),
    ...paths.map((path) => readFile(path, headSha)),
  ]);
  const [mcp, mcpLock, sdk, policy, releaseConfig] = candidateFiles.slice(0, 5).map((text) => JSON.parse(text));
  const changelog = candidateFiles[5];
  const normalized = normalizeMcpWorkspaceNotes({ baseMcp: JSON.parse(baseText), mcp, mcpLock, sdk, policy, releaseConfig, changelog, body: current.body });
  if (normalized.changelog === changelog && normalized.body === current.body) return { status: "unchanged", headSha };

  const assertCurrent = async (expectedHead) => {
    const snapshot = await loadExactReleasePleasePullRequest(repository, request);
    requireThat(snapshot?.pullRequestNumber === current.pullRequestNumber && snapshot.headSha === expectedHead &&
      snapshot.baseSha === trustedPolicySha && snapshot.body === current.body, "Release Please notes changed before publication.");
    for (const [branch, expected] of [[RELEASE_PLEASE_BASE, trustedPolicySha], [RELEASE_PLEASE_HEAD, expectedHead]]) {
      const ref = await request(`${api}/git/ref/heads/${branch}`);
      requireThat(ref?.ref === `refs/heads/${branch}` && ref.object?.type === "commit" && ref.object.sha === expected,
        "Release Please notes branch moved before publication.");
    }
  };
  await assertCurrent(headSha);
  let nextHead = headSha;
  if (normalized.changelog !== changelog) {
    const parent = await request(`${api}/git/commits/${headSha}`);
    requireThat(parent?.sha === headSha && SHA.test(parent.tree?.sha), "Invalid release-note parent tree.");
    const tree = await request(`${api}/git/trees`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ base_tree: parent.tree.sha, tree: [{ path: CHANGELOG, mode: "100644", type: "blob", content: normalized.changelog }] }),
    });
    requireThat(SHA.test(tree?.sha), "Invalid generated release-note tree.");
    const commit = await request(`${api}/git/commits`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "chore: align generated MCP workspace notes with package declarations", tree: tree.sha, parents: [headSha] }),
    });
    requireThat(SHA.test(commit?.sha) && commit.tree?.sha === tree.sha && commit.parents?.length === 1 && commit.parents[0].sha === headSha,
      "Invalid generated release-note commit.");
    await assertCurrent(headSha);
    const updated = await request(`${api}/git/refs/heads/${RELEASE_PLEASE_HEAD}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sha: commit.sha, force: false }),
    });
    requireThat(updated?.object?.sha === commit.sha, "Generated release-note branch update was not confirmed.");
    nextHead = commit.sha;
  }
  if (normalized.body !== current.body) {
    await assertCurrent(nextHead);
    const updated = await request(`${api}/pulls/${current.pullRequestNumber}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ body: normalized.body }),
    });
    requireThat(updated?.body === normalized.body && updated.head?.sha === nextHead,
      "Generated release-note body update was not confirmed.");
  }
  return { status: "normalized", headSha: nextHead };
}
