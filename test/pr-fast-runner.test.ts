import { describe, expect, it } from "vitest";

import { parseArgs } from "../scripts/run-pr-fast.mjs";

describe("PR-fast runner arguments", () => {
  it("keeps the monotonic timestamp and output arguments distinct", () => {
    expect(parseArgs(["--started-at-monotonic-ms", "123456", "--output", "test-results/pr-fast.json"])).toMatchObject({
      startedAtMonotonicMs: 123456,
      output: "test-results/pr-fast.json",
    });
  });

  it("rejects a missing timestamp before consuming the next flag", () => {
    expect(() => parseArgs(["--started-at-monotonic-ms", "--output", "test-results/pr-fast.json"])).toThrow(
      "--started-at-monotonic-ms requires a value",
    );
  });
});
