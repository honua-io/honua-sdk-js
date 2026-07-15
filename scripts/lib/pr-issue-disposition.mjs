const CLOSE_FOOTER_PATTERN = /^Closes #([1-9][0-9]*)$/u;
const REFERENCE_FOOTER_PATTERN = /^Refs #([1-9][0-9]*) \(([^()\r\n]+)\)$/u;
const CLOSING_KEYWORD_PATTERN =
  /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s*:?\s*(?:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)?#[1-9][0-9]*\b/iu;
const REFERENCE_DISPOSITION_PATTERN =
  /\brefs\s*:?\s*(?:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)?#[1-9][0-9]*\b/iu;
const PARTIAL_EXPLANATION_PATTERN =
  /(?:\bS[1-9][0-9]*\b|\bslice\b|\bpartial\b|\bremain(?:s|ing)?\b|\bfollow[- ]?up\b|\bblocked\b|\bhandoff\b)/iu;
const MAX_DISPOSITIONS = 20;
const MAX_EXPLANATION_LENGTH = 160;

export class PullRequestDispositionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "PullRequestDispositionError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new PullRequestDispositionError(code, message);
}

function normalizeLogin(value) {
  return String(value ?? "").toLowerCase();
}

/** Return the only automation exemptions allowed by repository policy. */
export function automationExemption(input) {
  const { authorLogin, headRefName, title } = input;
  const login = normalizeLogin(authorLogin);
  const authorType = String(input.authorType ?? "");
  const head = String(headRefName ?? "");
  const pullRequestTitle = String(title ?? "");
  const botActor = authorType === "Bot";

  if (
    botActor &&
    (login === "dependabot" || login === "dependabot[bot]" || login === "app/dependabot") &&
    head.startsWith("dependabot/")
  ) {
    return "Dependabot dependency update";
  }
  if (
    botActor &&
    (login === "github-actions" || login === "github-actions[bot]" || login === "app/github-actions") &&
    head.startsWith("release-please--branches--") &&
    /^chore: release(?:\s|$)/u.test(pullRequestTitle)
  ) {
    return "Release Please automation";
  }
  return null;
}

function parseFooterLine(line) {
  const close = CLOSE_FOOTER_PATTERN.exec(line);
  if (close) {
    return { mode: "closes", issueNumber: Number.parseInt(close[1], 10) };
  }

  const reference = REFERENCE_FOOTER_PATTERN.exec(line);
  if (!reference) return null;
  const explanation = reference[2];
  const nestedReference = explanation.match(REFERENCE_DISPOSITION_PATTERN)?.[0];
  if (nestedReference) {
    fail(
      "nested-reference",
      `Reference ${JSON.stringify(nestedReference)} must be its own line in the final disposition block.`,
    );
  }
  const ambiguousClosingKeyword = explanation.match(CLOSING_KEYWORD_PATTERN)?.[0];
  if (ambiguousClosingKeyword) {
    fail(
      "ambiguous-closing-keyword",
      `Closing keyword ${JSON.stringify(ambiguousClosingKeyword)} appears inside a Refs explanation.`,
    );
  }
  if (
    explanation !== explanation.trim() ||
    explanation.length > MAX_EXPLANATION_LENGTH ||
    !PARTIAL_EXPLANATION_PATTERN.test(explanation)
  ) {
    fail(
      "invalid-reference-explanation",
      `Refs #${reference[1]} must include a bounded slice or remaining-work explanation, for example ` +
        '`Refs #550 (S2; S3 remains)`.',
    );
  }
  return {
    mode: "refs",
    issueNumber: Number.parseInt(reference[1], 10),
    explanation,
  };
}

/** Parse an exact, contiguous disposition footer from the end of a PR body. */
export function parsePullRequestDisposition(body) {
  if (typeof body !== "string") {
    fail("missing-body", "Pull request body is required.");
  }

  const lines = body.replace(/\r\n?/gu, "\n").split("\n");
  while (lines.length > 0 && lines.at(-1).trim() === "") lines.pop();

  const dispositions = [];
  while (lines.length > 0) {
    const parsed = parseFooterLine(lines.at(-1));
    if (!parsed) break;
    dispositions.unshift(parsed);
    lines.pop();
  }

  if (dispositions.length === 0) {
    fail(
      "missing-footer",
      "The final nonblank line must be `Closes #N` for completed work or " +
        "`Refs #N (Sx; remaining work)` for a partial slice.",
    );
  }
  if (dispositions.length > MAX_DISPOSITIONS) {
    fail("too-many-dispositions", `A pull request may declare at most ${MAX_DISPOSITIONS} issue dispositions.`);
  }

  const seen = new Map();
  for (const disposition of dispositions) {
    const prior = seen.get(disposition.issueNumber);
    if (prior) {
      fail(
        "duplicate-disposition",
        `Issue #${disposition.issueNumber} is declared more than once (${prior} and ${disposition.mode}).`,
      );
    }
    seen.set(disposition.issueNumber, disposition.mode);
  }

  const prose = lines.join("\n");
  const misplacedReference = prose.match(REFERENCE_DISPOSITION_PATTERN)?.[0];
  if (misplacedReference) {
    fail(
      "misplaced-reference",
      `Reference ${JSON.stringify(misplacedReference)} is malformed or outside the final disposition block.`,
    );
  }
  const ambiguousClosingKeyword = prose.match(CLOSING_KEYWORD_PATTERN)?.[0];
  if (ambiguousClosingKeyword) {
    fail(
      "ambiguous-closing-keyword",
      `Closing keyword ${JSON.stringify(ambiguousClosingKeyword)} appears outside the exact footer. ` +
        "Use neutral prose and keep closure intent only in a final `Closes #N` line.",
    );
  }

  return dispositions;
}

function normalizeIssueMetadata(issues, repository) {
  if (!Array.isArray(issues)) fail("missing-issue-metadata", "Issue metadata is required for every disposition.");
  const byNumber = new Map();
  for (const issue of issues) {
    if (!Number.isSafeInteger(issue?.number) || issue.number <= 0) {
      fail("invalid-issue-metadata", "Issue metadata contains an invalid issue number.");
    }
    if (byNumber.has(issue.number)) {
      fail("invalid-issue-metadata", `Issue metadata contains duplicate issue #${issue.number}.`);
    }
    byNumber.set(issue.number, {
      ...issue,
      repository: String(issue.repository ?? repository),
      state: String(issue.state ?? "").toLowerCase(),
    });
  }
  return byNumber;
}

function normalizedNumberSet(values, label) {
  if (!Array.isArray(values)) fail("invalid-closing-metadata", `${label} must be an array.`);
  const result = new Set();
  for (const value of values) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      fail("invalid-closing-metadata", `${label} contains an invalid issue number.`);
    }
    result.add(value);
  }
  return result;
}

function sortedNumbers(values) {
  return [...values].sort((left, right) => left - right);
}

/**
 * Validate a parsed PR body against current same-repository issue metadata and
 * GitHub's own closingIssuesReferences interpretation.
 */
export function validatePullRequestDisposition(input) {
  const exemption = automationExemption(input);
  if (exemption) {
    return { status: "exempt", exemption, closes: [], refs: [] };
  }

  const repository = String(input.repository ?? "");
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository)) {
    fail("invalid-repository", "Repository must be an owner/name pair.");
  }

  const dispositions = parsePullRequestDisposition(input.body);
  const issueMetadata = normalizeIssueMetadata(input.issues, repository);
  const parsedClosing = normalizedNumberSet(input.closingIssueNumbers, "GitHub closing issue metadata");
  const declaredClosing = new Set();
  const declaredReferences = new Set();

  for (const disposition of dispositions) {
    const issue = issueMetadata.get(disposition.issueNumber);
    if (!issue) {
      fail(
        "missing-referenced-issue",
        `Issue #${disposition.issueNumber} was not returned by the ${repository} issue API.`,
      );
    }
    if (issue.repository !== repository) {
      fail(
        "cross-repository-issue",
        `Issue #${disposition.issueNumber} belongs to ${issue.repository}; dispositions must target ${repository}.`,
      );
    }
    if (issue.isPullRequest === true) {
      fail("pull-request-target", `#${disposition.issueNumber} is a pull request, not a backlog issue.`);
    }
    if (issue.state !== "open") {
      fail("closed-issue-target", `Issue #${disposition.issueNumber} is ${issue.state || "not open"}.`);
    }

    if (disposition.mode === "closes") declaredClosing.add(disposition.issueNumber);
    else declaredReferences.add(disposition.issueNumber);
  }

  const missingFromGitHub = sortedNumbers([...declaredClosing].filter((number) => !parsedClosing.has(number)));
  const unexpectedFromGitHub = sortedNumbers([...parsedClosing].filter((number) => !declaredClosing.has(number)));

  const accidentallyClosingReferences = sortedNumbers(
    [...declaredReferences].filter((number) => parsedClosing.has(number)),
  );
  if (accidentallyClosingReferences.length > 0) {
    fail(
      "reference-would-close",
      `Partial references would close ${accidentallyClosingReferences.map((n) => `#${n}`).join(", ")}.`,
    );
  }

  if (missingFromGitHub.length > 0 || unexpectedFromGitHub.length > 0) {
    const details = [];
    if (missingFromGitHub.length > 0) {
      details.push(`not parsed by GitHub: ${missingFromGitHub.map((n) => `#${n}`).join(", ")}`);
    }
    if (unexpectedFromGitHub.length > 0) {
      details.push(`unexpected GitHub closing references: ${unexpectedFromGitHub.map((n) => `#${n}`).join(", ")}`);
    }
    fail("github-closing-mismatch", `Declared closure does not match closingIssuesReferences (${details.join("; ")}).`);
  }

  return {
    status: "valid",
    exemption: null,
    closes: sortedNumbers(declaredClosing),
    refs: sortedNumbers(declaredReferences),
  };
}
