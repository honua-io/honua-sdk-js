import { describe, expect, it, vi } from "vitest";
import { createOgcFixtureClient } from "../../src/certification/ogc-fixture-client.js";
import { execute, schema } from "../../src/tools/list-sources.js";
import { asClient, createMockClient } from "../test-helpers.js";

function parse(result: { content: Array<{ type: "text"; text: string }> }) {
  return JSON.parse(result.content[0].text);
}

describe("honua_list_sources", () => {
  it("emits neutral source references for every GeoServices layer", async () => {
    const mock = createMockClient();
    const parsed = parse(await execute(asClient(mock), schema.parse({})));

    const refs = parsed.sources.map((s: { source: string }) => s.source);
    expect(refs).toContain("geoservices-feature-service:Parks/0");
    expect(refs).toContain("geoservices-feature-service:Parks/1");
    expect(refs).toContain("geoservices-map-service:Basemap/0");
    expect(parsed.families.geoservices.available).toBe(true);
    expect(parsed.sourceCount).toBe(refs.length);
  });

  it("reports each protocol family's availability independently", async () => {
    const parsed = parse(await execute(createOgcFixtureClient(), schema.parse({})));

    expect(parsed.families.geoservices.available).toBe(false);
    expect(parsed.families.geoservices.reason).toMatch(/no GeoServices catalog/);
    expect(parsed.families["ogc-features"].available).toBe(true);
    expect(parsed.sources.map((s: { source: string }) => s.source)).toContain("ogc-features:obs");
  });

  it("restricts discovery to one family when asked", async () => {
    const mock = createMockClient();
    const parsed = parse(await execute(asClient(mock), schema.parse({ protocol: "geoservices" })));

    expect(Object.keys(parsed.families)).toEqual(["geoservices"]);
  });

  it("caps how many services it expands", async () => {
    const mock = createMockClient();
    await execute(asClient(mock), schema.parse({ maxServices: 1 }));

    expect(mock.getFeatureServiceMetadata).toHaveBeenCalledTimes(1);
  });

  it("still emits a layer-0 reference when a service's metadata is unreadable", async () => {
    const mock = createMockClient({
      getFeatureServiceMetadata: vi.fn().mockRejectedValue(new Error("403")),
    });
    const parsed = parse(await execute(asClient(mock), schema.parse({ protocol: "geoservices" })));

    expect(parsed.sources.map((s: { source: string }) => s.source)).toContain("geoservices-feature-service:Parks/0");
  });

  it("guides the caller to direct addressing when nothing is discoverable", async () => {
    const mock = createMockClient({
      listServices: vi.fn().mockRejectedValue(new Error("no catalog")),
      pipelineFetch: vi.fn().mockResolvedValue(new Response("{}", { status: 404 })),
    });
    const parsed = parse(await execute(asClient(mock), schema.parse({})));

    expect(parsed.sourceCount).toBe(0);
    expect(parsed.guidance).toMatch(/ogc-features:<collectionId>/);
  });

  it("reports the capabilities each protocol advertises", async () => {
    const parsed = parse(await execute(createOgcFixtureClient(), schema.parse({ protocol: "ogc-features" })));

    const obs = parsed.sources.find((s: { source: string }) => s.source === "ogc-features:obs");
    expect(obs.capabilities).toContain("query");
    expect(obs.capabilities).not.toContain("queryAggregate");
  });
});
