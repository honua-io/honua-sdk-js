import { describe, expect, it } from "vitest";
import { Cql2UnsupportedError, compileCql2 } from "../../src/certification/cql2.js";
import { OGC_COLLECTIONS } from "../../src/certification/ogc-data.js";
import { createOgcFixtureClient } from "../../src/certification/ogc-fixture-client.js";

/**
 * The offline OGC API Features fixture is the evidence base for the
 * non-GeoServices lane (#1005). If it silently ignored a query parameter, the
 * lane would certify a filter path that never filtered — so the evaluator is
 * asserted directly against the recorded pygeoapi data.
 */
const client = createOgcFixtureClient() as unknown as {
  listOgcCollections(request?: unknown): Promise<{ collections: Array<{ id: string }> }>;
  getOgcCollection(request: { collectionId: string }): Promise<{ id: string; title?: string }>;
  getOgcQueryables(request: { collectionId: string }): Promise<{ properties?: Record<string, unknown> }>;
  listOgcItems(request: Record<string, unknown>): Promise<{
    features: Array<{ id?: string | number; properties: Record<string, unknown> | null }>;
    numberMatched?: number;
    numberReturned?: number;
  }>;
  listServices(): Promise<unknown>;
  queryFeatures(): Promise<unknown>;
  pipelineFetch(method: string, path: string): Promise<Response>;
};

describe("offline OGC API Features fixture", () => {
  it("advertises the recorded collections", async () => {
    const response = await client.listOgcCollections();
    expect(response.collections.map((c) => c.id)).toEqual(["obs", "utah_city_locations"]);
  });

  it("serves collection metadata and queryables", async () => {
    await expect(client.getOgcCollection({ collectionId: "obs" })).resolves.toMatchObject({ id: "obs" });
    const queryables = await client.getOgcQueryables({ collectionId: "obs" });
    expect(Object.keys(queryables.properties ?? {})).toContain("stn_id");
  });

  it("returns every recorded item with numberMatched", async () => {
    const page = await client.listOgcItems({ collectionId: "obs", limit: 100 });
    expect(page.numberMatched).toBe(5);
    expect(page.features).toHaveLength(5);
    expect(page.numberReturned).toBe(5);
  });

  it("pages with limit and offset", async () => {
    const page = await client.listOgcItems({ collectionId: "obs", limit: 2, offset: 1 });
    expect(page.features).toHaveLength(2);
    expect(page.numberMatched).toBe(5);
  });

  it("filters with CQL2 text and reports the filtered numberMatched", async () => {
    const page = await client.listOgcItems({
      collectionId: "obs",
      filter: "stn_id = 2147",
      filterLang: "cql2-text",
      limit: 100,
    });
    expect(page.numberMatched).toBe(2);
    expect(page.features.every((f) => f.properties?.stn_id === 2147)).toBe(true);
  });

  it("rejects a filter language it cannot evaluate", async () => {
    await expect(client.listOgcItems({ collectionId: "obs", filter: "{}", filterLang: "cql2-json" })).rejects.toThrow(
      /unsupported filter-lang/,
    );
  });

  it("filters with bbox", async () => {
    const page = await client.listOgcItems({ collectionId: "obs", bbox: "-80,42,-78,44", limit: 100 });
    expect(page.numberMatched).toBe(2);
  });

  it("filters with the OGC datetime parameter", async () => {
    const page = await client.listOgcItems({
      collectionId: "obs",
      datetime: "2001-01-01T00:00:00Z/2004-01-01T00:00:00Z",
      limit: 100,
    });
    expect(page.numberMatched).toBe(3);
  });

  it("refuses a datetime filter on a collection with no time dimension", async () => {
    await expect(client.listOgcItems({ collectionId: "utah_city_locations", datetime: "2001-01-01Z" })).rejects.toThrow(
      /no time dimension/,
    );
  });

  it("sorts, projects properties, and selects by id", async () => {
    const sorted = await client.listOgcItems({ collectionId: "obs", sortby: "-value", limit: 100 });
    expect(sorted.features[0].properties?.value).toBe(103.5);

    const projected = await client.listOgcItems({ collectionId: "obs", properties: ["value"], limit: 1 });
    expect(Object.keys(projected.features[0].properties ?? {})).toEqual(["value"]);

    const byId = await client.listOgcItems({ collectionId: "obs", ids: "371", limit: 100 });
    expect(byId.numberMatched).toBe(1);
  });

  it("rejects an unknown collection", async () => {
    await expect(client.listOgcItems({ collectionId: "nope" })).rejects.toThrow(/unknown collection/);
  });

  it("publishes no GeoServices surface at all", async () => {
    await expect(client.listServices()).rejects.toThrow(/OGC API Features only/);
    await expect(client.queryFeatures()).rejects.toThrow(/OGC API Features only/);
    const styles = await client.pipelineFetch("GET", "/ogc/styles");
    expect(styles.status).toBe(404);
  });

  it("keeps the recorded anchors the eval corpus asserts", () => {
    const values = OGC_COLLECTIONS.obs.features.map((f) => f.properties?.value as number);
    expect(values.reduce((a, b) => a + b, 0)).toBeCloseTo(480.7, 5);
    const pops = OGC_COLLECTIONS.utah_city_locations.features.map((f) => f.properties?.POP_2000 as number);
    expect(pops.reduce((a, b) => a + b, 0)).toBe(354212);
    expect(Math.max(...pops)).toBe(105166);
  });
});

describe("CQL2 fixture evaluator", () => {
  const rows = [
    { name: "alpha", n: 1, missing: null },
    { name: "beta", n: 5, missing: 2 },
    { name: "Gamma", n: 9, missing: 3 },
  ];
  const evaluate = (filter: string) => rows.filter(compileCql2(filter));

  it("evaluates comparisons, IN, BETWEEN and NULL checks", () => {
    expect(evaluate("n > 4")).toHaveLength(2);
    expect(evaluate("n <> 5")).toHaveLength(2);
    expect(evaluate("name IN ('alpha', 'beta')")).toHaveLength(2);
    expect(evaluate("n BETWEEN 2 AND 9")).toHaveLength(2);
    expect(evaluate("missing IS NULL")).toHaveLength(1);
    expect(evaluate("missing IS NOT NULL")).toHaveLength(2);
  });

  it("evaluates LIKE, including the case-insensitive CASEI form", () => {
    expect(evaluate("name LIKE 'a%'")).toHaveLength(1);
    expect(evaluate("CASEI(name) LIKE CASEI('g%')")).toHaveLength(1);
  });

  it("evaluates boolean composition and parentheses", () => {
    expect(evaluate("(n > 1) AND (n < 9)")).toHaveLength(1);
    expect(evaluate("(n = 1) OR (n = 9)")).toHaveLength(2);
    expect(evaluate("NOT (n = 1)")).toHaveLength(2);
  });

  it("evaluates temporal predicates against RFC 3339 values", () => {
    const events = [{ ts: "2001-06-01T00:00:00Z" }, { ts: "2005-06-01T00:00:00Z" }];
    expect(events.filter(compileCql2("T_BEFORE(ts, TIMESTAMP('2003-01-01T00:00:00Z'))"))).toHaveLength(1);
    expect(events.filter(compileCql2("T_AFTER(ts, TIMESTAMP('2003-01-01T00:00:00Z'))"))).toHaveLength(1);
    expect(
      events.filter(compileCql2("T_DURING(ts, INTERVAL('2001-01-01T00:00:00Z','2002-01-01T00:00:00Z'))")),
    ).toHaveLength(1);
    expect(events.filter(compileCql2("T_INTERSECTS(ts, DATE('2001-06-01'))"))).toHaveLength(1);
    expect(events.filter(compileCql2("T_INTERSECTS(ts, DATE('1999-01-01'))"))).toHaveLength(0);
  });

  it("refuses a spatial predicate rather than matching the wrong rows", () => {
    expect(() => compileCql2("S_INTERSECTS(geometry, POLYGON((0 0, 1 0, 1 1, 0 0)))")).toThrow(Cql2UnsupportedError);
    expect(() => compileCql2("S_WITHIN(geometry, ENVELOPE(0,0,1,1))")).toThrow(/Part 3/);
  });

  it("refuses anything else it cannot parse", () => {
    expect(() => compileCql2("n ?? 1")).toThrow(Cql2UnsupportedError);
    expect(() => compileCql2("n = ")).toThrow(Cql2UnsupportedError);
    expect(() => compileCql2("n = 1 EXTRA")).toThrow(Cql2UnsupportedError);
  });
});
