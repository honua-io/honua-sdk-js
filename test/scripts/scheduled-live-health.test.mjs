import assert from "node:assert/strict";
import test from "node:test";
import { buildScheduledLiveHealth, classifyLane } from "../../scripts/scheduled-live-health.mjs";

const lane = { id: "lane", workflow: "lane.yml", eligibleEvents: ["schedule"], branch: "trunk", required: true, maxAgeDays: 7, owner: "owner" };
const now = new Date("2026-08-24T00:00:00Z");
const run = (overrides = {}) => ({ id: 1, event: "schedule", head_branch: "trunk", status: "completed", conclusion: "success", created_at: "2026-08-23T00:00:00Z", updated_at: "2026-08-23T00:01:00Z", head_sha: "a".repeat(40), html_url: "https://example.test/run/1", ...overrides });

test("classifies never-run, running, failing, stale, expiring, and healthy lanes", () => {
  assert.equal(classifyLane(lane, null, now).status, "never-run");
  assert.equal(classifyLane(lane, run({ status: "in_progress", conclusion: null }), now).status, "running");
  assert.equal(classifyLane(lane, run({ conclusion: "failure" }), now).status, "failing");
  assert.equal(classifyLane(lane, run({ created_at: "2026-08-01T00:00:00Z" }), now).status, "stale");
  assert.equal(classifyLane(lane, run({ created_at: "2026-08-18T12:00:00Z" }), now).status, "expiring");
  assert.equal(classifyLane(lane, run(), now).status, "healthy");
});

test("binds failure triage only to the exact observed run", async () => {
  const triaged = { ...lane, triage: { runId: 1, class: "product", detail: "known defect" } };
  const matching = await buildScheduledLiveHealth({ repository: "honua-io/honua-sdk-js", lanes: [triaged] }, { now, fetchRun: async () => run({ conclusion: "failure" }) });
  assert.equal(matching.lanes[0].triage.class, "product");
  const newer = await buildScheduledLiveHealth({ repository: "honua-io/honua-sdk-js", lanes: [triaged] }, { now, fetchRun: async () => run({ id: 2, conclusion: "failure" }) });
  assert.equal(newer.lanes[0].triage, null);
});

test("only unhealthy required lanes fail the named aggregate", async () => {
  const config = { repository: "honua-io/honua-sdk-js", lanes: [lane, { ...lane, id: "optional", workflow: "optional.yml", required: false }] };
  const projection = await buildScheduledLiveHealth(config, { now, fetchRun: async (entry) => entry.workflow === "lane.yml" ? run() : null });
  assert.equal(projection.aggregate, "healthy");
  assert.equal(projection.lanes.find((entry) => entry.id === "optional").status, "never-run");

  const failed = await buildScheduledLiveHealth(config, { now, fetchRun: async () => null });
  assert.equal(failed.aggregate, "failing");
  assert.deepEqual(failed.requiredFailures, ["lane"]);
});

test("manual and off-branch successes cannot replace the canonical lane contract", () => {
  assert.equal(classifyLane(lane, run({ event: "workflow_dispatch" }), now).status, "ineligible-run");
  assert.equal(classifyLane(lane, run({ head_branch: "experiment" }), now).status, "ineligible-run");
  const reviewedDispatch = { ...lane, eligibleEvents: ["schedule", "workflow_dispatch"], eligibleWorkflowDispatchRunIds: [1] };
  assert.equal(classifyLane(reviewedDispatch, run({ event: "workflow_dispatch" }), now).status, "healthy");
  assert.equal(classifyLane(reviewedDispatch, run({ id: 2, event: "workflow_dispatch" }), now).status, "ineligible-run");
});

test("query failures are isolated per lane and only required lanes fail the aggregate", async () => {
  const optional = { ...lane, id: "optional", workflow: "optional.yml", required: false };
  const config = { repository: "honua-io/honua-sdk-js", lanes: [lane, optional] };
  const optionalFailure = await buildScheduledLiveHealth(config, {
    now,
    fetchRun: async (entry) => {
      if (entry.required) return run();
      throw new Error("HTTP 404");
    },
  });
  assert.equal(optionalFailure.aggregate, "healthy");
  assert.equal(optionalFailure.lanes[1].status, "query-error");
  assert.equal(optionalFailure.lanes[1].queryError, "HTTP 404");

  const requiredFailure = await buildScheduledLiveHealth(config, {
    now,
    fetchRun: async (entry) => {
      if (entry.required) throw new Error("HTTP 429");
      return run();
    },
  });
  assert.equal(requiredFailure.aggregate, "failing");
  assert.deepEqual(requiredFailure.requiredFailures, ["lane"]);
});

test("monthly scheduled corpus stays healthy through the longest on-time cadence", () => {
  const monthly = { ...lane, maxAgeDays: 35, alertBeforeDays: 2 };
  assert.equal(classifyLane(monthly, run({ created_at: "2026-07-24T00:00:00Z" }), now).status, "healthy");
});
