/**
 * Candidate-bound live coverage for the alert draft-validation contract.
 * Cross-references: honua-server#3388 and honua-release#157.
 *
 * @module
 */

import { expect, it } from "vitest";
import { createHonuaOperate } from "../../../src/operate/index.js";
import { integrationSuite, runWithDiagnostics } from "../harness.js";

const SURFACE = "alerts";

integrationSuite("Alert draft evaluation", SURFACE, ({ client, config, context }) => {
  it("validates a draft on the release candidate [cert:alerts/evaluation#positive] [cert:alerts/evaluation#media-schema]", async (ctx) => {
    const candidateCutAt = process.env.HONUA_CANDIDATE_CUT_AT?.trim();
    if (!candidateCutAt) {
      ctx.skip("HONUA_CANDIDATE_CUT_AT is required to bind alerts.evaluation evidence to a release candidate");
      return;
    }

    const operate = createHonuaOperate({ client });
    const result = await runWithDiagnostics(context, "operate.alertRules.test", () =>
      operate.alertRules.test({
        rule: {
          serviceId: config.serviceId,
          // Draft validation requires a positive layer identifier even though
          // the self-contained protocol fixture uses GeoServices layer 0.
          layerId: Math.max(config.layerId, 1),
          ruleName: `sdk-candidate-${candidateCutAt}`,
          triggerType: "enter",
          conditionsJson: "{}",
          cooldownSeconds: 0,
          severity: "warning",
          editionRequired: "pro",
          channels: [],
          isActive: true,
        },
        zone: {
          serviceId: config.serviceId,
          zoneName: `sdk-candidate-zone-${candidateCutAt}`,
          wkt: "POLYGON ((-158 21, -157 21, -157 22, -158 22, -158 21))",
          srid: 4326,
        },
      }),
    );

    expect(result.supported).toBe(true);
    if (!result.supported) return;
    expect(result.value.isValid).toBe(true);
    expect(result.value.errors).toEqual([]);
    expect(result.value.evaluatedAt).toBeTruthy();
  });
});
