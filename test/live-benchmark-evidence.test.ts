import { describe, expect, it } from "vitest";

import { collectLiveEvidence } from "../scripts/live-benchmark-evidence.mjs";

describe("live benchmark evidence", () => {
  it("skips safely and records a reason unless explicitly enabled", async () => {
    const report = await collectLiveEvidence({ GITHUB_EVENT_NAME: "pull_request" });

    expect(report).toMatchObject({
      format: "honua.sdk.benchmark-live-evidence.v1",
      schemaVersion: 1,
      run: {
        status: "skipped",
        trigger: "pull_request",
        skipReason: expect.stringContaining("opt-in"),
      },
      targets: [],
    });
    expect(JSON.stringify(report)).not.toContain("api-key");
  });
});
