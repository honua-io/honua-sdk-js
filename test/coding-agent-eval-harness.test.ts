/**
 * Self-test for the coding-agent evaluation harness (issue #501).
 *
 * Two layers:
 *
 *  1. Always-on unit coverage of the harness logic — corpus validation, the
 *     objective assertion evaluator, output parsing, scorecard assembly +
 *     schema validation, and the deterministic fixture server's protocol
 *     routes.
 *  2. A test-of-the-test over the committed fixture generations (requires the
 *     built SDK under dist/): the known-good lane must pass every task and
 *     the known-bad lane must fail every task at exactly the stage the
 *     manifest records. This is what proves the harness can actually catch a
 *     docs/API regression rather than rubber-stamping generated code.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createFixtureAdapter, readGenerationManifest } from "../scripts/lib/coding-agent-eval/adapters.mjs";
import {
  EVAL_OGC_COLLECTION_ID,
  EVAL_SERVICE_ID,
  evaluateWhere,
  startEvalFixtureServer,
} from "../scripts/lib/coding-agent-eval/fixture-server.mjs";
import type { EvalFixtureServer } from "../scripts/lib/coding-agent-eval/fixture-server.mjs";
import { runEvalLane } from "../scripts/lib/coding-agent-eval/runner.mjs";
import type { LaneResult, TaskScore } from "../scripts/lib/coding-agent-eval/runner.mjs";
import { buildScorecard, renderScorecardMarkdown } from "../scripts/lib/coding-agent-eval/scorecard.mjs";
import {
  MIN_TASK_COUNT,
  evaluateAssertion,
  loadTasks,
  parseProgramOutput,
  validateTask,
} from "../scripts/lib/coding-agent-eval/tasks.mjs";

const require = createRequire(import.meta.url);
const Ajv2020 = require("ajv/dist/2020").default;
const addFormats = require("ajv-formats").default;

const REPO_ROOT = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const SDK_BUILT = existsSync(path.join(REPO_ROOT, "dist", "src", "index.js"));
const scorecardSchema = JSON.parse(
  readFileSync(path.join(REPO_ROOT, "eval", "coding-agents", "scorecard.schema.json"), "utf8"),
) as Record<string, unknown>;

describe("coding-agent eval / task corpus", () => {
  const tasks = loadTasks(REPO_ROOT);

  it(`has at least ${MIN_TASK_COUNT} valid tasks with unique ids (REQ-001)`, () => {
    expect(tasks.length).toBeGreaterThanOrEqual(MIN_TASK_COUNT);
    expect(new Set(tasks.map((task) => task.id)).size).toBe(tasks.length);
  });

  it("covers the stable-tier golden workflow categories", () => {
    const categories = new Set(tasks.map((task) => task.category));
    for (const required of [
      "connect-query",
      "protocols",
      "map-runtime",
      "geocoding",
      "migration",
      "cli",
      "errors",
      "react",
      "planner",
    ]) {
      expect(categories, `missing category ${required}`).toContain(required);
    }
  });

  it("every task pins allowed docs context and objective assertions", () => {
    for (const task of tasks) {
      expect(task.context.docs.length).toBeGreaterThan(0);
      for (const doc of task.context.docs) {
        expect(existsSync(path.join(REPO_ROOT, doc)), `${task.id}: context doc ${doc} missing`).toBe(true);
      }
      expect(task.assertions.length).toBeGreaterThan(0);
    }
  });

  it("rejects malformed task documents", () => {
    expect(() => validateTask({ id: "x" }, "broken")).toThrow(/missing string field/);
    expect(() =>
      validateTask(
        {
          id: "ok-task",
          title: "t",
          category: "c",
          tier: "stable",
          artifact: "ts",
          prompt: "p",
          context: { docs: ["llms.txt"] },
          execution: { kind: "node", timeoutMs: 1000, env: [] },
          assertions: [{ path: "a", op: "similar-to", value: 1 }],
        },
        "broken",
      ),
    ).toThrow(/assertion\.op/);
  });
});

describe("coding-agent eval / objective assertion evaluator", () => {
  it("compares values exactly (no string similarity)", () => {
    expect(evaluateAssertion({ path: "count", op: "equals", value: 5 }, { count: 5 }).pass).toBe(true);
    expect(evaluateAssertion({ path: "count", op: "equals", value: 5 }, { count: "5" }).pass).toBe(false);
    expect(evaluateAssertion({ path: "name", op: "equals", value: "Aruba" }, { name: "aruba" }).pass).toBe(false);
    expect(evaluateAssertion({ path: "a.b", op: "equals", value: [1, 2] }, { a: { b: [1, 2] } }).pass).toBe(true);
  });

  it("supports gte/lte/contains/defined", () => {
    expect(evaluateAssertion({ path: "n", op: "gte", value: 3 }, { n: 3 }).pass).toBe(true);
    expect(evaluateAssertion({ path: "n", op: "lte", value: 3 }, { n: 4 }).pass).toBe(false);
    expect(evaluateAssertion({ path: "s", op: "contains", value: "bc" }, { s: "abcd" }).pass).toBe(true);
    expect(evaluateAssertion({ path: "arr", op: "contains", value: 2 }, { arr: [1, 2] }).pass).toBe(true);
    expect(evaluateAssertion({ path: "x", op: "defined" }, {}).pass).toBe(false);
  });

  it("parses the last JSON line of program output", () => {
    expect(parseProgramOutput('warming up\n{"count":5}\n')).toEqual({ count: 5 });
    expect(parseProgramOutput("no json here")).toBeUndefined();
  });
});

describe("coding-agent eval / scorecard", () => {
  const laneResult: LaneResult = {
    adapter: { name: "fixture", variant: "known-good", model: "committed-fixture", version: "1" },
    tasks: [
      {
        id: "sample-task",
        title: "Sample",
        category: "connect-query",
        generation: { status: "ok", bytes: 10 },
        typecheck: { pass: true, errors: [] },
        runtime: { pass: true, exitCode: 0, durationMs: 12, timedOut: false },
        assertions: { pass: true, checks: [{ path: "count", op: "equals", expected: 5, actual: 5, pass: true }] },
        pass: true,
      },
      {
        id: "failing-task",
        title: "Failing",
        category: "protocols",
        generation: { status: "ok", bytes: 10 },
        typecheck: { pass: false, errors: ["failing-task.ts(1,1): error TS2339: nope"] },
        runtime: { pass: false, exitCode: null, durationMs: 0, timedOut: false, detail: "skipped: typecheck failed" },
        assertions: { pass: false, checks: [] },
        pass: false,
      },
    ],
  };

  it("assembles a scorecard that validates against the committed JSON schema (REQ-004)", () => {
    const scorecard = buildScorecard({ repoRoot: REPO_ROOT, lane: "fixture-known-good", laneResult });
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    addFormats(ajv);
    const validate = ajv.compile(scorecardSchema);
    expect(validate(scorecard), JSON.stringify(validate.errors)).toBe(true);
    expect(scorecard.summary).toMatchObject({ tasks: 2, passed: 1, failed: 1, passRate: 0.5 });
    expect(scorecard.adapter.model).toBe("committed-fixture");
    expect(scorecard.repo.sha.length).toBeGreaterThan(0);
  });

  it("renders per-task Markdown with failure stages", () => {
    const scorecard = buildScorecard({ repoRoot: REPO_ROOT, lane: "fixture-known-good", laneResult });
    const markdown = renderScorecardMarkdown(scorecard);
    expect(markdown).toContain("| sample-task | connect-query | pass | pass | pass | PASS |");
    expect(markdown).toContain("FAIL (typecheck)");
    expect(markdown).toContain("**failing-task** failed at typecheck");
  });
});

describe("coding-agent eval / fixture server", () => {
  let server: EvalFixtureServer;

  beforeAll(async () => {
    server = await startEvalFixtureServer({ repoRoot: REPO_ROOT });
  });

  afterAll(async () => {
    await server.close();
  });

  it("evaluates the supported where subset and fails closed otherwise", () => {
    expect(evaluateWhere("1=1", { a: 1 })).toBe(true);
    expect(evaluateWhere("priority = 'high'", { priority: "high" })).toBe(true);
    expect(evaluateWhere("magnitude > 5", { magnitude: 7 })).toBe(true);
    expect(evaluateWhere("priority = 'high' OR 1=1", { priority: "low" })).toBe(false);
  });

  it("serves a deterministic FeatureServer count and paged queries", async () => {
    const base = `${server.url}/rest/services/${EVAL_SERVICE_ID}/FeatureServer/0/query`;
    const count = (await (await fetch(`${base}?where=1%3D1&returnCountOnly=true`)).json()) as { count: number };
    expect(count.count).toBe(5);
    const page = (await (await fetch(`${base}?where=1%3D1&resultOffset=4&resultRecordCount=2`)).json()) as {
      features: unknown[];
      exceededTransferLimit: boolean;
    };
    expect(page.features).toHaveLength(1);
    expect(page.exceededTransferLimit).toBe(false);
  });

  it("serves OGC items with numberMatched and CQL2 filtering", async () => {
    const url = `${server.url}/ogc/features/collections/${EVAL_OGC_COLLECTION_ID}/items?filter=priority%20%3D%20%27high%27&limit=1`;
    const body = (await (await fetch(url)).json()) as { numberMatched: number; numberReturned: number };
    expect(body.numberMatched).toBe(2);
    expect(body.numberReturned).toBe(1);
  });

  it("rewrites recorded WFS capabilities to advertise itself as the DCP endpoint", async () => {
    const caps = await (await fetch(`${server.url}/geoserver/ows?service=WFS&request=GetCapabilities`)).text();
    expect(caps).toContain(`${server.url}/geoserver/wfs`);
    expect(caps).not.toContain("ahocevar.com");
  });
});

describe.skipIf(!SDK_BUILT)("coding-agent eval / test-of-the-test (needs built SDK)", () => {
  const tasks = loadTasks(REPO_ROOT);
  let server: EvalFixtureServer;
  let workRoot: string;

  beforeAll(async () => {
    server = await startEvalFixtureServer({ repoRoot: REPO_ROOT });
    // The scaffold must live inside the repo: generated programs resolve
    // react/@types/node through the repo's node_modules via parent lookup.
    mkdirSync(path.join(REPO_ROOT, "test-results", "coding-agent-eval"), { recursive: true });
    workRoot = mkdtempSync(path.join(REPO_ROOT, "test-results", "coding-agent-eval", "self-test-"));
  });

  afterAll(async () => {
    await server.close();
    rmSync(workRoot, { recursive: true, force: true });
  });

  it("passes every task with the known-good generations", { timeout: 600_000 }, async () => {
    const adapter = createFixtureAdapter({ repoRoot: REPO_ROOT, variant: "known-good" });
    const laneResult = await runEvalLane({
      repoRoot: REPO_ROOT,
      workDir: path.join(workRoot, "known-good"),
      tasks,
      adapter,
      baseUrl: server.url,
    });
    const failed = laneResult.tasks.filter((task: TaskScore) => !task.skipped && !task.pass);
    expect(
      failed.map((task: TaskScore) => task.id),
      JSON.stringify(failed, null, 2),
    ).toEqual([]);
    expect(laneResult.tasks.filter((task: TaskScore) => !task.skipped)).toHaveLength(tasks.length);
  });

  it("fails every known-bad generation at exactly the manifest-recorded stage", { timeout: 600_000 }, async () => {
    const manifest = readGenerationManifest(REPO_ROOT);
    const knownBadIds = Object.keys(manifest.knownBad);
    expect(knownBadIds.length).toBeGreaterThanOrEqual(3);
    const adapter = createFixtureAdapter({ repoRoot: REPO_ROOT, variant: "known-bad" });
    const laneResult = await runEvalLane({
      repoRoot: REPO_ROOT,
      workDir: path.join(workRoot, "known-bad"),
      tasks,
      adapter,
      baseUrl: server.url,
      taskFilter: knownBadIds,
    });
    for (const id of knownBadIds) {
      const scored = laneResult.tasks.find((task: TaskScore) => task.id === id);
      expect(scored, `known-bad generation for ${id} was not scored`).toBeDefined();
      expect(scored?.pass, `${id} must fail`).toBe(false);
      const stage = !scored?.typecheck?.pass ? "typecheck" : !scored?.runtime?.pass ? "runtime" : "assertions";
      expect(stage, `${id} failed at ${stage}`).toBe(manifest.knownBad[id].failsAt);
    }
  });
});
