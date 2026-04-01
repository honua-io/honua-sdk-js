import { describe, expect, it } from "vitest";

import { resolveStoryDemoConfig } from "../examples/storytelling-25d-map/src/config.js";

describe("storytelling 2.5D demo config", () => {
  it("uses deterministic same-origin defaults for the local review lane", () => {
    const config = resolveStoryDemoConfig({});

    expect(config.honuaBaseUrl).toBe("");
    expect(config.collections).toEqual({
      assets: "story-25d-assets",
      route: "story-25d-route",
      stops: "story-25d-stops",
    });
    expect(config.basemapStyle).toBe("https://demotiles.maplibre.org/style.json");
    expect(config.sourceIds.assets).toBe("story-assets");
  });

  it("normalizes live environment overrides without trailing slashes", () => {
    const config = resolveStoryDemoConfig({
      VITE_HONUA_25D_BASE_URL: "https://demo.honua.example///",
      VITE_HONUA_25D_BASEMAP_STYLE: "https://maps.example/style.json",
      VITE_HONUA_25D_ASSETS_COLLECTION: "ops-assets",
      VITE_HONUA_25D_ROUTE_COLLECTION: "ops-route",
      VITE_HONUA_25D_STOPS_COLLECTION: "ops-stops",
      VITE_HONUA_25D_API_KEY: "demo-key",
    });

    expect(config.honuaBaseUrl).toBe("https://demo.honua.example");
    expect(config.apiKey).toBe("demo-key");
    expect(config.collections.assets).toBe("ops-assets");
    expect(config.collections.route).toBe("ops-route");
    expect(config.collections.stops).toBe("ops-stops");
    expect(config.basemapStyle).toBe("https://maps.example/style.json");
  });
});
