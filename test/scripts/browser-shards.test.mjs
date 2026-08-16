import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  auditBrowserShards,
  BROWSER_SHARD_ENV,
  BROWSER_SHARD_MAP_FORMAT,
  discoverPlaywrightSpecs,
  formatShardAudit,
  loadBrowserShardMap,
  parseBrowserShardMap,
  resolveShardFromEnvironment,
  shardTestMatch,
} from "../../scripts/lib/browser-shards.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function shard(overrides = {}) {
  return {
    id: "offline",
    name: "Browser: offline",
    owns: "The offline region reference and its service-worker shell generation.",
    specs: ["offline-indexeddb.spec.mjs"],
    ...overrides,
  };
}

function map(shards) {
  return { format: BROWSER_SHARD_MAP_FORMAT, shards };
}

describe("browser shard map schema", () => {
  it("accepts a well-formed partition", () => {
    const parsed = parseBrowserShardMap(map([shard()]));
    assert.equal(parsed.shards.length, 1);
    assert.equal(parsed.claimedBy.get("offline-indexeddb.spec.mjs"), "offline");
  });

  it("rejects a spec claimed by two shards", () => {
    assert.throws(
      () => parseBrowserShardMap(map([shard(), shard({ id: "realtime" })])),
      /claimed by both offline and realtime/,
    );
  });

  it("rejects a shard that does not state the failure domain it owns", () => {
    assert.throws(() => parseBrowserShardMap(map([shard({ owns: "misc" })])), /failure domain it owns/);
  });

  it("rejects an unsorted spec list so review diffs stay readable", () => {
    assert.throws(
      () => parseBrowserShardMap(map([shard({ specs: ["z.spec.mjs", "a.spec.mjs"] })])),
      /sorted order/,
    );
  });

  it("rejects an empty shard, a duplicate id, and a non-spec file", () => {
    assert.throws(() => parseBrowserShardMap(map([shard({ specs: [] })])), /claims no specs/);
    assert.throws(() => parseBrowserShardMap(map([shard(), shard()])), /Duplicate browser shard id/);
    assert.throws(() => parseBrowserShardMap(map([shard({ specs: ["helper.mjs"] })])), /invalid spec name/);
  });
});

describe("browser shard partition audit", () => {
  it("names a spec that belongs to no shard, because it would never run", () => {
    const shardMap = parseBrowserShardMap(map([shard()]));
    const audit = auditBrowserShards({
      shardMap,
      discoveredSpecs: ["offline-indexeddb.spec.mjs", "brand-new.spec.mjs"],
    });
    assert.equal(audit.ok, false);
    assert.deepEqual(audit.orphans, ["brand-new.spec.mjs"]);
    assert.match(formatShardAudit(audit), /brand-new\.spec\.mjs/);
    assert.match(formatShardAudit(audit), /would never run/);
  });

  it("names a claimed spec that no longer exists", () => {
    const shardMap = parseBrowserShardMap(map([shard({ specs: ["deleted.spec.mjs", "offline-indexeddb.spec.mjs"] })]));
    const audit = auditBrowserShards({ shardMap, discoveredSpecs: ["offline-indexeddb.spec.mjs"] });
    assert.equal(audit.ok, false);
    assert.deepEqual(audit.missing, ["deleted.spec.mjs"]);
  });
});

describe("the committed browser shard partition", () => {
  const shardMap = loadBrowserShardMap(root);
  const discoveredSpecs = discoverPlaywrightSpecs(root);

  it("claims every Playwright spec on disk exactly once", () => {
    const audit = auditBrowserShards({ shardMap, discoveredSpecs });
    assert.equal(audit.ok, true, formatShardAudit(audit));
    assert.equal(shardMap.claimedBy.size, discoveredSpecs.length);
  });

  it("splits at least the four failure domains REQ-004 names", () => {
    const ids = shardMap.shards.map((entry) => entry.id).sort();
    assert.deepEqual(ids, ["examples", "map", "offline", "realtime"]);
  });

  it("owns the offline regression that motivated the split", () => {
    // #1280: a change to src/core/error-classifications.ts drifted the offline
    // shell manifest and took 16 offline tests red. That evidence belongs to
    // one shard, so it is one shard that reruns.
    assert.equal(shardMap.claimedBy.get("offline-indexeddb.spec.mjs"), "offline");
  });

  it("keeps the heavyweight map and Kepler coverage off the cheap shards", () => {
    for (const spec of ["kepler-analytics-fixture.spec.mjs", "kepler-arrow-packed.spec.mjs"]) {
      assert.equal(shardMap.claimedBy.get(spec), "map");
    }
  });

  it("keeps realtime coverage together and realtime", () => {
    for (const spec of ["realtime-checkpoint-store.spec.mjs", "realtime-incident-dashboard.spec.mjs"]) {
      assert.equal(shardMap.claimedBy.get(spec), "realtime");
    }
  });
});

describe("Playwright shard selection", () => {
  it("matches a shard's specs and nothing else", () => {
    const shardMap = loadBrowserShardMap(root);
    const offline = shardMap.byId.get("offline");
    const pattern = shardTestMatch(offline);
    assert.ok(pattern.test("/work/test/playwright/offline-indexeddb.spec.mjs"));
    assert.ok(pattern.test("C:\\work\\test\\playwright\\offline-indexeddb.spec.mjs"));
    assert.equal(pattern.test("/work/test/playwright/kepler-arrow-packed.spec.mjs"), false);
    // Anchored on the whole basename: a longer name that merely ends the same
    // way must not be dragged into the shard.
    assert.equal(pattern.test("/work/test/playwright/not-offline-indexeddb.spec.mjs"), false);
  });

  it("runs the whole directory when no shard is selected", () => {
    const shardMap = loadBrowserShardMap(root);
    assert.equal(resolveShardFromEnvironment(shardMap, {}), undefined);
    assert.equal(resolveShardFromEnvironment(shardMap, { [BROWSER_SHARD_ENV]: "" }), undefined);
  });

  it("fails loudly on a shard name that does not exist", () => {
    const shardMap = loadBrowserShardMap(root);
    assert.throws(() => resolveShardFromEnvironment(shardMap, { [BROWSER_SHARD_ENV]: "typo" }), /names no browser shard/);
  });
});
