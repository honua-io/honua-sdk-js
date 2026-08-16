import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { parse as parseYaml } from "yaml";

import { loadBrowserShardMap } from "../../scripts/lib/browser-shards.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const GRAPH_WORKFLOW = ".github/workflows/sdk-verification.yml";
const CI_WORKFLOW = ".github/workflows/ci.yml";

function readWorkflow(relativePath) {
  return parseYaml(fs.readFileSync(path.join(root, relativePath), "utf8"));
}

const graph = readWorkflow(GRAPH_WORKFLOW);
const ci = readWorkflow(CI_WORKFLOW);

function steps(workflow, jobId) {
  const job = workflow.jobs?.[jobId];
  assert.ok(job, `${jobId} is not a job in this workflow`);
  return job.steps ?? [];
}

function runScript(step) {
  return typeof step?.run === "string" ? step.run : "";
}

/**
 * The directory a step's commands actually act on. It decides gate identity:
 * `npm run build` in the repository root compiles the SDK, while the same
 * words under `mcp/` compile the MCP server, and conflating them would let a
 * consumer rebuild the SDK unnoticed.
 *
 * `--prefix ..` is the one escape ci.yml uses: the MCP job inherits the `mcp`
 * working directory but reaches back up to install and build the root package.
 */
function effectiveDirectory(workflow, jobId, step, script) {
  if (/--prefix\s+\.\./u.test(script)) return ".";
  const explicit = step?.["working-directory"];
  const jobDefault = workflow.jobs[jobId]?.defaults?.run?.["working-directory"];
  const workflowDefault = workflow.defaults?.run?.["working-directory"];
  const directory = explicit ?? jobDefault ?? workflowDefault ?? ".";
  return directory === "" ? "." : directory;
}

/**
 * The set of commands a job actually invokes, identified by working directory
 * plus program plus script name rather than by literal line. Comparing literal
 * lines would break on an added flag or a shell wrapper
 * (`timeout --foreground ... npm ci`) while saying nothing about whether the
 * gate still runs.
 */
function invokedCommands(script, directory = ".") {
  const found = new Set();
  const scope = directory === "." ? "" : `${directory}:`;
  const add = (command) => found.add(`${scope}${command}`);
  for (const [, name] of script.matchAll(/\bnpm run ([a-z0-9:._-]+)/gu)) add(`npm run ${name}`);
  for (const [, name] of script.matchAll(/\bnpm (ci|test|audit)\b/gu)) add(`npm ${name}`);
  for (const [, name] of script.matchAll(/\bnpx ([a-z0-9@/._-]+)/gu)) add(`npx ${name}`);
  for (const match of script.matchAll(/\bnode (?:--test )?([^\s"']+\.(?:mjs|js|cjs))/gu)) {
    add(`node ${match[1]}`);
  }
  return found;
}

function jobCommands(workflow, jobId) {
  const found = new Set();
  for (const step of steps(workflow, jobId)) {
    const script = runScript(step);
    for (const command of invokedCommands(script, effectiveDirectory(workflow, jobId, step, script))) {
      found.add(command);
    }
  }
  return found;
}

function workflowCommands(workflow) {
  const found = new Set();
  for (const jobId of Object.keys(workflow.jobs)) {
    for (const command of jobCommands(workflow, jobId)) found.add(command);
  }
  return found;
}

const CONSUMER_JOBS = ["verify-core", "verify-package", "verify-examples", "mcp", "browser"];
const LONG_JOBS = ["quickstart-budget", "build", ...CONSUMER_JOBS];

describe("the SDK verification graph produces one build and consumes it", () => {
  it("builds the SDK in exactly one job", () => {
    const builders = Object.keys(graph.jobs).filter((jobId) => jobCommands(graph, jobId).has("npm run build"));
    assert.deepEqual(builders, ["build"], "exactly one producer job may compile the SDK");
  });

  it("publishes the build under a name derived from its own fingerprint", () => {
    const upload = steps(graph, "build").find((step) => String(step.uses ?? "").includes("upload-artifact"));
    assert.ok(upload, "the producer must upload the reusable build");
    assert.equal(upload.with.name, "${{ steps.evidence.outputs.artifact-name }}");
    assert.equal(upload.with["if-no-files-found"], "error");
    // .tmp/ is a dotted path; without this the prepared manifest silently would
    // not travel and every consumer would rebuild.
    assert.equal(upload.with["include-hidden-files"], true);
    const paths = String(upload.with.path);
    assert.match(paths, /(^|\n)\s*dist\/\s*$/mu);
    assert.match(paths, /\.tmp\/prepared-sdk-artifact\/manifest\.json/u);
    assert.match(paths, /\.artifacts\/sdk-build\/evidence\.v1\.json/u);
    assert.equal(graph.jobs.build.outputs.artifact_name, "${{ steps.evidence.outputs.artifact-name }}");
  });

  it("has every consumer download that exact build and admit it before using it", () => {
    for (const jobId of CONSUMER_JOBS) {
      const jobSteps = steps(graph, jobId);
      const downloadIndex = jobSteps.findIndex((step) => String(step.uses ?? "").includes("download-artifact"));
      assert.ok(downloadIndex >= 0, `${jobId} must download the reusable build`);
      const download = jobSteps[downloadIndex];
      assert.equal(
        download.with.name,
        "${{ needs.build.outputs.artifact_name }}",
        `${jobId} must name the exact producer artifact`,
      );
      // NFR-001: no pattern, no merge, no nearest match.
      for (const forbidden of ["pattern", "merge-multiple", "run-id"]) {
        assert.equal(download.with[forbidden], undefined, `${jobId} must not resolve the build by ${forbidden}`);
      }

      const admitIndex = jobSteps.findIndex((step) =>
        runScript(step).includes("scripts/sdk-build-evidence.mjs verify"),
      );
      assert.ok(admitIndex > downloadIndex, `${jobId} must admit the build immediately after downloading it`);
      assert.ok(graph.jobs[jobId].needs.includes("build"), `${jobId} must depend on the producer`);
    }
  });

  it("never rebuilds the SDK in a consumer", () => {
    for (const jobId of CONSUMER_JOBS) {
      assert.equal(jobCommands(graph, jobId).has("npm run build"), false, `${jobId} must not rebuild the SDK`);
    }
  });

  it("uses only the first-party artifact actions, so there is no cross-run fallback", () => {
    for (const jobId of Object.keys(graph.jobs)) {
      for (const step of steps(graph, jobId)) {
        const uses = String(step.uses ?? "");
        if (!uses.includes("artifact")) continue;
        assert.match(uses, /^actions\/(?:upload|download)-artifact@[0-9a-f]{40}/u);
      }
    }
  });

  it("measures the clean-install quickstart budget without the reusable build", () => {
    // Handing this job a prebuilt SDK would measure a different thing than the
    // five-minute promise it exists to keep.
    const jobSteps = steps(graph, "quickstart-budget");
    assert.equal(
      jobSteps.some((step) => String(step.uses ?? "").includes("download-artifact")),
      false,
    );
    assert.ok(jobCommands(graph, "quickstart-budget").has("npm run docs:quickstart:time-to-map"));
  });
});

describe("browser evidence is sharded by owned failure domain", () => {
  const shardMap = loadBrowserShardMap(root);

  it("runs one job per reviewed shard, from the audited matrix", () => {
    assert.equal(graph.jobs.browser.strategy.matrix, "${{ fromJSON(needs.admission.outputs.browser_matrix) }}");
    assert.ok(graph.jobs.admission.outputs.browser_matrix);
    assert.ok(shardMap.shards.length >= 4, "REQ-004 requires at least four browser failure domains");
  });

  it("does not let one failed domain cancel the others", () => {
    assert.equal(graph.jobs.browser.strategy["fail-fast"], false);
  });

  it("selects the shard through the reviewed partition, not an ad-hoc filter", () => {
    assert.equal(graph.jobs.browser.env.HONUA_BROWSER_SHARD, "${{ matrix.shard }}");
    assert.ok(jobCommands(graph, "browser").has("npm run test:playwright:prepared"));
  });

  it("audits the partition before any browser job starts", () => {
    const admissionScripts = steps(graph, "admission").map(runScript).join("\n");
    assert.match(admissionScripts, /scripts\/browser-shards\.mjs check/u);
    assert.ok(graph.jobs.browser.needs.includes("admission"));
  });
});

describe("generated offline evidence normalizes before browser execution", () => {
  it("checks the offline shell pins in the producer, right after the build", () => {
    const jobSteps = steps(graph, "build");
    const buildIndex = jobSteps.findIndex((step) => invokedCommands(runScript(step)).has("npm run build"));
    const checkIndex = jobSteps.findIndex((step) =>
      invokedCommands(runScript(step)).has("npm run offline:shell-manifest:check"),
    );
    assert.ok(buildIndex >= 0 && checkIndex > buildIndex, "the pins are recomputed against the dist just emitted");
  });

  it("keeps the producer free of browser work, so a stale pin fails before any browser is provisioned", () => {
    const commands = jobCommands(graph, "build");
    assert.equal(commands.has("npm run test:playwright:prepared"), false);
    assert.equal(commands.has("npx playwright"), false);
  });

  it("re-checks the pins in every browser shard before the suite runs", () => {
    const jobSteps = steps(graph, "browser");
    const checkIndex = jobSteps.findIndex((step) =>
      invokedCommands(runScript(step)).has("npm run offline:shell-manifest:check"),
    );
    const suiteIndex = jobSteps.findIndex((step) =>
      invokedCommands(runScript(step)).has("npm run test:playwright:prepared"),
    );
    assert.ok(checkIndex >= 0 && suiteIndex > checkIndex);
  });
});

describe("the aggregate gate cannot report green for a graph that did not run", () => {
  it("depends on every other job", () => {
    const others = Object.keys(graph.jobs).filter((jobId) => jobId !== "verified");
    assert.deepEqual([...graph.jobs.verified.needs].sort(), others.sort());
  });

  it("runs even when a dependency failed, and inspects each result explicitly", () => {
    assert.equal(graph.jobs.verified.if, "always()", "the aggregate gate must run with if: always()");
    const script = steps(graph, "verified").map(runScript).join("\n");
    assert.match(script, /toJSON\(needs\)|RESULTS/u);
    assert.match(script, /!= "success"/u);
  });
});

describe("forks and untrusted heads cannot publish reusable evidence", () => {
  it("never runs untrusted code in a write-token workflow", () => {
    assert.equal(graph.on.pull_request_target, undefined);
    assert.deepEqual(graph.permissions, { contents: "read" });
    for (const [jobId, job] of Object.entries(graph.jobs)) {
      assert.equal(job.permissions, undefined, `${jobId} must not widen the workflow's read-only token`);
    }
  });

  it("reads no secret", () => {
    const raw = fs.readFileSync(path.join(root, GRAPH_WORKFLOW), "utf8");
    assert.equal(/\bsecrets\./u.test(raw), false, "the verification graph must not consume a secret");
  });

  it("pins every action by commit SHA", () => {
    for (const job of Object.values(graph.jobs)) {
      for (const step of job.steps ?? []) {
        if (!step.uses) continue;
        assert.match(String(step.uses), /@[0-9a-f]{40}$/u, `${step.uses} must be pinned by SHA`);
      }
    }
  });
});

describe("exact-head orchestration and the rollback switch", () => {
  it("supersedes an older head instead of verifying it twice", () => {
    assert.match(graph.concurrency.group, /github\.event\.pull_request\.number/u);
    assert.equal(graph.concurrency["cancel-in-progress"], "${{ github.event_name == 'pull_request' }}");
  });

  it("verifies one pinned head across every job", () => {
    for (const jobId of LONG_JOBS) {
      const checkout = steps(graph, jobId).find((step) => String(step.uses ?? "").includes("actions/checkout"));
      assert.equal(
        checkout.with.ref,
        "${{ needs.admission.outputs.head_sha }}",
        `${jobId} must check out the head admission pinned, not re-resolve the ref`,
      );
    }
  });

  it("can be rolled back without editing a workflow file", () => {
    const modeScript = steps(graph, "admission")
      .map(runScript)
      .find((script) => script.includes("HONUA_SDK_VERIFICATION_MODE"));
    const modeEnv = steps(graph, "admission")
      .map((step) => JSON.stringify(step.env ?? {}))
      .join("\n");
    assert.ok(
      (modeScript ?? "").length > 0 || modeEnv.includes("HONUA_SDK_VERIFICATION_MODE"),
      "the rollout mode must come from a repository variable",
    );
    for (const jobId of LONG_JOBS) {
      assert.equal(
        graph.jobs[jobId].if,
        "needs.admission.outputs.enabled == 'true'",
        `${jobId} must be switchable off`,
      );
    }
  });
});

describe("the graph preserves the coverage ci.yml enforces today", () => {
  it("runs every verification command the JS SDK and MCP SDK jobs run", () => {
    const authoritative = new Set([...jobCommands(ci, "js-sdk"), ...jobCommands(ci, "mcp-sdk")]);
    const reproduced = workflowCommands(graph);
    const lost = [...authoritative].filter((command) => !reproduced.has(command)).sort();
    assert.deepEqual(
      lost,
      [],
      `the verification graph drops gates ci.yml enforces today: ${lost.join(", ")}. ` +
        "Sharding redistributes work; it must never retire a gate.",
    );
  });

  it("does not weaken the release-seal or publish gates", () => {
    // release:seal:check is a release-time gate in publish-js-sdk.yml and
    // first-map-release-smoke.yml, and it reads the git tree rather than dist/,
    // so build reuse neither serves nor subverts it. What ci.yml runs -- the
    // policy unit tests -- must still run here.
    const executed = workflowCommands(graph);
    assert.ok(executed.has("npm run release:seal:test"));
    // Scanned over what the graph EXECUTES, not the file text: the header
    // comment names `release:seal:check` precisely to explain why the graph
    // does not run it.
    assert.equal(executed.has("npm run release:seal:check"), false, "the graph must not take over the release-time seal");
    const executedScripts = Object.keys(graph.jobs)
      .flatMap((jobId) => steps(graph, jobId).map(runScript))
      .join("\n");
    assert.equal(/\bnpm publish\b/u.test(executedScripts), false, "the verification graph must never publish");
  });
});

describe("ci.yml stays the authoritative workflow while the graph runs in shadow", () => {
  it("still owns the JS SDK and MCP SDK jobs", () => {
    for (const jobId of ["pr-fast", "benchmark-lab", "js-sdk", "mcp-sdk"]) {
      assert.ok(ci.jobs[jobId], `${jobId} must remain in ci.yml until the graph is promoted`);
    }
  });

  // Composition guard for the workflow-guard wiring in ci.yml: `pr-fast` and
  // `js-sdk` both run the repository's cheap policy suites before anything
  // expensive. This asserts a required SUBSET rather than an exact list, so a
  // pull request that adds another guard suite to both jobs (for example the
  // stranded-merge detector in honua-io/honua-sdk-js#1331) composes with the
  // graph instead of colliding with it.
  it("keeps the cheap policy suites wired into both workflow-guard jobs", () => {
    const required = [
      "node test/scripts/pr-issue-disposition.test.mjs",
      "node test/scripts/release-please-ci-dispatch.test.mjs",
      "node test/scripts/release-please-ci-checks.test.mjs",
      "node test/scripts/backlog-dependencies.test.mjs",
      "node test/scripts/derived-artifact-loop-guard.test.mjs",
    ];
    for (const jobId of ["pr-fast", "js-sdk"]) {
      const commands = jobCommands(ci, jobId);
      for (const command of required) {
        assert.ok(commands.has(command), `ci.yml ${jobId} must still run ${command}`);
      }
    }
  });
});
