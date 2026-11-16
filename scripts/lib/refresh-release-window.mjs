import { githubRequest, loadCurrentPullRequestDisposition } from "./github-pr-issue-disposition.mjs";
import { PullRequestDispositionError, validatePullRequestDisposition } from "./pr-issue-disposition.mjs";
import { REQUIRED_DISPOSITION_CHECK } from "./release-please-disposition-check.mjs";
import { evaluateReleaseWindow, readAllPages, repositoryApi } from "./release-window.mjs";

async function completeCheck(checkUrl, result, request) {
  await request(checkUrl, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status: "completed", conclusion: result.allowed ? "success" : "failure",
      output: { title: result.allowed ? "Merge policies passed" : "Merge policies held", summary: result.summary } }),
  });
}

/**
 * The required check is published on a commit, so open trunk PRs that share a
 * head share one check. The newest of them owns it; an older PR that published
 * its own verdict there would block (or unblock) a PR nobody can fix from its side.
 */
function newerPullRequestOnHead(openPulls, pull, pullRequestNumber) {
  const newer = openPulls.filter((other) => other.state === "open" && other.base?.ref === "trunk" &&
    other.head?.sha === pull.head.sha && other.number > pullRequestNumber).map((other) => other.number);
  return newer.length > 0 ? Math.max(...newer) : undefined;
}

export async function refreshPullRequest(input, options = {}, request = githubRequest) {
  const root = repositoryApi(input.repository);
  const initial = await request(`${root}/pulls/${input.pullRequestNumber}`);
  if (initial.state !== "open" || initial.base?.ref !== "trunk") return { allowed: true, summary: "PR no longer targets trunk." };
  if (!/^[a-f0-9]{40}$/.test(initial.head?.sha)) throw new Error("Missing current PR head SHA.");
  const openPulls = options.openPulls ?? await readAllPages(`${root}/pulls?state=open&base=trunk`, request);
  const owner = newerPullRequestOnHead(openPulls, initial, input.pullRequestNumber);
  if (owner !== undefined) {
    return { allowed: true, superseded: true,
      summary: `Not published: #${owner} is a newer open PR on the same head and owns the merge-policy check.` };
  }
  const check = await request(`${root}/check-runs`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: REQUIRED_DISPOSITION_CHECK, head_sha: initial.head.sha, status: "in_progress",
      details_url: options.detailsUrl }),
  });
  if (!Number.isSafeInteger(check.id)) throw new Error("GitHub did not create a pending merge-policy check.");
  let result;
  try {
    const current = await loadCurrentPullRequestDisposition(input, request);
    if (current.headSha !== initial.head.sha) throw new PullRequestDispositionError("head-changed", "PR head changed before validation.");
    validatePullRequestDisposition(current);
    result = await evaluateReleaseWindow(current, options, request);
  } catch (error) {
    // The PR owns a disposition failure; anything else is an infrastructure error the run must surface.
    result = { allowed: false, summary: `Merge policy validation failed: ${error.message}`,
      ...(error instanceof PullRequestDispositionError ? {} : { infrastructureError: true }) };
  }
  await completeCheck(`${root}/check-runs/${check.id}`, result, request);
  return result;
}

export async function refreshReleaseWindows(input, request = githubRequest) {
  const root = repositoryApi(input.repository);
  const pulls = input.pullRequestNumber ? [{ number: input.pullRequestNumber }] :
    await readAllPages(`${root}/pulls?state=open&base=trunk`, request);
  const results = [];
  for (const pull of pulls) {
    const result = await refreshPullRequest({ repository: input.repository, pullRequestNumber: pull.number },
      { detailsUrl: input.detailsUrl, ...(input.pullRequestNumber ? {} : { openPulls: pulls }) }, request);
    results.push({ number: pull.number, ...result });
  }
  return results;
}
