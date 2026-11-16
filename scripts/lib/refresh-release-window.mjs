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

async function pullRequestVerdict(input, headSha, options, request) {
  const current = await loadCurrentPullRequestDisposition(input, request);
  if (current.headSha !== headSha) throw new PullRequestDispositionError("head-changed", "PR head changed before validation.");
  validatePullRequestDisposition(current);
  return evaluateReleaseWindow(current, options, request);
}

/**
 * The required check is published on a commit, so open trunk PRs from one
 * repository that share a head share one check. Every one of them publishes
 * the same combined verdict: the commit is held while any of them is held, and
 * the summary names the PR to fix or close. A PR from another repository (a
 * fork at the same commit) never holds this PR.
 */
async function siblingHolds(input, initial, options, request) {
  const root = repositoryApi(input.repository);
  const openPulls = options.openPulls ?? await readAllPages(`${root}/pulls?state=open&base=trunk`, request);
  const headRepository = initial.head.repo?.full_name;
  const siblings = openPulls.filter((other) => other.number !== input.pullRequestNumber && other.state === "open" &&
    other.base?.ref === "trunk" && other.head?.sha === initial.head.sha &&
    headRepository !== undefined && other.head?.repo?.full_name === headRepository);
  const holds = [];
  for (const listed of siblings) {
    // The listing can be stale: a sibling that closed or moved off this head no longer shares the check.
    const sibling = await request(`${root}/pulls/${listed.number}`);
    if (sibling.state !== "open" || sibling.base?.ref !== "trunk" || sibling.head?.sha !== initial.head.sha) continue;
    try {
      const verdict = await pullRequestVerdict({ repository: input.repository, pullRequestNumber: listed.number },
        initial.head.sha, options, request);
      if (!verdict.allowed) holds.push({ number: listed.number, summary: verdict.summary });
    } catch (error) {
      if (!(error instanceof PullRequestDispositionError)) throw error;
      holds.push({ number: listed.number, summary: error.message });
    }
  }
  return holds;
}

export async function refreshPullRequest(input, options = {}, request = githubRequest) {
  const root = repositoryApi(input.repository);
  const initial = await request(`${root}/pulls/${input.pullRequestNumber}`);
  if (initial.state !== "open" || initial.base?.ref !== "trunk") return { allowed: true, summary: "PR no longer targets trunk." };
  if (!/^[a-f0-9]{40}$/.test(initial.head?.sha)) throw new Error("Missing current PR head SHA.");
  const check = await request(`${root}/check-runs`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: REQUIRED_DISPOSITION_CHECK, head_sha: initial.head.sha, status: "in_progress",
      details_url: options.detailsUrl }),
  });
  if (!Number.isSafeInteger(check.id)) throw new Error("GitHub did not create a pending merge-policy check.");
  let result;
  try {
    result = await pullRequestVerdict(input, initial.head.sha, options, request);
    const holds = result.allowed ? await siblingHolds(input, initial, options, request) : [];
    if (holds.length > 0) {
      result = { allowed: false, summary: "Held by another open PR on the same commit; fix or close it: " +
        holds.map((hold) => `#${hold.number} (${hold.summary})`).join("; ") };
    }
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
