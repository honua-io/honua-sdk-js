import { describe, expect, it } from "vitest";

import { CompatEventBus, DirectionsCompat, DirectionsViewModelCompat } from "../src/esri-compat-entry.js";

describe("DirectionsCompat", () => {
  it("supports when() and watch() lifecycle plus route updates", async () => {
    const eventBus = new CompatEventBus();
    const seenTypes: string[] = [];
    eventBus.onAny((event) => {
      seenTypes.push(event.type);
    });

    const directions = new DirectionsCompat({ eventBus });
    const loadStatusValues: unknown[] = [];
    const loadedValues: unknown[] = [];
    const routeValues: unknown[] = [];
    const loadStatusHandle = directions.watch("loadStatus", (value) => {
      loadStatusValues.push(value);
    });
    const loadedHandle = directions.watch("loaded", (value) => {
      loadedValues.push(value);
    });
    const routeHandle = directions.watch("route", (value) => {
      routeValues.push(value);
    });

    let callbackWidget: DirectionsCompat | undefined;
    const widget = await directions.when((resolvedWidget) => {
      callbackWidget = resolvedWidget;
    });
    directions.setStops([
      { name: "Start", location: [-157.0, 21.3] },
      { name: "End", location: [-157.01, 21.31] },
    ]);
    await directions.solve();
    directions.clearStops();

    loadStatusHandle.remove();
    loadedHandle.remove();
    routeHandle.remove();
    const watchSnapshot = {
      loadStatus: loadStatusValues.length,
      loaded: loadedValues.length,
      route: routeValues.length,
    };
    directions.setStops([
      { name: "Start", location: [-157.0, 21.3] },
      { name: "End", location: [-157.01, 21.31] },
    ]);
    await directions.solve();

    expect(widget).toBe(directions);
    expect(callbackWidget).toBe(directions);
    expect(directions.loaded).toBe(true);
    expect(directions.loadStatus).toBe("loaded");
    expect(loadStatusValues).toEqual(["loading", "loaded"]);
    expect(loadedValues).toEqual([true]);
    expect(routeValues.length).toBe(2);
    expect(routeValues[1]).toBeUndefined();
    expect(seenTypes).toContain("directions.loading");
    expect(seenTypes).toContain("directions.loaded");
    expect(loadStatusValues).toHaveLength(watchSnapshot.loadStatus);
    expect(loadedValues).toHaveLength(watchSnapshot.loaded);
    expect(routeValues).toHaveLength(watchSnapshot.route);
  });

  it("solves directions using route layer and exposes summary", async () => {
    const eventBus = new CompatEventBus();
    const seenTypes: string[] = [];
    eventBus.onAny((event) => {
      seenTypes.push(event.type);
    });

    const directions = new DirectionsCompat({ eventBus });
    directions.setStops([
      { name: "Start", location: [-157.0, 21.3] },
      { name: "End", location: [-157.01, 21.31] },
    ]);

    const route = await directions.solve();
    const summary = directions.getSummary();
    expect(route).toBeDefined();
    expect(summary).toBeDefined();
    expect(summary?.distanceMeters).toBeGreaterThan(0);
    expect(summary?.durationSeconds).toBeGreaterThan(0);
    expect(summary?.stopCount).toBe(2);
    expect(seenTypes).toContain("directions.solve-started");
    expect(seenTypes).toContain("directions.solve-completed");
  });

  it("supports adding and clearing stops", () => {
    const directions = new DirectionsCompat();
    directions.addStop({ location: [0, 0] });
    directions.addStop({ location: [1, 1] });
    expect(directions.layer.stops).toHaveLength(2);
    directions.clearStops();
    expect(directions.layer.stops).toHaveLength(0);
  });
});

describe("DirectionsViewModelCompat", () => {
  it("reads travel modes and solves the route service for graphic stops", async () => {
    const originalFetch = globalThis.fetch;
    const urls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      urls.push(url);
      if (url.includes("retrieveTravelModes")) {
        return new Response(
          JSON.stringify({
            supportedTravelModes: [
              { name: "Walking Time", id: "walk" },
              { name: "Driving Time", id: "drive" },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({
          routes: {
            features: [
              {
                geometry: {
                  paths: [
                    [
                      [-157, 21],
                      [-157.01, 21.01],
                    ],
                  ],
                },
                attributes: { Total_Kilometers: 1.2, Total_TravelTime: 15 },
              },
            ],
          },
          directions: [{ features: [{ attributes: { text: "Walk north", length: 1.2, time: 15 } }] }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    try {
      const viewModel = new DirectionsViewModelCompat({
        routeServiceUrl: "https://example.test/Route/NAServer/Route_World",
      });
      await viewModel.load();
      const walking = viewModel.travelModes.find((mode) => mode.name === "Walking Time");
      viewModel.selectedTravelMode = walking;
      viewModel.stops.addMany([
        { geometry: { x: -157, y: 21 }, attributes: { Name: "Start" } },
        { geometry: { x: -157.01, y: 21.01 }, attributes: { Name: "End" } },
      ]);
      const result = await viewModel.getDirections();
      expect(walking).toBeDefined();
      expect(urls.some((url) => url.includes("/solve"))).toBe(true);
      expect(urls.some((url) => url.includes("travelMode="))).toBe(true);
      expect(result?.routeResults[0]?.directions?.features[0]?.attributes.text).toBe("Walk north");
      expect(result?.routeResults[0]?.route.geometry.paths[0]).toEqual([
        [-157, 21],
        [-157.01, 21.01],
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
