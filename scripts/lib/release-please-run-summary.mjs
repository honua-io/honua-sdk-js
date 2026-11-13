import { RELEASE_PLEASE_HEAD } from "./release-please-disposition-check.mjs";

const COMPONENT_VERIFICATION = "Component release pull requests are verified by the pull request workflows.";

function branchOutcome(candidate, refreshed) {
  if (candidate.status === "not-found") return "absent";
  const outcomes = [];
  if (candidate.status === "refreshed") outcomes.push("refreshed");
  if (candidate.status === "release-please-updated") outcomes.push("updated by Release Please");
  if (refreshed && candidate.headSha !== refreshed.headSha) outcomes.push("normalized");
  return outcomes.length ? outcomes.join(", ") : "unchanged";
}

function branchLine(candidate, refreshed) {
  const outcome = branchOutcome(candidate, refreshed);
  if (candidate.status === "not-found") return `- \`${candidate.headRefName}\`: ${outcome}.`;
  const details = [outcome, `${candidate.repository}#${candidate.pullRequestNumber} at ${candidate.headSha}`];
  if (candidate.workspaceNotes) details.push(`workspace dependency notes ${candidate.workspaceNotes}`);
  return `- \`${candidate.headRefName}\`: ${details.join("; ")}.`;
}

/**
 * One line per Release Please branch: what the refresh job did to it and the head it ended on.
 * `refreshedCandidates` are the heads after base refresh, before lockfile and notes normalization.
 */
export function renderReleasePleaseRefreshSummary({ trustedPolicySha, candidates, refreshedCandidates }) {
  const lines = [
    "## Trusted Release Please base refresh",
    "",
    `Trusted trunk policy revision: ${trustedPolicySha}.`,
    "",
    ...candidates.map((candidate) =>
      branchLine(candidate, refreshedCandidates.find((entry) => entry.headRefName === candidate.headRefName)),
    ),
  ];
  return `${lines.join("\n")}\n`;
}

export function renderReleasePleaseDispositionSummary(result) {
  const lines = ["## Trusted Release Please issue disposition", ""];
  if (result.status === "not-found") {
    lines.push(
      `Checked \`${RELEASE_PLEASE_HEAD}\`: no open combined Release Please pull request; no disposition check was emitted.`,
    );
  } else {
    lines.push(`Checked \`${RELEASE_PLEASE_HEAD}\`: validated ${result.repository}#${result.pullRequestNumber} at ${result.headSha}.`);
    lines.push(`Exempt: ${result.exemption}.`);
    lines.push(`Created source-bound check run ${result.checkRunId}.`);
  }
  lines.push(COMPONENT_VERIFICATION);
  lines.push(`Trusted trunk policy revision: ${result.trustedPolicySha}.`);
  return `${lines.join("\n")}\n`;
}
