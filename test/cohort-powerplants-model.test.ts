import { describe, expect, it } from "vitest";
import { mergeFuelCounts } from "../experiments/esri-cohort/powerplants/src/model.js";

describe("powerplant cohort count reconciliation", () => {
  it("retains null-fuel plants when normalization merges them with the Other category", () => {
    // Observed source: 3 null-fuel records and 36 explicitly labelled Other.
    // Comparing either raw group with 39 normalized plants falsely rejects a full import.
    expect(
      mergeFuelCounts(
        [
          { fuel1: null, plant_count: 3 },
          { fuel1: "Other", plant_count: 36 },
          { fuel1: "Solar", plant_count: 5427 },
        ],
        "fuel1",
      ),
    ).toEqual([
      { fuel: "other", count: 39 },
      { fuel: "solar", count: 5427 },
    ]);
  });

  it("combines case variants and preserves unknown named fuels for inspection", () => {
    expect(
      mergeFuelCounts(
        [
          { fuel1: "Wave and Tidal", plant_count: 4 },
          { fuel1: "waveandtidal", plant_count: 2 },
          { fuel1: "Future Fuel", plant_count: 5 },
        ],
        "fuel1",
      ),
    ).toEqual([
      { fuel: "waveandtidal", count: 6 },
      { fuel: "futurefuel", count: 5 },
    ]);
  });
});
