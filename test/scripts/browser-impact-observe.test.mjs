import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  assignSpecs,
  discoverBrowserFixtureRoots,
  discoverSpecs,
  evaluate,
  loadPolicy,
  parseChangedPaths,
  pathMatches,
  validatePolicy,
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

test("domain changes select only their owned browser evidence", () => {
  const offline = evaluate(policy, ["src/offline/indexeddb.ts"]);
  assert.deepEqual(offline.candidate.selected_lanes, ["offline-service-worker"]);
  const realtime = evaluate(policy, ["examples/realtime-incident-dashboard/src/main.ts"]);
  assert.deepEqual(realtime.candidate.selected_lanes, ["realtime-collaboration"]);
  const heavy = evaluate(policy, ["examples/kepler-analytics/src/main.ts"]);
  assert.deepEqual(heavy.candidate.selected_lanes, ["heavy-map-kepler"]);
  const quickstart = evaluate(policy, ["examples/maplibre-quickstart/mock-server.mjs"]);
  assert.deepEqual(quickstart.candidate.selected_lanes, ["heavy-map-kepler"]);
  const columnar = evaluate(policy, ["examples/columnar-query-quickstart/vite.config.ts"]);
  assert.deepEqual(columnar.candidate.selected_lanes, ["heavy-map-kepler"]);
});

test("shared app modules select realtime and general consumers", () => {
  for (const path of ["src/exploration/query.ts", "src/interactions/linked-view.ts"]) {
    const report = evaluate(policy, [path]);
    assert.deepEqual(report.candidate.selected_lanes, ["realtime-collaboration", "examples-general"]);
  }
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

test("glob matching treats repository prefixes and wildcards deterministically", () => {
  assert.equal(pathMatches("src/offline/indexeddb.ts", "src/offline/**"), true);
  assert.equal(pathMatches("test/offline-region.test.ts", "test/offline-*.test.ts"), true);
  assert.equal(pathMatches("test/realtime.test.ts", "test/offline-*.test.ts"), false);
});
