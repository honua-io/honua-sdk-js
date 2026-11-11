import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const workflow = await readFile(new URL("../../.github/workflows/schema-sync.yml", import.meta.url), "utf8");
const pullRequest = workflow.slice(workflow.indexOf("  pull_request:\n"), workflow.indexOf("\npermissions:"));
const push = workflow.slice(workflow.indexOf("  push:\n"), workflow.indexOf("  pull_request:\n"));

test("pull requests run the schema check only when an input of its verdict changes", () => {
  for (const input of [
    "mcp/certification/geospatial-mcp-schemas/**",
    "scripts/sync-schemas.sh",
    ".github/workflows/schema-sync.yml",
  ]) {
    assert.ok(pullRequest.includes(`      - "${input}"\n`), `pull_request paths must include ${input}`);
  }
});

test("trunk and release pushes keep the unfiltered schema check", () => {
  assert.ok(push.includes('      - trunk\n') && push.includes('      - "release/**"\n'));
  assert.doesNotMatch(push, /paths/);
});
