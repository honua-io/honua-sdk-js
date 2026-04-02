// @ts-nocheck

import { describe, expect, it } from "vitest";

import { toFeatureCollection } from "../examples/kepler-analytics/scripts/refresh-fixture.mjs";

describe("kepler analytics fixture refresh", () => {
  it("sorts raw Honua features by attributes replay time before GeoJSON conversion", () => {
    const collection = toFeatureCollection(
      [
        {
          attributes: {
            incident_id: "incident-3",
            replay_at: "2026-05-01T16:47:00.000Z",
          },
          geometry: {
            x: -157.8605,
            y: 21.3072,
          },
        },
        {
          attributes: {
            incident_id: "incident-1",
            replay_at: "2026-05-01T16:05:00.000Z",
          },
          geometry: {
            x: -157.8581,
            y: 21.3067,
          },
        },
        {
          attributes: {
            incident_id: "incident-2",
            replay_at: "2026-05-01T16:32:00.000Z",
          },
          geometry: {
            x: -157.8574,
            y: 21.3049,
          },
        },
      ],
      "replay_at",
    );

    expect(collection.features.map((feature) => feature.properties.incident_id)).toEqual([
      "incident-1",
      "incident-2",
      "incident-3",
    ]);
    expect(collection.features.map((feature) => feature.properties.replay_at)).toEqual([
      "2026-05-01T16:05:00.000Z",
      "2026-05-01T16:32:00.000Z",
      "2026-05-01T16:47:00.000Z",
    ]);
  });
});
