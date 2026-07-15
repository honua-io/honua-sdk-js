import { createHash, randomUUID } from "node:crypto";
import { readFile, symlink, unlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";

import { describe, expect, it, vi } from "vitest";

import {
  inspectCrossSdkSourceTree,
  refreshCrossSdkSourceTree,
  runCrossSdkReferenceCli,
  validateCrossSdkReferenceCorpus,
  validateCrossSdkReferenceFiles,
} from "../bench/cross-sdk/validate.js";

const require = createRequire(import.meta.url);
const Ajv2020 = require("ajv/dist/2020").default;
const addFormats = require("ajv-formats").default;

async function corpus(): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile("bench/cross-sdk/corpus.json", "utf8")) as Record<string, unknown>;
}

function honuaSourceTree(value: Record<string, unknown>): Record<string, unknown> {
  const honua = (value.references as Array<Record<string, unknown>>).find(({ id }) => id === "honua-sdk-js");
  if (!honua) throw new Error("Honua reference missing");
  const sourceTree = (honua.package as Record<string, unknown>).sourceTree;
  if (!sourceTree || typeof sourceTree !== "object") throw new Error("Honua source tree missing");
  return sourceTree as Record<string, unknown>;
}

function temporaryCorpusPath(label: string): string {
  return `bench/cross-sdk/.${label}-${process.pid}-${randomUUID()}.json`;
}

function staleTree(current: string, source: string): string {
  for (const candidate of ["0".repeat(40), "f".repeat(40), "1".repeat(40)]) {
    if (candidate !== current && !source.includes(candidate)) return candidate;
  }
  throw new Error("Unable to construct a unique stale tree fixture");
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

  it("rejects unequal paths, stale reviews, unlocked packages, legal drift, and credential fields", async () => {
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
        const reference = (value.references as Array<Record<string, unknown>>)[0];
        if (reference) (reference.licenseEvidence as Record<string, unknown>).publication = "not-cleared";
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

  it("keeps stale source-tree validation fail-closed while offline inspection succeeds", async () => {
    const value = await corpus();
    const current = inspectCrossSdkSourceTree();
    const stale = staleTree(current, JSON.stringify(value));
    honuaSourceTree(value).gitTree = stale;
    const temporaryCorpus = temporaryCorpusPath("stale-source-tree");
    const network = vi.fn(() => {
      throw new Error("network access is forbidden");
    });
    vi.stubGlobal("fetch", network);
    await writeFile(temporaryCorpus, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    try {
      await expect(validateCrossSdkReferenceFiles(temporaryCorpus)).rejects.toThrow(
        "honua-sdk-js source tree revision mismatch",
      );
      const output: string[] = [];
      await runCrossSdkReferenceCli([temporaryCorpus, "--print-source-tree"], (value) => output.push(value));
      expect(output.join("")).toBe(`${current}\n`);
      expect(current).toMatch(/^[a-f0-9]{40}$/);
      expect(network).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
      await unlink(temporaryCorpus);
    }
  });

  it("refreshes only the Honua source-tree field and is deterministic and offline", async () => {
    const original = await readFile("bench/cross-sdk/corpus.json", "utf8");
    const termsBefore = await readFile("bench/cross-sdk/terms-review.json", "utf8");
    const current = inspectCrossSdkSourceTree();
    const stale = staleTree(current, original);
    const staleCorpus = original.replace(JSON.stringify(current), JSON.stringify(stale));
    expect(staleCorpus).not.toBe(original);
    const temporaryCorpus = temporaryCorpusPath("refresh-source-tree");
    const network = vi.fn(() => {
      throw new Error("network access is forbidden");
    });
    vi.stubGlobal("fetch", network);
    await writeFile(temporaryCorpus, staleCorpus, "utf8");
    try {
      const output: string[] = [];
      await runCrossSdkReferenceCli([temporaryCorpus, "--write-source-tree"], (value) => output.push(value));
      expect(JSON.parse(output.join(""))).toEqual({
        schemaVersion: 1,
        outcome: "updated",
        previousGitTree: stale,
        gitTree: current,
      });
      expect(await readFile(temporaryCorpus, "utf8")).toBe(original);
      await expect(refreshCrossSdkSourceTree(temporaryCorpus)).resolves.toEqual({
        schemaVersion: 1,
        outcome: "unchanged",
        previousGitTree: current,
        gitTree: current,
      });
      await expect(validateCrossSdkReferenceFiles(temporaryCorpus)).resolves.toMatchObject({ valid: true });
      expect(await readFile("bench/cross-sdk/terms-review.json", "utf8")).toBe(termsBefore);
      expect(network).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
      await unlink(temporaryCorpus);
    }
  });

  it("keeps source-tree recovery usable when legal review freshness must fail later validation", async () => {
    const value = await corpus();
    const current = inspectCrossSdkSourceTree();
    const stale = staleTree(current, JSON.stringify(value));
    honuaSourceTree(value).gitTree = stale;
    value.reviewExpiresAt = value.reviewedAt;
    const temporaryCorpus = temporaryCorpusPath("expired-review-source-tree");
    await writeFile(temporaryCorpus, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    try {
      await expect(refreshCrossSdkSourceTree(temporaryCorpus)).resolves.toEqual({
        schemaVersion: 1,
        outcome: "updated",
        previousGitTree: stale,
        gitTree: current,
      });
      await expect(validateCrossSdkReferenceFiles(temporaryCorpus, "2027-01-01")).rejects.toThrow(
        "license review evidence is stale",
      );
      expect(
        honuaSourceTree(JSON.parse(await readFile(temporaryCorpus, "utf8")) as Record<string, unknown>).gitTree,
      ).toBe(current);
    } finally {
      await unlink(temporaryCorpus);
    }
  });

  it("does not let source-tree recovery bypass unrelated fixture drift", async () => {
    const value = await corpus();
    const current = inspectCrossSdkSourceTree();
    const stale = staleTree(current, JSON.stringify(value));
    honuaSourceTree(value).gitTree = stale;
    ((value.fixtures as Array<Record<string, unknown>>)[0] as Record<string, unknown>).sha256 = "0".repeat(64);
    const temporaryCorpus = temporaryCorpusPath("source-tree-fixture-drift");
    await writeFile(temporaryCorpus, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    try {
      await expect(refreshCrossSdkSourceTree(temporaryCorpus)).resolves.toMatchObject({ outcome: "updated" });
      await expect(validateCrossSdkReferenceFiles(temporaryCorpus)).rejects.toThrow(
        "fixture digest mismatch: five-public-synthetic-points-v1",
      );
      const refreshed = JSON.parse(await readFile(temporaryCorpus, "utf8")) as Record<string, unknown>;
      expect(honuaSourceTree(refreshed).gitTree).toBe(current);
      expect(((refreshed.fixtures as Array<Record<string, unknown>>)[0] as Record<string, unknown>).sha256).toBe(
        "0".repeat(64),
      );
    } finally {
      await unlink(temporaryCorpus);
    }
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
