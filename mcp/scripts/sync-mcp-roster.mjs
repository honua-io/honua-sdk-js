#!/usr/bin/env node
// Verify (or refresh) the vendored honua-server MCP tool roster against the
// server commit pinned in certification/honua-server-mcp-roster/PROVENANCE.md.
//
//   node mcp/scripts/sync-mcp-roster.mjs          # check: fail if the vendored copy drifts
//   node mcp/scripts/sync-mcp-roster.mjs --write  # refresh the vendored copy from the pin
//
// When the roster does not exist at the pinned commit yet, both modes report
// BLOCKED and leave no vendored roster behind: the certifier then reports the
// roster-parity contract as blocked rather than passing it.
// Set HONUA_MCP_ROSTER_TOKEN (or GH_TOKEN) when honua-server is not readable anonymously.

import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DIR = resolve(HERE, "..", "certification", "honua-server-mcp-roster");
const PROVENANCE = join(DIR, "PROVENANCE.md");
const TARGET = join(DIR, "mcp-tool-roster.v1.json");
const REPO_PATH = "docs/gis/data/mcp-tool-roster.v1.json";

const write = process.argv.includes("--write");
const pin = /Server commit:\*\* `([0-9a-f]{40})`/.exec(readFileSync(PROVENANCE, "utf8"))?.[1];
if (!pin) {
  console.error(`FAIL: no 'Server commit' sha in ${PROVENANCE}`);
  process.exit(2);
}

const url = `https://raw.githubusercontent.com/honua-io/honua-server/${pin}/${REPO_PATH}`;
const token = process.env.HONUA_MCP_ROSTER_TOKEN || process.env.GH_TOKEN;
const response = await fetch(url, token ? { headers: { Authorization: `token ${token}` } } : {});
if (response.status === 404) {
  console.log(`BLOCKED: ${REPO_PATH} not found at honua-server@${pin}${token ? "" : " (or not readable without a token)"}.`);
  if (existsSync(TARGET)) {
    if (write) {
      rmSync(TARGET);
      console.log("Removed the vendored roster: it no longer matches the pinned commit.");
    } else {
      console.error("FAIL: a vendored roster exists but the pinned commit has none. Re-run with --write.");
      process.exit(1);
    }
  }
  process.exit(0);
}
if (!response.ok) {
  console.error(`FAIL: roster fetch returned HTTP ${response.status} for ${url}`);
  process.exit(2);
}
const upstream = await response.text();
JSON.parse(upstream);
if (write) {
  writeFileSync(TARGET, upstream, "utf8");
  console.log(`OK: vendored roster refreshed from honua-server@${pin}.`);
  process.exit(0);
}
if (!existsSync(TARGET) || readFileSync(TARGET, "utf8") !== upstream) {
  console.error(`FAIL: the vendored roster differs from honua-server@${pin}. Run with --write.`);
  process.exit(1);
}
console.log(`OK: vendored roster is byte-identical to honua-server@${pin}.`);
