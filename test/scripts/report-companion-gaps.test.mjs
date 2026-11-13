import assert from "node:assert/strict";
import test from "node:test";

import { companionGapTitle, reportCompanionGaps } from "../../scripts/report-companion-gaps.mjs";

const gap = {
  id: "mcp-server",
  npmName: "@honua/mcp-server",
  version: "0.3.1",
  tag: "mcp-server-v0.3.1",
  workflow: ".github/workflows/publish-mcp-server.yml",
};
const receipt = { sealedTag: "js-sdk-v0.3.4", outcome: "companion-gap", companionGaps: [gap] };
const runUrl = "https://github.com/honua-io/honua-sdk-js/actions/runs/1";

function fakeIssues(open = []) {
  const issues = open.map((title, index) => ({ number: 100 + index, title }));
  const calls = [];
  return {
    calls,
    listOpenIssues: async () => issues,
    createIssue: async (title, body) => {
      calls.push({ action: "create", title, body });
      issues.push({ number: 200 + calls.length, title });
    },
    commentOnIssue: async (number, body) => {
      calls.push({ action: "comment", number, body });
    },
  };
}

test("the tracking issue title names the package, version and tag", () => {
  assert.equal(
    companionGapTitle(gap),
    "Companion release @honua/mcp-server@0.3.1 (mcp-server-v0.3.1) is tagged but not on the registry",
  );
});

test("a new companion gap opens one tracking issue that says how to resolve it", async () => {
  const issues = fakeIssues();
  await reportCompanionGaps({ receipt, runUrl, issues });
  assert.equal(issues.calls.length, 1);
  const [created] = issues.calls;
  assert.equal(created.action, "create");
  assert.equal(created.title, companionGapTitle(gap));
  assert.match(created.body, /js-sdk-v0\.3\.4/u);
  assert.match(created.body, /actions\/runs\/1/u);
  assert.match(created.body, /publish-mcp-server\.yml/u);
  assert.match(created.body, /skipped/u);
});

test("a gap that already has an open tracking issue gets a comment, not a second issue", async () => {
  const issues = fakeIssues(["Unrelated", companionGapTitle(gap)]);
  await reportCompanionGaps({ receipt, runUrl, issues });
  assert.deepEqual(
    issues.calls.map((call) => [call.action, call.number]),
    [["comment", 101]],
  );
  assert.match(issues.calls[0].body, /js-sdk-v0\.3\.4/u);
});

test("a receipt without companion gaps reports nothing", async () => {
  const issues = fakeIssues();
  await reportCompanionGaps({ receipt: { ...receipt, outcome: "verified", companionGaps: [] }, runUrl, issues });
  assert.deepEqual(issues.calls, []);
});

test("each gap is reported once even when two companions are missing", async () => {
  const scaffold = {
    id: "create-honua-app",
    npmName: "create-honua-app",
    version: "0.2.5",
    tag: "create-honua-app-v0.2.5",
    workflow: ".github/workflows/publish-create-honua-app.yml",
  };
  const issues = fakeIssues();
  await reportCompanionGaps({ receipt: { ...receipt, companionGaps: [gap, scaffold] }, runUrl, issues });
  assert.deepEqual(
    issues.calls.map((call) => call.title),
    [companionGapTitle(gap), companionGapTitle(scaffold)],
  );
  assert.match(issues.calls[1].body, /publish-create-honua-app\.yml/u);
});
