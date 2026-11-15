import process from "node:process";

import { githubRequest } from "./github-pr-issue-disposition.mjs";
import { isGeneratedReleasePath } from "./generated-release-paths.mjs";
import { PullRequestDispositionError, automationExemption } from "./pr-issue-disposition.mjs";

export function repositoryApi(repository) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error("Invalid repository.");
  return `${process.env.GITHUB_API_URL ?? "https://api.github.com"}/repos/${repository}`;
}

export async function readAllPages(url, request = githubRequest) {
  const values = [];
  for (let page = 1; page <= 30; page += 1) {
    const endpoint = new URL(url);
    endpoint.searchParams.set("per_page", "100");
    endpoint.searchParams.set("page", String(page));
    const batch = await request(endpoint.toString());
    if (!Array.isArray(batch)) throw new Error("GitHub returned a malformed paginated response.");
    values.push(...batch);
    if (batch.length < 100) return values;
  }
  throw new Error("GitHub pagination exceeded the 3000-item policy bound.");
}

export async function loadReleaseWindows(repository, request = githubRequest) {
  const root = repositoryApi(repository);
  const releases = await readAllPages(`${root}/releases`, request);
  const windows = [];
  for (const release of releases) {
    if (!release.draft || !/^js-sdk-v\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(release.tag_name)) continue;
    if (!Number.isFinite(Date.parse(release.created_at))) throw new Error("Draft release has no valid creation time.");
    try {
      await request(`${root}/git/ref/tags/${encodeURIComponent(release.tag_name)}`);
    } catch (error) {
      if (error.status !== 404) throw error;
      windows.push(release);
    }
  }
  const runs = await request(`${root}/actions/workflows/release-please.yml/runs?status=in_progress&per_page=100`);
  if (!Array.isArray(runs.workflow_runs)) throw new Error("GitHub returned malformed Release Please runs.");
  for (const run of runs.workflow_runs) {
    if (run.head_branch !== "trunk" || run.event === "workflow_run") continue;
    if (!Number.isFinite(Date.parse(run.created_at))) throw new Error("Release Please run has no valid creation time.");
    windows.push({ tag_name: `Release Please run ${run.id}`, created_at: run.created_at });
  }
  return windows;
}

function describeWindows(windows, now) {
  return windows.map((release) => {
    const minutes = Math.max(0, Math.floor((now - Date.parse(release.created_at)) / 60000));
    return `${release.tag_name} (window age ${minutes} minutes)`;
  }).join(", ");
}

function assertUnchanged(current, input) {
  if (current.state !== "open" || current.head?.sha !== input.headSha || current.base?.sha !== input.baseSha ||
      current.updated_at !== input.updatedAt || (current.body ?? "") !== input.body || current.title !== input.title) {
    throw new PullRequestDispositionError(
      "pull-request-changed",
      "Pull request changed during release-window validation; rerun the check.",
    );
  }
}

async function generatedOnly(input, request) {
  const root = repositoryApi(input.repository);
  const files = await readAllPages(`${root}/pulls/${input.pullRequestNumber}/files`, request);
  const current = await request(`${root}/pulls/${input.pullRequestNumber}`);
  assertUnchanged(current, input);
  if (files.length !== current.changed_files) throw new Error("GitHub returned an incomplete PR file list.");
  return files.length > 0 && files.every((file) => isGeneratedReleasePath(file.filename) &&
    (file.status !== "renamed" || isGeneratedReleasePath(file.previous_filename)));
}

export async function evaluateReleaseWindow(input, options = {}, request = githubRequest) {
  const windows = options.windows ?? await loadReleaseWindows(input.repository, request);
  if (windows.length === 0) return { allowed: true, summary: "Release window open: no untagged SDK draft or active release run." };
  if (automationExemption(input) === "Release Please automation") {
    return { allowed: true, summary: "Release window exception: authenticated Release Please automation." };
  }
  if (await generatedOnly(input, request)) {
    return { allowed: true, summary: "Release window exception: every changed and renamed path is generated." };
  }
  return {
    allowed: false,
    summary: `Release window held: ${describeWindows(windows, options.now ?? Date.now())}. ` +
      "Source changes must wait for publication, deletion, or creation of the release tag; generated-only PRs may merge.",
  };
}

/** The PR a run is for: the pull_request event's, or a positive dispatch input; otherwise all open PRs. */
export function targetPullRequestNumber(event) {
  if (event.pull_request?.number) return event.pull_request.number;
  const input = Number(event.inputs?.pull_request_number);
  return Number.isSafeInteger(input) && input > 0 ? input : undefined;
}

/**
 * Whether a merge-policy run should fail. A targeted run (one PR) reports that
 * PR's verdict. A bulk refresh has already published each PR's own required
 * check, so a held PR there is the PR's state, not a failure of the trunk run;
 * an infrastructure error while checking any PR still fails it.
 */
export function releaseWindowRunFails({ refresh, targeted, allowHeld, results }) {
  if (allowHeld) return false;
  if (results.some((result) => result.infrastructureError)) return true;
  if (refresh && !targeted) return false;
  return results.some((result) => !result.allowed);
}
