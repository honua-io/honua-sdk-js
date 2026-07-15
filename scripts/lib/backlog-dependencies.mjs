const DEPENDENCY_HEADING = "## Backlog Dependencies";
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/u;
const SAME_REPOSITORY_REFERENCE_PATTERN = /^#([1-9][0-9]*)$/u;
const CROSS_REPOSITORY_REFERENCE_PATTERN = /^([A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100})#([1-9][0-9]*)$/u;
const MAX_MANUAL_REASON_LENGTH = 240;
const MAX_ISSUE_BODY_LENGTH = 100_000;
const MAX_SUPPORTED_DEPENDENCIES = 100;
const UNSAFE_MANUAL_REASON_PATTERN = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

export const DEFAULT_MAX_DEPENDENCIES_PER_ISSUE = 20;
export const RECONCILIATION_KINDS = Object.freeze([
  "blocked-to-ready",
  "ready-to-blocked",
  "unchanged-blocked",
  "unchanged-ready",
  "manual",
  "missing",
  "malformed",
  "inaccessible",
  "cycle",
  "drift",
]);

export class BacklogDependencyError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "BacklogDependencyError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new BacklogDependencyError(code, message);
}

export function normalizeRepository(value) {
  const repository = String(value ?? "");
  if (!REPOSITORY_PATTERN.test(repository)) {
    fail("invalid-repository", "Repository must be an owner/name pair.");
  }
  if (repository.split("/").some((segment) => segment === "." || segment === "..")) {
    fail("invalid-repository", "Repository owner and name may not be path-navigation segments.");
  }
  return repository.toLowerCase();
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function backlogIssueKey(repository, number) {
  const normalizedRepository = normalizeRepository(repository);
  if (!Number.isSafeInteger(number) || number <= 0) {
    fail("invalid-issue-number", "Issue number must be a positive safe integer.");
  }
  return `${normalizedRepository}#${number}`;
}

function parseIssueNumber(value, reference) {
  const number = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(number) || number <= 0) {
    fail("malformed-dependency", `Dependency ${JSON.stringify(reference)} has an invalid issue number.`);
  }
  return number;
}

function dependencyReference(value, repository) {
  const sameRepository = SAME_REPOSITORY_REFERENCE_PATTERN.exec(value);
  if (sameRepository) {
    const number = parseIssueNumber(sameRepository[1], value);
    return {
      repository,
      number,
      key: backlogIssueKey(repository, number),
      reference: `#${number}`,
    };
  }

  const crossRepository = CROSS_REPOSITORY_REFERENCE_PATTERN.exec(value);
  if (!crossRepository) {
    fail("malformed-dependency", `Dependency ${JSON.stringify(value)} must be exactly #N or owner/repo#N.`);
  }
  const dependencyRepository = normalizeRepository(crossRepository[1]);
  const number = parseIssueNumber(crossRepository[2], value);
  return {
    repository: dependencyRepository,
    number,
    key: backlogIssueKey(dependencyRepository, number),
    reference: dependencyRepository === repository ? `#${number}` : `${dependencyRepository}#${number}`,
  };
}

function secondLevelHeadingIndexes(lines) {
  const indexes = [];
  let fence = null;
  for (let index = 0; index < lines.length; index += 1) {
    const fenceMatch = /^\s*(`{3,}|~{3,})/u.exec(lines[index]);
    if (fenceMatch) {
      const marker = fenceMatch[1][0];
      if (fence === null) fence = marker;
      else if (fence === marker) fence = null;
      continue;
    }
    if (fence === null && /^##(?:\s|$)/u.test(lines[index])) indexes.push(index);
  }
  return indexes;
}

function dependencySectionLines(body) {
  if (typeof body !== "string") fail("missing-body", "Issue body is required.");
  if (body.length > MAX_ISSUE_BODY_LENGTH) {
    fail("body-bound-exceeded", `Issue body exceeds the ${MAX_ISSUE_BODY_LENGTH}-character parser bound.`);
  }
  const lines = body.replace(/\r\n?/gu, "\n").split("\n");
  const headings = secondLevelHeadingIndexes(lines);
  const matches = headings.filter((index) => lines[index] === DEPENDENCY_HEADING);
  if (matches.length === 0) {
    fail("missing-dependency-section", `Issue body must contain an exact ${DEPENDENCY_HEADING} section.`);
  }
  if (matches.length > 1) {
    fail("duplicate-dependency-section", `Issue body contains more than one ${DEPENDENCY_HEADING} section.`);
  }

  const start = matches[0];
  const end = headings.find((index) => index > start) ?? lines.length;
  const section = lines.slice(start + 1, end);
  while (section.length > 0 && section[0] === "") section.shift();
  while (section.length > 0 && section.at(-1) === "") section.pop();
  if (section.length === 0) fail("empty-dependency-section", `${DEPENDENCY_HEADING} must not be empty.`);
  if (section.some((line) => line === "")) {
    fail("malformed-dependency-section", `${DEPENDENCY_HEADING} may not contain internal blank lines.`);
  }
  return section;
}

function issueIsEpic(body) {
  return /^Type: Epic$/mu.test(body);
}

/** Parse the exact, bounded dependency section from an issue body. */
export function parseBacklogDependencies(
  body,
  { repository, issueNumber, maxDependencies = DEFAULT_MAX_DEPENDENCIES_PER_ISSUE },
) {
  const normalizedRepository = normalizeRepository(repository);
  if (!Number.isSafeInteger(issueNumber) || issueNumber <= 0) {
    fail("invalid-issue-number", "The owning issue number must be a positive safe integer.");
  }
  if (!Number.isSafeInteger(maxDependencies) || maxDependencies <= 0 || maxDependencies > MAX_SUPPORTED_DEPENDENCIES) {
    fail("invalid-dependency-bound", `maxDependencies must be between 1 and ${MAX_SUPPORTED_DEPENDENCIES}.`);
  }

  const lines = dependencySectionLines(body);
  const mode = lines[0];
  if (mode === "Mode: manual") {
    if (lines.length !== 2 || !lines[1].startsWith("Reason: ")) {
      fail(
        "malformed-manual-opt-out",
        "Manual dependency reconciliation requires exactly `Mode: manual` and one `Reason: ...` line.",
      );
    }
    const reason = lines[1].slice("Reason: ".length);
    if (
      reason !== reason.trim() ||
      reason.length === 0 ||
      reason.length > MAX_MANUAL_REASON_LENGTH ||
      UNSAFE_MANUAL_REASON_PATTERN.test(reason)
    ) {
      fail("malformed-manual-reason", `Manual reason must contain 1-${MAX_MANUAL_REASON_LENGTH} trimmed characters.`);
    }
    return { mode: "manual", reason, dependencies: [] };
  }

  if (mode !== "Mode: automatic") {
    fail("invalid-dependency-mode", "Dependency mode must be exactly `Mode: automatic` or `Mode: manual`.");
  }
  if (issueIsEpic(body)) {
    fail("epic-requires-manual", "Specifica epics must use the validated manual opt-out.");
  }

  if (lines.length === 2 && lines[1] === "Dependencies: none") {
    return { mode: "automatic", dependencies: [] };
  }
  if (lines[1] !== "Dependencies:" || lines.length < 3) {
    fail(
      "malformed-dependency-list",
      "Automatic mode requires `Dependencies: none` or `Dependencies:` followed by exact `- #N` entries.",
    );
  }
  const dependencyLines = lines.slice(2);
  if (dependencyLines.length > maxDependencies) {
    fail("too-many-dependencies", `Issue declares more than ${maxDependencies} dependencies.`);
  }

  const ownerKey = backlogIssueKey(normalizedRepository, issueNumber);
  const seen = new Set();
  const dependencies = dependencyLines.map((line) => {
    if (!line.startsWith("- ")) {
      fail("malformed-dependency", `Dependency line ${JSON.stringify(line)} must start with exactly \`- \`.`);
    }
    const dependency = dependencyReference(line.slice(2), normalizedRepository);
    if (dependency.key === ownerKey) {
      fail("self-cycle", `Issue ${ownerKey} cannot depend on itself.`);
    }
    if (seen.has(dependency.key)) {
      fail("duplicate-dependency", `Dependency ${dependency.reference} is declared more than once.`);
    }
    seen.add(dependency.key);
    return dependency;
  });

  dependencies.sort((left, right) => compareText(left.key, right.key));
  return { mode: "automatic", dependencies };
}

function normalizeIssueSnapshot(issue) {
  const repository = normalizeRepository(issue?.repository);
  const number = issue?.number;
  const key = backlogIssueKey(repository, number);
  const state = String(issue?.state ?? "").toLowerCase();
  if (state !== "open" && state !== "closed") {
    fail("invalid-issue-state", `Issue ${key} has invalid state ${JSON.stringify(issue?.state)}.`);
  }
  if (!Array.isArray(issue?.labels) || issue.labels.some((label) => typeof label !== "string")) {
    fail("invalid-issue-labels", `Issue ${key} has invalid label metadata.`);
  }
  return {
    repository,
    number,
    key,
    state,
    body: typeof issue.body === "string" ? issue.body : "",
    labels: [...new Set(issue.labels)].sort(),
    isPullRequest: issue.isPullRequest === true,
    stable: issue.stable !== false,
    driftReason: String(issue.driftReason ?? "metadata changed during the double-read"),
    target: issue.target === true,
  };
}

function normalizeUnavailable(unavailable) {
  if (unavailable === undefined) return new Map();
  if (!Array.isArray(unavailable)) fail("invalid-unavailable-metadata", "Unavailable metadata must be an array.");
  const result = new Map();
  for (const entry of unavailable) {
    const key = backlogIssueKey(entry?.repository, entry?.number);
    if (result.has(key)) fail("duplicate-unavailable-metadata", `Unavailable metadata duplicates ${key}.`);
    result.set(key, String(entry?.reason ?? "issue metadata is inaccessible"));
  }
  return result;
}

function displayReference(issue, repository) {
  return issue.repository === repository ? `#${issue.number}` : issue.key;
}

function parseAllOpenIssues(issues, maxDependencies) {
  const parsed = new Map();
  for (const issue of issues.values()) {
    if (issue.state !== "open" || issue.isPullRequest || !issue.stable) continue;
    try {
      parsed.set(
        issue.key,
        parseBacklogDependencies(issue.body, {
          repository: issue.repository,
          issueNumber: issue.number,
          maxDependencies,
        }),
      );
    } catch (error) {
      if (!(error instanceof BacklogDependencyError)) throw error;
      parsed.set(issue.key, error);
    }
  }
  return parsed;
}

function findReachableCycle(startKey, issues, parsed) {
  const completed = new Set();
  const active = [];
  const activeIndexes = new Map();

  function visit(key) {
    const activeIndex = activeIndexes.get(key);
    if (activeIndex !== undefined) return [...active.slice(activeIndex), key];
    if (completed.has(key)) return null;

    const issue = issues.get(key);
    if (!issue || issue.state !== "open" || issue.isPullRequest || !issue.stable) {
      completed.add(key);
      return null;
    }
    const specification = parsed.get(key);
    if (specification instanceof BacklogDependencyError) {
      if (specification.code === "self-cycle") return [key, key];
      completed.add(key);
      return null;
    }
    if (!specification || specification.mode !== "automatic") {
      completed.add(key);
      return null;
    }

    activeIndexes.set(key, active.length);
    active.push(key);
    for (const dependency of specification.dependencies) {
      const cycle = visit(dependency.key);
      if (cycle) return cycle;
    }
    active.pop();
    activeIndexes.delete(key);
    completed.add(key);
    return null;
  }

  return visit(startKey);
}

function disposition(issue, kind, reason, dependencies = [], proposedLabels = null) {
  return {
    issue: displayReference(issue, issue.repository),
    repository: issue.repository,
    number: issue.number,
    kind,
    reason,
    dependencies,
    proposedLabels,
  };
}

function dependencyStates(specification, issues, unavailable, repository) {
  return specification.dependencies.map((dependency) => {
    const inaccessibleReason = unavailable.get(dependency.key);
    if (inaccessibleReason) {
      return { reference: dependency.reference, state: "inaccessible", reason: inaccessibleReason };
    }
    const issue = issues.get(dependency.key);
    if (!issue) {
      return { reference: dependency.reference, state: "inaccessible", reason: "issue metadata was not returned" };
    }
    if (!issue.stable) {
      return { reference: dependency.reference, state: "drift", reason: issue.driftReason };
    }
    if (issue.isPullRequest) {
      return { reference: dependency.reference, state: "pull-request", reason: "reference resolves to a pull request" };
    }
    return { reference: displayReference(issue, repository), state: issue.state };
  });
}

function planTarget(issue, issues, parsed, unavailable) {
  if (!issue.stable) return disposition(issue, "drift", issue.driftReason);
  if (issue.state !== "open" || issue.isPullRequest) {
    return disposition(issue, "malformed", "Reconciliation targets must be open issues, not pull requests.");
  }

  const specification = parsed.get(issue.key);
  if (specification instanceof BacklogDependencyError) {
    if (specification.code === "missing-dependency-section") {
      return disposition(issue, "missing", specification.message);
    }
    if (specification.code === "self-cycle") return disposition(issue, "cycle", specification.message);
    return disposition(issue, "malformed", `${specification.code}: ${specification.message}`);
  }
  if (!specification) return disposition(issue, "missing", "Dependency metadata was not parsed.");
  if (specification.mode === "manual") {
    return disposition(issue, "manual", specification.reason);
  }

  const blocked = issue.labels.includes("blocked");
  const ready = issue.labels.includes("ready-to-start");
  if (blocked === ready) {
    return disposition(issue, "malformed", "Automatic issues must carry exactly one of `blocked` or `ready-to-start`.");
  }

  const dependencies = dependencyStates(specification, issues, unavailable, issue.repository);
  const inaccessible = dependencies.find(({ state }) => state === "inaccessible");
  if (inaccessible) {
    return disposition(
      issue,
      "inaccessible",
      `${inaccessible.reference} is inaccessible: ${inaccessible.reason}`,
      dependencies,
    );
  }
  const drift = dependencies.find(({ state }) => state === "drift");
  if (drift) {
    return disposition(issue, "drift", `${drift.reference} changed during the double-read.`, dependencies);
  }
  const pullRequest = dependencies.find(({ state }) => state === "pull-request");
  if (pullRequest) {
    return disposition(
      issue,
      "malformed",
      `${pullRequest.reference} resolves to a pull request, not an issue.`,
      dependencies,
    );
  }

  const cycle = findReachableCycle(issue.key, issues, parsed);
  if (cycle) {
    return disposition(issue, "cycle", `Dependency cycle: ${cycle.join(" -> ")}.`, dependencies);
  }

  const openDependencies = dependencies.filter(({ state }) => state === "open");
  if (openDependencies.length > 0) {
    const reason = `Open dependencies: ${openDependencies.map(({ reference }) => reference).join(", ")}.`;
    if (blocked) return disposition(issue, "unchanged-blocked", reason, dependencies);
    return disposition(issue, "ready-to-blocked", reason, dependencies, {
      remove: ["ready-to-start"],
      add: ["blocked"],
    });
  }

  if (blocked) {
    return disposition(issue, "blocked-to-ready", "Every exact dependency is closed.", dependencies, {
      remove: ["blocked"],
      add: ["ready-to-start"],
    });
  }
  return disposition(issue, "unchanged-ready", "Every exact dependency is closed.", dependencies);
}

/** Build a deterministic, side-effect-free label reconciliation plan. */
export function planBacklogReconciliation(
  { repository, issues: rawIssues, unavailable: rawUnavailable },
  { maxDependencies = DEFAULT_MAX_DEPENDENCIES_PER_ISSUE } = {},
) {
  const normalizedRepository = normalizeRepository(repository);
  if (!Array.isArray(rawIssues)) fail("invalid-issue-metadata", "Issue metadata must be an array.");
  const issues = new Map();
  for (const rawIssue of rawIssues) {
    const issue = normalizeIssueSnapshot(rawIssue);
    if (issues.has(issue.key)) fail("duplicate-issue-metadata", `Issue metadata duplicates ${issue.key}.`);
    issues.set(issue.key, issue);
  }
  const unavailable = normalizeUnavailable(rawUnavailable);
  const parsed = parseAllOpenIssues(issues, maxDependencies);
  const targets = [...issues.values()]
    .filter((issue) => issue.target && issue.repository === normalizedRepository)
    .sort((left, right) => left.number - right.number);
  const dispositions = targets.map((issue) => planTarget(issue, issues, parsed, unavailable));
  const counts = Object.fromEntries(RECONCILIATION_KINDS.map((kind) => [kind, 0]));
  for (const item of dispositions) counts[item.kind] += 1;

  return {
    schemaVersion: 1,
    mode: "dry-run",
    repository: normalizedRepository,
    mutationsPerformed: false,
    targetCount: targets.length,
    metadataIssueCount: issues.size,
    counts,
    dispositions,
  };
}
