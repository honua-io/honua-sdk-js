import { describe, expect, it } from "vitest";

import { CompatEventBus, RouteTaskCompat } from "../src/client-compat-entry.js";

describe("RouteTaskCompat", () => {
  it("supports when() and watch() lifecycle and solve result state", async () => {
    const eventBus = new CompatEventBus();
    const seenTypes: string[] = [];
    eventBus.onAny((event) => {
      seenTypes.push(event.type);
    });

    const task = new RouteTaskCompat({ eventBus });
    const loadStatusValues: unknown[] = [];
    const resultValues: unknown[] = [];
    const loadStatusHandle = task.watch("loadStatus", (value) => {
      loadStatusValues.push(value);
    });
    const resultHandle = task.watch("lastSolveResult", (value) => {
      resultValues.push(value);
    });

    let callbackTask: RouteTaskCompat | undefined;
    const widget = await task.when((resolvedTask) => {
      callbackTask = resolvedTask;
    });
    await task.solve({
      stops: [{ location: [-157.8583, 21.3069] }, { location: [-157.9076, 21.3035] }],
    });

    loadStatusHandle.remove();
    resultHandle.remove();
    const watchSnapshot = {
      loadStatus: loadStatusValues.length,
      results: resultValues.length,
    };
    await task.solve({
      stops: [{ location: [-157.8583, 21.3069] }, { location: [-157.9076, 21.3035] }],
    });

    expect(widget).toBe(task);
    expect(callbackTask).toBe(task);
    expect(task.loaded).toBe(true);
    expect(task.loadStatus).toBe("loaded");
    expect(loadStatusValues).toEqual(["loading", "loaded"]);
    expect(resultValues).toHaveLength(1);
    expect(resultValues[0]).toMatchObject({ routeResults: expect.any(Array) });
    expect(seenTypes).toContain("route-task.loading");
    expect(seenTypes).toContain("route-task.loaded");
    expect(loadStatusValues).toHaveLength(watchSnapshot.loadStatus);
    expect(resultValues).toHaveLength(watchSnapshot.results);
  });

  it("solves route parameters and returns routeResults payload", async () => {
    const task = new RouteTaskCompat({
      url: "https://routing.example.com/rest/services/network/RouteServer",
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      expect(String(input)).toContain("https://routing.example.com/rest/services/network/RouteServer/solve");
      return new Response(
        JSON.stringify({
          routes: {
            features: [
              {
                geometry: {
                  paths: [
                    [
                      [-157.8583, 21.3069],
                      [-157.9076, 21.3035],
                    ],
                  ],
                },
                attributes: { Total_Kilometers: 5, Total_TravelTime: 12 },
              },
            ],
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    try {
      const result = await task.solve({
        stops: {
          features: [
            { geometry: { x: -157.8583, y: 21.3069 }, attributes: { Name: "Start" } },
            { geometry: { x: -157.9076, y: 21.3035 }, attributes: { Name: "End" } },
          ],
        },
        returnDirections: true,
      });

      expect(result.routeResults).toHaveLength(1);
      const [first] = result.routeResults;
      expect(first?.route.geometry.paths[0]).toHaveLength(2);
      expect(first?.route.attributes.Total_Kilometers).toBeGreaterThan(0);
      expect(first?.route.attributes.Total_TravelTime).toBeGreaterThan(0);
      expect(first?.directions?.features.length).toBeGreaterThan(0);
      expect(first?.stops).toEqual([
        { name: "Start", location: [-157.8583, 21.3069] },
        { name: "End", location: [-157.9076, 21.3035] },
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("emits solve lifecycle events", async () => {
    const eventBus = new CompatEventBus();
    const seenTypes: string[] = [];
    eventBus.onAny((event) => {
      seenTypes.push(event.type);
    });

    const task = new RouteTaskCompat({ eventBus });
    await task.solve({
      stops: [{ location: [-157.8583, 21.3069] }, { location: [-157.9076, 21.3035] }],
    });

    expect(seenTypes).toContain("route-task.solve-started");
    expect(seenTypes).toContain("route-task.solve-completed");
  });
});
