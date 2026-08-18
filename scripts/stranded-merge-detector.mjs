#!/usr/bin/env node
/**
 * Sweeps a repository for pull-request payload that never reached the default
 * branch, and for open pull requests that are about to repeat the mistake.
 *
 * Usage:
 *   node scripts/stranded-merge-detector.mjs [options]
 *
 *   --repo <owner/name>        default: the repository `gh` resolves for cwd
 *   --default-branch <name>    default: trunk
 *   --remote <name>            default: origin
 *   --limit <n>                merged pull requests to sweep (default 250)
 *   --open-limit <n>           open pull requests to check (default 200)
 *   --transient-base <glob>    repeatable; bases expected to disappear
 *                              (default `train/batch/*`, the merge-train
 *                              batches honua-server lands through)
 *   --output <path>            also write the markdown report here
 *   --json                     emit findings.json on stdout instead of markdown
 *   --from-json <path>         render the markdown report from a recorded sweep
 *   --fixture <path>           replay recorded facts; no `gh`, no network
 *   --fail-on <mode>           actionable (default) | stranded | never
 *   --no-fetch                 skip `git fetch` (tests, offline runs)
 *
 * Exit code 1 when the selected findings are present, so a scheduled job fails
 * loudly -- but only for findings a human must act on. A stranded *merge commit*
 * whose content re-landed elsewhere is real and harmless; failing on it is how a
 * detector gets muted, and how the silence it exists to break comes back.
 *
 * This file resolves facts (`gh`, `git`) and hands them to the pure classifiers
 * in scripts/lib/stranded-merge-detector.mjs. See that module for why ancestry
 * alone is not the answer. Related: honua-io/honua-sdk-js#1317,
 * honua-io/honua-server#3248.
 */

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import {
  ACTIONABLE_CLASSIFICATIONS,
  DEFAULT_TRANSIENT_BASE_PATTERNS,
  MERGED_STRANDED,
  SCHEMA_VERSION,
  classifyMergedPullRequest,
  classifyOpenPullRequest,
  classifyPath,
  matchesAnyBasePattern,
  normalizePullRequest,
  renderReport,
  significantAddedLines,
  summarize,
  unquoteDiffPath,
} from "./lib/stranded-merge-detector.mjs";

/**
 * Upper bound on how far back a squash/rebase payload walk looks, so a malformed
 * commit count can never turn into a whole-branch scan.
 */
const MAX_PAYLOAD_WALK = 250;

/**
 * Upper bound on default-branch commits whose patch id is computed while looking
 * for a re-landed payload commit. The search is already narrowed by path, so
 * this only caps a pathological history.
 */
const MAX_PATCH_ID_CANDIDATES = 200;

// core.quotepath=off keeps non-ASCII paths literal in diff headers. With it on,
// `docs/héllo.md` arrives as `"docs/h\303\251llo.md"`, every blob lookup for it
// fails, and an absent file is classified as landed.
const GIT = ["-c", "core.quotepath=off"];

const EXEC = { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 };

/** Scratch buffer for the synchronous retry backoff in {@link gh}. */
const BACKOFF = new Int32Array(new SharedArrayBuffer(4));

function parseArgs(argv) {
  const options = {
    repo: "",
    defaultBranch: "trunk",
    remote: "origin",
    limit: 250,
    openLimit: 200,
    transientBasePatterns: [],
    output: "",
    json: false,
    fromJson: "",
    fixture: "",
    failOn: "actionable",
    fetch: true,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      const value = argv[index + 1];
      if (value === undefined) throw new Error(`${arg} requires a value`);
      index += 1;
      return value;
    };
    if (arg === "--repo") options.repo = next();
    else if (arg === "--default-branch") options.defaultBranch = next();
    else if (arg === "--remote") options.remote = next();
    else if (arg === "--limit") options.limit = Number.parseInt(next(), 10);
    else if (arg === "--open-limit") options.openLimit = Number.parseInt(next(), 10);
    else if (arg === "--transient-base") options.transientBasePatterns.push(next());
    else if (arg === "--output") options.output = next();
    else if (arg === "--json") options.json = true;
    else if (arg === "--from-json") options.fromJson = next();
    else if (arg === "--fixture") options.fixture = next();
    else if (arg === "--fail-on") options.failOn = next();
    else if (arg === "--no-fetch") options.fetch = false;
    else throw new Error(`unknown argument: ${arg}`);
  }
  for (const [flag, value] of [
    ["--limit", options.limit],
    ["--open-limit", options.openLimit],
  ]) {
    if (!Number.isInteger(value) || value <= 0 || value > 1000) {
      throw new Error(`${flag} must be an integer between 1 and 1000`);
    }
  }
  // `payload-missing` was schema version 1's name for `stranded`; keep it
  // working so an older caller does not silently select a different gate.
  if (options.failOn === "payload-missing") options.failOn = "stranded";
  if (!["actionable", "stranded", "never"].includes(options.failOn)) {
    throw new Error("--fail-on must be one of: actionable, stranded, never");
  }
  if (options.transientBasePatterns.length === 0) {
    options.transientBasePatterns = [...DEFAULT_TRANSIENT_BASE_PATTERNS];
  }
  return options;
}

function run(command, args) {
  return execFileSync(command, args, EXEC).trim();
}

function git(args, { check = true, stdin } = {}) {
  const result = spawnSync("git", [...GIT, ...args], { ...EXEC, input: stdin });
  if (result.status !== 0) {
    if (check) throw new Error(`git ${args.join(" ")} failed: ${(result.stderr || "").trim()}`);
    return "";
  }
  return result.stdout;
}

function gitOk(args) {
  return spawnSync("git", [...GIT, ...args], EXEC).status === 0;
}

/**
 * Calls `gh`, retrying a required call a couple of times. The GraphQL endpoint
 * returns a transient 503 often enough that a weekly job would go red on it; a
 * swallowed failure, on the other hand, is how the open-PR pass invents
 * re-targets, so a required call still throws once the retries are spent.
 */
function gh(args, { check = true, attempts = 3 } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const result = spawnSync("gh", args, EXEC);
    if (result.status === 0) return result.stdout;
    lastError = (result.stderr || "").trim();
    if (!check) return "";
    // Synchronous backoff: this script is a linear sweep, and blocking here is
    // simpler to reason about than threading async through every resolver.
    if (attempt < attempts) Atomics.wait(BACKOFF, 0, 0, Math.min(2 ** attempt, 8) * 1000);
  }
  throw new Error(`gh ${args.join(" ")} failed: ${lastError}`);
}

/** Resolves the facts the classifiers need from `gh` and the local clone. */
class LiveResolver {
  constructor({ repo, defaultRef, remote }) {
    this.repo = repo;
    this.defaultRef = defaultRef;
    this.remote = remote;
    this.trees = new Map();
    this.patchIds = new Map();
    this.baseStates = new Map();
    this.localHeads = undefined;
  }

  ghJson(args, { check = true, fallback } = {}) {
    const raw = gh([...args, "--repo", this.repo], { check });
    try {
      return JSON.parse(raw || "null") ?? fallback;
    } catch {
      return fallback;
    }
  }

  listPullRequests(state, limit, fields) {
    return (
      this.ghJson(["pr", "list", "--state", state, "--limit", String(limit), "--json", fields], {
        fallback: [],
      }) ?? []
    );
  }

  mergedPullRequests(limit) {
    return this.listPullRequests("merged", limit, "number,title,baseRefName,headRefName,mergeCommit,mergedAt,url");
  }

  openPullRequests(limit) {
    return this.listPullRequests("open", limit, "number,title,baseRefName,headRefName,url");
  }

  /** `true` on the default branch, `false` not, `undefined` not in this clone. */
  onDefaultBranch(mergeCommit) {
    if (!gitOk(["cat-file", "-e", `${mergeCommit}^{commit}`])) return undefined;
    return gitOk(["merge-base", "--is-ancestor", mergeCommit, this.defaultRef]);
  }

  /** `{ pathVerdicts, indeterminateReason }` for one stranded candidate. */
  adjudicate(pullRequest, mergeCommit) {
    try {
      const { commits, reason } = this.payloadCommits(pullRequest, mergeCommit);
      if (reason) return { pathVerdicts: [], indeterminateReason: reason };

      const { added, touchedBy } = this.payloadAddedLines(commits);
      if (added.size === 0) {
        return {
          pathVerdicts: [],
          indeterminateReason: `the ${commits.length} payload commit(s) add no adjudicable lines (pure removals, binary content, or an empty diff)`,
        };
      }

      const landedCommits = this.patchLandedCommits(commits);
      const mergeTree = this.tree(mergeCommit);
      const defaultTree = this.tree(this.defaultRef);
      const touchedSince = this.pathsTouchedSince([...added.keys()], pullRequest.mergedAt);

      const pathVerdicts = [...added.keys()].sort().map((filePath) => {
        const headBlob = mergeTree.get(filePath);
        const defaultBlob = defaultTree.get(filePath);
        const differ = headBlob !== undefined && defaultBlob !== undefined && headBlob !== defaultBlob;
        const owners = touchedBy.get(filePath) ?? new Set();
        return classifyPath({
          path: filePath,
          headBlob,
          defaultBlob,
          addedLines: added.get(filePath),
          defaultText: differ ? git(["show", `${this.defaultRef}:${filePath}`], { check: false }) : undefined,
          touchedOnDefaultSinceMerge: touchedSince.has(filePath),
          patchLanded: owners.size > 0 && [...owners].every((commit) => landedCommits.has(commit)),
        });
      });
      return { pathVerdicts, indeterminateReason: undefined };
    } catch (error) {
      return { pathVerdicts: [], indeterminateReason: `git could not adjudicate this merge: ${error.message}` };
    }
  }

  /**
   * Commits carrying the pull request's own work, excluding default-branch
   * drift. A pull request raised against a *stale* stack base has its file list
   * inflated with unrelated drift, so the payload is never taken from the API's
   * changed-file list.
   */
  payloadCommits(pullRequest, mergeCommit) {
    const parents = git(["rev-list", "--parents", "-n", "1", mergeCommit]).trim().split(/\s+/u).slice(1);

    if (parents.length >= 2) {
      const [baseParent, headParent] = parents;
      if (!gitOk(["cat-file", "-e", `${headParent}^{commit}`])) {
        return { commits: [], reason: `the head parent ${headParent.slice(0, 9)} of the merge commit is not in this clone` };
      }
      const commits = git(["rev-list", headParent, "--not", baseParent, this.defaultRef, "--no-merges"])
        .trim()
        .split(/\s+/u)
        .filter(Boolean);
      if (commits.length === 0) return { commits: [], reason: "the merge commit brought in no commits of its own" };
      return { commits, reason: undefined };
    }

    if (parents.length === 0) {
      return { commits: [], reason: `merge commit ${mergeCommit.slice(0, 9)} is a root commit with no parent to diff against` };
    }

    // Squash or rebase merge. GitHub reports only the *last* rebased commit as
    // mergeCommit, so walking just that one silently drops everything the
    // earlier commits of a rebase merge added. Walk back over the new commits on
    // the base and keep the ones that belong to this pull request.
    const summaries = this.pullRequestCommitSummaries(pullRequest);
    const window = Math.min(Math.max(summaries.size, 1), MAX_PAYLOAD_WALK);
    const candidates = git(["rev-list", "--no-merges", "-n", String(window), mergeCommit, "--not", this.defaultRef])
      .trim()
      .split(/\s+/u)
      .filter(Boolean);
    const marker = `(#${pullRequest.number})`;
    const mine = candidates.filter((commit) => {
      const summary = git(["log", "-1", "--format=%s", commit], { check: false }).trim();
      return summaries.has(summary) || summary.includes(marker);
    });
    return { commits: mine.length > 0 ? mine : [mergeCommit], reason: undefined };
  }

  pullRequestCommitSummaries(pullRequest) {
    const payload = this.ghJson(["pr", "view", String(pullRequest.number), "--json", "commits"], {
      check: false,
      fallback: {},
    });
    const summaries = new Set();
    for (const commit of payload?.commits ?? []) {
      if (commit?.messageHeadline) summaries.add(commit.messageHeadline);
    }
    return summaries;
  }

  payloadAddedLines(commits) {
    const added = new Map();
    const touchedBy = new Map();
    for (const commit of commits) {
      const diff = git(["diff", "--no-color", "-U0", `${commit}^`, commit], { check: false });
      for (const [filePath, lines] of significantAddedLines(diff)) {
        if (lines.length === 0) continue;
        if (!added.has(filePath)) added.set(filePath, []);
        added.get(filePath).push(...lines);
        if (!touchedBy.has(filePath)) touchedBy.set(filePath, new Set());
        touchedBy.get(filePath).add(commit);
      }
    }
    return { added, touchedBy };
  }

  /**
   * Payload commits with an exact patch-id equivalent on the default branch.
   *
   * Patch identity is the only *proof* available here: it survives squash,
   * rebase and cherry-pick, where the commit SHA does not. `git cherry` itself
   * is not used, because it drops commits that are literally upstream from its
   * output instead of marking them, so an exact re-land would read as not found.
   */
  patchLandedCommits(commits) {
    const landed = new Set();
    for (const commit of commits) {
      if (gitOk(["merge-base", "--is-ancestor", commit, this.defaultRef])) {
        landed.add(commit);
        continue;
      }
      const wanted = this.patchId(commit);
      if (!wanted) continue;
      const paths = git(["diff-tree", "--no-commit-id", "--name-only", "-r", commit], { check: false })
        .split("\n")
        .filter(Boolean);
      if (paths.length === 0) continue;
      const candidates = git(
        [
          "rev-list",
          "--no-merges",
          "-n",
          String(MAX_PATCH_ID_CANDIDATES),
          this.defaultRef,
          "--not",
          `${commit}^`,
          "--",
          ...paths,
        ],
        { check: false },
      )
        .trim()
        .split(/\s+/u)
        .filter(Boolean);
      if (candidates.some((candidate) => this.patchId(candidate) === wanted)) landed.add(commit);
    }
    return landed;
  }

  patchId(commit) {
    if (!this.patchIds.has(commit)) {
      const diff = git(["diff", "--no-color", `${commit}^`, commit], { check: false });
      const out = diff ? git(["patch-id", "--stable"], { check: false, stdin: diff }).trim().split(/\s+/u) : [];
      this.patchIds.set(commit, out[0] ?? "");
    }
    return this.patchIds.get(commit);
  }

  /** path -> blob id for the whole tree at `ref`; one git call, cached. */
  tree(ref) {
    if (!this.trees.has(ref)) {
      const entries = new Map();
      for (const line of git(["ls-tree", "-r", ref]).split("\n")) {
        const tab = line.indexOf("\t");
        if (tab < 0) continue;
        const fields = line.slice(0, tab).split(/\s+/u);
        if (fields.length >= 3 && fields[1] === "blob") entries.set(unquoteDiffPath(line.slice(tab + 1)), fields[2]);
      }
      this.trees.set(ref, entries);
    }
    return this.trees.get(ref);
  }

  /** Payload paths the default branch has changed since the merge; one git call. */
  pathsTouchedSince(paths, mergedAt) {
    if (!mergedAt || paths.length === 0) return new Set();
    const out = git(["log", `--since=${mergedAt}`, "--name-only", "--format=", this.defaultRef, "--", ...paths], {
      check: false,
    });
    return new Set(out.split("\n").map((line) => unquoteDiffPath(line.trim())).filter(Boolean));
  }

  /** `{ baseExists, baseMerged, baseIsAncestor }` for an open pull request's base. */
  baseState(base) {
    if (!this.baseStates.has(base)) this.baseStates.set(base, this.resolveBaseState(base));
    return this.baseStates.get(base);
  }

  resolveBaseState(base) {
    const local = this.heads().get(base);
    if (local) {
      return {
        baseExists: true,
        baseMerged: this.baseMerged(base),
        baseIsAncestor: gitOk(["merge-base", "--is-ancestor", local, this.defaultRef]),
      };
    }
    // A credential-free checkout makes `git ls-remote` run unauthenticated, so
    // ask the API with the workflow token instead and treat failure as unknown.
    const exists = this.branchExistsViaApi(base);
    if (exists === undefined) return { baseExists: undefined, baseMerged: undefined, baseIsAncestor: undefined };
    if (!exists) return { baseExists: false, baseMerged: undefined, baseIsAncestor: undefined };
    return { baseExists: true, baseMerged: this.baseMerged(base), baseIsAncestor: undefined };
  }

  /** Local remote-tracking branches. No network; `fetch-depth: 0` populates these. */
  heads() {
    if (this.localHeads === undefined) {
      this.localHeads = new Map();
      const prefix = `refs/remotes/${this.remote}/`;
      for (const line of git(["for-each-ref", "--format=%(refname) %(objectname)", prefix], { check: false }).split(
        "\n",
      )) {
        const space = line.indexOf(" ");
        if (space < 0 || !line.startsWith(prefix)) continue;
        const short = line.slice(prefix.length, space);
        if (short && short !== "HEAD") this.localHeads.set(short, line.slice(space + 1).trim());
      }
    }
    return this.localHeads;
  }

  branchExistsViaApi(base) {
    const result = spawnSync("gh", ["api", "-i", `repos/${this.repo}/branches/${base}`], EXEC);
    if (result.status === 0) return true;
    if (`${result.stdout}${result.stderr}`.includes("HTTP 404")) return false;
    return undefined;
  }

  /**
   * `true` when a pull request whose head is `base` has been merged.
   *
   * Deliberately not "is an ancestor of the default branch": a stack base
   * created or reset from the default branch is an ancestor while being alive,
   * and telling someone to detach a live stack from it would be wrong.
   */
  baseMerged(base) {
    const raw = this.ghJson(["pr", "list", "--head", base, "--state", "merged", "--limit", "1", "--json", "number"], {
      check: false,
      fallback: undefined,
    });
    return Array.isArray(raw) ? raw.length > 0 : undefined;
  }
}

/** Replays recorded facts so the whole sweep is testable offline. */
class FixtureResolver {
  constructor(fixture) {
    this.fixture = fixture;
  }

  mergedPullRequests(limit) {
    return (this.fixture.merged ?? []).slice(0, limit);
  }

  openPullRequests(limit) {
    return (this.fixture.open ?? []).slice(0, limit);
  }

  onDefaultBranch(mergeCommit) {
    for (const pullRequest of this.fixture.merged ?? []) {
      const oid = typeof pullRequest.mergeCommit === "string" ? pullRequest.mergeCommit : pullRequest.mergeCommit?.oid;
      if (oid === mergeCommit) return pullRequest.onDefaultBranch;
    }
    return undefined;
  }

  /**
   * `pathFacts` records the raw inputs (blob ids, added lines, the default
   * branch's text) and is adjudicated through the real {@link classifyPath}, so
   * a fixture run exercises the adjudication rather than asserting a verdict
   * somebody typed. `paths` skips straight to recorded verdicts, for the cases
   * where only the pull-request-level rollup is under test.
   */
  adjudicate(pullRequest) {
    const source = (this.fixture.merged ?? []).find((entry) => entry.number === pullRequest.number) ?? {};
    if (source.pathFacts) {
      return {
        pathVerdicts: source.pathFacts.map((facts) => classifyPath(facts)),
        indeterminateReason: source.indeterminateReason,
      };
    }
    return { pathVerdicts: source.paths ?? [], indeterminateReason: source.indeterminateReason };
  }

  baseState(base) {
    // A base the fixture forgot to record is unknown, not healthy.
    return (
      (this.fixture.bases ?? {})[base] ?? { baseExists: true, baseMerged: undefined, baseIsAncestor: undefined }
    );
  }
}

export function sweep({ resolver, defaultBranch, limit, openLimit, transientBasePatterns }) {
  const merged = resolver.mergedPullRequests(limit);
  const open = resolver.openPullRequests(openLimit);

  const mergedFindings = merged.map((raw) => {
    const record = normalizePullRequest(raw);
    const onDefaultBranch = record.mergeCommit === undefined ? undefined : resolver.onDefaultBranch(record.mergeCommit);
    const transientBase =
      record.baseRefName !== defaultBranch && matchesAnyBasePattern(record.baseRefName, transientBasePatterns);
    const needsAdjudication = onDefaultBranch === false && !transientBase;
    const { pathVerdicts, indeterminateReason } = needsAdjudication
      ? resolver.adjudicate(record, record.mergeCommit)
      : { pathVerdicts: [], indeterminateReason: undefined };
    return classifyMergedPullRequest(raw, { onDefaultBranch, transientBase, pathVerdicts, indeterminateReason });
  });

  const openFindings = open.map((raw) => {
    const record = normalizePullRequest(raw);
    const state =
      record.baseRefName === defaultBranch || matchesAnyBasePattern(record.baseRefName, transientBasePatterns)
        ? {}
        : resolver.baseState(record.baseRefName);
    return classifyOpenPullRequest(raw, { defaultBranch, transientBasePatterns, ...state });
  });

  return { mergedFindings, openFindings, scanned: merged.length, openScanned: open.length };
}

function gateCount({ failOn, mergedFindings, openFindings }) {
  if (failOn === "never") return 0;
  if (failOn === "stranded") {
    return mergedFindings.filter((finding) => finding.classification === MERGED_STRANDED).length;
  }
  return [...mergedFindings, ...openFindings].filter((finding) =>
    ACTIONABLE_CLASSIFICATIONS.has(finding.classification),
  ).length;
}

function main() {
  const options = parseArgs(process.argv.slice(2));

  if (options.fromJson) {
    const recorded = JSON.parse(fs.readFileSync(options.fromJson, "utf8"));
    if (recorded.schemaVersion !== SCHEMA_VERSION) {
      throw new Error(`findings schemaVersion ${recorded.schemaVersion} is not ${SCHEMA_VERSION}`);
    }
    process.stdout.write(renderReport(recorded));
    return;
  }

  let resolver;
  let repo;
  if (options.fixture) {
    const fixture = JSON.parse(fs.readFileSync(options.fixture, "utf8"));
    repo = options.repo || fixture.repo || "fixture";
    resolver = new FixtureResolver(fixture);
  } else {
    repo = options.repo || run("gh", ["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"]);
    if (options.fetch) {
      // The sweep is only as good as the local view of the default branch, and a
      // stranded merge commit is by definition on a branch nobody fetched.
      run("git", ["fetch", "--quiet", "--prune", options.remote, "+refs/heads/*:refs/remotes/origin/*"]);
    }
    resolver = new LiveResolver({
      repo,
      defaultRef: `${options.remote}/${options.defaultBranch}`,
      remote: options.remote,
    });
  }

  const { mergedFindings, openFindings, scanned, openScanned } = sweep({
    resolver,
    defaultBranch: options.defaultBranch,
    limit: options.limit,
    openLimit: options.openLimit,
    transientBasePatterns: options.transientBasePatterns,
  });

  const { counts, actionable } = summarize({ mergedFindings, openFindings });
  const findings = {
    schemaVersion: SCHEMA_VERSION,
    repo,
    defaultBranch: options.defaultBranch,
    scanned,
    openScanned,
    counts,
    actionable,
    mergedFindings,
    openFindings,
  };

  const report = renderReport(findings);
  process.stdout.write(options.json ? `${JSON.stringify(findings, undefined, 2)}\n` : report);
  if (options.output) {
    fs.mkdirSync(path.dirname(path.resolve(options.output)), { recursive: true });
    fs.writeFileSync(options.output, report, "utf8");
  }
  if (process.env.GITHUB_STEP_SUMMARY && !options.json) {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, report, "utf8");
  }

  const failures = gateCount({ failOn: options.failOn, mergedFindings, openFindings });
  if (failures > 0) {
    process.stderr.write(`\n${failures} finding(s) need a human, out of ${actionable} actionable.\n`);
    process.exitCode = 1;
  }
}

// Importable for tests without running the sweep.
if (process.argv[1] && import.meta.url === `file://${path.resolve(process.argv[1])}`) main();
