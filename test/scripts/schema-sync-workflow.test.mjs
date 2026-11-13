import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const workflow = await readFile(new URL("../../.github/workflows/schema-sync.yml", import.meta.url), "utf8");

function section(start, end) {
  const from = workflow.indexOf(start);
  const to = workflow.indexOf(end);
  assert.ok(from >= 0 && to > from, `schema-sync.yml must contain ${JSON.stringify(start)} before ${JSON.stringify(end)}`);
  return workflow.slice(from, to);
}

const pullRequest = section("  pull_request:\n", "\npermissions:");
const push = section("  push:\n", "  pull_request:\n");

test("pull requests run the schema check only when an input of its verdict changes", () => {
  for (const input of [
    "mcp/certification/geospatial-mcp-schemas/**",
    "scripts/sync-schemas.sh",
    ".github/workflows/schema-sync.yml",
  ]) {
    assert.ok(pullRequest.includes(`      - "${input}"\n`), `pull_request paths must include ${input}`);
  }
  assert.match(pullRequest, /\n    paths:\n/u, "the pull_request filter must be paths:, not paths-ignore:");
  assert.doesNotMatch(pullRequest, /paths-ignore:/u);
});

test("trunk and release pushes keep the unfiltered schema check", () => {
  assert.ok(push.includes("      - trunk\n") && push.includes('      - "release/**"\n'));
  assert.doesNotMatch(push, /paths/);
});
