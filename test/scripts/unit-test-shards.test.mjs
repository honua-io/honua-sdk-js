import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { auditPartition, loadUnitShardConfig, partitionSpecs } from "../../scripts/unit-test-shards.mjs";

describe("unit coverage shard partition", () => {
  it("uses a bounded reviewed shard count", () => {
    assert.equal(loadUnitShardConfig().shardCount, 4);
  });

  it("accepts a complete, non-overlapping partition", () => {
    assert.deepEqual(auditPartition(["a.test.ts", "b.test.ts"], [["a.test.ts"], ["b.test.ts"]]), {
      specCount: 2,
      shardCounts: [1, 1],
    });
  });

  it("assigns every path deterministically", () => {
    const files = ["test/a.test.ts", "test/b.test.ts", "test/c.test.ts"];
    assert.deepEqual(partitionSpecs(files, 2), partitionSpecs(files, 2));
    auditPartition(files, partitionSpecs(files, 2));
  });

  it("rejects missing and multiply-owned specs", () => {
    assert.throws(() => auditPartition(["a.test.ts", "b.test.ts"], [["a.test.ts"], []]), /b\.test\.ts.*none/u);
    assert.throws(() => auditPartition(["a.test.ts"], [["a.test.ts"], ["a.test.ts"]]), /owners=1,2/u);
  });
});
