import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  assignSpecs,
  buildTrust,
  discoverBrowserFixtureRoots,
  discoverLocalModuleDependencies,
  discoverSpecs,
  evaluate,
  loadPolicy,
  parseChangedPaths,
  pathMatches,
  validatePolicy,
  validateWorkflow,
} from "../../scripts/browser-impact-observe.mjs";

const policy = loadPolicy();

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

test("owns every current Playwright spec exactly once", () => {
  const { specs, ownership } = validatePolicy(policy);
  assert.equal(specs.length, discoverSpecs().length);
  assert.equal(ownership.size, specs.length);
  assert.deepEqual([...new Set(ownership.values())].sort(), [
    "examples-general",
    "heavy-map-kepler",
    "offline-service-worker",
    "realtime-collaboration",
  ]);
});

test("assigns special domains before the general fallback", () => {
  const ownership = assignSpecs(policy, [
    "offline-indexeddb.spec.mjs",
    "realtime-incident-dashboard.spec.mjs",
    "kepler-arrow-packed.spec.mjs",
    "service-explorer.spec.mjs",
  ]);
  assert.equal(ownership.get("offline-indexeddb.spec.mjs"), "offline-service-worker");
  assert.equal(ownership.get("realtime-incident-dashboard.spec.mjs"), "realtime-collaboration");
  assert.equal(ownership.get("kepler-arrow-packed.spec.mjs"), "heavy-map-kepler");
  assert.equal(ownership.get("service-explorer.spec.mjs"), "examples-general");
});

test("global generated-asset inputs select every lane", () => {
  const report = evaluate(policy, ["src/core/error-classifications.ts"]);
  assert.deepEqual(report.candidate.selected_lanes, policy.lanes.map((lane) => lane.id));
  assert.equal(report.comparison.avoided_spec_count, 0);
  assert.deepEqual(report.fail_closed_paths, []);
});

test("domain changes select every direct browser consumer", () => {
  const offline = evaluate(policy, ["src/offline/indexeddb.ts"]);
  assert.deepEqual(offline.candidate.selected_lanes, ["offline-service-worker", "examples-general"]);
  const realtime = evaluate(policy, ["examples/realtime-incident-dashboard/src/main.ts"]);
  assert.deepEqual(realtime.candidate.selected_lanes, ["realtime-collaboration"]);
  const heavy = evaluate(policy, ["examples/kepler-analytics/src/main.ts"]);
  assert.deepEqual(heavy.candidate.selected_lanes, ["heavy-map-kepler"]);
  const quickstart = evaluate(policy, ["examples/maplibre-quickstart/mock-server.mjs"]);
  assert.deepEqual(quickstart.candidate.selected_lanes, ["heavy-map-kepler"]);
  const columnar = evaluate(policy, ["examples/columnar-query-quickstart/vite.config.ts"]);
  assert.deepEqual(columnar.candidate.selected_lanes, ["heavy-map-kepler"]);
});

test("shared app modules select every direct browser consumer", () => {
  for (const path of ["src/exploration/query.ts", "src/interactions/linked-view.ts"]) {
    const report = evaluate(policy, [path]);
    assert.deepEqual(report.candidate.selected_lanes, [
      "realtime-collaboration",
      "heavy-map-kepler",
      "examples-general",
    ]);
  }
  const realtime = evaluate(policy, ["src/realtime/index.ts"]);
  assert.deepEqual(realtime.candidate.selected_lanes, ["realtime-collaboration", "examples-general"]);
});

test("offline cache primitives select the heavy columnar browser consumer", () => {
  for (const path of ["src/offline/digest.ts", "src/offline/quota.ts"]) {
    const report = evaluate(policy, [path]);
    assert.deepEqual(report.candidate.selected_lanes, [
      "offline-service-worker",
      "heavy-map-kepler",
      "examples-general",
    ]);
  }
});

test("discovers SDK package entry dependencies from browser fixtures", () => {
  const dependencies = discoverLocalModuleDependencies("examples/unified-ops-workspace");
  assert.ok(dependencies.some((path) => path.startsWith("src/realtime/")));
});

test("shared fixtures select every direct browser consumer", () => {
  const spatial = evaluate(policy, ["examples/spatial-analytics-workbench/src/kepler-handoff.ts"]);
  assert.deepEqual(spatial.candidate.selected_lanes, ["heavy-map-kepler", "examples-general"]);
  const firstMap = evaluate(policy, ["samples/fixtures/first-map/v2/features.json"]);
  assert.deepEqual(firstMap.candidate.selected_lanes, policy.lanes.map((lane) => lane.id));
  const scenarios = evaluate(policy, ["samples/scenarios/index.mjs"]);
  assert.deepEqual(scenarios.candidate.selected_lanes, policy.lanes.map((lane) => lane.id));
  const sharedRenderer = evaluate(policy, ["docs/examples/shared-renderer-state/app.mjs"]);
  assert.deepEqual(sharedRenderer.candidate.selected_lanes, ["heavy-map-kepler"]);
  const sharedKit = evaluate(policy, ["examples/_kit/vite.config.ts"]);
  assert.deepEqual(sharedKit.candidate.selected_lanes, [
    "realtime-collaboration",
    "heavy-map-kepler",
    "examples-general",
  ]);
  const sharedExample = evaluate(policy, ["examples/shared/maplibre-vite-worker.js"]);
  assert.deepEqual(sharedExample.candidate.selected_lanes, policy.lanes.map((lane) => lane.id));
});

test("every browser-served example root routes to the owning spec lane", () => {
  const specs = discoverSpecs();
  const ownership = assignSpecs(policy, specs);
  for (const spec of specs) {
    const source = readFileSync(`test/playwright/${spec}`, "utf8");
    const dependencies = discoverBrowserFixtureRoots(source);
    for (const dependency of dependencies) {
      const report = evaluate(policy, [`${dependency}/__impact_probe__`]);
      assert.ok(
        report.candidate.selected_lanes.includes(ownership.get(spec)),
        `${dependency} must select ${ownership.get(spec)} for ${spec}`,
      );
    }
  }
});

test("discovers split path.join fixture roots", () => {
  const source = `
    path.join(projectRoot, "docs", "examples", "automatic-source-workflow");
    path.join(projectRoot, "examples", "kepler-analytics", "dist");
  `;
  assert.deepEqual(discoverBrowserFixtureRoots(source), [
    "docs/examples/automatic-source-workflow",
    "examples/kepler-analytics",
  ]);
});

test("full upstream base fetch preserves the merge base for a fork head", () => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "honua-browser-impact-fork-"));
  try {
    const upstream = join(fixtureRoot, "upstream");
    const fork = join(fixtureRoot, "fork.git");
    const forkWork = join(fixtureRoot, "fork-work");
    const observer = join(fixtureRoot, "observer");
    mkdirSync(upstream);
    git(upstream, "init", "--initial-branch=trunk");
    git(upstream, "config", "user.email", "ci@example.invalid");
    git(upstream, "config", "user.name", "CI Fixture");
    writeFileSync(join(upstream, "fixture.txt"), "base\n");
    git(upstream, "add", "fixture.txt");
    git(upstream, "commit", "-m", "base");
    const mergeBase = git(upstream, "rev-parse", "HEAD");

    git(fixtureRoot, "clone", "--bare", upstream, fork);
    git(fixtureRoot, "clone", fork, forkWork);
    git(forkWork, "config", "user.email", "fork@example.invalid");
    git(forkWork, "config", "user.name", "Fork Fixture");
    git(forkWork, "switch", "-c", "feature");
    writeFileSync(join(forkWork, "fork.txt"), "fork\n");
    git(forkWork, "add", "fork.txt");
    git(forkWork, "commit", "-m", "fork head");
    git(forkWork, "push", "origin", "HEAD:feature");

    for (const value of ["base-advanced-once\n", "base-advanced-twice\n"]) {
      writeFileSync(join(upstream, "fixture.txt"), value);
      git(upstream, "add", "fixture.txt");
      git(upstream, "commit", "-m", value.trim());
    }
    const baseSha = git(upstream, "rev-parse", "HEAD");

    git(fixtureRoot, "clone", "--branch", "feature", fork, observer);
    assert.throws(() => git(observer, "cat-file", "-e", `${baseSha}^{commit}`));
    git(observer, "fetch", "--no-tags", "--filter=blob:none", upstream, baseSha);
    assert.equal(git(observer, "merge-base", baseSha, "HEAD"), mergeBase);
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test("rename parsing evaluates both source and destination paths", () => {
  const paths = parseChangedPaths(
    "R100\0examples/maplibre-quickstart/mock-server.mjs\0docs/archive/mock-server.mjs\0M\0README.md\0",
  );
  assert.deepEqual(paths, [
    "README.md",
    "docs/archive/mock-server.mjs",
    "examples/maplibre-quickstart/mock-server.mjs",
  ]);
  const report = evaluate(policy, paths);
  assert.ok(report.candidate.selected_lanes.includes("heavy-map-kepler"));
});

test("direct spec and snapshot changes select the owning lane", () => {
  const spec = evaluate(policy, ["test/playwright/service-explorer.spec.mjs"]);
  assert.deepEqual(spec.candidate.selected_lanes, ["examples-general"]);
  const snapshot = evaluate(policy, [
    "test/playwright/imagery-cog-quickstart.spec.mjs-snapshots/render-chromium-linux.png",
  ]);
  assert.deepEqual(snapshot.candidate.selected_lanes, ["heavy-map-kepler"]);
});

test("unknown paths fail closed and documentation-only paths may select nothing", () => {
  const unknown = evaluate(policy, ["new-build-system/opaque-input.bin"]);
  assert.deepEqual(unknown.candidate.selected_lanes, policy.lanes.map((lane) => lane.id));
  assert.deepEqual(unknown.fail_closed_paths, ["new-build-system/opaque-input.bin"]);
  const docs = evaluate(policy, ["docs/decisions/unrelated.md"]);
  assert.deepEqual(docs.candidate.selected_lanes, []);
  assert.equal(docs.comparison.authoritative_execution_unchanged, true);
});

test("records the source head and merge-tree evaluation snapshot separately", () => {
  const report = evaluate(policy, ["docs/decisions/unrelated.md"], {
    headSha: "source-head",
    evaluationSha: "synthetic-merge",
  });
  assert.equal(report.head_sha, "source-head");
  assert.equal(report.evaluation_sha, "synthetic-merge");
  assert.match(report.mode, /^observe$/u);
});

test("binds v2 evidence to a fixed ordered trusted-policy manifest", () => {
  const trust = buildTrust({
    observerRunId: "789",
    observerRunAttempt: "1",
    observerEvent: "workflow_run",
    observerRef: "refs/heads/trunk",
    observerRepository: "honua-io/honua-sdk-js",
    sourceRunId: "123",
    sourceRunAttempt: "2",
    sourceRunConclusion: "failure",
    sourceJobId: "456",
    sourceJobName: "JS SDK",
    sourceJobConclusion: "success",
    sourceCheckRunId: "456",
    policyCommitSha: "a".repeat(40),
    observerWorkflowSha256: "d".repeat(64),
    policyBlobSha256: "e".repeat(64),
    resolverBlobSha256: "f".repeat(64),
    selectorBlobSha256: "0".repeat(64),
  });
  const report = evaluate(policy, ["docs/decisions/unrelated.md"], { trust });
  assert.equal(report.schema, "honua.sdk.browser-impact-observation/v2");
  assert.equal(report.trust.source_run_id, 123);
  assert.equal(report.trust.source_run_conclusion, "failure");
  assert.equal(report.trust.source_job_conclusion, "success");
  assert.equal(report.comparison.promotion_sample_eligible, true);
  assert.match(report.trust.policy_manifest_sha256, /^[0-9a-f]{64}$/u);
});

test("excludes policy and source-workflow changes from promotion samples", () => {
  const trust = buildTrust({
    observerRunId: "789",
    observerRunAttempt: "1",
    observerEvent: "workflow_run",
    observerRef: "refs/heads/trunk",
    observerRepository: "honua-io/honua-sdk-js",
    sourceRunId: "123",
    sourceRunAttempt: "2",
    sourceRunConclusion: "success",
    sourceJobId: "456",
    sourceJobName: "JS SDK",
    sourceJobConclusion: "success",
    sourceCheckRunId: "456",
    policyCommitSha: "a".repeat(40),
    observerWorkflowSha256: "b".repeat(64),
    policyBlobSha256: "c".repeat(64),
    resolverBlobSha256: "d".repeat(64),
    selectorBlobSha256: "e".repeat(64),
  });
  const report = evaluate(
    policy,
    [".github/workflows/ci.yml", "scripts/trusted-pr-workflow-run.cjs"],
    { trust },
  );
  assert.equal(report.comparison.promotion_sample_eligible, false);
  assert.deepEqual(report.comparison.promotion_exclusion_reasons, [
    "source-workflow-changed",
    "trusted-observer-policy-changed",
  ]);
});

test("rejects incomplete or malformed trusted evidence identity", () => {
  const valid = {
    observerRunId: "789",
    observerRunAttempt: "1",
    observerEvent: "workflow_run",
    observerRef: "refs/heads/trunk",
    observerRepository: "honua-io/honua-sdk-js",
    sourceRunId: "123",
    sourceRunAttempt: "2",
    sourceRunConclusion: "success",
    sourceJobId: "456",
    sourceJobName: "JS SDK",
    sourceJobConclusion: "success",
    sourceCheckRunId: "456",
    policyCommitSha: "a".repeat(40),
    observerWorkflowSha256: "b".repeat(64),
    policyBlobSha256: "c".repeat(64),
    resolverBlobSha256: "d".repeat(64),
    selectorBlobSha256: "e".repeat(64),
  };
  assert.throws(() => buildTrust({ ...valid, sourceRunAttempt: "0" }), /source run attempt/u);
  assert.throws(
    () => buildTrust({ ...valid, policyCommitSha: "short" }),
    /policy commit SHA/u,
  );
  assert.throws(
    () => buildTrust({ ...valid, selectorBlobSha256: "short" }),
    /selector_blob_sha256/u,
  );
  assert.throws(
    () => buildTrust({ ...valid, observerRef: "refs/heads/feature" }),
    /workflow identity/u,
  );
  assert.throws(
    () => buildTrust({ ...valid, observerRepository: "fork/honua-sdk-js" }),
    /workflow identity/u,
  );
});

test("trusted observer workflow rejects permission and identity regressions", () => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "honua-browser-impact-workflow-"));
  const workflowDirectory = join(fixtureRoot, ".github", "workflows");
  mkdirSync(workflowDirectory, { recursive: true });
  const source = readFileSync(".github/workflows/browser-impact-observe.yml", "utf8");
  try {
    const workflowPath = join(workflowDirectory, "browser-impact-observe.yml");
    writeFileSync(workflowPath, source);
    assert.doesNotThrow(() => validateWorkflow(fixtureRoot));
    for (const mutated of [
      source.replace("  checks: read", "  checks: write"),
      source.replace("  pull-requests: read", "  pull-requests: write"),
      source.replace("  contents: read", "  contents: read\n  issues: read"),
      source.replace('jobName: "JS SDK"', 'jobName: "MCP SDK"'),
      source.replace('workflows: ["SDK CI"]', 'workflows: ["Lookalike"]'),
      source.replace(
        '[[ "$MERGE_HEAD" == "$HEAD_SHA" ]]',
        '[[ "$MERGE_HEAD" != "$HEAD_SHA" ]]',
      ),
      source.replace('--head "$MERGE_SHA"', '--head "$HEAD_SHA"'),
    ]) {
      writeFileSync(workflowPath, mutated);
      assert.throws(() => validateWorkflow(fixtureRoot), /browser observer/u);
    }
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test("glob matching treats repository prefixes and wildcards deterministically", () => {
  assert.equal(pathMatches("src/offline/indexeddb.ts", "src/offline/**"), true);
  assert.equal(pathMatches("test/offline-region.test.ts", "test/offline-*.test.ts"), true);
  assert.equal(pathMatches("test/realtime.test.ts", "test/offline-*.test.ts"), false);
});
