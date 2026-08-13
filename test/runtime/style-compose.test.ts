/**
 * Regression coverage for honua-io/honua-sdk-js#1269.
 *
 * `composeStyle` used to write `layout: undefined` / `paint: undefined` onto
 * layers that never declared them. MapLibre's `Style.setState` — the code
 * behind `map.setStyle(style, { diff: true })` — validates the incoming
 * document first and **returns `false` without throwing** when validation
 * fails, so the diff is never applied: the map silently stops updating while
 * every non-map projection of the same state stays correct.
 *
 * These tests drive the real gate rather than an assumption about it:
 * `validateStyleMin` and `diff` come from
 * `@maplibre/maplibre-gl-style-spec`, the same package MapLibre GL JS calls
 * in `setState` (its `validateStyle` is `validateStyleMin` plus
 * string/Buffer parsing, which a composed in-memory style never needs).
 */

import * as styleSpec from "@maplibre/maplibre-gl-style-spec";
import { describe, expect, test } from "vitest";

import {
  HONUA_MAP_PACKAGE_FORMAT_V1,
  type HonuaMapPackage,
  applyStyleRefs,
  applyTheme,
  composeStyle,
} from "../../src/runtime/index.js";
import type { HonuaStyleSpecification } from "../../src/style/specification.js";

const { diff, validateStyleMin } = styleSpec as unknown as {
  diff: (before: unknown, after: unknown) => readonly { command: string }[];
  validateStyleMin: (style: unknown) => readonly { message: string }[];
};

// ── Helpers ──────────────────────────────────────────────────

/**
 * Every path in `value` whose own enumerable property is present but
 * `undefined`. A structural assertion, so it keeps holding as the layer
 * shape grows new optional properties.
 */
function undefinedPaths(value: unknown, path = "$"): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) => undefinedPaths(entry, `${path}[${index}]`));
  }
  if (typeof value !== "object" || value === null) return [];
  const found: string[] = [];
  for (const [key, entry] of Object.entries(value)) {
    const child = `${path}.${key}`;
    if (entry === undefined) found.push(child);
    else found.push(...undefinedPaths(entry, child));
  }
  return found;
}

/**
 * The gate MapLibre applies in `Style.setState`: validate the next state,
 * give up silently when it does not pass, otherwise diff it against the
 * current state and apply the resulting operations. Mirrors the real
 * control flow — no throw on rejection, which is exactly why #1269 was
 * invisible from the outside.
 */
function setStyleWithDiff(
  current: unknown,
  next: unknown,
): { applied: boolean; operations: readonly string[]; errors: readonly string[] } {
  const errors = validateStyleMin(next).map((error) => error.message);
  if (errors.length > 0) return { applied: false, operations: [], errors };
  const operations = diff(current, next).map((change) => change.command);
  return { applied: operations.length > 0, operations, errors: [] };
}

function geoJsonSources(): HonuaStyleSpecification["sources"] {
  return {
    parcels: { type: "geojson", data: { type: "FeatureCollection", features: [] } },
  };
}

/**
 * A package whose layers omit every optional MapLibre property — the shape
 * that used to come out of composition carrying `layout: undefined`.
 */
function makePackage(overrides: Partial<HonuaMapPackage> = {}): HonuaMapPackage {
  return {
    mapPackageId: "pkg-1269",
    format: HONUA_MAP_PACKAGE_FORMAT_V1,
    sourceBindings: [],
    mapSpec: {
      version: 8,
      sources: geoJsonSources(),
      layers: [
        { id: "parcels-fill", type: "fill", source: "parcels" },
        { id: "parcels-line", type: "line", source: "parcels" },
      ],
    },
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────

describe("composeStyle: no present-but-undefined properties (#1269)", () => {
  test("layers that omit optional properties keep omitting them after composition", async () => {
    const pkg = makePackage({
      styleRefs: [{ styleId: "s1", body: { "parcels-fill": { paint: { "fill-color": "#112233" } } } }],
      theme: { tokens: { primary: "#445566" } },
    });

    const composed = await composeStyle(pkg, pkg.mapSpec, {});

    expect(undefinedPaths(composed)).toEqual([]);
    const line = composed.layers.find((layer) => layer.id === "parcels-line");
    expect(line && Object.keys(line)).toEqual(["id", "type", "source"]);
    // The overridden layer gains paint only; nothing else is materialized.
    const fill = composed.layers.find((layer) => layer.id === "parcels-fill");
    expect(fill?.paint).toEqual({ "fill-color": "#112233" });
    expect(Object.hasOwn(fill ?? {}, "layout")).toBe(false);
    expect(Object.hasOwn(fill ?? {}, "metadata")).toBe(false);
  });

  test("composition strips undefined-valued properties supplied by the input style", async () => {
    const pkg = makePackage();
    const dirty = {
      ...pkg.mapSpec,
      metadata: undefined,
      name: undefined,
      layers: pkg.mapSpec.layers.map((layer) => ({ ...layer, layout: undefined, filter: undefined })),
    } as unknown as HonuaStyleSpecification;

    const composed = await composeStyle(pkg, dirty, {});

    expect(undefinedPaths(composed)).toEqual([]);
    expect(validateStyleMin(composed)).toEqual([]);
  });

  test("composed style passes the MapLibre style-spec validator", async () => {
    const pkg = makePackage({
      styleRefs: [{ styleId: "s1", body: { "parcels-line": { layout: { "line-cap": "round" }, minzoom: 4 } } }],
    });

    const composed = await composeStyle(pkg, pkg.mapSpec, {});

    expect(validateStyleMin(composed)).toEqual([]);
    expect(composed.layers.find((layer) => layer.id === "parcels-line")?.layout).toEqual({ "line-cap": "round" });
  });

  test("a composed style actually applies through setStyle(..., { diff: true })", async () => {
    const pkg = makePackage();
    const current = await composeStyle(pkg, pkg.mapSpec, {});

    const next = await composeStyle(
      makePackage({ styleRefs: [{ styleId: "s1", body: { "parcels-fill": { paint: { "fill-color": "#ff00ff" } } } }] }),
      pkg.mapSpec,
      {},
    );

    const result = setStyleWithDiff(current, next);
    expect(result.errors).toEqual([]);
    expect(result.applied).toBe(true);
    expect(result.operations).toContain("setPaintProperty");
  });

  test("the pre-fix shape is what MapLibre rejects — silently", () => {
    const rejected = setStyleWithDiff(
      { version: 8, sources: geoJsonSources(), layers: [{ id: "parcels-fill", type: "fill", source: "parcels" }] },
      {
        version: 8,
        sources: geoJsonSources(),
        layers: [
          {
            id: "parcels-fill",
            type: "fill",
            source: "parcels",
            paint: { "fill-color": "#ff00ff" },
            layout: undefined,
          },
        ],
      },
    );

    // No throw, nothing applied: the failure mode the issue describes.
    expect(rejected.applied).toBe(false);
    expect(rejected.errors.join("\n")).toContain("layers[0].layout");
  });
});

describe("style composition siblings do not reintroduce undefined", () => {
  test("applyTheme leaves layers without paint/layout untouched", () => {
    const themed = applyTheme(
      {
        version: 8,
        sources: geoJsonSources(),
        layers: [
          { id: "a", type: "fill", source: "parcels" },
          { id: "b", type: "fill", source: "parcels", paint: { "fill-color": "{theme:primary}" } },
        ],
      },
      { tokens: { primary: "#112233" } },
    );

    expect(undefinedPaths(themed)).toEqual([]);
    expect(Object.hasOwn(themed.layers[0], "paint")).toBe(false);
    expect(Object.hasOwn(themed.layers[0], "layout")).toBe(false);
    expect(themed.layers[1].paint).toEqual({ "fill-color": "#112233" });
  });

  test("applyStyleRefs clones layers without materializing absent properties", async () => {
    const pkg = makePackage({
      styleRefs: [{ styleId: "s1", body: { "parcels-fill": { minzoom: 6 } } }],
    });

    const refs = await applyStyleRefs(pkg.mapSpec, pkg, undefined);

    expect(undefinedPaths(refs)).toEqual([]);
    expect(refs.layers.find((layer) => layer.id === "parcels-fill")?.minzoom).toBe(6);
    expect(Object.hasOwn(refs.layers[1], "paint")).toBe(false);
  });
});
