/**
 * Stranded-merge detection -- pure classification (schema version 2).
 *
 * A pull request opened against a *stack base* branch and merged into that base
 * is reported MERGED by GitHub even when the base branch itself never reaches
 * the default branch. The payload is then not in the product, CI was green, and
 * the tracking issue is often closed as resolved. Nothing signals the loss --
 * the failure is silent by construction.
 *
 * The cheap test is one command per merged pull request:
 *
 *   git merge-base --is-ancestor <mergeCommit> origin/<defaultBranch>
 *
 * That test is exact, and it is the wrong question to *stop* on. It compares
 * commit identity, and identity is not content: a squash merge, a cherry-pick,
 * or an independent re-implementation all put the payload on the default branch
 * under a different SHA and all read as "stranded". This repository is the proof
 * -- schema version 1 of this module reported honua-sdk-js#863 stranded on every
 * weekly run, while #863's payload had been on trunk since #921 four days after
 * the strand, in a stricter form. A detector that files "payload lost" on a
 * payload that is present gets muted, which reinstates the silence it exists to
 * break.
 *
 * So ancestry only nominates *candidates*, and every candidate is adjudicated by
 * content in three descending strengths of evidence:
 *
 *   1. Patch identity -- `git patch-id --stable` proves an equivalent patch is
 *      already on the default branch. Exact, and survives squash and cherry-pick.
 *   2. Blob equality -- the path's blob at the merge equals its blob on the
 *      default branch, so the content landed byte-identically whatever the SHA.
 *   3. Added-line presence -- the significant lines the pull request added to
 *      that path are looked for in the default branch's current version.
 *
 * Only (3) is a heuristic, and it is biased toward false-positives-that-say-so
 * over silent misses: a line moved to another file, or re-worded during a later
 * re-land, reads as missing. Hence the split between `stranded` (the file is
 * absent outright -- hard evidence) and `edits-missing` (the file is there but
 * the added lines are not -- strong, worth a human minute, not proof). Anything
 * that cannot be adjudicated at all is `indeterminate`, never quietly `landed`.
 *
 * This module is deliberately pure -- no `gh`, no `git`, no filesystem -- so the
 * whole classification is unit-testable without a network or a repository. The
 * live fact resolution lives in scripts/stranded-merge-detector.mjs.
 *
 * The classification vocabulary is kept identical to honua-server's
 * scripts/ci/detect-stranded-merges.py (also schema version 2) so the two
 * repositories publish one contract even while they carry two implementations
 * in two languages; honua-io/honua-sdk-js#1317 and honua-io/honua-server#3248
 * are the same failure.
 */

/** Bumped when the JSON contract changes. Consumers must branch on it. */
export const SCHEMA_VERSION = 2;

/** Bases that are expected not to survive, and so must not be reported. */
export const DEFAULT_TRANSIENT_BASE_PATTERNS = Object.freeze(["train/batch/*"]);

// Classifications for merged pull requests.
export const MERGED_ON_DEFAULT = "on-default-branch";
export const MERGED_LANDED = "landed";
export const MERGED_SUPERSEDED = "superseded";
export const MERGED_EDITS_MISSING = "edits-missing";
export const MERGED_STRANDED = "stranded";
export const MERGED_INDETERMINATE = "indeterminate";
export const MERGED_TRANSIENT_BASE = "transient-base";

// Classifications for open pull requests.
export const OPEN_ON_DEFAULT = "based-on-default-branch";
export const OPEN_LIVE_BASE = "stacked-live-base";
export const OPEN_UNKNOWN_BASE = "unknown-base";
export const OPEN_NEEDS_RETARGET = "needs-retarget";

/** Findings a human has to look at. Everything else is informational. */
export const ACTIONABLE_CLASSIFICATIONS = Object.freeze(
  new Set([MERGED_STRANDED, MERGED_EDITS_MISSING, MERGED_INDETERMINATE, OPEN_NEEDS_RETARGET]),
);

// Per-path verdicts.
export const PATH_IDENTICAL = "identical";
export const PATH_PATCH_LANDED = "patch-landed";
export const PATH_PRESENT = "present";
export const PATH_PARTIAL = "partial";
export const PATH_MISSING = "missing";
export const PATH_ABSENT = "absent";
export const PATH_INDETERMINATE = "indeterminate";
export const PATH_DELETION_PENDING = "deletion-not-applied";

/**
 * A line has to carry some information before its absence means anything.
 * Braces, `else`, and blank lines occur everywhere and would match by accident.
 */
export const MIN_SIGNIFICANT_LINE_LENGTH = 8;

/**
 * Per-path cap on how many distinct added lines are probed. Generated files can
 * add tens of thousands of lines and the verdict never changes after a few
 * hundred.
 */
export const MAX_PROBED_LINES = 400;

/**
 * Compiles a glob-ish base-branch pattern (`*` matches any run of characters,
 * including `/`) into an anchored matcher. Nothing else is special.
 */
function compileBasePattern(pattern) {
  if (typeof pattern !== "string" || pattern.length === 0) {
    throw new Error("base pattern must be a non-empty string");
  }
  // Split on the one metacharacter and escape each literal segment. A sentinel
  // substitution would be shorter but needs a character that cannot appear in a
  // branch name, and every such character is a control byte -- which would make
  // this file grep-invisible (see honua-io/honua-sdk-js#1332).
  const escaped = pattern
    .split("*")
    .map((segment) => segment.replace(/[.*+?^${}()|[\]\\]/gu, (character) => `\\${character}`))
    .join(".*");
  return new RegExp(`^${escaped}$`, "u");
}

export function matchesAnyBasePattern(baseRefName, patterns) {
  return patterns.some((pattern) => compileBasePattern(pattern).test(baseRefName));
}

function requireString(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

/**
 * Decodes a git-quoted path from a diff header.
 *
 * `core.quotepath=off` stops git quoting non-ASCII, but a path containing a
 * quote, a backslash or a control character is still C-quoted, so the decode has
 * to exist regardless: a path that fails to decode fails every blob lookup, and
 * an absent file would then be classified as landed.
 */
export function unquoteDiffPath(raw) {
  if (!(raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"'))) return raw;
  const body = raw.slice(1, -1);
  const simple = { n: 10, t: 9, r: 13, b: 8, f: 12, a: 7, v: 11, '"': 34, "\\": 92 };
  const bytes = [];
  let index = 0;
  while (index < body.length) {
    const character = body[index];
    if (character !== "\\") {
      for (const byte of Buffer.from(character, "utf8")) bytes.push(byte);
      index += 1;
      continue;
    }
    if (index + 1 >= body.length) break;
    const next = body[index + 1];
    if (next >= "0" && next <= "7") {
      bytes.push(Number.parseInt(body.slice(index + 1, index + 4), 8) & 0xff);
      index += 4;
    } else {
      bytes.push(simple[next] ?? next.charCodeAt(0));
      index += 2;
    }
  }
  return Buffer.from(bytes).toString("utf8");
}

/**
 * Added lines per post-image path from a unified diff, noise filtered out.
 *
 * Reads `+++ b/<path>` headers, so renames are attributed to the new path and
 * files the diff deletes (`+++ /dev/null`) contribute nothing.
 */
export function significantAddedLines(diffText) {
  const perPath = new Map();
  let current;
  for (const line of diffText.split("\n")) {
    if (line.startsWith("+++ ")) {
      const target = unquoteDiffPath(line.slice(4).trim());
      current = target === "/dev/null" ? undefined : target.startsWith("b/") ? target.slice(2) : target;
      if (current !== undefined && !perPath.has(current)) perPath.set(current, []);
      continue;
    }
    if (line.startsWith("---") || line.startsWith("@@") || line.startsWith("diff --git")) continue;
    if (current !== undefined && line.startsWith("+")) {
      const stripped = line.slice(1).trim();
      if (stripped.length >= MIN_SIGNIFICANT_LINE_LENGTH) perPath.get(current).push(stripped);
    }
  }
  return perPath;
}

/**
 * Adjudicates one path of a stranded candidate against the default branch.
 *
 * `headBlob` / `defaultBlob` are blob object ids, or `undefined` when the path
 * does not exist on that side. `patchLanded` means every payload commit touching
 * this path has an exact patch-id equivalent on the default branch -- proof, and
 * so checked before any heuristic.
 */
export function classifyPath({
  path,
  headBlob: rawHeadBlob,
  defaultBlob: rawDefaultBlob,
  addedLines = [],
  defaultText,
  touchedOnDefaultSinceMerge = false,
  patchLanded = false,
}) {
  // `?? undefined` on purpose: a JSON fixture spells "the path is not on this
  // side" as null, and a null blob id must not compare equal to a real one.
  const headBlob = rawHeadBlob ?? undefined;
  const defaultBlob = rawDefaultBlob ?? undefined;
  const probed = [...new Set(addedLines)].slice(0, MAX_PROBED_LINES);
  let found = 0;
  let verdict;

  if (headBlob === undefined) {
    // The pull request deleted the path. Absent downstream is the intended
    // outcome; still present means the deletion has not landed, which is not
    // lost work.
    verdict = defaultBlob === undefined ? PATH_IDENTICAL : PATH_DELETION_PENDING;
  } else if (defaultBlob === undefined) {
    verdict = PATH_ABSENT;
  } else if (defaultBlob === headBlob) {
    verdict = PATH_IDENTICAL;
  } else if (patchLanded) {
    verdict = PATH_PATCH_LANDED;
  } else if (probed.length === 0) {
    // Nothing was added, so there is no textual evidence either way (a pure
    // removal, or binary content). Say so rather than guess.
    verdict = PATH_INDETERMINATE;
  } else {
    const haystack = defaultText ?? "";
    found = probed.reduce((total, line) => total + (haystack.includes(line) ? 1 : 0), 0);
    verdict = found === probed.length ? PATH_PRESENT : found === 0 ? PATH_MISSING : PATH_PARTIAL;
  }

  const entry = { path, verdict };
  if (verdict === PATH_PARTIAL || verdict === PATH_MISSING) {
    entry.addedLinesProbed = probed.length;
    entry.addedLinesFound = found;
    // "The default branch moved past this" is only credible when the default
    // branch demonstrably has *part* of the change. A hot path that trunk
    // rewrites weekly must not launder a wholly absent edit into a
    // non-actionable finding, which a bare "touched since" test would do.
    entry.supersededOnDefault = touchedOnDefaultSinceMerge && found > 0;
  }
  return entry;
}

/**
 * Normalizes one `gh pr list --json` record. `mergeCommit` is an object in the
 * GitHub CLI's shape (`{ oid }`); a bare string is accepted so callers can hand
 * in fixtures without ceremony.
 */
export function normalizePullRequest(pullRequest) {
  const number = pullRequest?.number;
  if (!Number.isInteger(number) || number <= 0) {
    throw new Error("pull request number must be a positive integer");
  }
  const mergeCommit = pullRequest?.mergeCommit;
  const oid = typeof mergeCommit === "string" ? mergeCommit : mergeCommit?.oid;
  return {
    number,
    title: typeof pullRequest?.title === "string" ? pullRequest.title : "",
    baseRefName: requireString(pullRequest?.baseRefName, `pull request #${number} baseRefName`),
    headRefName: typeof pullRequest?.headRefName === "string" ? pullRequest.headRefName : "",
    mergeCommit: typeof oid === "string" && oid.length > 0 ? oid : undefined,
    mergedAt: typeof pullRequest?.mergedAt === "string" ? pullRequest.mergedAt : "",
    url: typeof pullRequest?.url === "string" ? pullRequest.url : "",
  };
}

/**
 * Classifies one merged pull request from already-resolved facts. Pure.
 *
 * `onDefaultBranch` is the ancestry answer: `true` when the merge commit is an
 * ancestor of the default branch tip, `false` when it is not, and `undefined`
 * when the object is not in the clone at all. Unknown is never reported as
 * landed -- the commonest cause is a stack base that was deleted or
 * force-pushed, which is exactly when payload goes missing.
 */
export function classifyMergedPullRequest(
  pullRequest,
  { onDefaultBranch, pathVerdicts = [], indeterminateReason, transientBase = false } = {},
) {
  const record = normalizePullRequest(pullRequest);
  const finding = {
    number: record.number,
    title: record.title,
    url: record.url,
    base: record.baseRefName,
    mergeCommit: record.mergeCommit,
    mergedAt: record.mergedAt,
  };

  if (record.mergeCommit === undefined) {
    // Squash and rebase landings still record a merge commit; a missing one
    // means the record is incomplete, not that the payload is fine.
    finding.classification = MERGED_INDETERMINATE;
    finding.reason = "no merge commit recorded on the pull request";
    return finding;
  }

  if (onDefaultBranch === true) {
    finding.classification = MERGED_ON_DEFAULT;
    return finding;
  }

  if (onDefaultBranch !== false) {
    finding.classification = MERGED_INDETERMINATE;
    finding.reason = `merge commit ${record.mergeCommit.slice(0, 9)} is not in this clone -- the stack base was probably deleted or force-pushed, so the payload cannot be checked`;
    return finding;
  }

  if (transientBase) {
    // A merge-train batch branch that has not yet fast-forwarded the default
    // branch. Expected to resolve on its own; surfaced but not failed on.
    finding.classification = MERGED_TRANSIENT_BASE;
    return finding;
  }

  if (indeterminateReason) {
    finding.classification = MERGED_INDETERMINATE;
    finding.reason = indeterminateReason;
    finding.paths = [...pathVerdicts];
    return finding;
  }

  const verdicts = [...pathVerdicts];
  finding.paths = verdicts;
  const absent = verdicts.filter((entry) => entry.verdict === PATH_ABSENT).map((entry) => entry.path);
  const lost = verdicts
    .filter(
      (entry) =>
        (entry.verdict === PATH_MISSING || entry.verdict === PATH_PARTIAL) && !entry.supersededOnDefault,
    )
    .map((entry) => entry.path);
  const movedOn = verdicts.filter(
    (entry) =>
      entry.verdict === PATH_MISSING ||
      entry.verdict === PATH_PARTIAL ||
      entry.verdict === PATH_INDETERMINATE,
  );

  finding.absentPaths = absent;
  finding.unlandedEditPaths = lost;

  if (absent.length > 0) finding.classification = MERGED_STRANDED;
  else if (lost.length > 0) finding.classification = MERGED_EDITS_MISSING;
  else if (movedOn.length > 0) finding.classification = MERGED_SUPERSEDED;
  else finding.classification = MERGED_LANDED;
  return finding;
}

/**
 * Classifies one open pull request from already-resolved facts. Pure.
 *
 * By the time the merged sweep fires, the work is already stranded. An open pull
 * request whose base branch has already been merged, or no longer exists, will
 * strand its payload the moment it merges, and the remedy is one command. That
 * turns the scheduled job from an autopsy into a warning.
 *
 * "Merged" is deliberately not "is an ancestor of the default branch": a freshly
 * created or freshly reset stack base points at a default-branch commit and is
 * an ancestor while being perfectly alive, and telling someone to detach a live
 * stack from it would be wrong.
 *
 * `undefined` for `baseExists` / `baseMerged` means "could not be established",
 * which is reported as such rather than assumed either way.
 */
export function classifyOpenPullRequest(
  pullRequest,
  {
    defaultBranch,
    baseExists,
    baseMerged,
    baseIsAncestor,
    transientBasePatterns = DEFAULT_TRANSIENT_BASE_PATTERNS,
  } = {},
) {
  requireString(defaultBranch, "defaultBranch");
  const record = normalizePullRequest(pullRequest);
  const finding = {
    number: record.number,
    title: record.title,
    url: record.url,
    base: record.baseRefName,
    baseExists,
    baseMerged,
  };

  if (record.baseRefName === defaultBranch || matchesAnyBasePattern(record.baseRefName, transientBasePatterns)) {
    finding.classification = OPEN_ON_DEFAULT;
    return finding;
  }

  // `== null` on purpose: JSON fixtures and the GitHub API both express "could
  // not be established" as null, and treating that as a resolved value is how a
  // live stack gets told to detach.
  if (baseExists == null) {
    finding.classification = OPEN_UNKNOWN_BASE;
    finding.reason = "base branch could not be resolved";
  } else if (baseExists === false) {
    finding.classification = OPEN_NEEDS_RETARGET;
    finding.reason = "base branch no longer exists";
  } else if (baseMerged == null) {
    finding.classification = OPEN_UNKNOWN_BASE;
    finding.reason = "could not establish whether the base branch has been merged";
  } else if (baseMerged) {
    finding.classification = OPEN_NEEDS_RETARGET;
    finding.reason = `base branch has already been merged into ${defaultBranch}`;
  } else {
    finding.classification = OPEN_LIVE_BASE;
    finding.reason = baseIsAncestor
      ? `base branch has no commits of its own beyond ${defaultBranch} yet; re-target once it lands`
      : "base branch is still open; re-target once it lands";
  }

  if (finding.classification === OPEN_NEEDS_RETARGET) {
    finding.remedy = `gh pr edit ${record.number} --base ${defaultBranch}`;
  }
  return finding;
}

/** Counts per classification, plus how many findings a human must act on. */
export function summarize({ mergedFindings = [], openFindings = [] } = {}) {
  const counts = {};
  let actionable = 0;
  for (const finding of [...mergedFindings, ...openFindings]) {
    counts[finding.classification] = (counts[finding.classification] ?? 0) + 1;
    if (ACTIONABLE_CLASSIFICATIONS.has(finding.classification)) actionable += 1;
  }
  return { counts, actionable };
}

function mergedBullet(finding, defaultBranch) {
  const link = finding.url || `#${finding.number}`;
  const title = finding.title ? ` — ${finding.title}` : "";
  const merged = finding.mergedAt ? `, merged ${finding.mergedAt}` : "";
  const commit = finding.mergeCommit ? `\`${finding.mergeCommit.slice(0, 9)}\`` : "(none)";
  const lines = [
    `- ${link}${title}`,
    `  - base \`${finding.base}\` (not \`${defaultBranch}\`)${merged}, merge commit ${commit}`,
  ];
  if (finding.reason) lines.push(`  - ${finding.reason}`);
  if (finding.absentPaths?.length) lines.push(`  - absent from \`${defaultBranch}\`: ${finding.absentPaths.join(", ")}`);
  if (finding.unlandedEditPaths?.length) {
    lines.push(`  - added lines not found on \`${defaultBranch}\`: ${finding.unlandedEditPaths.join(", ")}`);
  }
  return lines.join("\n");
}

function openBullet(finding) {
  const link = finding.url || `#${finding.number}`;
  const title = finding.title ? ` — ${finding.title}` : "";
  const lines = [`- ${link}${title}`, `  - base \`${finding.base}\` — ${finding.reason ?? "stacked"}`];
  if (finding.remedy) lines.push(`  - remedy: \`${finding.remedy}\``);
  return lines.join("\n");
}

function section(lines, heading, blurb, findings, render) {
  if (findings.length === 0) return;
  lines.push("", heading, "");
  if (blurb) lines.push(blurb, "");
  for (const finding of findings) lines.push(render(finding));
}

/** Renders the sweep as markdown, for a job summary or a tracking issue body. */
export function renderReport({
  repo,
  defaultBranch,
  scanned,
  openScanned = 0,
  mergedFindings = [],
  openFindings = [],
}) {
  const of = (classification) => mergedFindings.filter((finding) => finding.classification === classification);
  const openOf = (classification) => openFindings.filter((finding) => finding.classification === classification);
  const { counts, actionable } = summarize({ mergedFindings, openFindings });

  const lines = [
    `# Stranded merge sweep — \`${repo}\``,
    "",
    `Swept the ${scanned} most recent merged pull requests and ${openScanned} open pull requests.`,
    `A merge commit that is not an ancestor of \`${defaultBranch}\` only makes a pull request a`,
    "*candidate*; each candidate's payload is then adjudicated against the default branch by",
    "patch identity, blob equality, and added-line presence, because a squash, a cherry-pick or",
    "an independent re-land all put the content on the branch under a different SHA.",
    "",
    `- on \`${defaultBranch}\`: ${counts[MERGED_ON_DEFAULT] ?? 0}`,
    `- landed elsewhere (content present): ${counts[MERGED_LANDED] ?? 0}`,
    `- superseded (default branch moved past it): ${counts[MERGED_SUPERSEDED] ?? 0}`,
    `- **stranded (files absent): ${counts[MERGED_STRANDED] ?? 0}**`,
    `- **edits missing (files present, added lines absent): ${counts[MERGED_EDITS_MISSING] ?? 0}**`,
    `- **indeterminate: ${counts[MERGED_INDETERMINATE] ?? 0}**`,
    `- in-flight merge-train bases: ${counts[MERGED_TRANSIENT_BASE] ?? 0}`,
    `- **open pull requests needing a re-target: ${counts[OPEN_NEEDS_RETARGET] ?? 0}**`,
    `- open pull requests on a live stack base: ${counts[OPEN_LIVE_BASE] ?? 0}`,
    `- open pull requests with an unresolvable base: ${counts[OPEN_UNKNOWN_BASE] ?? 0}`,
    "",
    `Actionable findings: ${actionable}.`,
  ];

  section(
    lines,
    "## Stranded — payload files are absent from the default branch",
    "Hard evidence: the pull request added or changed these paths and they are not there.",
    of(MERGED_STRANDED),
    (finding) => mergedBullet(finding, defaultBranch),
  );
  section(
    lines,
    "## Edits missing — the files are there, the added lines are not",
    "Strong but not proof: a re-land that re-worded or moved the lines reads the same way. Diff before acting.",
    of(MERGED_EDITS_MISSING),
    (finding) => mergedBullet(finding, defaultBranch),
  );
  section(
    lines,
    "## Indeterminate — could not be adjudicated",
    "Never assume these landed; the usual cause is a deleted or force-pushed stack base.",
    of(MERGED_INDETERMINATE),
    (finding) => mergedBullet(finding, defaultBranch),
  );
  section(
    lines,
    "## Open pull requests needing a re-target",
    "Their base has already merged or been deleted, so landing them as-is would strand them.",
    openOf(OPEN_NEEDS_RETARGET),
    openBullet,
  );
  section(
    lines,
    "## Landed elsewhere — stranded merge, content present",
    "Not lost work. Recorded so a re-run does not re-investigate them, and so nobody reads the merge-commit ancestry test as a loss report.",
    of(MERGED_LANDED).concat(of(MERGED_SUPERSEDED)),
    (finding) => mergedBullet(finding, defaultBranch),
  );
  section(
    lines,
    "## In-flight merge-train bases — expected to resolve",
    "",
    of(MERGED_TRANSIENT_BASE),
    (finding) => mergedBullet(finding, defaultBranch),
  );
  section(
    lines,
    "## Open pull requests with an unresolvable base",
    "",
    openOf(OPEN_UNKNOWN_BASE),
    openBullet,
  );

  return `${lines.join("\n")}\n`;
}
