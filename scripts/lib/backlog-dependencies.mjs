const DEPENDENCY_HEADING = "## Backlog Dependencies";
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}(?![\s\S])/u;
const SAME_REPOSITORY_REFERENCE_PATTERN = /^#([1-9][0-9]*)(?![\s\S])/u;
const CROSS_REPOSITORY_REFERENCE_PATTERN = /^([A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100})#([1-9][0-9]*)(?![\s\S])/u;
const MAX_MANUAL_REASON_LENGTH = 240;
export const MAX_BACKLOG_ISSUE_BODY_LENGTH = 100_000;
export const DEFAULT_MAX_BACKLOG_ISSUES = 200;
export const MAX_SUPPORTED_BACKLOG_ISSUES = 1_000;
const MAX_SUPPORTED_DEPENDENCIES = 100;
const MAX_ISSUE_LABELS = 100;
const MAX_ISSUE_LABEL_LENGTH = 100;
const UNSAFE_MANUAL_REASON_PATTERN = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
const UNSAFE_LABEL_PATTERN = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
const FIXED_DRIFT_REASON = "Issue metadata changed during the required double-read.";

const BACKLOG_ERROR_MESSAGES = Object.freeze({
  "body-bound-exceeded": "Issue body exceeds the parser bound.",
  "duplicate-dependency": "A dependency is declared more than once.",
  "duplicate-dependency-section": "Issue body contains more than one dependency section.",
  "duplicate-issue-metadata": "Issue metadata contains a duplicate issue.",
  "duplicate-unavailable-metadata": "Unavailable metadata contains a duplicate issue.",
  "empty-dependency-section": "The dependency section must not be empty.",
  "epic-requires-manual": "Specifica epics must use the validated manual opt-out.",
  "invalid-specifica-type": "Automatic mode requires exactly one canonical Type: Feature Specifica declaration.",
  "invalid-dependency-bound": "The dependency bound is invalid.",
  "invalid-dependency-mode": "Dependency mode must be exactly automatic or manual.",
  "invalid-issue-labels": "Issue label metadata is invalid.",
  "invalid-issue-body": "Issue body metadata is invalid.",
  "invalid-issue-bound": "The issue metadata bound is invalid.",
  "invalid-issue-flags": "Issue boolean metadata is invalid.",
  "invalid-issue-metadata": "Issue metadata is invalid.",
  "invalid-issue-number": "Issue number must be a positive safe integer.",
  "invalid-issue-state": "Issue state metadata is invalid.",
  "invalid-planner-input": "Planner input metadata is invalid.",
  "invalid-planner-options": "Planner options are invalid.",
  "invalid-repository": "Repository must be a valid owner/name pair.",
  "invalid-unavailable-metadata": "Unavailable metadata must be an array.",
  "issue-bound-exceeded": "Issue metadata exceeds the configured bound.",
  "malformed-dependency": "A dependency must be exactly #N or owner/repo#N.",
  "malformed-dependency-list": "Automatic mode requires an exact bounded dependency list.",
  "malformed-dependency-section": "The dependency section contains invalid blank lines.",
  "malformed-manual-opt-out": "Manual mode requires exactly one validated reason line.",
  "malformed-manual-reason": "Manual reason is invalid.",
  "missing-body": "Issue body is required.",
  "missing-dependency-section": "Issue body does not contain the exact dependency section.",
  "self-cycle": "An issue cannot depend on itself.",
  "too-many-dependencies": "Issue declares too many dependencies.",
  "unavailable-overlaps-issue": "Unavailable metadata overlaps readable issue metadata.",
});

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
  constructor(code) {
    const knownCode = Object.hasOwn(BACKLOG_ERROR_MESSAGES, code) ? code : "backlog-error";
    super(BACKLOG_ERROR_MESSAGES[knownCode] ?? "Backlog dependency metadata is invalid.");
    this.name = "BacklogDependencyError";
    this.code = knownCode;
  }
}

function fail(code) {
  throw new BacklogDependencyError(code);
}

export function normalizeRepository(value) {
  if (typeof value !== "string") fail("invalid-repository");
  const repository = value;
  if (!REPOSITORY_PATTERN.test(repository)) {
    fail("invalid-repository");
  }
  if (repository.split("/").some((segment) => segment === "." || segment === "..")) {
    fail("invalid-repository");
  }
  return repository.toLowerCase();
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function backlogIssueKey(repository, number) {
  const normalizedRepository = normalizeRepository(repository);
  if (!Number.isSafeInteger(number) || number <= 0) {
    fail("invalid-issue-number");
  }
  return `${normalizedRepository}#${number}`;
}

function parseIssueNumber(value) {
  const number = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(number) || number <= 0) {
    fail("malformed-dependency");
  }
  return number;
}

function dependencyReference(value, repository) {
  const sameRepository = SAME_REPOSITORY_REFERENCE_PATTERN.exec(value);
  if (sameRepository) {
    const number = parseIssueNumber(sameRepository[1]);
    return {
      repository,
      number,
      key: backlogIssueKey(repository, number),
      reference: `#${number}`,
    };
  }

  const crossRepository = CROSS_REPOSITORY_REFERENCE_PATTERN.exec(value);
  if (!crossRepository) {
    fail("malformed-dependency");
  }
  const dependencyRepository = normalizeRepository(crossRepository[1]);
  const number = parseIssueNumber(crossRepository[2]);
  return {
    repository: dependencyRepository,
    number,
    key: backlogIssueKey(dependencyRepository, number),
    reference: dependencyRepository === repository ? `#${number}` : `${dependencyRepository}#${number}`,
  };
}

function openingFence(line) {
  const match = /^ {0,3}(`{3,}|~{3,})(.*)$/u.exec(line);
  if (!match || (match[1][0] === "`" && match[2].includes("`"))) return null;
  return { marker: match[1][0], length: match[1].length };
}

function isClosingFence(line, fence) {
  const match = /^ {0,3}(`+|~+)[\t ]*$/u.exec(line);
  return Boolean(match && match[1][0] === fence.marker && match[1].length >= fence.length);
}

function updateHtmlCommentState(line, initialState) {
  let inComment = initialState;
  let offset = 0;
  while (offset < line.length) {
    if (inComment) {
      const end = line.indexOf("-->", offset);
      if (end < 0) return true;
      inComment = false;
      offset = end + 3;
      continue;
    }
    const start = line.indexOf("<!--", offset);
    if (start < 0) return false;
    inComment = true;
    offset = start + 4;
  }
  return inComment;
}

function openingRawHtmlBlock(line) {
  const prefix = /^ {0,3}<(.*)$/u.exec(line)?.[1];
  if (!prefix) return null;

  const rawText = /^(pre|script|style|textarea)(?:[\t />]|$)/iu.exec(prefix);
  if (rawText) {
    return { kind: "terminator", terminator: new RegExp(`</${rawText[1]}[\\t ]*>`, "iu") };
  }
  if (prefix.startsWith("?")) return { kind: "terminator", terminator: /\?>/u };
  if (prefix.startsWith("![CDATA[")) return { kind: "terminator", terminator: /\]\]>/u };
  if (/^![A-Z]/u.test(prefix)) return { kind: "terminator", terminator: />/u };

  // Be conservative for standard and custom HTML tags, including malformed or
  // attribute-heavy candidates: an uncertain container must never admit work.
  if (/^\/?[A-Za-z][A-Za-z0-9-]*(?:[\t />]|$)/u.test(prefix)) {
    return { kind: "blank-line" };
  }
  return null;
}

function advanceRawHtmlBlock(line, block) {
  if (block.kind === "blank-line") return line.trim() === "" ? null : block;
  return block.terminator.test(line) ? null : block;
}

/** Return lines whose first character is visible Markdown, outside bounded lexical containers. */
function visibleMarkdownLineIndexes(lines) {
  const indexes = [];
  let fence = null;
  let inHtmlComment = false;
  let rawHtmlBlock = null;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (fence) {
      if (isClosingFence(line, fence)) fence = null;
      continue;
    }
    if (rawHtmlBlock) {
      rawHtmlBlock = advanceRawHtmlBlock(line, rawHtmlBlock);
      continue;
    }
    if (inHtmlComment) {
      inHtmlComment = updateHtmlCommentState(line, true);
      continue;
    }
    const nextFence = openingFence(line);
    if (nextFence) {
      fence = nextFence;
      continue;
    }
    const nextRawHtmlBlock = openingRawHtmlBlock(line);
    if (nextRawHtmlBlock) {
      rawHtmlBlock = advanceRawHtmlBlock(line, nextRawHtmlBlock);
      continue;
    }
    indexes.push(index);
    inHtmlComment = updateHtmlCommentState(line, false);
  }
  return indexes;
}

function secondLevelHeadingIndexes(lines) {
  return visibleMarkdownLineIndexes(lines).filter((index) => /^##(?:[\t ]|$)/u.test(lines[index]));
}

function dependencySectionLines(body) {
  if (typeof body !== "string") fail("missing-body");
  if (body.length > MAX_BACKLOG_ISSUE_BODY_LENGTH) {
    fail("body-bound-exceeded");
  }
  const lines = body.replace(/\r\n?/gu, "\n").split("\n");
  const headings = secondLevelHeadingIndexes(lines);
  const matches = headings.filter((index) => lines[index] === DEPENDENCY_HEADING);
  if (matches.length === 0) {
    fail("missing-dependency-section");
  }
  if (matches.length > 1) {
    fail("duplicate-dependency-section");
  }

  const start = matches[0];
  const end = headings.find((index) => index > start) ?? lines.length;
  const section = lines.slice(start + 1, end);
  while (section.length > 0 && section[0] === "") section.shift();
  while (section.length > 0 && section.at(-1) === "") section.pop();
  if (section.length === 0) fail("empty-dependency-section");
  if (section.some((line) => line === "")) {
    fail("malformed-dependency-section");
  }
  return section;
}

function issueIsEpic(body) {
  const lines = body.replace(/\r\n?/gu, "\n").split("\n");
  return visibleMarkdownLineIndexes(lines).some((index) => /^[\t ]*Type:[\t ]*Epic[\t ]*$/iu.test(lines[index]));
}

function issueHasCanonicalFeatureType(body) {
  const lines = body.replace(/\r\n?/gu, "\n").split("\n");
  const headings = secondLevelHeadingIndexes(lines);
  const specificaHeadings = headings.filter((index) => lines[index] === "## Specifica");
  if (specificaHeadings.length !== 1) return false;

  const start = specificaHeadings[0];
  const end = headings.find((index) => index > start) ?? lines.length;
  const visible = new Set(visibleMarkdownLineIndexes(lines));
  const typeLines = lines
    .map((line, index) => ({ line, index }))
    .filter(({ line, index }) => index > start && index < end && visible.has(index) && /^[\t ]*Type:/iu.test(line));
  return typeLines.length === 1 && typeLines[0].line === "Type: Feature";
}

/** Parse the exact, bounded dependency section from an issue body. */
export function parseBacklogDependencies(
  body,
  { repository, issueNumber, maxDependencies = DEFAULT_MAX_DEPENDENCIES_PER_ISSUE },
) {
  const normalizedRepository = normalizeRepository(repository);
  if (!Number.isSafeInteger(issueNumber) || issueNumber <= 0) {
    fail("invalid-issue-number");
  }
  if (!Number.isSafeInteger(maxDependencies) || maxDependencies <= 0 || maxDependencies > MAX_SUPPORTED_DEPENDENCIES) {
    fail("invalid-dependency-bound");
  }

  const lines = dependencySectionLines(body);
  const mode = lines[0];
  if (mode === "Mode: manual") {
    if (lines.length !== 2 || !lines[1].startsWith("Reason: ")) {
      fail("malformed-manual-opt-out");
    }
    const reason = lines[1].slice("Reason: ".length);
    if (
      reason !== reason.trim() ||
      reason.length === 0 ||
      reason.length > MAX_MANUAL_REASON_LENGTH ||
      UNSAFE_MANUAL_REASON_PATTERN.test(reason)
    ) {
      fail("malformed-manual-reason");
    }
    return { mode: "manual", dependencies: [] };
  }

  if (mode !== "Mode: automatic") {
    fail("invalid-dependency-mode");
  }
  if (issueIsEpic(body)) {
    fail("epic-requires-manual");
  }
  if (!issueHasCanonicalFeatureType(body)) {
    fail("invalid-specifica-type");
  }

  if (lines.length === 2 && lines[1] === "Dependencies: none") {
    return { mode: "automatic", dependencies: [] };
  }
  if (lines[1] !== "Dependencies:" || lines.length < 3) {
    fail("malformed-dependency-list");
  }
  const dependencyLines = lines.slice(2);
  if (dependencyLines.length > maxDependencies) {
    fail("too-many-dependencies");
  }

  const ownerKey = backlogIssueKey(normalizedRepository, issueNumber);
  const seen = new Set();
  const dependencies = dependencyLines.map((line) => {
    if (!line.startsWith("- ")) {
      fail("malformed-dependency");
    }
    const dependency = dependencyReference(line.slice(2), normalizedRepository);
    if (dependency.key === ownerKey) {
      fail("self-cycle");
    }
    if (seen.has(dependency.key)) {
      fail("duplicate-dependency");
    }
    seen.add(dependency.key);
    return dependency;
  });

  dependencies.sort((left, right) => compareText(left.key, right.key));
  return { mode: "automatic", dependencies };
}

function ownDataProperty(value, key, errorCode = "invalid-issue-metadata") {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor && !("value" in descriptor)) fail(errorCode);
  return descriptor?.value;
}

function optionalBoolean(value, fallback) {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") fail("invalid-issue-flags");
  return value;
}

function normalizedIssueLabels(value) {
  if (!Array.isArray(value) || value.length > MAX_ISSUE_LABELS) fail("invalid-issue-labels");
  const labels = [];
  const seen = new Set();
  for (let index = 0; index < value.length; index += 1) {
    const label = ownDataProperty(value, String(index));
    if (
      typeof label !== "string" ||
      label.length === 0 ||
      label.length > MAX_ISSUE_LABEL_LENGTH ||
      UNSAFE_LABEL_PATTERN.test(label) ||
      seen.has(label)
    ) {
      fail("invalid-issue-labels");
    }
    seen.add(label);
    labels.push(label);
  }
  return labels.sort(compareText);
}

function normalizeIssueSnapshotUnsafe(issue) {
  if (issue === null || typeof issue !== "object" || Array.isArray(issue)) fail("invalid-issue-metadata");
  const repository = normalizeRepository(ownDataProperty(issue, "repository"));
  const number = ownDataProperty(issue, "number");
  const key = backlogIssueKey(repository, number);
  const state = ownDataProperty(issue, "state");
  if (state !== "open" && state !== "closed") {
    fail("invalid-issue-state");
  }
  const bodyValue = ownDataProperty(issue, "body");
  const body = bodyValue === undefined || bodyValue === null ? "" : bodyValue;
  if (typeof body !== "string") fail("invalid-issue-body");
  return {
    repository,
    number,
    key,
    state,
    body,
    labels: normalizedIssueLabels(ownDataProperty(issue, "labels")),
    isPullRequest: optionalBoolean(ownDataProperty(issue, "isPullRequest"), false),
    stable: optionalBoolean(ownDataProperty(issue, "stable"), true),
    driftReason: FIXED_DRIFT_REASON,
    target: optionalBoolean(ownDataProperty(issue, "target"), false),
  };
}

function normalizeIssueSnapshot(issue) {
  try {
    return normalizeIssueSnapshotUnsafe(issue);
  } catch (error) {
    if (error instanceof BacklogDependencyError) throw error;
    fail("invalid-issue-metadata");
  }
}

function normalizeUnavailable(unavailable, maxIssues) {
  if (unavailable === undefined) return new Map();
  if (!Array.isArray(unavailable)) fail("invalid-unavailable-metadata");
  if (unavailable.length > maxIssues) fail("issue-bound-exceeded");
  const result = new Map();
  for (let index = 0; index < unavailable.length; index += 1) {
    const entry = ownDataProperty(unavailable, String(index), "invalid-unavailable-metadata");
    let key;
    try {
      if (entry === null || typeof entry !== "object" || Array.isArray(entry)) fail("invalid-unavailable-metadata");
      key = backlogIssueKey(
        ownDataProperty(entry, "repository", "invalid-unavailable-metadata"),
        ownDataProperty(entry, "number", "invalid-unavailable-metadata"),
      );
    } catch {
      fail("invalid-unavailable-metadata");
    }
    if (result.has(key)) fail("duplicate-unavailable-metadata");
    result.set(key, true);
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
    if (unavailable.has(dependency.key)) {
      return { reference: dependency.reference, state: "inaccessible" };
    }
    const issue = issues.get(dependency.key);
    if (!issue) {
      return { reference: dependency.reference, state: "inaccessible" };
    }
    if (!issue.stable) {
      return { reference: dependency.reference, state: "drift" };
    }
    if (issue.isPullRequest) {
      return { reference: dependency.reference, state: "pull-request" };
    }
    return { reference: displayReference(issue, repository), state: issue.state };
  });
}

function blockReadyIssue(issue) {
  const blocked = issue.labels.includes("blocked");
  const ready = issue.labels.includes("ready-to-start");
  if (blocked || !ready) return null;
  return { remove: ["ready-to-start"], add: ["blocked"] };
}

function planTarget(issue, issues, parsed, unavailable) {
  if (!issue.stable) return disposition(issue, "drift", FIXED_DRIFT_REASON);
  if (issue.state !== "open" || issue.isPullRequest) {
    return disposition(issue, "malformed", "Reconciliation targets must be open issues, not pull requests.");
  }

  const specification = parsed.get(issue.key);
  if (specification instanceof BacklogDependencyError) {
    if (specification.code === "missing-dependency-section") {
      return disposition(issue, "missing", specification.message);
    }
    if (specification.code === "self-cycle") {
      return disposition(issue, "cycle", specification.message, [], blockReadyIssue(issue));
    }
    return disposition(issue, "malformed", `${specification.code}: ${specification.message}`);
  }
  if (!specification) return disposition(issue, "missing", "Dependency metadata was not parsed.");
  if (specification.mode === "manual") {
    return disposition(issue, "manual", "Manual dependency reconciliation is enabled.");
  }

  const blocked = issue.labels.includes("blocked");
  const ready = issue.labels.includes("ready-to-start");
  if (blocked === ready) {
    return disposition(issue, "malformed", "Automatic issues must carry exactly one of `blocked` or `ready-to-start`.");
  }

  const dependencies = dependencyStates(specification, issues, unavailable, issue.repository);
  const drift = dependencies.find(({ state }) => state === "drift");
  if (drift) {
    return disposition(issue, "drift", FIXED_DRIFT_REASON, dependencies);
  }
  const inaccessible = dependencies.find(({ state }) => state === "inaccessible");
  if (inaccessible) {
    return disposition(
      issue,
      "inaccessible",
      "At least one exact dependency is inaccessible.",
      dependencies,
      blockReadyIssue(issue),
    );
  }
  const pullRequest = dependencies.find(({ state }) => state === "pull-request");
  if (pullRequest) {
    return disposition(
      issue,
      "malformed",
      "An exact dependency resolves to a pull request, not an issue.",
      dependencies,
      blockReadyIssue(issue),
    );
  }

  const cycle = findReachableCycle(issue.key, issues, parsed);
  if (cycle) {
    return disposition(issue, "cycle", "A dependency cycle was detected.", dependencies, blockReadyIssue(issue));
  }

  const openDependencies = dependencies.filter(({ state }) => state === "open");
  if (openDependencies.length > 0) {
    const reason = "At least one exact dependency remains open.";
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
export function planBacklogReconciliation(input, options = {}) {
  if (input === null || typeof input !== "object" || Array.isArray(input)) fail("invalid-planner-input");
  if (options === null || typeof options !== "object" || Array.isArray(options)) fail("invalid-planner-options");
  const repository = ownDataProperty(input, "repository", "invalid-planner-input");
  const rawIssues = ownDataProperty(input, "issues", "invalid-planner-input");
  const rawUnavailable = ownDataProperty(input, "unavailable", "invalid-planner-input");
  const maxDependenciesValue = ownDataProperty(options, "maxDependencies", "invalid-planner-options");
  const maxDependencies =
    maxDependenciesValue === undefined ? DEFAULT_MAX_DEPENDENCIES_PER_ISSUE : maxDependenciesValue;
  const maxIssuesValue = ownDataProperty(options, "maxIssues", "invalid-planner-options");
  const maxIssues = maxIssuesValue === undefined ? DEFAULT_MAX_BACKLOG_ISSUES : maxIssuesValue;
  const normalizedRepository = normalizeRepository(repository);
  if (!Array.isArray(rawIssues)) fail("invalid-issue-metadata");
  if (!Number.isSafeInteger(maxDependencies) || maxDependencies <= 0 || maxDependencies > MAX_SUPPORTED_DEPENDENCIES) {
    fail("invalid-dependency-bound");
  }
  if (!Number.isSafeInteger(maxIssues) || maxIssues <= 0 || maxIssues > MAX_SUPPORTED_BACKLOG_ISSUES) {
    fail("invalid-issue-bound");
  }
  if (rawIssues.length > maxIssues) fail("issue-bound-exceeded");
  const issues = new Map();
  for (let index = 0; index < rawIssues.length; index += 1) {
    const rawIssue = ownDataProperty(rawIssues, String(index));
    const issue = normalizeIssueSnapshot(rawIssue);
    if (issues.has(issue.key)) fail("duplicate-issue-metadata");
    issues.set(issue.key, issue);
  }
  const unavailable = normalizeUnavailable(rawUnavailable, maxIssues);
  if (issues.size + unavailable.size > maxIssues) fail("issue-bound-exceeded");
  for (const key of unavailable.keys()) {
    if (issues.has(key)) fail("unavailable-overlaps-issue");
  }
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
