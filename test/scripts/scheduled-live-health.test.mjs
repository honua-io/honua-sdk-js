import assert from "node:assert/strict";
import test from "node:test";
import { buildScheduledLiveHealth, classifyLane } from "../../scripts/scheduled-live-health.mjs";

const lane = { id: "lane", workflow: "lane.yml", required: true, maxAgeDays: 7, owner: "owner" };
const now = new Date("2026-08-24T00:00:00Z");
const run = (overrides = {}) => ({ id: 1, event: "schedule", status: "completed", conclusion: "success", created_at: "2026-08-23T00:00:00Z", updated_at: "2026-08-23T00:01:00Z", head_sha: "a".repeat(40), html_url: "https://example.test/run/1", ...overrides });

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
  const projection = await buildScheduledLiveHealth(config, { now, fetchRun: async (workflow) => workflow === "lane.yml" ? run() : null });
  assert.equal(projection.aggregate, "healthy");
  assert.equal(projection.lanes.find((entry) => entry.id === "optional").status, "never-run");

  const failed = await buildScheduledLiveHealth(config, { now, fetchRun: async () => null });
  assert.equal(failed.aggregate, "failing");
  assert.deepEqual(failed.requiredFailures, ["lane"]);
});
