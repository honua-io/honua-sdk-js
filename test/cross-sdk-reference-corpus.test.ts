import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { validateCrossSdkReferenceCorpus, validateCrossSdkReferenceFiles } from "../bench/cross-sdk/validate.js";

async function corpus(): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile("bench/cross-sdk/corpus.json", "utf8")) as Record<string, unknown>;
}

describe("cross-SDK reference corpus", () => {
  it("validates pinned fixtures, license decisions, and explicit unavailable states", async () => {
    const report = await validateCrossSdkReferenceFiles("bench/cross-sdk/corpus.json");

    expect(report).toMatchObject({
      valid: true,
      crossSdkComparable: false,
      comparisonState: "reference-preflight-only",
      rankingPermitted: false,
      eligibleReferences: ["cesium-js", "deck-gl", "honua-sdk-js", "maplibre-gl-js"],
    });
    expect(report.unavailableReferences.map(({ id }) => id)).toEqual([
      "arcgis-maps-sdk-js",
      "mapbox-gl-js",
      "carto-deck-gl",
    ]);
    expect(report.scenarios).toEqual([
      expect.objectContaining({
        id: "local-geojson-point-render-pick-v1",
        state: "not-measured",
        crossSdkComparable: false,
      }),
    ]);
  });

  it("fails closed when an unavailable proprietary path is promoted", async () => {
    const value = await corpus();
    const references = value.references as Array<Record<string, unknown>>;
    const mapbox = references.find(({ id }) => id === "mapbox-gl-js");
    if (!mapbox) throw new Error("fixture reference missing");
    mapbox.status = "eligible";
    mapbox.taskIds = ["local-geojson-point-render-pick-v1"];
    mapbox.reasons = [];

    expect(() => validateCrossSdkReferenceCorpus(value)).toThrow("mapbox-gl-js is not eligible");
  });

  it("rejects unequal paths, stale reviews, unlocked packages, and credential fields", async () => {
    const mutations: Array<(value: Record<string, unknown>) => void> = [
      (value) => {
        (value.methodology as Record<string, unknown>).network = "internet-allowed";
      },
      (value) => {
        value.reviewExpiresAt = "2026-07-01";
      },
      (value) => {
        const reference = (value.references as Array<Record<string, unknown>>)[0];
        if (reference) (reference.package as Record<string, unknown>).integrity = "latest";
      },
      (value) => {
        value.apiKey = "forbidden";
      },
      (value) => {
        ((value.tasks as Array<Record<string, unknown>>)[0] as Record<string, unknown>).fixtureId = "different-bytes";
      },
    ];
    for (const mutate of mutations) {
      const value = await corpus();
      mutate(value);
      expect(() => validateCrossSdkReferenceCorpus(value, "2026-07-12")).toThrow("Invalid cross-SDK reference corpus");
    }
  });

  it("rejects fixture byte drift", async () => {
    const value = await corpus();
    ((value.fixtures as Array<Record<string, unknown>>)[0] as Record<string, unknown>).sha256 = "0".repeat(64);
    expect(() => validateCrossSdkReferenceCorpus(value)).not.toThrow();
    // Structural validation is intentionally separate from file-system digest validation.
    const original = await readFile("bench/cross-sdk/corpus.json", "utf8");
    expect(original).toContain("b980be3434dbe98483a90e455cf8bbb8f75463fcdc4c0d21d1c9c341b2331164");
  });
});
