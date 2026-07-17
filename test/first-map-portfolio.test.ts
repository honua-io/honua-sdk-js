import { readFile, readdir } from "node:fs/promises";

import { describe, expect, it } from "vitest";

async function json(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
}

describe("First Map portfolio convergence", () => {
  it("keeps one executable and stable compatibility aliases", async () => {
    const packageJson = await json("package.json");
    const scripts = packageJson.scripts as Record<string, string>;
    expect(scripts["demo:standalone"]).toBe("npm run demo:quickstart");
    expect(scripts["demo:standalone:mock"]).toBe("npm run demo:quickstart:mock");
    expect(scripts["demo:endpoint-to-map"]).toBe("npm run demo:quickstart");
    expect(scripts["demo:endpoint-to-map:mock"]).toBe("npm run demo:quickstart:mock");
    expect(scripts["test:playwright:standalone"]).toBe("npm run test:playwright:quickstart");

    for (const directory of ["examples/standalone-quickstart", "examples/endpoint-to-map"]) {
      const files = (await readdir(directory, { recursive: true, withFileTypes: true }))
        .filter((entry) => entry.isFile() || entry.isSymbolicLink())
        .map((entry) => entry.name)
        .sort();
      expect(files).toEqual(["README.md"]);
      expect(await readFile(`${directory}/README.md`, "utf8")).toContain("maplibre-quickstart");
    }
  });

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
