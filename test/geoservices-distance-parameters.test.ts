import { describe, expect, it } from "vitest";
import { HonuaClient } from "../src/core/client.js";

describe.each(["queryFeatures", "queryMapLayer"] as const)("%s distance parameters", (operation) => {
  it.each(["GET", "POST"] as const)("sends distance and nearest-query options over %s", async (method) => {
    let sent = new URLSearchParams();
    const client = new HonuaClient({
      baseUrl: "https://example.test",
      fetchFn: async (input, init) => {
        expect(init?.method).toBe(method);
        sent = method === "GET" ? new URL(String(input)).searchParams : new URLSearchParams(String(init?.body));
        return Response.json({ features: [] });
      },
    });

    await client[operation]({
      serviceId: "complaints",
      layerId: 6,
      method,
      geometry: { x: -74, y: 40.7, spatialReference: { wkid: 4326 } },
      geometryType: "esriGeometryPoint",
      spatialRel: "esriSpatialRelIntersects",
      distance: 0.5,
      units: "esriSRUnit_StatuteMile",
      nearestCount: 3,
      returnDistance: true,
    });

    expect(sent.get("distance")).toBe("0.5");
    expect(sent.get("units")).toBe("esriSRUnit_StatuteMile");
    expect(sent.get("nearestCount")).toBe("3");
    expect(sent.get("returnDistance")).toBe("true");
  });

  it("preserves explicit zero and false instead of treating them as absent", async () => {
    let sent = new URLSearchParams();
    const client = new HonuaClient({
      baseUrl: "https://example.test",
      fetchFn: async (input) => {
        sent = new URL(String(input)).searchParams;
        return Response.json({ features: [] });
      },
    });
    await client[operation]({ serviceId: "complaints", layerId: 6, distance: 0, returnDistance: false });
    expect(sent.get("distance")).toBe("0");
    expect(sent.get("returnDistance")).toBe("false");
    expect(sent.has("units")).toBe(false);
    expect(sent.has("nearestCount")).toBe(false);
  });

  it("does not add distance semantics to an ordinary query", async () => {
    let sent = new URLSearchParams();
    const client = new HonuaClient({
      baseUrl: "https://example.test",
      fetchFn: async (input) => {
        sent = new URL(String(input)).searchParams;
        return Response.json({ features: [] });
      },
    });
    await client[operation]({ serviceId: "complaints", layerId: 6 });
    for (const name of ["distance", "units", "nearestCount", "returnDistance"]) expect(sent.has(name)).toBe(false);
  });
});
