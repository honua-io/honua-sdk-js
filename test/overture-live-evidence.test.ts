import { afterEach, describe, expect, it } from "vitest";

import { collectOvertureLiveEvidence } from "../scripts/overture-live-evidence.mjs";

const original = process.env.HONUA_OVERTURE_LIVE_ENABLED;

afterEach(() => {
  if (original === undefined) delete process.env.HONUA_OVERTURE_LIVE_ENABLED;
  else process.env.HONUA_OVERTURE_LIVE_ENABLED = original;
});

describe("Overture live evidence", () => {
  it("is opt-in and emits a valid shared skipped envelope without network access", async () => {
    delete process.env.HONUA_OVERTURE_LIVE_ENABLED;
    const evidence = await collectOvertureLiveEvidence();
    expect(evidence).toMatchObject({
      format: "honua.sdk.sample-evidence.v1",
      sampleId: "overture-geoparquet",
      lane: "live",
      status: "skipped",
      authMode: "anonymous",
      degradation: { state: "unavailable" },
    });
    expect(evidence.reason).toContain("opt-in");
    expect(JSON.stringify(evidence)).not.toMatch(/AKIA|Bearer\s|[?&](token|key|signature)=/i);
  });
});
