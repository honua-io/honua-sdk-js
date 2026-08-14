#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_POLICY = resolve(ROOT, ".github/data/browser-impact-policy.v1.json");
const OBSERVATION_SCHEMA = "honua.sdk.browser-impact-observation/v1";
const EXPECTED_LANES = [
  "offline-service-worker",
  "realtime-collaboration",
  "heavy-map-kepler",
  "examples-general",
];

export class PolicyError extends Error {}

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

function validateWorkflow(root) {
  const workflowPath = resolve(root, ".github/workflows/browser-impact-observe.yml");
  const workflow = readFileSync(workflowPath, "utf8");
  if (/^\s{4}paths(?:-ignore)?:/mu.test(workflow)) {
    throw new PolicyError("browser observer must run on every pull request");
  }
  for (const forbidden of ["playwright test", "gh run cancel", "cancelWorkflowRun", "pull_request_target"]) {
    if (workflow.includes(forbidden)) {
      throw new PolicyError(`observe-only workflow contains forbidden authority: ${forbidden}`);
    }
  }
  if (workflow.includes("--depth=1")) {
    throw new PolicyError("browser observer must not shallow-fetch the upstream base");
  }
  if (!workflow.includes('git merge-base "$BASE_SHA" "$HEAD_SHA"')) {
    throw new PolicyError("browser observer must prove the exact diff has a merge base");
  }
}

export function validatePolicy(policy, root = ROOT) {
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
  for (const spec of specs) {
    const source = readFileSync(resolve(root, "test/playwright", spec), "utf8");
    for (const fixtureRoot of discoverBrowserFixtureRoots(source)) {
      const selectedLanes = selectedLanesForFixtureRoot(policy, fixtureRoot);
      if (!selectedLanes.includes(ownership.get(spec))) {
        throw new PolicyError(`${fixtureRoot} must select ${ownership.get(spec)} for ${spec}`);
      }
    }
  }
  validateWorkflow(root);
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
  const { specs, ownership } = validatePolicy(policy, root);
  const allLanes = policy.lanes.map((lane) => lane.id);
  const reasons = Object.fromEntries(allLanes.map((lane) => [lane, []]));
  const ignored = [];
  const failClosed = [];

  for (const rawPath of [...new Set(changedPaths.map(normalizePath).filter(Boolean))].sort()) {
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
  return {
    schema: OBSERVATION_SCHEMA,
    mode: "observe",
    mutation: "none",
    repository: metadata.repository ?? "",
    pull_request: metadata.pullRequest ?? 0,
    base_sha: metadata.baseSha ?? "",
    head_sha: metadata.headSha ?? "",
    policy_sha256: policyDigest,
    changed_paths: [...new Set(changedPaths.map(normalizePath).filter(Boolean))].sort(),
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
    },
  };
}

export function markdown(report) {
  const lines = [
    "## SDK browser impact observation",
    "",
    `- Mode: \`${report.mode}\` (mutation: \`${report.mutation}\`)`,
    `- PR/head: \`#${report.pull_request}\` / \`${report.head_sha}\``,
    `- Candidate lanes: ${report.candidate.selected_lanes.length ? report.candidate.selected_lanes.map((lane) => `\`${lane}\``).join(", ") : "none"}`,
    `- Legacy specs: \`${report.legacy.spec_count}\`; candidate specs: \`${report.candidate.selected_spec_count}\``,
    `- Unknown paths failing closed to all lanes: \`${report.fail_closed_paths.length}\``,
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

function changedPaths(base, head) {
  const output = execFileSync(
    "git",
    ["diff", "--name-status", "-z", "--find-renames", "--diff-filter=ACDMRTUXB", `${base}...${head}`],
    { cwd: ROOT, encoding: "utf8" },
  );
  return parseChangedPaths(output);
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
  const policy = loadPolicy(args.policy ? resolve(ROOT, args.policy) : DEFAULT_POLICY);
  const validated = validatePolicy(policy);
  if (args.command === "validate") {
    console.log(`browser-impact=ok mode=observe specs=${validated.specs.length} lanes=${policy.lanes.length}`);
    return;
  }
  if (args.command !== "observe" || !args.base || !args.head || !args.output || !args.markdown) {
    throw new PolicyError("observe requires --base, --head, --output, and --markdown");
  }
  const report = evaluate(policy, changedPaths(args.base, args.head), {
    baseSha: args.base,
    headSha: args.head,
    repository: args.repository,
    pullRequest: Number(args.pr ?? 0),
  });
  for (const target of [args.output, args.markdown]) mkdirSync(dirname(resolve(ROOT, target)), { recursive: true });
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
