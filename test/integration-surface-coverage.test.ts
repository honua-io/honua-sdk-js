import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SURFACES_DIR = path.resolve(fileURLToPath(import.meta.url), "../integration/surfaces");

const REQUIRED_SURFACES = [
  "feature-server",
  "map-server",
  "image-server",
  "geometry-server",
  "gp-server",
  "ogc-features",
  "ogc-tiles",
  "ogc-maps",
  "ogc-processes",
  "stac",
  "wfs",
  "wms",
  "wmts",
  "odata",
  "geocoding",
] as const;

describe("integration API surface registry", () => {
  it("has one integration surface entry for every public server-backed protocol API", () => {
    const files = fs.readdirSync(SURFACES_DIR).filter((name) => name.endsWith(".integration.ts"));
    const sourceByFile = new Map(files.map((name) => [name, fs.readFileSync(path.join(SURFACES_DIR, name), "utf8")]));
    const joined = [...sourceByFile.values()].join("\n");

    for (const surface of REQUIRED_SURFACES) {
      const registration = new RegExp(
        `(?:integrationSuite|skippedIntegrationSuite)\\([^\\n]*["']${escapeRegExp(surface)}["']`,
      );
      expect(joined, `missing integration registration for ${surface}`).toMatch(registration);
    }
  });
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
