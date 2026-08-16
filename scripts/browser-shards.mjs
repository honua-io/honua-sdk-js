#!/usr/bin/env node

// Browser shard map CLI (honua-io/honua-sdk-js#1286).
//
//   check    every spec on disk is claimed by exactly one shard, and every
//            claimed spec exists. This is the guard against a new spec that
//            silently never runs.
//   matrix   the GitHub Actions matrix for the browser shard jobs.
//   files    the spec files of one shard, one per line.

import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  auditBrowserShards,
  discoverPlaywrightSpecs,
  formatShardAudit,
  loadBrowserShardMap,
} from "./lib/browser-shards.mjs";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function main(argv) {
  const command = argv[0] ?? "check";
  const shardMap = loadBrowserShardMap(PROJECT_ROOT);

  if (command === "check") {
    const audit = auditBrowserShards({ shardMap, discoveredSpecs: discoverPlaywrightSpecs(PROJECT_ROOT) });
    if (!audit.ok) {
      process.stderr.write(`${formatShardAudit(audit)}\n`);
      process.exitCode = 1;
      return;
    }
    const total = shardMap.shards.reduce((sum, shard) => sum + shard.specs.length, 0);
    const breakdown = shardMap.shards.map((shard) => `${shard.id}=${shard.specs.length}`).join(" ");
    process.stdout.write(`browser shards: ${shardMap.shards.length} shards, ${total} specs, no orphans (${breakdown})\n`);
    return;
  }

  if (command === "matrix") {
    const include = shardMap.shards.map((shard) => ({ shard: shard.id, name: shard.name }));
    process.stdout.write(`${JSON.stringify({ include })}\n`);
    return;
  }

  if (command === "files") {
    const id = argv[1];
    const shard = shardMap.byId.get(id);
    if (!shard) throw new Error(`Unknown browser shard: ${String(id)}`);
    process.stdout.write(`${shard.specs.map((spec) => `test/playwright/${spec}`).join("\n")}\n`);
    return;
  }

  throw new Error("Usage: node scripts/browser-shards.mjs [check|matrix|files <shard>]");
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
