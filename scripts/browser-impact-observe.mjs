#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_POLICY = resolve(ROOT, ".github/data/browser-impact-policy.v1.json");
const OBSERVATION_SCHEMA = "honua.sdk.browser-impact-observation/v2";
const SUPERSEDED_SCHEMA = "honua.sdk.browser-impact-superseded/v1";
const SUPERSEDE_REASONS = new Set([
  "pull-request-association-withdrawn",
  "source-run-head-superseded",
  "pull-request-head-moved",
]);
const SHA = /^[0-9a-f]{40}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const TERMINAL_CONCLUSIONS = new Set([
  "success",
  "failure",
  "cancelled",
  "timed_out",
  "action_required",
  "neutral",
  "skipped",
  "stale",
  "startup_failure",
]);
const OBSERVER_EVENTS = new Set(["workflow_run", "workflow_dispatch"]);
const TRUSTED_POLICY_INPUTS = new Set([
  ".github/data/browser-impact-policy.v1.json",
  ".github/workflows/browser-impact-observe.yml",
  "scripts/browser-impact-observe.mjs",
  "scripts/trusted-pr-workflow-run.cjs",
]);
const TRUSTED_MANIFEST_ORDER = [
  "observer_workflow_sha256",
  "policy_blob_sha256",
  "resolver_blob_sha256",
  "selector_blob_sha256",
];
const EXPECTED_LANES = [
  "offline-service-worker",
  "realtime-collaboration",
  "heavy-map-kepler",
  "examples-general",
];
const MODULE_EXTENSIONS = new Set([".cjs", ".js", ".mjs", ".mts", ".ts", ".tsx"]);
const PACKAGE_NAME = "@honua/sdk-js";
const PACKAGE_EXPORTS = new Map();

export class PolicyError extends Error {}

export function assertTrustedPolicyCommit(policyCommitSha, defaultHeadSha, isAncestor) {
  if (!SHA.test(policyCommitSha) || !SHA.test(defaultHeadSha)) {
    throw new PolicyError("observer policy commit or fetched default-branch head is invalid");
  }
  if (policyCommitSha === defaultHeadSha) return;
  if (typeof isAncestor !== "function" || !isAncestor(policyCommitSha, defaultHeadSha)) {
    throw new PolicyError("observer policy commit is not reachable from the fetched default branch");
  }
}

export function resolveEventMergeTree(baseSha, headSha, repositoryRoot = ROOT) {
  if (!SHA.test(baseSha) || !SHA.test(headSha)) {
    throw new PolicyError("event-time merge base or head is invalid");
  }
  let treeSha;
  try {
    treeSha = execFileSync("git", ["merge-tree", "--write-tree", baseSha, headSha], {
      cwd: repositoryRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (error) {
    throw new PolicyError(`cannot reconstruct event-time merge tree: ${error.message}`);
  }
  if (!SHA.test(treeSha)) {
    throw new PolicyError("event-time merge did not produce exactly one tree");
  }
  return treeSha;
}

export function reconstructEventMerge(baseSha, headSha, candidateRoot, repositoryRoot = ROOT) {
  const resolvedCandidateRoot = resolve(candidateRoot);
  if (resolvedCandidateRoot === resolve(repositoryRoot) || existsSync(resolvedCandidateRoot)) {
    throw new PolicyError("event-time merge candidate root must be a new separate path");
  }
  const treeSha = resolveEventMergeTree(baseSha, headSha, repositoryRoot);
  const identity = {
    ...process.env,
    GIT_AUTHOR_NAME: "Honua Browser Impact Observer",
    GIT_AUTHOR_EMAIL: "browser-impact@honua.invalid",
    GIT_AUTHOR_DATE: "2000-01-01T00:00:00+00:00",
    GIT_COMMITTER_NAME: "Honua Browser Impact Observer",
    GIT_COMMITTER_EMAIL: "browser-impact@honua.invalid",
    GIT_COMMITTER_DATE: "2000-01-01T00:00:00+00:00",
  };
  const mergeSha = execFileSync(
    "git",
    ["commit-tree", treeSha, "-p", baseSha, "-p", headSha],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
      env: identity,
      input: "Honua event-time browser merge\n",
      stdio: ["pipe", "pipe", "pipe"],
    },
  ).trim();
  if (!SHA.test(mergeSha)) throw new PolicyError("event-time merge commit identity is invalid");
  execFileSync("git", ["worktree", "add", "--detach", resolvedCandidateRoot, mergeSha], {
    cwd: repositoryRoot,
    stdio: "ignore",
  });
  return { merge_sha: mergeSha, merge_tree_sha: treeSha };
}

export function normalizePath(value) {
  return String(value).replaceAll("\\", "/").replace(/^\.\//, "").replace(/^\/+|\/+$/g, "");
}

function escapeRegex(value) {
  return value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}

export function pathMatches(path, pattern) {
  const normalizedPath = normalizePath(path);
  const normalizedPattern = normalizePath(pattern);
  const placeholder = "\u0000";
  const source = escapeRegex(normalizedPattern)
    .replaceAll("**", placeholder)
    .replaceAll("*", "[^/]*")
    .replaceAll(placeholder, ".*");
  return new RegExp(`^${source}$`, "u").test(normalizedPath);
}

function matchesAny(path, patterns) {
  return patterns.some((pattern) => pathMatches(path, pattern));
}

export function loadPolicy(path = DEFAULT_POLICY) {
  let policy;
  try {
    policy = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new PolicyError(`cannot read policy ${path}: ${error.message}`);
  }
  return policy;
}

export function discoverSpecs(root = ROOT) {
  const directory = resolve(root, "test/playwright");
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".spec.mjs"))
    .map((entry) => entry.name)
    .sort();
}

export function discoverBrowserFixtureRoots(source) {
  const roots = new Set();
  for (const literal of source.matchAll(/["'`]([^"'`\r\n]+)["'`]/gu)) {
    const value = literal[1].replaceAll("\\", "/");
    if (value.includes("://")) continue;
    const normalized = value.replace(/^(?:\.\.\/)+/u, "");
    const fixture = /^(docs\/examples|examples)\/([a-z0-9-]+)(?:\/|$)/u.exec(normalized);
    if (fixture) roots.add(`${fixture[1]}/${fixture[2]}`);
  }
  for (const call of source.matchAll(/path\.(?:join|resolve)\(([^;]*?)\)/gsu)) {
    const segments = [...call[1].matchAll(/["'`]([^"'`]+)["'`]/gu)].map(
      (match) => match[1],
    );
    for (let index = 0; index < segments.length; index += 1) {
      if (
        segments[index] === "examples" &&
        segments[index - 1] !== "docs" &&
        /^[a-z0-9-]+$/u.test(segments[index + 1] ?? "")
      ) {
        roots.add(`examples/${segments[index + 1]}`);
      }
      if (
        segments[index] === "docs" &&
        segments[index + 1] === "examples" &&
        /^[a-z0-9-]+$/u.test(segments[index + 2] ?? "")
      ) {
        roots.add(`docs/examples/${segments[index + 2]}`);
      }
    }
  }
  return [...roots].sort();
}

function sourceFilesUnder(path) {
  if (!existsSync(path)) return [];
  if (statSync(path).isFile()) return MODULE_EXTENSIONS.has(extname(path)) ? [path] : [];
  const files = [];
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    if (entry.name === "dist" || entry.name === "node_modules") continue;
    const child = resolve(path, entry.name);
    if (entry.isDirectory()) files.push(...sourceFilesUnder(child));
    else if (entry.isFile() && MODULE_EXTENSIONS.has(extname(entry.name))) files.push(child);
  }
  return files;
}

function localImportSpecifiers(source) {
  const specifiers = new Set();
  for (const match of source.matchAll(/\b(?:import|export)\s+(?:[^"'`]*?\s+from\s+)?["'`]([^"'`]+)["'`]/gsu)) {
    specifiers.add(match[1]);
  }
  for (const match of source.matchAll(/\b(?:import|require)\(\s*["'`]([^"'`]+)["'`]\s*\)/gu)) {
    specifiers.add(match[1]);
  }
  return [...specifiers];
}

function packageSourcePath(specifier, root) {
  if (specifier !== PACKAGE_NAME && !specifier.startsWith(`${PACKAGE_NAME}/`)) return undefined;
  if (!PACKAGE_EXPORTS.has(root)) {
    PACKAGE_EXPORTS.set(root, JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")).exports);
  }
  const exportKey = specifier === PACKAGE_NAME ? "." : `.${specifier.slice(PACKAGE_NAME.length)}`;
  const target = PACKAGE_EXPORTS.get(root)?.[exportKey]?.default;
  return typeof target === "string" && target.startsWith("./dist/")
    ? resolve(root, target.slice("./dist/".length))
    : undefined;
}

function resolveLocalImport(fromFile, specifier, root) {
  const base = specifier.startsWith(".")
    ? resolve(dirname(fromFile), specifier)
    : packageSourcePath(specifier, root);
  if (!base) return undefined;
  const extension = extname(base);
  const candidates = [base];
  if (extension) {
    const stem = base.slice(0, -extension.length);
    for (const candidateExtension of MODULE_EXTENSIONS) candidates.push(`${stem}${candidateExtension}`);
  } else {
    for (const candidateExtension of MODULE_EXTENSIONS) {
      candidates.push(`${base}${candidateExtension}`, resolve(base, `index${candidateExtension}`));
    }
  }
  return candidates.find((candidate) => existsSync(candidate) && statSync(candidate).isFile());
}

export function discoverLocalModuleDependencies(entryRoot, root = ROOT) {
  const queue = sourceFilesUnder(resolve(root, entryRoot));
  const visited = new Set();
  const dependencies = new Set();
  while (queue.length > 0) {
    const file = queue.pop();
    if (visited.has(file)) continue;
    visited.add(file);
    for (const specifier of localImportSpecifiers(readFileSync(file, "utf8"))) {
      const target = resolveLocalImport(file, specifier, root);
      if (!target) continue;
      const repositoryPath = normalizePath(relative(root, target));
      if (!repositoryPath || repositoryPath.startsWith("../")) continue;
      dependencies.add(repositoryPath);
      if (
        !repositoryPath.startsWith("src/") &&
        !repositoryPath.startsWith("packages/") &&
        !visited.has(target)
      ) {
        queue.push(target);
      }
    }
  }
  return [...dependencies].sort();
}

export function assignSpecs(policy, specs) {
  const ownership = new Map();
  for (const spec of specs) {
    const owners = policy.lanes
      .filter((lane) => matchesAny(spec, lane.specPatterns))
      .map((lane) => lane.id);
    if (owners.length > 1) {
      throw new PolicyError(`${spec} belongs to multiple browser lanes: ${owners.join(", ")}`);
    }
    ownership.set(spec, owners[0] ?? policy.fallbackLane);
  }
  return ownership;
}

export function validateWorkflow(root) {
  const workflowPath = resolve(root, ".github/workflows/browser-impact-observe.yml");
  const workflow = readFileSync(workflowPath, "utf8");
  if (!workflow.includes("workflow_run:") || !workflow.includes('workflows: ["SDK CI"]')) {
    throw new PolicyError("browser observer must consume completed SDK CI workflow runs");
  }
  for (const forbidden of [
    "playwright test",
    "gh run cancel",
    "cancelWorkflowRun",
    "pull_request_target",
    "pull_request:",
  ]) {
    if (workflow.includes(forbidden)) {
      throw new PolicyError(`observe-only workflow contains forbidden authority: ${forbidden}`);
    }
  }
  const permissionBlocks = [
    ...workflow.matchAll(/^permissions:\r?\n((?:  [a-z-]+: [^\r\n]+\r?\n)+)/gmu),
  ];
  const permissions = permissionBlocks[0]?.[1]
    ?.trim()
    .split(/\r?\n/u)
    .map((line) => line.trim());
  if (
    permissionBlocks.length !== 1 ||
    JSON.stringify(permissions) !==
      JSON.stringify([
        "actions: read",
        "checks: read",
        "contents: read",
        "pull-requests: read",
      ]) ||
    /^\s{4,}permissions:/mu.test(workflow)
  ) {
    throw new PolicyError("browser observer permissions must be the exact read-only allowlist");
  }
  if (
    !workflow.includes("scripts/trusted-pr-workflow-run.cjs") ||
    !workflow.includes('ref: ${{ github.sha }}') ||
    !workflow.includes('head_repository.full_name == github.repository') ||
    !/github\.event\.workflow_run\.pull_requests\[0\]\.base\.ref\s*==\s*github\.event\.repository\.default_branch/u.test(
      workflow,
    )
  ) {
    throw new PolicyError("browser observer must resolve the exact trusted JS SDK workflow job");
  }
  for (const binding of [
    'workflowPath: ".github/workflows/ci.yml"',
    'workflowName: "SDK CI"',
    'jobName: "JS SDK"',
  ]) {
    if (workflow.split(binding).length - 1 !== 2) {
      throw new PolicyError("browser observer source identity must match in both resolutions");
    }
  }
  if (
    workflow.split('refs/pull/${PR_NUMBER}/head').length - 1 !== 2 ||
    workflow.split('browser-impact-observe.mjs reconstruct').length - 1 !== 1 ||
    workflow.split('browser-impact-observe.mjs event-tree').length - 1 !== 1 ||
    workflow.split('browser-impact/${PR_NUMBER}/head^{commit}').length - 1 !== 2 ||
    !workflow.includes('EXPECTED_MERGE_TREE_SHA: ${{ steps.merge.outputs.merge_tree_sha }}') ||
    !workflow.includes('--head "$MERGE_SHA"') ||
    !workflow.includes('--source-head "$HEAD_SHA"')
  ) {
    throw new PolicyError("browser observer must reconstruct and revalidate the event-time merge tree");
  }
  const resolveCalls = workflow.match(/await resolveTrustedPullRequestWorkflowRun/gmu) ?? [];
  if (resolveCalls.length !== 2) {
    throw new PolicyError("browser observer must resolve source identity before and after observation");
  }
  // A source run that can no longer be observed is skipped, never silently: both
  // resolutions must classify the supersede, every observation step must be
  // gated on that classification, and the always-uploaded evidence must be
  // replaced by an explicit superseded record. Dropping any of these turns a
  // skipped observation back into either a red build or a silent no-op.
  const supersedeGuards = [
    workflow.split("SUPERSEDED_SOURCE_RUN").length - 1 >= 4,
    (workflow.match(/core\.setOutput\("superseded", "true"\)/gmu) ?? []).length === 2,
    (workflow.match(/core\.setOutput\("superseded", "false"\)/gmu) ?? []).length === 2,
    (workflow.match(/steps\.resolve\.outputs\.superseded != 'true'/gmu) ?? []).length === 4,
    workflow.includes("steps.revalidate.outputs.superseded != 'true'"),
    workflow.includes("browser-impact-observe.mjs superseded"),
    workflow.includes("steps.resolve.outputs.superseded == 'true' ||"),
    workflow.includes("steps.revalidate.outputs.superseded == 'true'"),
    (workflow.match(/core\.warning\(/gmu) ?? []).length === 2,
  ];
  if (supersedeGuards.some((guard) => !guard)) {
    throw new PolicyError(
      "browser observer must classify superseded source runs and publish an explicit superseded record",
    );
  }
  for (const argument of [
    '--observer-run-id "$GITHUB_RUN_ID"',
    '--observer-run-attempt "$GITHUB_RUN_ATTEMPT"',
    '--observer-event "$GITHUB_EVENT_NAME"',
    '--observer-ref "$GITHUB_REF"',
    '--observer-repository "$GITHUB_REPOSITORY"',
  ]) {
    if (!workflow.includes(argument)) {
      throw new PolicyError("browser observer receipt is missing trusted run identity");
    }
  }
}

export function validatePolicy(policy, root = ROOT, workflowRoot = ROOT) {
  if (policy.schema !== "honua.sdk.browser-impact-policy/v1") {
    throw new PolicyError("unsupported browser impact policy schema");
  }
  if (policy.mode !== "observe") {
    throw new PolicyError("browser impact policy must remain observe-only");
  }
  const laneIds = policy.lanes?.map((lane) => lane.id) ?? [];
  if (JSON.stringify(laneIds) !== JSON.stringify(EXPECTED_LANES)) {
    throw new PolicyError(`browser lanes must be ordered as ${EXPECTED_LANES.join(", ")}`);
  }
  if (!laneIds.includes(policy.fallbackLane)) {
    throw new PolicyError("fallback lane is not declared");
  }
  for (const lane of policy.lanes) {
    for (const field of ["specPatterns", "changePatterns"]) {
      if (!Array.isArray(lane[field]) || lane[field].length !== new Set(lane[field]).size) {
        throw new PolicyError(`${lane.id}.${field} must be a duplicate-free array`);
      }
    }
  }
  for (const field of ["globalPatterns", "ignoredPatterns"]) {
    if (!Array.isArray(policy[field]) || policy[field].length === 0) {
      throw new PolicyError(`${field} must be a non-empty array`);
    }
  }
  if (!Array.isArray(policy.sharedLanePatterns)) {
    throw new PolicyError("sharedLanePatterns must be an array");
  }
  for (const shared of policy.sharedLanePatterns) {
    if (!Array.isArray(shared.patterns) || shared.patterns.length === 0) {
      throw new PolicyError("shared lane patterns must be non-empty");
    }
    if (!Array.isArray(shared.lanes) || shared.lanes.length === 0 || shared.lanes.some((lane) => !laneIds.includes(lane))) {
      throw new PolicyError("shared lane targets must name declared lanes");
    }
  }
  const specs = discoverSpecs(root);
  const ownership = assignSpecs(policy, specs);
  if (ownership.size !== specs.length || specs.length === 0) {
    throw new PolicyError("every Playwright spec must have exactly one owner");
  }
  const dependencyCache = new Map();
  const routingErrors = new Set();
  for (const spec of specs) {
    const source = readFileSync(resolve(root, "test/playwright", spec), "utf8");
    for (const fixtureRoot of discoverBrowserFixtureRoots(source)) {
      const selectedLanes = selectedLanesForFixtureRoot(policy, fixtureRoot);
      if (!selectedLanes.includes(ownership.get(spec))) {
        routingErrors.add(`${fixtureRoot} must select ${ownership.get(spec)} for ${spec}`);
      }
      if (!dependencyCache.has(fixtureRoot)) {
        dependencyCache.set(fixtureRoot, discoverLocalModuleDependencies(fixtureRoot, root));
      }
      for (const dependency of dependencyCache.get(fixtureRoot)) {
        const routedLanes = routePath(policy, dependency, laneIds).lanes;
        if (!routedLanes.includes(ownership.get(spec))) {
          routingErrors.add(
            `${dependency}, imported by ${fixtureRoot}, must select ${ownership.get(spec)} for ${spec}`,
          );
        }
      }
    }
  }
  if (routingErrors.size > 0) {
    throw new PolicyError(`browser dependency routing gaps:\n- ${[...routingErrors].join("\n- ")}`);
  }
  validateWorkflow(workflowRoot);
  return { specs, ownership };
}

function selectedLanesForFixtureRoot(policy, fixtureRoot) {
  const path = `${fixtureRoot}/__impact_probe__`;
  const allLanes = policy.lanes.map((lane) => lane.id);
  return routePath(policy, path, allLanes).lanes;
}

function routePath(policy, path, allLanes) {
  if (matchesAny(path, policy.globalPatterns)) return { kind: "selected", lanes: allLanes };
  const shared = policy.sharedLanePatterns.find((candidate) => matchesAny(path, candidate.patterns));
  if (shared) return { kind: "selected", lanes: shared.lanes };
  const lane = policy.lanes.find((candidate) => matchesAny(path, candidate.changePatterns));
  if (lane) return { kind: "selected", lanes: [lane.id] };
  if (matchesAny(path, policy.ignoredPatterns)) return { kind: "ignored", lanes: [] };
  return { kind: "fail-closed", lanes: allLanes };
}

function specForSnapshot(path, specs) {
  for (const spec of specs) {
    if (path.startsWith(`test/playwright/${spec}-snapshots/`)) return spec;
  }
  return undefined;
}

export function evaluate(policy, changedPaths, metadata = {}, root = ROOT) {
  const { specs, ownership } = validatePolicy(policy, root, metadata.workflowRoot ?? ROOT);
  const normalizedChangedPaths = [
    ...new Set(changedPaths.map(normalizePath).filter(Boolean)),
  ].sort();
  const allLanes = policy.lanes.map((lane) => lane.id);
  const reasons = Object.fromEntries(allLanes.map((lane) => [lane, []]));
  const ignored = [];
  const failClosed = [];

  for (const rawPath of normalizedChangedPaths) {
    const directSpec = rawPath.startsWith("test/playwright/")
      ? rawPath.slice("test/playwright/".length)
      : undefined;
    const ownedSpec = ownership.has(directSpec) ? directSpec : specForSnapshot(rawPath, specs);
    if (ownedSpec) {
      reasons[ownership.get(ownedSpec)].push(rawPath);
      continue;
    }
    const route = routePath(policy, rawPath, allLanes);
    if (route.kind === "ignored") {
      ignored.push(rawPath);
      continue;
    }
    if (route.kind === "fail-closed") failClosed.push(rawPath);
    for (const laneId of route.lanes) reasons[laneId].push(rawPath);
  }

  const selectedLanes = allLanes.filter((lane) => reasons[lane].length > 0);
  const selectedSpecs = specs.filter((spec) => selectedLanes.includes(ownership.get(spec)));
  const policyDigest = createHash("sha256")
    .update(JSON.stringify(policy))
    .digest("hex");
  const promotionExclusionReasons = [];
  if (!metadata.trust) promotionExclusionReasons.push("missing-trusted-identity");
  if (metadata.trust?.source_job_conclusion === "failure") {
    promotionExclusionReasons.push("browser-authority-failure-unattributed");
  } else if (metadata.trust && metadata.trust.source_job_conclusion !== "success") {
    promotionExclusionReasons.push("browser-authority-not-comparable");
  }
  if (normalizedChangedPaths.includes(".github/workflows/ci.yml")) {
    promotionExclusionReasons.push("source-workflow-changed");
  }
  if (normalizedChangedPaths.some((path) => TRUSTED_POLICY_INPUTS.has(path))) {
    promotionExclusionReasons.push("trusted-observer-policy-changed");
  }
  return {
    schema: OBSERVATION_SCHEMA,
    mode: "observe",
    mutation: "none",
    repository: metadata.repository ?? "",
    pull_request: metadata.pullRequest ?? 0,
    base_sha: metadata.baseSha ?? "",
    head_sha: metadata.headSha ?? "",
    evaluation_sha: metadata.evaluationSha ?? metadata.headSha ?? "",
    policy_sha256: policyDigest,
    trust: metadata.trust ?? null,
    changed_paths: normalizedChangedPaths,
    ignored_paths: ignored,
    fail_closed_paths: failClosed,
    legacy: { runs_all_specs: true, spec_count: specs.length },
    candidate: {
      selected_lanes: selectedLanes,
      skipped_lanes: allLanes.filter((lane) => !selectedLanes.includes(lane)),
      selected_specs: selectedSpecs,
      selected_spec_count: selectedSpecs.length,
      reasons,
    },
    inventory: {
      lanes: Object.fromEntries(
        allLanes.map((lane) => [lane, specs.filter((spec) => ownership.get(spec) === lane)]),
      ),
      spec_count: specs.length,
    },
    comparison: {
      avoided_spec_count: specs.length - selectedSpecs.length,
      candidate_runs_nothing: selectedLanes.length === 0,
      authoritative_execution_unchanged: true,
      promotion_sample_eligible: promotionExclusionReasons.length === 0,
      promotion_exclusion_reasons: promotionExclusionReasons,
    },
  };
}

/**
 * Evidence for a source run that can no longer be observed.
 *
 * This deliberately carries its own schema rather than an observation with
 * empty lanes: nothing downstream may mistake a skipped observation for a
 * successful one, and the artifact the observer always uploads must state, in
 * the run's own evidence, exactly which run was skipped and why.
 */
export function supersededRecord(metadata) {
  const reason = String(metadata.reason ?? "");
  if (!SUPERSEDE_REASONS.has(reason)) {
    throw new PolicyError(`unknown superseded reason: ${reason || "(empty)"}`);
  }
  return {
    schema: SUPERSEDED_SCHEMA,
    mode: "observe",
    mutation: "none",
    observed: false,
    status: "superseded",
    reason,
    stage: metadata.stage === "revalidate" ? "revalidate" : "resolve",
    repository: String(metadata.repository ?? ""),
    source_run_id: parsePositiveSafeInteger(metadata.sourceRunId, "source run id"),
    source_run_attempt: parsePositiveSafeInteger(
      metadata.sourceRunAttempt,
      "source run attempt",
    ),
    source_run_conclusion: String(metadata.sourceRunConclusion ?? ""),
    observer_run_id: parsePositiveSafeInteger(metadata.observerRunId, "observer run id"),
    observer_run_attempt: parsePositiveSafeInteger(
      metadata.observerRunAttempt,
      "observer run attempt",
    ),
    detail: String(metadata.detail ?? ""),
  };
}

export function supersededMarkdown(record) {
  return [
    "## SDK browser impact observation: SUPERSEDED (not observed)",
    "",
    `- Outcome: \`${record.status}\` at stage \`${record.stage}\` -- **no routing comparison was produced**`,
    `- Reason: \`${record.reason}\``,
    `- Source SDK CI run: \`${record.source_run_id}\` attempt \`${record.source_run_attempt}\` (\`${record.source_run_conclusion}\`)`,
    `- Observer run: \`${record.observer_run_id}\` attempt \`${record.observer_run_attempt}\``,
    `- Detail: \`${record.detail || "none"}\``,
    "",
    "The immutable workflow run this observer was handed no longer names an",
    "observable pull request: GitHub recomputes the check-run association from",
    "live repository state, so a later push, or a merge that deletes the head",
    "branch, detaches it. Nothing was compared and nothing is wrong. The head",
    "that superseded this one gets its own SDK CI run and its own observation.",
    "",
  ].join("\n");
}

export function markdown(report) {
  const lines = [
    "## SDK browser impact observation",
    "",
    `- Mode: \`${report.mode}\` (mutation: \`${report.mutation}\`)`,
    `- PR/head: \`#${report.pull_request}\` / \`${report.head_sha}\``,
    `- Evaluation snapshot: \`${report.evaluation_sha}\``,
    `- Candidate lanes: ${report.candidate.selected_lanes.length ? report.candidate.selected_lanes.map((lane) => `\`${lane}\``).join(", ") : "none"}`,
    `- Legacy specs: \`${report.legacy.spec_count}\`; candidate specs: \`${report.candidate.selected_spec_count}\``,
    `- Unknown paths failing closed to all lanes: \`${report.fail_closed_paths.length}\``,
    `- Promotion sample eligible: \`${report.comparison.promotion_sample_eligible}\`${report.comparison.promotion_exclusion_reasons.length ? ` (${report.comparison.promotion_exclusion_reasons.join(", ")})` : ""}`,
    "",
    "| Lane | Selected | Owned specs | Reasons |",
    "|---|---:|---:|---|",
  ];
  for (const [lane, specs] of Object.entries(report.inventory.lanes)) {
    const laneReasons = report.candidate.reasons[lane];
    const rendered = laneReasons.slice(0, 6).map((path) => `\`${path}\``).join("<br>") || "—";
    lines.push(`| \`${lane}\` | \`${laneReasons.length > 0}\` | \`${specs.length}\` | ${rendered} |`);
  }
  lines.push("", "This report is shadow evidence only. The existing JS SDK job still runs every Playwright spec.", "");
  return lines.join("\n");
}

export function parseChangedPaths(output) {
  const tokens = output.split("\0");
  const paths = [];
  for (let index = 0; index < tokens.length; ) {
    const status = tokens[index++];
    if (!status) continue;
    const source = tokens[index++];
    if (!source) throw new PolicyError(`missing path for git diff status ${status}`);
    paths.push(source);
    if (/^[CR][0-9]+$/u.test(status)) {
      const destination = tokens[index++];
      if (!destination) throw new PolicyError(`missing destination for git diff status ${status}`);
      paths.push(destination);
    }
  }
  return [...new Set(paths.map(normalizePath))].sort();
}

function changedPaths(base, head, root = ROOT) {
  const output = execFileSync(
    "git",
    ["diff", "--name-status", "-z", "--find-renames", "--diff-filter=ACDMRTUXB", `${base}...${head}`],
    { cwd: root, encoding: "utf8" },
  );
  return parseChangedPaths(output);
}

function parsePositiveSafeInteger(value, label) {
  const text = String(value ?? "");
  if (!/^[1-9][0-9]*$/u.test(text)) throw new PolicyError(`invalid ${label}`);
  const number = Number(text);
  if (!Number.isSafeInteger(number)) throw new PolicyError(`unsafe ${label}`);
  return number;
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function buildTrust(metadata) {
  const trust = {
    observer_run_id: parsePositiveSafeInteger(metadata.observerRunId, "observer run id"),
    observer_run_attempt: parsePositiveSafeInteger(
      metadata.observerRunAttempt,
      "observer run attempt",
    ),
    observer_event: String(metadata.observerEvent ?? ""),
    observer_ref: String(metadata.observerRef ?? ""),
    observer_repository: String(metadata.observerRepository ?? ""),
    source_run_id: parsePositiveSafeInteger(metadata.sourceRunId, "source run id"),
    source_run_attempt: parsePositiveSafeInteger(
      metadata.sourceRunAttempt,
      "source run attempt",
    ),
    source_run_conclusion: String(metadata.sourceRunConclusion ?? ""),
    source_job_id: parsePositiveSafeInteger(metadata.sourceJobId, "source job id"),
    source_job_name: String(metadata.sourceJobName ?? ""),
    source_job_conclusion: String(metadata.sourceJobConclusion ?? ""),
    source_check_run_id: parsePositiveSafeInteger(
      metadata.sourceCheckRunId,
      "source check run id",
    ),
    policy_commit_sha: String(metadata.policyCommitSha ?? ""),
    observer_workflow_sha256: String(metadata.observerWorkflowSha256 ?? ""),
    policy_blob_sha256: String(metadata.policyBlobSha256 ?? ""),
    resolver_blob_sha256: String(metadata.resolverBlobSha256 ?? ""),
    selector_blob_sha256: String(metadata.selectorBlobSha256 ?? ""),
  };
  if (!SHA.test(trust.policy_commit_sha)) {
    throw new PolicyError("invalid trusted policy commit SHA");
  }
  if (
    !OBSERVER_EVENTS.has(trust.observer_event) ||
    trust.observer_ref !== "refs/heads/trunk" ||
    trust.observer_repository !== "honua-io/honua-sdk-js" ||
    trust.source_job_name !== "JS SDK" ||
    !TERMINAL_CONCLUSIONS.has(trust.source_run_conclusion) ||
    !TERMINAL_CONCLUSIONS.has(trust.source_job_conclusion)
  ) {
    throw new PolicyError("trusted source workflow identity is incomplete");
  }
  for (const field of TRUSTED_MANIFEST_ORDER) {
    if (!SHA256.test(trust[field])) throw new PolicyError(`invalid ${field}`);
  }
  const manifest = TRUSTED_MANIFEST_ORDER.map((field) => `${field} ${trust[field]}\n`).join("");
  trust.policy_manifest_sha256 = createHash("sha256").update(manifest).digest("hex");
  return trust;
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const values = { command };
  for (let index = 0; index < rest.length; index += 2) {
    if (!rest[index]?.startsWith("--") || rest[index + 1] === undefined) {
      throw new PolicyError(`invalid argument sequence near ${rest[index] ?? "end"}`);
    }
    values[rest[index].slice(2)] = rest[index + 1];
  }
  return values;
}

function main(argv) {
  const args = parseArgs(argv);
  if (args.command === "reconstruct") {
    if (!args.base || !args.head || !args["candidate-root"]) {
      throw new PolicyError("reconstruct requires --base, --head, and --candidate-root");
    }
    console.log(
      JSON.stringify(reconstructEventMerge(args.base, args.head, args["candidate-root"])),
    );
    return;
  }
  if (args.command === "superseded") {
    if (!args.output || !args.markdown) {
      throw new PolicyError("superseded requires --output and --markdown");
    }
    const record = supersededRecord({
      reason: args.reason,
      stage: args.stage,
      repository: args.repository,
      sourceRunId: args["source-run-id"],
      sourceRunAttempt: args["source-run-attempt"],
      sourceRunConclusion: args["source-run-conclusion"],
      observerRunId: args["observer-run-id"],
      observerRunAttempt: args["observer-run-attempt"],
      detail: args.detail,
    });
    for (const target of [args.output, args.markdown]) {
      mkdirSync(dirname(resolve(ROOT, target)), { recursive: true });
    }
    writeFileSync(resolve(ROOT, args.output), `${JSON.stringify(record, null, 2)}\n`);
    writeFileSync(resolve(ROOT, args.markdown), supersededMarkdown(record));
    console.log(JSON.stringify(record));
    return;
  }
  if (args.command === "event-tree") {
    if (!args.base || !args.head) {
      throw new PolicyError("event-tree requires --base and --head");
    }
    console.log(resolveEventMergeTree(args.base, args.head));
    return;
  }
  const candidateRoot = args.root ? resolve(args.root) : ROOT;
  const policyPath = args.policy ? resolve(args.policy) : DEFAULT_POLICY;
  if (policyPath !== DEFAULT_POLICY) {
    throw new PolicyError("observation policy must be the trusted checked-in policy");
  }
  const policy = loadPolicy(policyPath);
  const validated = validatePolicy(policy, candidateRoot, ROOT);
  if (args.command === "validate") {
    console.log(`browser-impact=ok mode=observe specs=${validated.specs.length} lanes=${policy.lanes.length}`);
    return;
  }
  if (args.command !== "observe" || !args.base || !args.head || !args.output || !args.markdown) {
    throw new PolicyError("observe requires --base, --head, --output, and --markdown");
  }
  if (
    !SHA.test(args.base) ||
    !SHA.test(args.head) ||
    !SHA.test(args["source-head"] ?? "") ||
    args.repository !== "honua-io/honua-sdk-js"
  ) {
    throw new PolicyError("observation repository or commit identity is invalid");
  }
  const pullRequestNumber = parsePositiveSafeInteger(args.pr, "pull request number");
  const trust = buildTrust({
    observerRunId: args["observer-run-id"],
    observerRunAttempt: args["observer-run-attempt"],
    observerEvent: args["observer-event"],
    observerRef: args["observer-ref"],
    observerRepository: args["observer-repository"],
    sourceRunId: args["source-run-id"],
    sourceRunAttempt: args["source-run-attempt"],
    sourceRunConclusion: args["source-run-conclusion"],
    sourceJobId: args["source-job-id"],
    sourceJobName: args["source-job-name"],
    sourceJobConclusion: args["source-job-conclusion"],
    sourceCheckRunId: args["source-check-run-id"],
    policyCommitSha: execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: ROOT,
      encoding: "utf8",
    }).trim(),
    observerWorkflowSha256: sha256File(
      resolve(ROOT, ".github/workflows/browser-impact-observe.yml"),
    ),
    policyBlobSha256: sha256File(DEFAULT_POLICY),
    resolverBlobSha256: sha256File(resolve(ROOT, "scripts/trusted-pr-workflow-run.cjs")),
    selectorBlobSha256: sha256File(resolve(ROOT, "scripts/browser-impact-observe.mjs")),
  });
  const trustedDefaultHead = execFileSync("git", ["rev-parse", "origin/trunk"], {
    cwd: ROOT,
    encoding: "utf8",
  }).trim();
  assertTrustedPolicyCommit(trust.policy_commit_sha, trustedDefaultHead, (ancestor, descendant) => {
    try {
      execFileSync("git", ["merge-base", "--is-ancestor", ancestor, descendant], {
        cwd: ROOT,
        stdio: "ignore",
      });
      return true;
    } catch {
      return false;
    }
  });
  const report = evaluate(
    policy,
    changedPaths(args.base, args.head, candidateRoot),
    {
      baseSha: args.base,
      headSha: args["source-head"] ?? args.head,
      evaluationSha: args.head,
      repository: args.repository,
      pullRequest: pullRequestNumber,
      trust,
      workflowRoot: ROOT,
    },
    candidateRoot,
  );
  for (const target of [args.output, args.markdown]) {
    mkdirSync(dirname(resolve(ROOT, target)), { recursive: true });
  }
  writeFileSync(resolve(ROOT, args.output), `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(resolve(ROOT, args.markdown), markdown(report));
  console.log(JSON.stringify(report));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(`browser-impact: ${error.message}`);
    process.exitCode = 2;
  }
}
