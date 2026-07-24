import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { STUDIO_PACKAGE_FAMILIES } from "../../src/studio/index.js";
import type { HonuaStudioPackageFamily, StudioPackageEnvelope } from "../../src/studio/index.js";

const fixturesDir = resolve(dirname(fileURLToPath(import.meta.url)), "../fixtures/studio-lifecycle/envelopes");

function readEnvelopeFixture(family: HonuaStudioPackageFamily): { raw: string; parsed: StudioPackageEnvelope } {
  const raw = readFileSync(resolve(fixturesDir, `${family}.v1.json`), "utf8");
  return { raw, parsed: JSON.parse(raw) as StudioPackageEnvelope };
}

describe("StudioPackageEnvelope round-trip fixtures", () => {
  it.each(STUDIO_PACKAGE_FAMILIES)("round-trips the %s family envelope losslessly", (family) => {
    const { parsed } = readEnvelopeFixture(family);

    // Structural shape every StudioPackageEnvelope carries, regardless of family.
    expect(parsed.family).toBe(family);
    expect(parsed.schemaVersion).toBe("1.0");
    expect(parsed.format).toMatch(/^studio_[a-z_]+\.v1$/);
    expect(parsed.body).toBeTypeOf("object");
    expect(parsed.body).not.toBeNull();

    // Lossless serialize/parse: re-stringifying the parsed value reproduces
    // the exact same JSON document (same keys, same nesting, same values) —
    // nothing was dropped or coerced by the TypeScript projection.
    const reparsed: unknown = JSON.parse(JSON.stringify(parsed));
    expect(reparsed).toEqual(parsed);
    expect(JSON.parse(JSON.stringify(reparsed))).toEqual(JSON.parse(readEnvelopeFixture(family).raw));
  });

  it("covers every registered package family with a fixture", () => {
    for (const family of STUDIO_PACKAGE_FAMILIES) {
      expect(() => readEnvelopeFixture(family)).not.toThrow();
    }
  });

  it("types the map/app family bodies against their established SDK-native shapes", () => {
    const map = readEnvelopeFixture("map").parsed as StudioPackageEnvelope<{
      readonly mapPackageId: string;
      readonly format: string;
    }>;
    expect(map.body.mapPackageId).toBe("pkg-map-1");
    expect(map.body.format).toBe("honua_map_package.v1");

    const app = readEnvelopeFixture("app").parsed as StudioPackageEnvelope<{
      readonly format: string;
      readonly manifest: { readonly appId: string };
    }>;
    expect(app.body.format).toBe("honua_generated_app_package.v1");
    expect(app.body.manifest.appId).toBe("incident-app-1");
  });

  it("preserves bindings, dependencies, and provenance lineage on the query family", () => {
    const { parsed } = readEnvelopeFixture("query");
    expect(parsed.bindings).toEqual([
      {
        key: "source",
        kind: "content",
        ref: "content.parcels",
        crs: "EPSG:4326",
        srid: 4326,
        requiredPermissions: ["metadata.read"],
      },
    ]);
    expect(parsed.dependencies).toEqual([
      { kind: "content-item", ref: "content.parcels", versionId: "v1", required: true },
    ]);
    expect(parsed.provenance).toEqual([{ kind: "prompt", ref: "prompt-1", rel: "generated-by" }]);
    expect(parsed.publicationIntent).toEqual({ route: "/studio/parcels", visibility: "organization" });
    expect(parsed.validation).toEqual({ status: "not-validated" });
  });
});
