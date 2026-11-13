import { refreshReleasePleaseBase } from "./release-please-base-refresh.mjs";
import { RELEASE_PLEASE_HEAD, RELEASE_PLEASE_HEADS } from "./release-please-disposition-check.mjs";
import { normalizeReleasePleaseLockfiles } from "./release-please-lockfiles.mjs";
import { normalizeMcpComponentReleaseNotes, normalizeReleasePleaseWorkspaceNotes } from "./release-please-workspace-notes.mjs";

// Pinned action v5 emits `prs` only for created/updated PRs. release-please
// 17.6.0 returns undefined for an existing PR with unchanged release notes.
export function parseReleasePleasePullRequests(value) {
  const records = JSON.parse(value || "[]");
  if (!Array.isArray(records)) throw new Error("Release Please prs output must be an array.");
  const updates = new Map();
  for (const record of records) {
    if (!RELEASE_PLEASE_HEADS.includes(record?.headBranchName) || record.baseBranchName !== "trunk" ||
        !Number.isSafeInteger(record.number) || record.number <= 0 || updates.has(record.headBranchName)) {
      throw new Error("Release Please prs output contains an invalid or duplicate exact candidate.");
    }
    updates.set(record.headBranchName, record.number);
  }
  return updates;
}

export async function prepareReleasePleaseCandidates(input, dependencies = {}) {
  const refresh = dependencies.refresh ?? refreshReleasePleaseBase;
  const locks = dependencies.locks ?? normalizeReleasePleaseLockfiles;
  const mcpNotes = dependencies.mcpNotes ?? normalizeMcpComponentReleaseNotes;
  const workspaceNotes = dependencies.workspaceNotes ?? normalizeReleasePleaseWorkspaceNotes;
  const updates = parseReleasePleasePullRequests(input.releasePleasePullRequests);
  const candidates = [];
  for (const headRefName of RELEASE_PLEASE_HEADS) {
    const result = await refresh({ ...input, headRefName,
      releasePleaseReportedUpdate: updates.has(headRefName),
      reportedPullRequestNumber: updates.get(headRefName) });
    candidates.push({ ...result, headRefName });
  }
  const refreshedCandidates = structuredClone(candidates);
  // Every stale base must be repaired before either normalizer can enforce
  // its exact trusted-base transaction guard.
  const lockResults = await locks({ ...input, expectedCandidates: structuredClone(candidates) });
  for (const result of lockResults) {
    const candidate = candidates.find((entry) => entry.pullRequestNumber === result.pullRequestNumber);
    if (!candidate || candidate.status === "not-found") throw new Error("Lock normalization candidate changed.");
    candidate.headSha = result.headSha;
  }
  const notes = await mcpNotes({ ...input, expectedCandidates: structuredClone(candidates) });
  const mcp = candidates.find((entry) => entry.headRefName.endsWith("--components--mcp-server"));
  if ((notes.status === "absent") !== (mcp.status === "not-found")) {
    throw new Error("MCP notes candidate changed during normalization.");
  }
  if (notes.status !== "absent") mcp.headSha = notes.headSha;
  const legacy = candidates.find((entry) => entry.headRefName === RELEASE_PLEASE_HEAD);
  if (legacy.status !== "not-found") {
    const result = await workspaceNotes(legacy);
    legacy.headSha = result.headSha;
    legacy.workspaceNotes = result.status;
  }
  // Confirm final heads after every normalization transaction. Never dispatch
  // CI with a refresh head superseded by a lockfile or notes commit.
  for (const candidate of candidates) {
    const final = await refresh({ ...input, headRefName: candidate.headRefName, releasePleaseReportedUpdate: false, requireCurrent: true });
    if (final.status === "not-found" ? candidate.status !== "not-found" :
        final.pullRequestNumber !== candidate.pullRequestNumber || final.headSha !== candidate.headSha) {
      throw new Error("Release Please candidate moved during normalization.");
    }
  }
  return { legacy, candidates, refreshedCandidates };
}
