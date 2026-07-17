import { createHash } from "node:crypto";

import {
  BacklogDependencyError,
  DEFAULT_MAX_BACKLOG_ISSUES,
  DEFAULT_MAX_DEPENDENCIES_PER_ISSUE,
  backlogIssueKey,
  normalizeRepository,
  parseBacklogDependencies,
  planBacklogReconciliation,
} from "./backlog-dependencies.mjs";
import {
  githubBacklogLabelRequest,
  githubBacklogRequest,
  loadGitHubBacklogSnapshot,
  loadGitHubBacklogTargetSnapshot,
  replaceGitHubBacklogIssueLabels,
} from "./github-backlog-dependencies.mjs";

const CONTROLLED_LABELS = Object.freeze(["blocked", "ready-to-start"]);

const APPLY_ERROR_MESSAGES = Object.freeze({
  "invalid-adapters": "Backlog reconciliation adapters are invalid.",
  "invalid-apply-input": "Backlog reconciliation apply input is invalid.",
  "invalid-transition": "The planner proposed an invalid readiness-label transition.",
  "postcondition-failed": "The readiness-label mutation did not reach a stable postcondition.",
  "preflight-drift": "Issue or dependency metadata changed before the readiness-label mutation.",
  "unexpected-plan": "The targeted reconciliation plan is invalid.",
});

export class BacklogDependencyApplyError extends Error {
  constructor(code) {
    const knownCode = Object.hasOwn(APPLY_ERROR_MESSAGES, code) ? code : "apply-error";
    super(APPLY_ERROR_MESSAGES[knownCode] ?? "Backlog dependency apply failed safely.");
    this.name = "BacklogDependencyApplyError";
    this.code = knownCode;
  }
}

function applyFail(code) {
  throw new BacklogDependencyApplyError(code);
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function exactJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sha256Json(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function issueFingerprint(issue) {
  return sha256Json({
    repository: issue.repository,
    number: issue.number,
    state: issue.state,
    body: issue.body,
    labels: issue.labels,
    isPullRequest: issue.isPullRequest,
  });
}

function dispositionFingerprint(disposition) {
  return JSON.stringify({
    repository: disposition.repository,
    number: disposition.number,
    kind: disposition.kind,
    dependencies: disposition.dependencies,
    proposedLabels: disposition.proposedLabels,
  });
}

function dependencyGraphFingerprint(snapshot, repository, number, maxDependencies) {
  const issues = new Map(
    snapshot.issues.map((issue) => [backlogIssueKey(issue.repository, issue.number), issue]),
  );
  const unavailable = new Set(
    (snapshot.unavailable ?? []).map((issue) => backlogIssueKey(issue.repository, issue.number)),
  );
  const pending = [backlogIssueKey(repository, number)];
  let pendingIndex = 0;
  const seen = new Set();
  const graph = [];

  while (pendingIndex < pending.length) {
    const key = pending[pendingIndex];
    pendingIndex += 1;
    if (seen.has(key)) continue;
    seen.add(key);

    if (unavailable.has(key)) {
      graph.push({ key, availability: "inaccessible" });
      continue;
    }
    const issue = issues.get(key);
    if (!issue) {
      graph.push({ key, availability: "missing" });
      continue;
    }
    const record = {
      key,
      availability: "readable",
      state: issue.state,
      body: issue.body,
      isPullRequest: issue.isPullRequest,
      stable: issue.stable,
    };
    graph.push(record);
    if (issue.state !== "open" || issue.isPullRequest || !issue.stable) continue;

    try {
      const specification = parseBacklogDependencies(issue.body, {
        repository: issue.repository,
        issueNumber: issue.number,
        maxDependencies,
      });
      if (specification.mode === "automatic") {
        for (const dependency of specification.dependencies) {
          if (!seen.has(dependency.key)) pending.push(dependency.key);
        }
      }
    } catch (error) {
      if (!(error instanceof BacklogDependencyError)) throw error;
      record.parseError = error.code;
    }
  }

  graph.sort((left, right) => compareText(left.key, right.key));
  return sha256Json(graph);
}

function findTarget(snapshot, repository, number) {
  return snapshot.issues.find((issue) => issue.repository === repository && issue.number === number && issue.target);
}

function expectedTransition(disposition) {
  const proposed = disposition.proposedLabels;
  if (!proposed || !Array.isArray(proposed.remove) || !Array.isArray(proposed.add)) applyFail("invalid-transition");
  if (proposed.remove.length !== 1 || proposed.add.length !== 1) applyFail("invalid-transition");
  const transition = { remove: proposed.remove[0], add: proposed.add[0] };
  const promotes = transition.remove === "blocked" && transition.add === "ready-to-start";
  const demotes = transition.remove === "ready-to-start" && transition.add === "blocked";
  if (!promotes && !demotes) applyFail("invalid-transition");
  if (promotes && disposition.kind !== "blocked-to-ready") applyFail("invalid-transition");
  if (demotes && !["ready-to-blocked", "inaccessible", "cycle", "malformed"].includes(disposition.kind)) {
    applyFail("invalid-transition");
  }
  return transition;
}

function replacementLabels(issue, transition) {
  const controlled = issue.labels.filter((label) => CONTROLLED_LABELS.includes(label));
  if (!exactJson(controlled, [transition.remove]) || issue.labels.includes(transition.add)) {
    applyFail("preflight-drift");
  }
  return issue.labels
    .filter((label) => label !== transition.remove)
    .concat(transition.add)
    .sort(compareText);
}

function candidateFrom(snapshot, disposition, plannerOptions) {
  const issue = findTarget(snapshot, disposition.repository, disposition.number);
  if (!issue) applyFail("unexpected-plan");
  return {
    disposition,
    dispositionFingerprint: dispositionFingerprint(disposition),
    issueFingerprint: issueFingerprint(issue),
    graphFingerprint: dependencyGraphFingerprint(
      snapshot,
      disposition.repository,
      disposition.number,
      plannerOptions.maxDependencies,
    ),
    transition: expectedTransition(disposition),
  };
}

function verifyTargetedCandidate(snapshot, candidate, plannerOptions) {
  const plan = planBacklogReconciliation(snapshot, plannerOptions);
  if (plan.targetCount !== 1 || plan.dispositions.length !== 1) applyFail("unexpected-plan");
  const disposition = plan.dispositions[0];
  const issue = findTarget(snapshot, candidate.disposition.repository, candidate.disposition.number);
  if (
    !issue ||
    issueFingerprint(issue) !== candidate.issueFingerprint ||
    dependencyGraphFingerprint(
      snapshot,
      candidate.disposition.repository,
      candidate.disposition.number,
      plannerOptions.maxDependencies,
    ) !== candidate.graphFingerprint ||
    dispositionFingerprint(disposition) !== candidate.dispositionFingerprint
  ) {
    applyFail("preflight-drift");
  }
  return { disposition, issue };
}

function normalizeAdapters(adapters) {
  if (adapters === null || typeof adapters !== "object" || Array.isArray(adapters)) applyFail("invalid-adapters");
  const read = adapters.read ?? githubBacklogRequest;
  const mutate = adapters.mutate ?? githubBacklogLabelRequest;
  if (typeof read !== "function" || typeof mutate !== "function") applyFail("invalid-adapters");
  return { read, mutate };
}

function normalizeInput(input) {
  if (input === null || typeof input !== "object" || Array.isArray(input)) applyFail("invalid-apply-input");
  return {
    repository: normalizeRepository(input.repository),
    apiRoot: input.apiRoot,
    maxPages: input.maxPages,
    maxIssues: input.maxIssues ?? DEFAULT_MAX_BACKLOG_ISSUES,
    maxDependencies: input.maxDependencies ?? DEFAULT_MAX_DEPENDENCIES_PER_ISSUE,
    concurrency: input.concurrency,
  };
}

function targetedInput(input, number) {
  return {
    repository: input.repository,
    issueNumber: number,
    apiRoot: input.apiRoot,
    maxIssues: input.maxIssues,
    maxDependencies: input.maxDependencies,
    concurrency: input.concurrency,
  };
}

/**
 * Apply only planner-approved readiness-label transitions. Every candidate is
 * preflighted before any write, then its transitive graph is double-read again
 * immediately before one atomic label replacement.
 */
export async function applyGitHubBacklogReconciliation(input, adapters = {}) {
  const normalizedInput = normalizeInput(input);
  const { read, mutate } = normalizeAdapters(adapters);
  const plannerOptions = {
    maxIssues: normalizedInput.maxIssues,
    maxDependencies: normalizedInput.maxDependencies,
  };
  const initialSnapshot = await loadGitHubBacklogSnapshot(normalizedInput, read);
  const initialPlan = planBacklogReconciliation(initialSnapshot, plannerOptions);
  const candidates = initialPlan.dispositions
    .filter((disposition) => disposition.proposedLabels !== null)
    .map((disposition) => candidateFrom(initialSnapshot, disposition, plannerOptions));

  // Prove every candidate is still eligible before the first mutation. This
  // prevents a known later failure from leaving an avoidable partial batch.
  for (const candidate of candidates) {
    const snapshot = await loadGitHubBacklogTargetSnapshot(
      targetedInput(normalizedInput, candidate.disposition.number),
      read,
    );
    verifyTargetedCandidate(snapshot, candidate, plannerOptions);
  }

  const applied = [];
  for (const candidate of candidates) {
    const snapshot = await loadGitHubBacklogTargetSnapshot(
      targetedInput(normalizedInput, candidate.disposition.number),
      read,
    );
    const { issue } = verifyTargetedCandidate(snapshot, candidate, plannerOptions);
    const labels = replacementLabels(issue, candidate.transition);
    const updated = await replaceGitHubBacklogIssueLabels(
      {
        repository: normalizedInput.repository,
        issueNumber: candidate.disposition.number,
        apiRoot: normalizedInput.apiRoot,
        labels,
      },
      mutate,
    );
    if (
      updated.repository !== issue.repository ||
      updated.number !== issue.number ||
      updated.state !== issue.state ||
      updated.body !== issue.body ||
      updated.isPullRequest !== issue.isPullRequest ||
      !exactJson(updated.labels, labels)
    ) {
      applyFail("postcondition-failed");
    }

    const postSnapshot = await loadGitHubBacklogTargetSnapshot(
      targetedInput(normalizedInput, candidate.disposition.number),
      read,
    );
    const postPlan = planBacklogReconciliation(postSnapshot, plannerOptions);
    const postIssue = findTarget(postSnapshot, normalizedInput.repository, candidate.disposition.number);
    if (
      postPlan.targetCount !== 1 ||
      postPlan.dispositions.length !== 1 ||
      postPlan.dispositions[0].proposedLabels !== null ||
      !postIssue ||
      !exactJson(postIssue.labels, labels)
    ) {
      applyFail("postcondition-failed");
    }
    applied.push({
      issue: `#${candidate.disposition.number}`,
      remove: candidate.transition.remove,
      add: candidate.transition.add,
    });
  }

  return {
    ...initialPlan,
    mode: "apply",
    mutationsPerformed: applied.length > 0,
    appliedCount: applied.length,
    applied,
  };
}
