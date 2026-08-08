import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import { HonuaClient } from "../src/core/client.js";
import {
  HonuaCoverageError,
  HonuaWcsExceptionError,
  createCoverageClient,
  createWcsClient,
} from "../src/coverages/index.js";

function fixture(name: string): string {
  return readFileSync(new URL(`fixtures/coverages/${name}`, import.meta.url), "utf8");
}

function jsonFixture(name: string): Response {
  const body = fixture(name);
  return new Response(body, {
    headers: { "Content-Type": "application/json", "Content-Length": String(new TextEncoder().encode(body).length) },
  });
}

function coverageFetch(onRequest?: (request: Request) => void): typeof fetch {
  return vi.fn(async (input, init) => {
    const request = new Request(input, init);
    onRequest?.(request);
    const url = new URL(request.url);
    if (url.pathname === "/ogc/coverages") return jsonFixture("landing.json");
    if (url.pathname === "/ogc/coverages/conformance") return jsonFixture("conformance.json");
    if (url.pathname === "/ogc/coverages/collections") return jsonFixture("collections.json");
    if (url.pathname === "/ogc/coverages/collections/7") return jsonFixture("collection.json");
    if (url.pathname === "/ogc/coverages/collections/7/schema") return jsonFixture("schema.json");
    if (url.pathname === "/ogc/coverages/collections/7/coverage") {
      const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
      return new Response(bytes, {
        headers: { "Content-Type": "image/png", "Content-Length": String(bytes.byteLength) },
      });
    }
    if (url.pathname === "/ogc/services/7/wcs") {
      const operation = url.searchParams.get("REQUEST");
      if (operation === "GetCapabilities")
        return new Response(fixture("wcs-capabilities.xml"), { headers: { "Content-Type": "application/xml" } });
      if (operation === "DescribeCoverage")
        return new Response(fixture("wcs-description.xml"), { headers: { "Content-Type": "application/xml" } });
      if (operation === "GetCoverage") {
        return new Response(new Uint8Array([73, 73, 42, 0]), { headers: { "Content-Type": "image/tiff" } });
      }
    }
    return new Response("not found", { status: 404 });
  });
}

describe("OGC API Coverages client", () => {
  it("discovers collections and normalizes domain and range metadata through the shared auth pipeline", async () => {
    const requests: Request[] = [];
    const client = new HonuaClient({
      baseUrl: "https://coverages.example",
      apiKey: "fixture-key",
      fetchFn: coverageFetch((request) => requests.push(request)),
    });
    const coverages = createCoverageClient(client);

    const service = await coverages.discover();
    const source = coverages.source("7");
    const [domain, range] = await Promise.all([source.domainSet(), source.rangeType()]);

    expect(service.landing.title).toBe("Honua island elevation coverages");
    expect(service.collections.map((collection) => collection.id)).toEqual(["7"]);
    expect(domain.collectionId).toBe("7");
    expect(domain.bbox).toEqual([-158.3, 21.2, -157.6, 21.75]);
    expect(domain.axes[0]).toMatchObject({ name: "Lat", lower: 21.2, upper: 21.75 });
    expect(range.fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "elevation", dataType: "number", noData: [-9999] }),
        expect.objectContaining({ name: "quality", dataType: "integer", noData: [255] }),
      ]),
    );
    expect(requests.every((request) => request.headers.get("X-API-Key") === "fixture-key")).toBe(true);
  });

  it("serializes named axis, temporal, range, CRS, format, and scaling subsets without reordering", async () => {
    let requested: URL | undefined;
    const client = new HonuaClient({
      baseUrl: "https://coverages.example",
      fetchFn: coverageFetch((request) => {
        const url = new URL(request.url);
        if (url.pathname.endsWith("/coverage")) requested = url;
      }),
    });
    const result = await createCoverageClient(client).getCoverage("7", {
      bbox: [-158.1, 21.3, -157.9, 21.5],
      bboxCrs: "EPSG:4326",
      outputCrs: "EPSG:4326",
      subsets: [
        { axis: "phenomenonTime", low: "2025-01-01T00:00:00Z" },
        { axis: "elevation", low: 0, high: 500 },
      ],
      properties: ["elevation", "quality"],
      scaleSize: { width: 256, height: 128 },
      format: "image/png",
      maxResponseBytes: 1024,
    });

    expect(result.contentType).toBe("image/png");
    expect([...result.bytes]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    expect(requested?.searchParams.getAll("subset")).toEqual([
      'phenomenonTime("2025-01-01T00:00:00Z")',
      "elevation(0,500)",
    ]);
    expect(requested?.searchParams.get("bbox")).toBe("-158.1,21.3,-157.9,21.5");
    expect(requested?.searchParams.get("scale-size")).toBe("x(256),y(128)");
    expect(requested?.searchParams.get("properties")).toBe("elevation,quality");
    expect(requested?.searchParams.get("f")).toBe("png");
  });

  it("fails closed for unbounded or oversized coverage downloads", async () => {
    const client = new HonuaClient({ baseUrl: "https://coverages.example", fetchFn: coverageFetch() });
    const coverages = createCoverageClient(client);
    await expect(coverages.getCoverage("7", { format: "image/png" })).rejects.toMatchObject({
      code: "invalid-request",
    });
    await expect(
      coverages.getCoverage("7", { bbox: [-158, 21, -157, 22], format: "image/png", maxResponseBytes: 4 }),
    ).rejects.toMatchObject({ code: "response-too-large" });
  });

  it("enforces the streaming ceiling when Content-Length is absent", async () => {
    const client = new HonuaClient({
      baseUrl: "https://coverages.example",
      fetchFn: vi.fn(
        async () => new Response(new Uint8Array([1, 2, 3, 4, 5]), { headers: { "Content-Type": "image/png" } }),
      ),
    });
    await expect(
      createCoverageClient(client).getCoverage("7", {
        bbox: [-158, 21, -157, 22],
        format: "image/png",
        maxResponseBytes: 4,
      }),
    ).rejects.toBeInstanceOf(HonuaCoverageError);
  });

  it("passes caller cancellation into the shared client pipeline", async () => {
    const controller = new AbortController();
    controller.abort();
    const client = new HonuaClient({ baseUrl: "https://coverages.example", fetchFn: coverageFetch() });
    await expect(createCoverageClient(client).landing({ signal: controller.signal })).rejects.toMatchObject({
      name: "HonuaAbortError",
    });
  });
});

describe("WCS 2.0.1 compatibility client", () => {
  it("parses capabilities and DescribeCoverage axis, CRS, range, and no-data metadata", async () => {
    let capabilitiesRequest: URL | undefined;
    const client = new HonuaClient({
      baseUrl: "https://coverages.example",
      fetchFn: coverageFetch((request) => {
        const url = new URL(request.url);
        if (url.searchParams.get("REQUEST") === "GetCapabilities") capabilitiesRequest = url;
      }),
    });
    const wcs = createWcsClient(client, { basePath: "/ogc/services/7/wcs" });
    const capabilities = await wcs.capabilities({
      acceptVersions: ["2.0.1"],
      acceptFormats: ["application/xml"],
      sections: ["ServiceIdentification", "Contents"],
    });
    const descriptions = await wcs.describeCoverage(["7"]);

    expect(capabilities).toMatchObject({
      version: "2.0.1",
      title: "Honua WCS fixture",
      coverageIds: ["7"],
      formats: ["image/tiff", "image/png"],
    });
    expect(capabilities.operations).toEqual(["GetCapabilities", "DescribeCoverage", "GetCoverage"]);
    expect(capabilitiesRequest?.searchParams.get("ACCEPTVERSIONS")).toBe("2.0.1");
    expect(capabilitiesRequest?.searchParams.get("ACCEPTFORMATS")).toBe("application/xml");
    expect(capabilitiesRequest?.searchParams.get("SECTIONS")).toBe("ServiceIdentification,Contents");
    expect(descriptions[0]).toMatchObject({
      coverageId: "7",
      axisLabels: ["Lat", "Long"],
      lowerCorner: [21.2, -158.3],
      upperCorner: [21.75, -157.6],
      fields: [{ name: "elevation", title: "Elevation", noData: [-9999] }],
      noData: [-9999],
    });
  });

  it("preserves caller-provided WCS subset axis order and content negotiation", async () => {
    let requested: URL | undefined;
    const client = new HonuaClient({
      baseUrl: "https://coverages.example",
      fetchFn: coverageFetch((request) => {
        const url = new URL(request.url);
        if (url.searchParams.get("REQUEST") === "GetCoverage") requested = url;
      }),
    });
    const result = await createWcsClient(client, { basePath: "/ogc/services/7/wcs" }).getCoverage("7", {
      subsets: [
        { axis: "Lat", low: 21.3, high: 21.5 },
        { axis: "Long", low: -158.1, high: -157.9 },
      ],
      subsettingCrs: "http://www.opengis.net/def/crs/EPSG/0/4326",
      outputCrs: "http://www.opengis.net/def/crs/EPSG/0/4326",
      rangeSubset: ["elevation"],
      scaleSize: { Lat: 128, Long: 256 },
      format: "image/tiff",
    });

    expect(result.contentType).toBe("image/tiff");
    expect(requested?.searchParams.getAll("SUBSET")).toEqual(["Lat(21.3,21.5)", "Long(-158.1,-157.9)"]);
    expect(requested?.searchParams.get("SCALESIZE")).toBe("Lat(128),Long(256)");
    expect(requested?.searchParams.get("RANGESUBSET")).toBe("elevation");
    expect(requested?.searchParams.get("FORMAT")).toBe("image/tiff");
  });

  it("surfaces structured OWS exception reports", async () => {
    const client = new HonuaClient({
      baseUrl: "https://coverages.example",
      fetchFn: vi.fn(
        async () =>
          new Response(fixture("wcs-exception.xml"), { status: 400, headers: { "Content-Type": "application/xml" } }),
      ),
    });
    const error = await createWcsClient(client, { basePath: "/ogc/services/7/wcs" })
      .getCoverage("7", { subsets: [{ axis: "Lat", low: 99, high: 100 }] })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(HonuaWcsExceptionError);
    expect(error).toMatchObject({ exceptionCode: "InvalidParameterValue", locator: "SUBSET", statusCode: 400 });
  });
});
