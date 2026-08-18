/**
 * Browser shard map (honua-io/honua-sdk-js#1286 REQ-004).
 *
 * Playwright ran as one 45-spec block, so any late browser failure invalidated
 * every earlier browser result and a failed-only rerun replayed all of them.
 * The specs are partitioned into four owned failure domains instead, so a
 * Kepler regression reruns Kepler.
 *
 * The partition is a reviewed decision in config/browser-shards.v1.json, not a
 * discovery: a shard defined by a glob silently absorbs new specs, and -- worse
 * -- a spec matching no glob silently never runs. honua-server learned that the
 * expensive way (218 tests matched no CI shard filter and had never executed;
 * honua-io/honua-server#3259). `auditBrowserShards` is the countermeasure:
 * every spec on disk must be claimed by exactly one shard, and every claimed
 * spec must exist.
 */

import fs from "node:fs";
import path from "node:path";

export const BROWSER_SHARD_MAP_FORMAT = "honua.browser-shards.v1";
export const BROWSER_SHARD_MAP_PATH = path.join("config", "browser-shards.v1.json");
export const PLAYWRIGHT_SPEC_DIRECTORY = path.join("test", "playwright");
export const BROWSER_SHARD_ENV = "HONUA_BROWSER_SHARD";

const SHARD_ID_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;
// Specs are named by their path RELATIVE TO test/playwright, forward-slashed,
// not by basename. Playwright's `testDir` recurses, so a spec in a subdirectory
// is a spec Playwright runs; a basename-only model cannot represent it, and a
// non-recursive audit would call the directory clean while that spec belonged
// to no shard and never ran -- honua-io/honua-server#3259 reproduced inside the
// countermeasure meant to prevent it. Flat names remain valid relative paths,
// so the committed map needed no change.
// The two limits are ONE limit, derived rather than written twice. They were
// written twice and disagreed by one: discovery admitted a spec five
// directories deep while the claim pattern accepted at most four, so such a
// spec was reported as an orphan and then rejected when someone tried to claim
// it -- an unbreakable loop where the audit demands an action the parser
// refuses. Fail-closed, but a soft-lock, and the fix must not be "raise one of
// them" or they drift apart again.
export const MAX_SPEC_DIRECTORY_DEPTH = 4;
const SPEC_PATH_PATTERN = new RegExp(
  `^(?:[a-z0-9][a-z0-9._-]{0,63}/){0,${MAX_SPEC_DIRECTORY_DEPTH}}[a-z0-9][a-z0-9.-]{0,127}\\.spec\\.mjs$`,
);

/**
 * Whether a discovered spec path could ever be claimed by a shard.
 *
 * The audit's job is to name specs that no shard runs. When the reason a spec
 * is unclaimed is that its own path cannot satisfy the claim pattern -- too
 * deep, uppercase, a leading dot -- reporting it as a plain orphan sends the
 * reader to add a line that will be rejected. Naming the real problem is the
 * difference between a finding and a dead end.
 */
export function isClaimableSpecPath(spec) {
  return typeof spec === "string" && SPEC_PATH_PATTERN.test(spec);
}

export function parseBrowserShardMap(raw) {
  if (raw?.format !== BROWSER_SHARD_MAP_FORMAT) {
    throw new Error(`Browser shard map format must be ${BROWSER_SHARD_MAP_FORMAT}`);
  }
  if (!Array.isArray(raw.shards) || raw.shards.length === 0) {
    throw new Error("Browser shard map declares no shards");
  }

  const byId = new Map();
  const claimedBy = new Map();
  for (const shard of raw.shards) {
    if (typeof shard?.id !== "string" || !SHARD_ID_PATTERN.test(shard.id)) {
      throw new Error(`Browser shard id is invalid: ${String(shard?.id)}`);
    }
    if (byId.has(shard.id)) throw new Error(`Duplicate browser shard id: ${shard.id}`);
    if (typeof shard.name !== "string" || shard.name.length === 0) {
      throw new Error(`Browser shard ${shard.id} has no display name`);
    }
    // A shard without a stated owned domain is a bucket, and buckets drift back
    // into a monolith one convenient assignment at a time.
    if (typeof shard.owns !== "string" || shard.owns.length < 40) {
      throw new Error(`Browser shard ${shard.id} must state the failure domain it owns`);
    }
    if (!Array.isArray(shard.specs) || shard.specs.length === 0) {
      throw new Error(`Browser shard ${shard.id} claims no specs`);
    }
    for (const spec of shard.specs) {
      if (!isClaimableSpecPath(spec)) {
        throw new Error(`Browser shard ${shard.id} claims an invalid spec name: ${String(spec)}`);
      }
      const existing = claimedBy.get(spec);
      if (existing) {
        throw new Error(`Spec ${spec} is claimed by both ${existing} and ${shard.id}`);
      }
      claimedBy.set(spec, shard.id);
    }
    const sorted = [...shard.specs].sort();
    if (sorted.some((spec, index) => spec !== shard.specs[index])) {
      throw new Error(`Browser shard ${shard.id} must list its specs in sorted order`);
    }
    byId.set(shard.id, Object.freeze({ ...shard, specs: Object.freeze([...shard.specs]) }));
  }
  return { shards: [...byId.values()], byId, claimedBy };
}

export function loadBrowserShardMap(projectRoot) {
  const file = path.join(projectRoot, BROWSER_SHARD_MAP_PATH);
  return parseBrowserShardMap(JSON.parse(fs.readFileSync(file, "utf8")));
}

/**
 * Every spec Playwright would run, as forward-slashed paths relative to
 * test/playwright.
 *
 * Recursive, because `testDir` is. A flat `readdirSync` sees only the top level,
 * so a spec added under test/playwright/<subdir>/ would run in CI, be claimed by
 * no shard, and be reported by this audit as "no orphans" -- the audit lying in
 * exactly the direction it exists to prevent. Symlinks are refused rather than
 * followed: a link out of the tree would let a spec be claimed under two names.
 */
export function discoverPlaywrightSpecs(projectRoot) {
  const root = path.join(projectRoot, PLAYWRIGHT_SPEC_DIRECTORY);
  const found = [];

  const visit = (relativeDirectory, depth) => {
    if (depth > MAX_SPEC_DIRECTORY_DEPTH) {
      throw new Error(
        `Playwright spec tree is nested deeper than ${MAX_SPEC_DIRECTORY_DEPTH} directories at ` +
          `${PLAYWRIGHT_SPEC_DIRECTORY}/${relativeDirectory}. A spec below this point could not be ` +
          "claimed by any shard, so it would never run.",
      );
    }
    const absolute = relativeDirectory === "" ? root : path.join(root, ...relativeDirectory.split("/"));
    for (const entry of fs.readdirSync(absolute, { withFileTypes: true })) {
      const relativePath = relativeDirectory === "" ? entry.name : `${relativeDirectory}/${entry.name}`;
      if (entry.isSymbolicLink()) {
        throw new Error(`Playwright spec tree contains a symlink: ${relativePath}`);
      }
      if (entry.isDirectory()) {
        visit(relativePath, depth + 1);
      } else if (entry.isFile() && entry.name.endsWith(".spec.mjs")) {
        found.push(relativePath);
      }
    }
  };

  visit("", 0);
  return found.sort();
}

/**
 * Totality and disjointness of the partition. `orphans` is the finding that
 * matters: a spec on disk that no shard claims would simply never run, which is
 * indistinguishable from passing.
 */
export function auditBrowserShards({ shardMap, discoveredSpecs }) {
  const discovered = new Set(discoveredSpecs);
  const unclaimed = discoveredSpecs.filter((spec) => !shardMap.claimedBy.has(spec));
  // Split by WHY the spec is unclaimed. Both are failures; only one of them is
  // fixable by editing the shard map.
  const unclaimable = unclaimed.filter((spec) => !isClaimableSpecPath(spec));
  const orphans = unclaimed.filter((spec) => isClaimableSpecPath(spec));
  const missing = [...shardMap.claimedBy.keys()].filter((spec) => !discovered.has(spec)).sort();
  return {
    orphans,
    unclaimable,
    missing,
    ok: orphans.length === 0 && unclaimable.length === 0 && missing.length === 0,
  };
}

export function formatShardAudit({ orphans, unclaimable = [], missing }) {
  const lines = [];
  if (unclaimable.length > 0) {
    lines.push(
      `${unclaimable.length} Playwright spec(s) have a path no shard can claim, so they would never run`,
      `and cannot be added to ${BROWSER_SHARD_MAP_PATH}. Rename or relocate each one: paths are`,
      `lowercase, at most ${MAX_SPEC_DIRECTORY_DEPTH} directories deep, and end in .spec.mjs.`,
      ...unclaimable.map((spec) => `  ${spec}`),
    );
  }
  if (orphans.length > 0) {
    if (lines.length > 0) lines.push("");
    lines.push(
      `${orphans.length} Playwright spec(s) belong to no browser shard and would never run in CI.`,
      `Claim each in ${BROWSER_SHARD_MAP_PATH} under the shard that owns its failure domain:`,
      ...orphans.map((spec) => `  ${spec}`),
    );
  }
  if (missing.length > 0) {
    if (lines.length > 0) lines.push("");
    lines.push(
      `${missing.length} spec(s) are claimed by a browser shard but do not exist on disk.`,
      `Remove them from ${BROWSER_SHARD_MAP_PATH}:`,
      ...missing.map((spec) => `  ${spec}`),
    );
  }
  return lines.join("\n");
}

/**
 * Playwright filter for one shard.
 *
 * Anchored on the spec's whole path relative to test/playwright, preceded by a
 * separator, so `a/b.spec.mjs` and `c/b.spec.mjs` are different specs and a
 * longer name ending the same way is not dragged in. Returned as a RegExp
 * because a bare string is interpreted as a glob against the full path. Both
 * separators are accepted so the filter works on Windows checkouts.
 */
export function shardTestMatch(shard) {
  const alternatives = shard.specs.map((spec) =>
    spec
      .split("/")
      .map((segment) => segment.replace(/[.*+?^${}()|[\]\\]/gu, (ch) => `\\${ch}`))
      .join("[\\\\/]"),
  );
  return new RegExp(`[\\\\/](?:${alternatives.join("|")})$`, "u");
}

/**
 * Resolves the selected shard, loading the map only when one is selected.
 *
 * `shardMap` is a THUNK, not a map. playwright.config.mjs is shared with
 * ci.yml's authoritative `JS SDK` job, which never sets HONUA_BROWSER_SHARD;
 * loading config/browser-shards.v1.json eagerly there would let a malformed or
 * missing shard map -- a shadow-lane concern -- hard-fail production Playwright
 * at config load. Deferring the read means the unsharded path never touches the
 * file, while a sharded job still fails loudly rather than quietly running
 * every spec.
 */
export function resolveShardFromEnvironment(shardMap, environment) {
  const id = environment?.[BROWSER_SHARD_ENV];
  if (typeof id !== "string" || id.length === 0) return undefined;
  const resolved = typeof shardMap === "function" ? shardMap() : shardMap;
  const shard = resolved.byId.get(id);
  if (!shard) {
    throw new Error(
      `${BROWSER_SHARD_ENV}=${id} names no browser shard. Known shards: ` +
        `${[...resolved.byId.keys()].join(", ")}`,
    );
  }
  return shard;
}
