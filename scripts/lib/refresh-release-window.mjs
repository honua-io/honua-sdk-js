import { githubRequest, loadCurrentPullRequestDisposition } from "./github-pr-issue-disposition.mjs";
import { validatePullRequestDisposition } from "./pr-issue-disposition.mjs";
import { REQUIRED_DISPOSITION_CHECK } from "./release-please-disposition-check.mjs";
import { evaluateReleaseWindow, readAllPages, repositoryApi } from "./release-window.mjs";

async function completeCheck(root, check, result, request) {
  await request(`${root}/check-runs/${check.id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status: "completed", conclusion: result.allowed ? "success" : "failure",
      output: { title: result.allowed ? "Merge policies passed" : "Merge policies held", summary: result.summary } }),
  });
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
    const current = await loadCurrentPullRequestDisposition(input, request);
    if (current.headSha !== initial.head.sha) throw new Error("PR head changed before validation.");
    validatePullRequestDisposition(current);
    result = await evaluateReleaseWindow(current, options, request);
  } catch (error) {
    result = { allowed: false, summary: `Merge policy validation failed: ${error.message}` };
  }
  await completeCheck(root, check, result, request);
  return result;
}

export async function refreshReleaseWindows(input, request = githubRequest) {
  const root = repositoryApi(input.repository);
  const pulls = input.pullRequestNumber ? [{ number: input.pullRequestNumber }] :
    await readAllPages(`${root}/pulls?state=open&base=trunk`, request);
  const results = [];
  for (const pull of pulls) {
    const result = await refreshPullRequest({ repository: input.repository, pullRequestNumber: pull.number },
      { detailsUrl: input.detailsUrl }, request);
    results.push({ number: pull.number, ...result });
  }
  return results;
}
