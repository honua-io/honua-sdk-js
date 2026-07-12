import { performance } from "node:perf_hooks";
import { expect, it } from "vitest";

import { planOvertureQuery } from "../examples/overture-geoparquet/src/planner.js";
import { OVERTURE_POLICY } from "../examples/overture-geoparquet/src/source-manifests.js";
import { INCIDENT_SOURCE_ID } from "../examples/realtime-incident-dashboard/src/fixtures.js";
import { createFixtureIncidentTransport } from "../examples/realtime-incident-dashboard/src/realtime-fixture.js";
import type { IncidentFeature } from "../examples/realtime-incident-dashboard/src/types.js";
import { createRealtimeFeatureStore } from "../src/realtime/index.js";

it("keeps 500 incident reconnect/resume cycles inside the deterministic in-process budget", () => {
  let now = 50_000;
  const store = createRealtimeFeatureStore<IncidentFeature>();
  const transport = createFixtureIncidentTransport({ now: () => now });
  store.connect(transport, { sourceId: INCIDENT_SOURCE_ID });

  const started = performance.now();
  for (let index = 0; index < 500; index += 1) {
    now += 1_000;
    transport.reconnect();
    transport.resume();
  }
  const elapsedMs = performance.now() - started;

  expect(store.state.status).toBe("live");
  expect(store.state.cursor).toContain("heartbeat");
  expect(elapsedMs).toBeLessThan(1_000);
  store.close();
});

it("keeps 1,000 bounded Overture plans inside the deterministic in-process budget", () => {
  const input = {
    lane: "fixture" as const,
    aoi: [-157.9, 21.25, -157.8, 21.35] as const,
    category: "all",
    limit: 100,
  };
  const fingerprints = new Set<string>();
  const started = performance.now();
  for (let index = 0; index < 1_000; index += 1) {
    fingerprints.add(planOvertureQuery(input, OVERTURE_POLICY).cacheKey);
  }
  const elapsedMs = performance.now() - started;

  expect(fingerprints.size).toBe(1);
  expect(elapsedMs).toBeLessThan(1_000);
});
