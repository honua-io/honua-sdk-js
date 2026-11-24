import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

async function json(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
}

describe("First Map portfolio convergence", () => {
  it("projects First Map as the sole catalog journey without redesigning React", async () => {
    const catalog = await json("samples/catalog.v1.json");
    const samples = catalog.samples as Array<{ id: string }>;
    expect(samples.some(({ id }) => id === "maplibre-quickstart")).toBe(true);
    expect(samples.some(({ id }) => id === "standalone-quickstart")).toBe(false);
    expect(samples.some(({ id }) => id === "endpoint-to-map")).toBe(false);

    const migration = await json("samples/contract/v2/migrations/catalog.v1-to-v2.json");
    const overrides = migration.sampleOverrides as Record<
      string,
      { track?: string; journeyId?: string; validationProfile?: string }
    >;
    expect(overrides["maplibre-quickstart"]).toMatchObject({
      track: "golden",
      journeyId: "first-map",
      validationProfile: "golden-browser",
    });
    expect(overrides["react-quickstart"]).toMatchObject({ track: "recipe", validationProfile: "browser-recipe" });
    expect(overrides["standalone-quickstart"]).toBeUndefined();
    expect(overrides["endpoint-to-map"]).toBeUndefined();
  });
});
