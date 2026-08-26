#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function loadUnitShardConfig(repositoryRoot = root) {
  const value = JSON.parse(fs.readFileSync(path.join(repositoryRoot, "config/unit-test-shards.v1.json"), "utf8"));
  assert.equal(value.format, "honua.sdk.unit-test-shards.v1");
  assert.ok(Number.isInteger(value.shardCount) && value.shardCount >= 2 && value.shardCount <= 8);
  return value;
}

export function auditPartition(allFiles, shards) {
  const expected = [...new Set(allFiles)].sort();
  assert.deepEqual(allFiles.slice().sort(), expected, "the unsharded Vitest listing contains duplicates");
  const owners = new Map(expected.map((file) => [file, []]));
  shards.forEach((files, index) => {
    for (const file of files) {
      assert.ok(owners.has(file), `shard ${index + 1} selected unexpected spec ${file}`);
      owners.get(file).push(index + 1);
    }
  });
  for (const [file, fileOwners] of owners) {
    assert.equal(fileOwners.length, 1, `${file} must belong to exactly one shard; owners=${fileOwners.join(",") || "none"}`);
  }
  return { specCount: expected.length, shardCounts: shards.map((files) => files.length) };
}

export function listUnitSpecs(repositoryRoot = root) {
  const found = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (/\.test\.tsx?$/u.test(entry.name)) found.push(path.relative(repositoryRoot, absolute).replaceAll(path.sep, "/"));
    }
  };
  visit(path.join(repositoryRoot, "test"));
  return found.sort();
}

export function partitionSpecs(files, shardCount) {
  const shards = Array.from({ length: shardCount }, () => []);
  for (const file of files) {
    const owner = crypto.createHash("sha256").update(file).digest().readUInt32BE(0) % shardCount;
    shards[owner].push(file);
  }
  return shards;
}

export function check() {
  const { shardCount } = loadUnitShardConfig();
  const allFiles = listUnitSpecs();
  const shards = partitionSpecs(allFiles, shardCount);
  const summary = auditPartition(allFiles, shards);
  assert.ok(summary.shardCounts.every((count) => count > 0), "every configured shard must own at least one spec");
  process.stdout.write(`${JSON.stringify({ shardCount, ...summary })}\n`);
}

function run(shardText) {
  const { shardCount } = loadUnitShardConfig();
  const shard = Number(shardText);
  assert.ok(Number.isInteger(shard) && shard >= 1 && shard <= shardCount, `shard must be 1..${shardCount}`);
  const files = partitionSpecs(listUnitSpecs(), shardCount)[shard - 1];
  const result = spawnSync("npx", [
    "vitest", "run", ...files, "--coverage", "--reporter=blob",
    `--outputFile=.vitest-reports/blob-${shard}.json`,
  ], { cwd: root, stdio: "inherit" });
  process.exit(result.status ?? 1);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === "check") check();
  else if (process.argv[2] === "run") run(process.argv[3]);
  else throw new Error("usage: unit-test-shards.mjs check | run <shard>");
}
