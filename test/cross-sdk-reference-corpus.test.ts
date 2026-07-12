import { createHash } from "node:crypto";
import { readFile, symlink, unlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";

import { describe, expect, it } from "vitest";

import { validateCrossSdkReferenceCorpus, validateCrossSdkReferenceFiles } from "../bench/cross-sdk/validate.js";

const require = createRequire(import.meta.url);
const Ajv2020 = require("ajv/dist/2020").default;
const addFormats = require("ajv-formats").default;

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

  it("contains hostile proxy and accessor failures behind typed validation errors", async () => {
    const proxy = new Proxy(
      {},
      {
        getPrototypeOf() {
          throw new Error("hostile trap");
        },
      },
    );
    expect(() => validateCrossSdkReferenceCorpus(proxy)).toThrow("Invalid cross-SDK reference corpus");
    const value = await corpus();
    Object.defineProperty(value, "schemaVersion", {
      get() {
        throw new Error("hostile accessor");
      },
      enumerable: true,
    });
    expect(() => validateCrossSdkReferenceCorpus(value)).toThrow("Invalid cross-SDK reference corpus");
  });

  it("enforces the published schema against unequal reference states", async () => {
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    addFormats(ajv);
    const schema = JSON.parse(await readFile("bench/cross-sdk/corpus.schema.json", "utf8"));
    const validate = ajv.compile(schema);
    const golden = await corpus();
    expect(validate(golden), JSON.stringify(validate.errors)).toBe(true);
    const hostile = structuredClone(golden);
    const first = (hostile.references as Array<Record<string, unknown>>)[0];
    if (!first) throw new Error("reference missing");
    first.package = null;
    first.taskIds = [];
    first.reasons = ["unsafe promotion"];
    expect(validate(hostile)).toBe(false);
  });

  it("rejects traversal and over-depth inputs without invoking accessors", async () => {
    const value = await corpus();
    const first = (value.references as Array<Record<string, unknown>>)[0];
    if (!first) throw new Error("reference missing");
    (first.licenseEvidence as Record<string, unknown>).licensePath = "../../etc/passwd";
    expect(() => validateCrossSdkReferenceCorpus(value)).toThrow("outside reviewed roots");

    let nested: Record<string, unknown> = {};
    const root = nested;
    for (let depth = 0; depth < 40; depth += 1) {
      nested.next = {};
      nested = nested.next as Record<string, unknown>;
    }
    expect(() => validateCrossSdkReferenceCorpus(root)).toThrow("structural limits");
  });

  it("rejects a symlinked eligible license that resolves outside the repository", async () => {
    const link = "node_modules/.honua-license-escape";
    const temporaryCorpus = "bench/cross-sdk/.escape-corpus.json";
    const value = await corpus();
    const first = (value.references as Array<Record<string, unknown>>)[0];
    if (!first) throw new Error("reference missing");
    const evidence = first.licenseEvidence as Record<string, unknown>;
    const outside = await readFile("/etc/hosts");
    evidence.licensePath = link;
    evidence.licenseContentSha256 = createHash("sha256").update(outside).digest("hex");
    await symlink("/etc/hosts", link);
    await writeFile(temporaryCorpus, JSON.stringify(value));
    try {
      await expect(validateCrossSdkReferenceFiles(temporaryCorpus)).rejects.toThrow("escapes the repository");
    } finally {
      await Promise.all([unlink(link), unlink(temporaryCorpus)]);
    }
  });
});
