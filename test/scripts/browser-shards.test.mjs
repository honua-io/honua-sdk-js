import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  auditBrowserShards,
  BROWSER_SHARD_ENV,
  BROWSER_SHARD_MAP_FORMAT,
  discoverPlaywrightSpecs,
  formatShardAudit,
  isClaimableSpecPath,
  loadBrowserShardMap,
  MAX_SPEC_DIRECTORY_DEPTH,
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

  it("claims specs by path relative to test/playwright, not by basename", () => {
    // Playwright's testDir recurses, so a subdirectory spec is a real spec and
    // the map has to be able to name it -- and to distinguish two specs that
    // share a basename in different directories.
    const parsed = parseBrowserShardMap(
      map([shard({ specs: ["nested/deep.spec.mjs", "offline-indexeddb.spec.mjs"] })]),
    );
    assert.equal(parsed.claimedBy.get("nested/deep.spec.mjs"), "offline");
    assert.throws(
      () => parseBrowserShardMap(map([shard({ specs: ["../escape.spec.mjs"] })])),
      /invalid spec name/,
    );
    assert.throws(
      () => parseBrowserShardMap(map([shard({ specs: ["/absolute.spec.mjs"] })])),
      /invalid spec name/,
    );
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

describe("spec discovery follows Playwright's testDir", () => {
  // Verified against Playwright itself: a spec at test/playwright/nested/ is
  // listed by `playwright test --list` (46 files instead of 45). A flat
  // readdirSync missed it, so the audit reported "no orphans" for a spec that
  // ran in CI and belonged to no shard -- honua-server#3259 reproduced inside
  // the countermeasure. See scripts/lib/browser-shards.mjs.
  it("finds specs in subdirectories, named by their relative path", () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "honua-browser-shards-"));
    try {
      const specs = path.join(scratch, "test", "playwright", "nested", "deeper");
      fs.mkdirSync(specs, { recursive: true });
      fs.writeFileSync(path.join(scratch, "test", "playwright", "flat.spec.mjs"), "");
      fs.writeFileSync(path.join(scratch, "test", "playwright", "nested", "mid.spec.mjs"), "");
      fs.writeFileSync(path.join(specs, "low.spec.mjs"), "");
      fs.writeFileSync(path.join(scratch, "test", "playwright", "helper.mjs"), "");

      assert.deepEqual(discoverPlaywrightSpecs(scratch), [
        "flat.spec.mjs",
        "nested/deeper/low.spec.mjs",
        "nested/mid.spec.mjs",
      ]);
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("refuses a symlinked spec rather than claiming it under two names", () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "honua-browser-shards-"));
    try {
      const directory = path.join(scratch, "test", "playwright");
      fs.mkdirSync(directory, { recursive: true });
      fs.writeFileSync(path.join(directory, "real.spec.mjs"), "");
      fs.symlinkSync(path.join(directory, "real.spec.mjs"), path.join(directory, "alias.spec.mjs"));
      assert.throws(() => discoverPlaywrightSpecs(scratch), /contains a symlink/);
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("reports a nested orphan the same way it reports a flat one", () => {
    const shardMap = loadBrowserShardMap(root);
    const audit = auditBrowserShards({
      shardMap,
      discoveredSpecs: [...discoverPlaywrightSpecs(root), "nested/brand-new.spec.mjs"],
    });
    assert.equal(audit.ok, false);
    assert.deepEqual(audit.orphans, ["nested/brand-new.spec.mjs"]);
    assert.match(formatShardAudit(audit), /nested\/brand-new\.spec\.mjs/);
  });
});

// The residual left open by honua-io/honua-sdk-js#1334: discovery admitted a
// spec five directories deep while the claim pattern accepted at most four. The
// audit demanded the spec be claimed and the parser refused the claim -- a
// soft-lock with no way out that did not involve editing this module.
describe("what discovery admits is exactly what a shard can claim", () => {
  it("accepts a claim at the deepest path discovery will produce", () => {
    const deepest = `${Array.from({ length: MAX_SPEC_DIRECTORY_DEPTH }, (_unused, index) => `d${index}`).join("/")}/leaf.spec.mjs`;
    assert.equal(isClaimableSpecPath(deepest), true);
    assert.doesNotThrow(() =>
      parseBrowserShardMap({
        format: BROWSER_SHARD_MAP_FORMAT,
        shards: [shard({ specs: [deepest] })],
      }),
    );
  });

  it("refuses to discover anything a shard could not then claim", () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "honua-browser-shards-"));
    try {
      const tooDeep = path.join(
        scratch,
        "test",
        "playwright",
        ...Array.from({ length: MAX_SPEC_DIRECTORY_DEPTH + 1 }, (_unused, index) => `d${index}`),
      );
      fs.mkdirSync(tooDeep, { recursive: true });
      fs.writeFileSync(path.join(tooDeep, "leaf.spec.mjs"), "");
      // A named, actionable failure rather than an orphan report nobody can act on.
      assert.throws(() => discoverPlaywrightSpecs(scratch), /nested deeper than 4 directories at test\/playwright\/d0/u);
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });

  // Depth was one way to reach the soft-lock; a name shape is another. Both now
  // report what is actually wrong instead of "claim this spec" for a spec that
  // cannot be claimed.
  it("names an unclaimable spec as unclaimable, not as a plain orphan", () => {
    const audit = auditBrowserShards({
      shardMap: loadBrowserShardMap(root),
      discoveredSpecs: [...discoverPlaywrightSpecs(root), "Nested/Brand-New.spec.mjs"],
    });
    assert.equal(audit.ok, false);
    assert.deepEqual(audit.orphans, []);
    assert.deepEqual(audit.unclaimable, ["Nested/Brand-New.spec.mjs"]);
    const message = formatShardAudit(audit);
    assert.match(message, /no shard can claim/u);
    assert.match(message, /Nested\/Brand-New\.spec\.mjs/u);
    assert.doesNotMatch(message, /Claim each in/u);
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
    // Anchored on the whole path segment: a longer name that merely ends the
    // same way must not be dragged into the shard.
    assert.equal(pattern.test("/work/test/playwright/not-offline-indexeddb.spec.mjs"), false);
  });

  it("distinguishes two specs that share a basename in different directories", () => {
    const nested = { id: "nested", name: "n", specs: ["a/shared.spec.mjs"] };
    const pattern = shardTestMatch(nested);
    assert.ok(pattern.test("/work/test/playwright/a/shared.spec.mjs"));
    assert.ok(pattern.test("C:\\work\\test\\playwright\\a\\shared.spec.mjs"));
    assert.equal(pattern.test("/work/test/playwright/b/shared.spec.mjs"), false);
    assert.equal(pattern.test("/work/test/playwright/shared.spec.mjs"), false);
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
