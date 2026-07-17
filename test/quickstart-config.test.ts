import { describe, expect, it } from "vitest";

import { resolveFirstMapConfig } from "../examples/maplibre-quickstart/src/first-map-config.js";
import { firstMapCopyCode } from "../examples/maplibre-quickstart/src/first-map-copy.js";
import {
  FIRST_MAP_RUNTIME_BUDGET_MS,
  evaluateFirstMapRuntime,
  resolveFirstMapShellConfig,
  toFirstMapConfigInput,
} from "../examples/maplibre-quickstart/src/first-map-shell-config.js";

describe("First Map shell configuration", () => {
  it("defaults to a credential-free same-origin fixture with an explicit runtime budget", () => {
    const config = resolveFirstMapShellConfig({}, "http://127.0.0.1:4173");

    expect(config).toMatchObject({
      endpoint: "http://127.0.0.1:4173/rest/services/natural-earth/FeatureServer/0",
      mode: "fixture",
      protocol: "auto",
      maxFeatures: 5_000,
      basemapStyle: "http://127.0.0.1:4173/__honua-quickstart__/basemap-style.json",
      query: { returnGeometry: true, pagination: { limit: 5_000 } },
    });
    expect(FIRST_MAP_RUNTIME_BUDGET_MS).toBe(5_000);
  });

  it("uses only the reviewed public-live environment surface", () => {
    const config = resolveFirstMapShellConfig(
      {
        VITE_HONUA_FIRST_MAP_BASEMAP_STYLE: "https://tiles.example.test/style.json",
        VITE_HONUA_FIRST_MAP_FILTER: "STATUS = 'Ready'",
        VITE_HONUA_FIRST_MAP_MAX_FEATURES: "50",
        VITE_HONUA_FIRST_MAP_MODE: "public-live",
        VITE_HONUA_FIRST_MAP_PROTOCOL: "ogc-features",
        VITE_HONUA_FIRST_MAP_SOURCE_ID: "operations-areas",
        VITE_HONUA_FIRST_MAP_URL: "https://features.example.test/ogc",
      },
      "https://app.example.test",
    );

    expect(config).toMatchObject({
      endpoint: "https://features.example.test/ogc",
      mode: "public-live",
      protocol: "ogc-features",
      sourceId: "operations-areas",
      maxFeatures: 50,
      query: { where: "STATUS = 'Ready'", pagination: { limit: 50 } },
    });
  });

  it("rejects credential-bearing basemap assets and changes pasted cross-origin URLs to public-live mode", () => {
    expect(() =>
      resolveFirstMapShellConfig(
        { VITE_HONUA_FIRST_MAP_BASEMAP_STYLE: "https://tiles.example.test/style.json?token=secret" },
        "https://app.example.test",
      ),
    ).toThrow("credential-free HTTP(S)");

    const shell = resolveFirstMapShellConfig({}, "https://app.example.test");
    const input = toFirstMapConfigInput(shell, {
      endpoint: "https://public.example.test/rest/services/demo/FeatureServer/0",
      protocol: "auto",
    });
    expect(resolveFirstMapConfig(input).mode).toBe("public-live");
  });

  it("keeps a successful slow public map while controlled qualification still fails closed", () => {
    expect(evaluateFirstMapRuntime("public-live", FIRST_MAP_RUNTIME_BUDGET_MS + 1)).toEqual({
      withinBudget: false,
      preserveSuccessfulMap: true,
    });
    expect(evaluateFirstMapRuntime("fixture", FIRST_MAP_RUNTIME_BUDGET_MS + 1)).toEqual({
      withinBudget: false,
      preserveSuccessfulMap: false,
    });
    expect(evaluateFirstMapRuntime("public-live", FIRST_MAP_RUNTIME_BUDGET_MS)).toEqual({
      withinBudget: true,
      preserveSuccessfulMap: true,
    });
  });

  it("renders the selected bounded filter through copyable public-SDK code without executable markup", () => {
    const config = resolveFirstMapConfig<Record<string, unknown>>({
      endpoint: "https://public.example.test/rest/services/demo/FeatureServer/0",
      maxFeatures: 25,
    });
    const code = firstMapCopyCode(config, "https://tiles.example.test/style.json", {
      returnGeometry: true,
      where: "NAME = '<script>'",
      pagination: { limit: 25 },
    });

    expect(code).toContain('from "@honua/sdk-js"');
    expect(code).toContain('from "@honua/sdk-js/map"');
    expect(code).toContain('await map.once("load")');
    expect(code).toContain("\\u003cscript>");
    expect(code).not.toContain("<script>");
  });
});
