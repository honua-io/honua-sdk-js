import { githubRequest, loadCurrentPullRequestDisposition } from "./github-pr-issue-disposition.mjs";
import { PullRequestDispositionError, validatePullRequestDisposition } from "./pr-issue-disposition.mjs";
import { REQUIRED_DISPOSITION_CHECK } from "./release-please-disposition-check.mjs";
import { evaluateReleaseWindow, loadReleaseWindows, readAllPages, repositoryApi } from "./release-window.mjs";

async function completeCheck(checkUrl, result, request) {
  await request(checkUrl, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status: "completed", conclusion: result.allowed ? "success" : "failure",
      output: { title: result.allowed ? "Merge policies passed" : "Merge policies held", summary: result.summary } }),
  });
}

async function pullRequestVerdict(target, options, request) {
  const current = await loadCurrentPullRequestDisposition(target, request);
  if (current.headSha !== target.headSha) throw new PullRequestDispositionError("head-changed", "PR head changed before validation.");
  validatePullRequestDisposition(current);
  return evaluateReleaseWindow(current, options, request);
}

/**
 * The required check is published on a commit, so every open trunk PR on one
 * head shares one check, whichever repository its branch is in. Each of them
 * publishes the same combined verdict: the commit is held while any of them is
 * held, and the summary names the PR to fix or close. Fail closed: a valid PR
 * never clears another PR's failure on the commit they share.
 */
async function siblingHolds(target, options, request) {
  const root = repositoryApi(target.repository);
  const openPulls = options.openPulls ?? await readAllPages(`${root}/pulls?state=open&base=trunk`, request);
  const siblings = openPulls.filter((other) => other.number !== target.pullRequestNumber && other.state === "open" &&
    other.base?.ref === "trunk" && other.head?.sha === target.headSha);
  const holds = [];
  for (const listed of siblings) {
    // The listing can be stale: only a sibling that is still open on this head shares the check.
    const sibling = await request(`${root}/pulls/${listed.number}`);
    if (sibling.state !== "open" || sibling.base?.ref !== "trunk" || sibling.head?.sha !== target.headSha) continue;
    try {
      const verdict = await pullRequestVerdict({ ...target, pullRequestNumber: listed.number }, options, request);
      if (!verdict.allowed) holds.push({ number: listed.number, summary: verdict.summary });
    } catch (error) {
      if (!(error instanceof PullRequestDispositionError)) throw new Error(`#${listed.number}: ${error.message}`, { cause: error });
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
    // One release-window read serves this PR and every PR that shares its head.
    const shared = { ...options, windows: options.windows ?? await loadReleaseWindows(input.repository, request) };
    const target = { ...input, headSha: initial.head.sha };
    result = await pullRequestVerdict(target, shared, request);
    const holds = result.allowed ? await siblingHolds(target, shared, request) : [];
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
