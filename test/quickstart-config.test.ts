import { describe, expect, it } from "vitest";

import { resolveQuickstartConfig, resolveQuickstartStagingConfig } from "../examples/maplibre-quickstart/src/config.js";

describe("maplibre quickstart config", () => {
  it("uses deterministic same-origin defaults for the local review lane", () => {
    const config = resolveQuickstartConfig({});

    expect(config.honuaBaseUrl).toBe("");
    expect(config.serviceId).toBe("natural-earth");
    expect(config.layerId).toBe(0);
    expect(config.where).toBe("1=1");
    expect(config.resultRecordCount).toBe(25);
    expect(config.basemapStyle).toBe("https://demotiles.maplibre.org/style.json");
    expect(config.sourceId).toBe("quickstart-features");
  });

  it("normalizes live overrides and forwards auth options", () => {
    const config = resolveQuickstartConfig({
      VITE_HONUA_QUICKSTART_BASE_URL: "https://demo.honua.example///",
      VITE_HONUA_QUICKSTART_SERVICE_ID: "operations",
      VITE_HONUA_QUICKSTART_LAYER_ID: "7",
      VITE_HONUA_QUICKSTART_WHERE: "status = 'open'",
      VITE_HONUA_QUICKSTART_RESULT_RECORD_COUNT: "12",
      VITE_HONUA_QUICKSTART_BASEMAP_STYLE: "https://maps.example/style.json",
      VITE_HONUA_QUICKSTART_API_KEY: "demo-key",
      VITE_HONUA_QUICKSTART_BEARER_TOKEN: "demo-token",
    });

    expect(config.honuaBaseUrl).toBe("https://demo.honua.example");
    expect(config.serviceId).toBe("operations");
    expect(config.layerId).toBe(7);
    expect(config.where).toBe("status = 'open'");
    expect(config.resultRecordCount).toBe(12);
    expect(config.basemapStyle).toBe("https://maps.example/style.json");
    expect(config.apiKey).toBe("demo-key");
    expect(config.bearerToken).toBe("demo-token");
  });

  it("requires the staging contract keys", () => {
    expect(() => resolveQuickstartStagingConfig({})).toThrow("HONUA_STAGING_BASE_URL is required.");
  });

  it("resolves staging configuration without browser-only env vars", () => {
    const config = resolveQuickstartStagingConfig({
      HONUA_STAGING_BASE_URL: "https://staging.honua.example/",
      HONUA_STAGING_SERVICE_ID: "ready-layer",
      HONUA_STAGING_LAYER_ID: "3",
      HONUA_STAGING_WHERE: "1=1",
      HONUA_STAGING_RESULT_RECORD_COUNT: "10",
      HONUA_STAGING_API_KEY: "staging-key",
    });

    expect(config.honuaBaseUrl).toBe("https://staging.honua.example");
    expect(config.serviceId).toBe("ready-layer");
    expect(config.layerId).toBe(3);
    expect(config.resultRecordCount).toBe(10);
    expect(config.apiKey).toBe("staging-key");
  });
});
