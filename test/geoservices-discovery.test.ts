import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import { connect } from "../src/connect.js";
import { HonuaClient } from "../src/core/client.js";
import { HonuaAbortError, HonuaDiscoveryError } from "../src/core/errors.js";
import { discoverGeoServices } from "../src/geoservices-discovery.js";
import { HONUA_GEOSERVICES_METADATA_MAX_BYTES, getGeoServicesMetadata } from "../src/geoservices-metadata.js";

const imageMetadata = fixture("image-server.json");
const geometryMetadata = fixture("geometry-server.json");
const gpMetadata = fixture("gp-server.json");
const gpAsyncMetadata = fixture("gp-task-async.json");
const gpSyncMetadata = fixture("gp-task-sync.json");

function fixture(name: string): unknown {
  return JSON.parse(
    readFileSync(new URL(`./fixtures/geoservices-discovery/${name}`, import.meta.url), "utf8"),
  ) as unknown;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function responseAtUrl(response: Response, url: string, redirected = false): Response {
  Object.defineProperties(response, {
    url: { configurable: true, value: url },
    redirected: { configurable: true, value: redirected },
  });
  return response;
}

describe("GeoServices service discovery", () => {
  it("discovers ImageServer as an honest raster-catalog Source plus explicit image operations", async () => {
    const requests: string[] = [];
    const fetchFn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(new Request(input, init).url);
      requests.push(`${url.pathname}${url.search}`);
      return json(imageMetadata);
    });

    const result = await discoverGeoServices({
      endpoint: "https://example.test/arcgis/rest/services/Elevation/Oahu/ImageServer?f=pjson",
      clientOptions: { fetchFn },
    });

    expect(requests).toEqual(["/arcgis/rest/services/Elevation/Oahu/ImageServer?f=json"]);
    expect(result.state).toBe("complete");
    expect(result.service).toMatchObject({
      serviceKind: "image",
      protocol: "geoservices-image-service",
      serviceId: "Elevation/Oahu",
      sourceBacked: true,
      formats: {
        query: ["JSON", "PBF"],
        image: ["JPG", "PNG32"],
      },
      limits: {
        maxRecordCount: 2000,
        maxImageWidth: 4096,
        maxImageHeight: 4096,
      },
      authentication: { requirement: "not-required", evidence: "metadata" },
    });
    expect(result.service.crs).toEqual([{ wkid: 102100, latestWkid: 3857, authority: "EPSG", code: 3857 }]);
    expect(result.sources).toHaveLength(1);
    const source = result.sources[0]!.descriptor;
    expect(source.id).toBe("Elevation/Oahu");
    expect(source.locator).toEqual({
      url: "https://example.test/arcgis",
      serviceId: "Elevation/Oahu",
    });
    expect(source.schema?.primaryKey).toBe("OBJECTID");
    for (const capability of ["query", "queryExtent", "queryObjectIds", "image", "render", "tiles"] as const) {
      expect(source.capabilities.has(capability)).toBe(true);
    }
    for (const invented of ["applyEdits", "attachments", "queryRelated", "stream"] as const) {
      expect(source.capabilities.has(invented)).toBe(false);
    }
    expect(result.operations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "exportImage",
          href: "https://example.test/arcgis/rest/services/Elevation/Oahu/ImageServer/exportImage",
          execution: "synchronous",
        }),
        expect.objectContaining({
          id: "tile",
          href: "https://example.test/arcgis/rest/services/Elevation/Oahu/ImageServer/tile/{level}/{row}/{col}",
          methods: ["GET"],
        }),
      ]),
    );
    expect(Object.isFrozen(result.operations)).toBe(true);
  });

  it("makes root ImageServer discovery available through connect() without feature-only capabilities", async () => {
    const requests: string[] = [];
    const fetchFn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(new Request(input, init).url);
      requests.push(`${url.pathname}${url.search}`);
      if (url.pathname.endsWith("/query")) {
        return json({
          objectIdFieldName: "OBJECTID",
          fields: [{ name: "OBJECTID", type: "esriFieldTypeOID" }],
          features: [{ attributes: { OBJECTID: 1 } }],
          exceededTransferLimit: false,
        });
      }
      return json(imageMetadata);
    });
    const connection = await connect({
      endpoint: "https://example.test/honua/rest/services/Elevation/Oahu/ImageServer",
      protocol: "auto",
      authorizationScopeFingerprint: "anonymous",
      clientOptions: { fetchFn },
    });

    expect(connection.inspection.protocol).toBe("geoservices-image-service");
    expect(connection.inspection.defaultSourceId).toBe("Elevation/Oahu");
    expect(connection.source().capabilities.has("image")).toBe(true);
    expect(connection.source().capabilities.has("applyEdits")).toBe(false);
    expect(connection.source().descriptor.locator).toEqual({
      url: "https://example.test/honua",
      serviceId: "Elevation/Oahu",
    });
    const queried = await connection.source().query({ pagination: { limit: 1 } });
    expect(queried.features).toHaveLength(1);
    expect(requests[0]).toBe("/honua/rest/services/Elevation/Oahu/ImageServer?f=json");
    expect(requests[1]).toContain("/honua/rest/services/Elevation/Oahu/ImageServer/query?");
    expect(requests.some((request) => /exportImage|identify|\/tile\//.test(request))).toBe(false);
  });

  it("keeps export-only ImageServer metadata in the operation facade instead of creating a nominal Source", async () => {
    const metadata = {
      name: "Rendered imagery",
      capabilities: "Image",
      supportedImageFormatTypes: "PNG32",
      operations: [{ name: "Export Image", href: "exportImage", methods: ["GET", "POST"] }],
    };
    const discovered = await discoverGeoServices({
      endpoint: "https://example.test/rest/services/Imagery/Rendered/ImageServer",
      clientOptions: { fetchFn: vi.fn(async () => json(metadata)) },
    });

    expect(discovered.service.sourceBacked).toBe(false);
    expect(discovered.sources).toEqual([]);
    expect(discovered.operations).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "exportImage", kind: "image" })]),
    );

    await expect(
      connect({
        endpoint: "https://example.test/rest/services/Imagery/Rendered/ImageServer",
        protocol: "auto",
        authorizationScopeFingerprint: "anonymous",
        clientOptions: { fetchFn: vi.fn(async () => json(metadata)) },
      }),
    ).rejects.toMatchObject({ name: "HonuaDiscoveryError", code: "unsupported-protocol" });
  });

  it("does not create an ImageServer Source for a noncanonical advertised query route", async () => {
    const endpoint = "https://example.test/rest/services/Imagery/Catalog/ImageServer";
    const metadata = {
      operations: [{ name: "Query", href: "custom-query", methods: ["GET"] }],
      advancedQueryCapabilities: { supportsPagination: true },
      fields: [{ name: "OBJECTID", type: "esriFieldTypeOID" }],
    };
    const fetchFn = vi.fn(async () => json(metadata));

    const discovered = await discoverGeoServices({ endpoint, clientOptions: { fetchFn } });
    expect(discovered.service.sourceBacked).toBe(false);
    expect(discovered.sources).toEqual([]);
    expect(discovered.operations).toEqual([
      expect.objectContaining({
        id: "query",
        href: `${endpoint}/custom-query`,
        sdkSupported: false,
      }),
    ]);

    await expect(
      connect({
        endpoint,
        protocol: "auto",
        authorizationScopeFingerprint: "anonymous",
        clientOptions: { fetchFn },
      }),
    ).rejects.toMatchObject({ name: "HonuaDiscoveryError", code: "unsupported-protocol" });
  });

  it("does not create an ImageServer Source when the canonical query route is POST-only", async () => {
    await expect(
      connect({
        endpoint: "https://example.test/rest/services/Imagery/Catalog/ImageServer",
        protocol: "auto",
        authorizationScopeFingerprint: "anonymous",
        clientOptions: {
          fetchFn: vi.fn(async () =>
            json({
              capabilities: "Query",
              operations: [{ name: "Query", href: "query", methods: ["POST"] }],
              advancedQueryCapabilities: { supportsPagination: true },
              fields: [{ name: "OBJECTID", type: "esriFieldTypeOID" }],
            }),
          ),
        },
      }),
    ).rejects.toMatchObject({ name: "HonuaDiscoveryError", code: "unsupported-protocol" });
  });

  it("honors explicit ImageServer query-extent denial while retaining safe query capabilities", async () => {
    const connection = await connect({
      endpoint: "https://example.test/rest/services/Imagery/Catalog/ImageServer",
      protocol: "auto",
      authorizationScopeFingerprint: "anonymous",
      clientOptions: {
        fetchFn: vi.fn(async () =>
          json({
            capabilities: "Catalog,Query",
            advancedQueryCapabilities: {
              supportsPagination: true,
              supportsReturningQueryExtent: false,
            },
            fields: [{ name: "OBJECTID", type: "esriFieldTypeOID" }],
          }),
        ),
      },
    });

    expect(connection.source().capabilities.has("query")).toBe(true);
    expect(connection.source().capabilities.has("queryObjectIds")).toBe(true);
    expect(connection.source().capabilities.has("queryExtent")).toBe(false);
  });

  it("preserves tile placeholders and does not claim SDK support for safe noncanonical operation routes", async () => {
    const endpoint = "https://example.test/rest/services/Imagery/Rendered/ImageServer";
    const discovered = await discoverGeoServices({
      endpoint,
      clientOptions: {
        fetchFn: vi.fn(async () =>
          json({
            capabilities: "Image",
            operations: [
              { name: "Tile", href: "tile/{level}/{row}/{col}", methods: ["GET"] },
              { name: "Export Image", href: "custom-export", methods: ["POST"] },
            ],
          }),
        ),
      },
    });

    expect(discovered.operations.find((operation) => operation.id === "tile")).toMatchObject({
      href: `${endpoint}/tile/{level}/{row}/{col}`,
      sdkSupported: true,
    });
    expect(discovered.operations.find((operation) => operation.id === "exportImage")).toMatchObject({
      href: `${endpoint}/custom-export`,
      sdkSupported: false,
    });
  });

  it("does not claim SDK support for a GP task advertised on a noncanonical route", async () => {
    const endpoint = "https://example.test/rest/services/Analysis/Tools/GPServer";
    const fetchFn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const pathname = new URL(new Request(input, init).url).pathname;
      return pathname.endsWith("/GPServer")
        ? json({ tasks: [{ name: "Viewshed", href: "custom/Viewshed" }] })
        : json(gpAsyncMetadata);
    });
    const discovered = await discoverGeoServices({ endpoint, clientOptions: { fetchFn } });

    expect(discovered.operations).toEqual([
      expect.objectContaining({
        id: "Viewshed",
        href: `${endpoint}/custom/Viewshed/submitJob`,
        sdkSupported: false,
      }),
    ]);
  });

  it("rejects ImageServer catalog ids before authentication or network work", async () => {
    const fetchFn = vi.fn<typeof fetch>();
    const auth = vi.fn(async () => "secret");
    const endpoint = "https://example.test/rest/services/Elevation/Oahu/ImageServer/7";

    await expect(
      connect({
        endpoint,
        protocol: "auto",
        authorizationScopeFingerprint: "scope",
        clientOptions: { fetchFn, auth },
      }),
    ).rejects.toMatchObject({ name: "HonuaDiscoveryError", code: "invalid-endpoint" });
    await expect(discoverGeoServices({ endpoint, clientOptions: { fetchFn, auth } })).rejects.toMatchObject({
      name: "HonuaDiscoveryError",
      code: "invalid-endpoint",
    });
    expect(fetchFn).not.toHaveBeenCalled();
    expect(auth).not.toHaveBeenCalled();
  });

  it("returns GeometryServer operations as non-Source descriptors and resolves relative URLs", async () => {
    const requests: Request[] = [];
    const client = new HonuaClient({
      baseUrl: "https://example.test/arcgis",
      fetchFn: vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        requests.push(request);
        return request.url.endsWith("/project") ? json({ geometries: [] }) : json(geometryMetadata);
      }),
    });
    const result = await discoverGeoServices({
      endpoint: "https://example.test/arcgis/rest/services/Utilities/Geometry/GeometryServer/",
      client,
    });

    expect(result.service).toMatchObject({
      serviceKind: "geometry",
      protocol: "geoservices-geometry-service",
      serviceId: "Utilities/Geometry",
      sourceBacked: false,
      formats: { input: ["esriJSON", "geoJSON"], output: ["esriJSON", "geoJSON"] },
      authentication: {
        requirement: "required",
        evidence: "metadata",
        schemes: ["token"],
      },
    });
    expect(result.sources).toEqual([]);
    expect(result.operations.map((operation) => operation.id)).toEqual([
      "buffer",
      "clip",
      "difference",
      "intersect",
      "project",
      "simplify",
      "union",
    ]);
    expect(result.operations.find((operation) => operation.id === "project")).toMatchObject({
      kind: "geometry",
      href: "https://example.test/arcgis/rest/services/Utilities/Geometry/GeometryServer/project",
      methods: ["GET", "POST"],
      execution: "synchronous",
      sdkSupported: true,
    });
    expect(result.operations.every((operation) => !("capabilities" in operation))).toBe(true);

    await client.geometryService().project({
      geometries: { geometryType: "esriGeometryPoint", geometries: [{ x: -157.8, y: 21.3 }] },
      inSr: 4326,
      outSr: 3857,
    });
    expect(requests.map((request) => [new URL(request.url).pathname, request.method])).toEqual([
      ["/arcgis/rest/services/Utilities/Geometry/GeometryServer", "GET"],
      ["/arcgis/rest/services/Utilities/Geometry/GeometryServer/project", "POST"],
    ]);
  });

  it("does not claim SDK execution for an alternate GeometryServer binding and canonicalizes uppercase names", async () => {
    const result = await discoverGeoServices({
      endpoint: "https://example.test/arcgis/rest/services/Custom/Geometry/GeometryServer",
      clientOptions: { fetchFn: vi.fn(async () => json({ supportedOperations: ["PROJECT"] })) },
    });

    expect(result.operations).toEqual([
      expect.objectContaining({
        id: "project",
        operation: "project",
        href: "https://example.test/arcgis/rest/services/Custom/Geometry/GeometryServer/project",
        sdkSupported: false,
      }),
    ]);
  });

  it("discovers GPServer task execution modes without starting jobs and keeps mixed auth evidence unknown", async () => {
    const requests: string[] = [];
    const fetchFn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(new Request(input, init).url);
      requests.push(url.pathname);
      if (url.pathname.endsWith("/GPServer")) return json(gpMetadata);
      if (url.pathname.endsWith("/GPServer/Viewshed")) return json(gpAsyncMetadata);
      if (url.pathname.endsWith("/GPServer/Summarize%20Within")) return json(gpSyncMetadata);
      return new Response("not found", { status: 404 });
    });

    const result = await discoverGeoServices({
      endpoint: "https://example.test/arcgis/rest/services/Analysis/Tools/GPServer",
      clientOptions: { fetchFn },
    });

    expect(result.state).toBe("complete");
    expect(result.service).toMatchObject({
      serviceKind: "geoprocessing",
      protocol: "geoservices-gp-service",
      serviceId: "Analysis/Tools",
      sourceBacked: false,
      authentication: { requirement: "unknown", evidence: "none", schemes: [] },
    });
    expect(result.sources).toEqual([]);
    expect(result.operations).toEqual([
      expect.objectContaining({
        id: "Viewshed",
        operation: "submitJob",
        execution: "asynchronous",
        href: "https://example.test/arcgis/rest/services/Analysis/Tools/GPServer/Viewshed/submitJob",
        jobLifecycle: {
          statusHrefTemplate: "https://example.test/arcgis/rest/services/Analysis/Tools/GPServer/Viewshed/jobs/{jobId}",
          resultHrefTemplate:
            "https://example.test/arcgis/rest/services/Analysis/Tools/GPServer/Viewshed/jobs/{jobId}/results/{resultName}",
          cancelHrefTemplate:
            "https://example.test/arcgis/rest/services/Analysis/Tools/GPServer/Viewshed/jobs/{jobId}/cancel",
        },
      }),
      expect.objectContaining({
        id: "Summarize Within",
        operation: "execute",
        execution: "synchronous",
        href: "https://example.test/arcgis/rest/services/Analysis/Tools/GPServer/Summarize%20Within/execute",
      }),
    ]);
    expect(requests).toEqual([
      "/arcgis/rest/services/Analysis/Tools/GPServer",
      "/arcgis/rest/services/Analysis/Tools/GPServer/Viewshed",
      "/arcgis/rest/services/Analysis/Tools/GPServer/Summarize%20Within",
    ]);
    expect(requests.some((path) => path.includes("submitJob") || path.includes("/jobs"))).toBe(false);
  });

  it("normalizes a selected encoded GP task and reads only its metadata document", async () => {
    const requests: string[] = [];
    const result = await discoverGeoServices({
      endpoint: "https://example.test/arcgis/rest/services/Analysis/Tools/GPServer/Summarize%20Within?f=pjson",
      clientOptions: {
        fetchFn: vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
          requests.push(new URL(new Request(input, init).url).pathname);
          return json(gpSyncMetadata);
        }),
      },
    });

    expect(requests).toEqual(["/arcgis/rest/services/Analysis/Tools/GPServer/Summarize%20Within"]);
    expect(result.service).toMatchObject({
      serviceKind: "geoprocessing",
      serviceId: "Analysis/Tools",
      taskName: "Summarize Within",
      sourceBacked: false,
    });
    expect(result.sources).toEqual([]);
    expect(result.operations).toEqual([
      expect.objectContaining({
        id: "Summarize Within",
        operation: "execute",
        execution: "synchronous",
        href: "https://example.test/arcgis/rest/services/Analysis/Tools/GPServer/Summarize%20Within/execute",
      }),
    ]);
    expect(requests.some((path) => path.includes("/execute") || path.includes("/jobs"))).toBe(false);
  });

  it("preserves structured partial GP discovery when one task metadata request fails", async () => {
    const fetchFn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(new Request(input, init).url);
      if (url.pathname.endsWith("/GPServer")) return json(gpMetadata);
      if (url.pathname.endsWith("/GPServer/Viewshed")) return json(gpAsyncMetadata);
      return new Response("temporarily unavailable", { status: 503 });
    });
    const result = await discoverGeoServices({
      endpoint: "https://example.test/arcgis/rest/services/Analysis/Tools/GPServer",
      clientOptions: { fetchFn, retry: { maxRetries: 0 } },
    });

    expect(result.state).toBe("partial");
    expect(result.operations[0]).toMatchObject({ id: "Viewshed", execution: "asynchronous" });
    expect(result.operations[1]).toMatchObject({
      id: "Summarize Within",
      operation: "task",
      availability: "unavailable",
      execution: "unknown",
      sdkSupported: false,
    });
    expect(result.diagnostics.map((entry) => entry.code)).toEqual(
      expect.arrayContaining(["operation-metadata-unavailable", "partial-discovery"]),
    );
  });

  it.each([
    {
      name: "HTTP status",
      response: new Response(JSON.stringify({ error: "unauthorized" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      }),
    },
    { name: "GeoServices error envelope", response: json({ error: { code: 499, message: "Token Required" } }) },
  ])("returns auth evidence without inventing operations for secured metadata ($name)", async ({ response }) => {
    const result = await discoverGeoServices({
      endpoint: "https://example.test/rest/services/Utilities/Geometry/GeometryServer",
      clientOptions: { fetchFn: vi.fn(async () => response.clone()), retry: { maxRetries: 0 } },
    });

    expect(result.state).toBe("partial");
    expect(result.service.authentication).toMatchObject({ requirement: "required" });
    expect(result.operations).toEqual([]);
    expect(result.sources).toEqual([]);
    expect(result.diagnostics.map((entry) => entry.code)).toEqual(
      expect.arrayContaining(["authentication-required", "partial-discovery"]),
    );
  });

  it("retains secured ImageServer identity without creating a Source or inferring capabilities", async () => {
    const result = await discoverGeoServices({
      endpoint: "https://example.test/rest/services/Secure/ImageServer",
      clientOptions: {
        fetchFn: vi.fn(async () => json({ error: { code: 498, message: "Invalid Token" } })),
      },
    });

    expect(result.state).toBe("partial");
    expect(result.service.sourceBacked).toBe(false);
    expect(result.sources).toEqual([]);
    expect(result.operations).toEqual([]);
    expect(result.service.authentication).toMatchObject({
      requirement: "required",
      evidence: "http-status",
      statusCode: 498,
    });
  });

  it.each([
    {
      name: "missing Content-Length",
      headers: new Headers({ "Content-Type": "application/json" }),
      missing: true,
    },
    {
      name: "dishonest Content-Length",
      headers: new Headers({ "Content-Type": "application/json", "Content-Length": "16" }),
      missing: false,
    },
  ])("rejects an oversized streamed metadata response with $name before JSON parsing", async ({ headers, missing }) => {
    const payload = JSON.stringify({ padding: "x".repeat(HONUA_GEOSERVICES_METADATA_MAX_BYTES) });
    const response = new Response(payload, { headers });
    if (missing) expect(response.headers.get("content-length")).toBeNull();

    await expect(
      discoverGeoServices({
        endpoint: "https://example.test/rest/services/Utilities/Geometry/GeometryServer",
        clientOptions: { fetchFn: vi.fn(async () => response) },
      }),
    ).rejects.toMatchObject({
      name: "HonuaDiscoveryError",
      code: "invalid-endpoint",
      message: `GeoServices metadata exceeds the ${HONUA_GEOSERVICES_METADATA_MAX_BYTES}-byte response limit.`,
    });
  });

  it.each([
    ["cross-origin", "https://attacker.example/collect"],
    ["outside the service root", "https://example.test/rest/services/Other/GeometryServer"],
  ])("refuses a %s metadata redirect before replaying credentials", async (_name, location) => {
    const requests: Request[] = [];
    const fetchFn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(new Request(input, init));
      return new Response(null, { status: 302, headers: { Location: location } });
    });

    await expect(
      discoverGeoServices({
        endpoint: "https://example.test/rest/services/Utilities/Geometry/GeometryServer",
        clientOptions: { fetchFn, auth: vi.fn(async () => "secret"), retry: { maxRetries: 0 } },
      }),
    ).rejects.toMatchObject({
      name: "HonuaDiscoveryError",
      code: "invalid-endpoint",
      message: "GeoServices metadata redirects are not allowed.",
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toContain("/rest/services/Utilities/Geometry/GeometryServer?f=json");
    expect(requests.some((request) => request.url.startsWith(location))).toBe(false);
  });

  it("rejects a successful metadata response whose final authority or service root drifted", async () => {
    const response = responseAtUrl(
      json(geometryMetadata),
      "https://example.test/rest/services/Other/GeometryServer?f=json",
    );
    await expect(
      discoverGeoServices({
        endpoint: "https://example.test/rest/services/Utilities/Geometry/GeometryServer",
        clientOptions: { fetchFn: vi.fn(async () => response) },
      }),
    ).rejects.toMatchObject({
      name: "HonuaDiscoveryError",
      code: "invalid-endpoint",
      message: "GeoServices metadata response authority or service path does not match the requested endpoint.",
    });
  });

  it("records the validated final metadata authority in result and operation provenance", async () => {
    const endpoint = "https://example.test/arcgis/rest/services/Utilities/Geometry/GeometryServer";
    const result = await discoverGeoServices({
      endpoint,
      clientOptions: {
        fetchFn: vi.fn(async () => responseAtUrl(json(geometryMetadata), `${endpoint}?f=json`)),
      },
    });

    expect(result.provenance[0]?.source).toBe(endpoint);
    expect(result.operations.every((operation) => operation.provenance[0]?.source === endpoint)).toBe(true);
  });

  it("rejects malformed metadata and unsafe advertised operation URLs", async () => {
    await expect(
      discoverGeoServices({
        endpoint: "https://example.test/rest/services/Utilities/Geometry/GeometryServer",
        clientOptions: {
          fetchFn: vi.fn(async () => new Response("not-json", { headers: { "Content-Type": "application/json" } })),
        },
      }),
    ).rejects.toMatchObject({
      name: "HonuaDiscoveryError",
      code: "invalid-endpoint",
      message: "GeoServices metadata must be a valid JSON object.",
    });

    await expect(
      discoverGeoServices({
        endpoint: "https://example.test/rest/services/Utilities/Geometry/GeometryServer",
        clientOptions: { fetchFn: vi.fn(async () => json({ supportedOperations: "Project" })) },
      }),
    ).rejects.toMatchObject({ name: "HonuaDiscoveryError", code: "invalid-endpoint" });

    await expect(
      discoverGeoServices({
        endpoint: "https://example.test/rest/services/Utilities/Geometry/GeometryServer",
        clientOptions: {
          fetchFn: vi.fn(async () =>
            json({ operations: [{ name: "Project", href: "https://attacker.example/project" }] }),
          ),
        },
      }),
    ).rejects.toMatchObject({ name: "HonuaDiscoveryError", code: "invalid-endpoint" });

    await expect(
      discoverGeoServices({
        endpoint: "https://example.test/rest/services/Analysis/Tools/GPServer",
        clientOptions: { fetchFn: vi.fn(async () => json({ tasks: "Viewshed" })) },
      }),
    ).rejects.toMatchObject({ name: "HonuaDiscoveryError", code: "invalid-endpoint" });

    await expect(
      discoverGeoServices({
        endpoint: "https://example.test/rest/services/Utilities/Geometry/GeometryServer",
        clientOptions: {
          fetchFn: vi.fn(async () => json({ ignored: Array.from({ length: 10_001 }, () => true) })),
        },
      }),
    ).rejects.toMatchObject({
      name: "HonuaDiscoveryError",
      code: "invalid-endpoint",
      message: "GeoServices metadata exceeds discovery bounds.",
    });
  });

  it("never reflects a remote GeoServices error message into a public discovery error", async () => {
    const reflectedToken = "reflected-bearer-token-should-not-escape";
    const client = new HonuaClient({
      baseUrl: "https://example.test",
      fetchFn: vi.fn(async () => json({ error: { code: 500, message: `Authorization: Bearer ${reflectedToken}` } })),
      retry: { maxRetries: 0 },
    });
    let caught: unknown;
    try {
      await getGeoServicesMetadata(
        client,
        "https://example.test",
        "https://example.test/rest/services/Utilities/Geometry/GeometryServer",
        {},
      );
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(HonuaDiscoveryError);
    if (!(caught instanceof HonuaDiscoveryError)) return;
    expect(caught.message).toBe("GeoServices metadata returned an error object.");
    expect(caught.detail).toEqual({ code: 500 });
    expect(caught.context).toEqual({ code: 500 });
    expect(JSON.stringify(caught)).not.toContain(reflectedToken);
  });

  it("fails closed when ImageServer metadata proves identity but no operation support", async () => {
    const result = await discoverGeoServices({
      endpoint: "https://example.test/rest/services/Imagery/Empty/ImageServer",
      clientOptions: { fetchFn: vi.fn(async () => json({ name: "Empty imagery", fields: [] })) },
    });

    expect(result.state).toBe("partial");
    expect(result.service.sourceBacked).toBe(false);
    expect(result.sources).toEqual([]);
    expect(result.operations).toEqual([]);
    expect(result.diagnostics.map((entry) => entry.code)).toEqual(expect.arrayContaining(["metadata-unavailable"]));
  });

  it("forwards explicit metadata refresh and cache-bypass directives", async () => {
    const requests: Request[] = [];
    const fetchFn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(new Request(input, init));
      return json(geometryMetadata);
    });
    const endpoint = "https://example.test/rest/services/Utilities/Geometry/GeometryServer";

    await discoverGeoServices({ endpoint, clientOptions: { fetchFn } });
    await discoverGeoServices({ endpoint, refresh: true, clientOptions: { fetchFn } });
    await discoverGeoServices({ endpoint, metadata: { cache: "bypass" }, clientOptions: { fetchFn } });

    expect(requests[0]!.headers.get("Cache-Control")).toBeNull();
    expect(requests[1]!.headers.get("Cache-Control")).toBe("no-cache");
    expect(requests[2]!.headers.get("Cache-Control")).toBe("no-store");
    expect(requests[2]!.headers.get("Pragma")).toBe("no-cache");
  });

  it("rejects unsupported TTL/stale metadata controls instead of silently ignoring them", async () => {
    const fetchFn = vi.fn<typeof fetch>();
    await expect(
      discoverGeoServices({
        endpoint: "https://example.test/rest/services/Utilities/Geometry/GeometryServer",
        metadata: { ttlMs: 1, staleIfError: true } as never,
        clientOptions: { fetchFn },
      }),
    ).rejects.toMatchObject({
      name: "HonuaDiscoveryError",
      code: "invalid-endpoint",
      message:
        "GeoServices metadata options support only the cache directive; TTL and stale fallback require an owned metadata cache.",
    });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("preserves common identity and operation semantics across facade/native descriptions", async () => {
    const discover = (prefix: "arcgis" | "honua") =>
      discoverGeoServices({
        endpoint: `https://example.test/${prefix}/rest/services/Utilities/Geometry/GeometryServer`,
        clientOptions: { fetchFn: vi.fn(async () => json(geometryMetadata)) },
      });
    const [native, facade] = await Promise.all([discover("arcgis"), discover("honua")]);

    expect({
      serviceKind: native.service.serviceKind,
      protocol: native.service.protocol,
      serviceId: native.service.serviceId,
      sourceBacked: native.service.sourceBacked,
      operations: native.operations.map(({ id, execution, sdkSupported }) => ({ id, execution, sdkSupported })),
    }).toEqual({
      serviceKind: facade.service.serviceKind,
      protocol: facade.service.protocol,
      serviceId: facade.service.serviceId,
      sourceBacked: facade.service.sourceBacked,
      operations: facade.operations.map(({ id, execution, sdkSupported }) => ({ id, execution, sdkSupported })),
    });
  });

  it("rejects GeometryServer and GPServer connect() calls before auth/network and directs callers to discovery", async () => {
    for (const { endpoint, protocol } of [
      {
        endpoint: "https://example.test/rest/services/Utilities/Geometry/GeometryServer",
        protocol: "geoservices-geometry-service",
      },
      {
        endpoint: "https://example.test/rest/services/Analysis/Tools/GPServer",
        protocol: "geoservices-gp-service",
      },
    ] as const) {
      const fetchFn = vi.fn<typeof fetch>();
      const auth = vi.fn(async () => "secret");
      for (const hint of ["auto", protocol] as const) {
        await expect(
          connect({
            endpoint,
            protocol: hint,
            authorizationScopeFingerprint: "scope",
            clientOptions: { fetchFn, auth },
          }),
        ).rejects.toMatchObject({ name: "HonuaDiscoveryError", code: "unsupported-protocol" });
      }
      expect(fetchFn).not.toHaveBeenCalled();
      expect(auth).not.toHaveBeenCalled();
    }
  });

  it("does not probe a canonical operation service through a mismatched Source protocol", async () => {
    const fetchFn = vi.fn<typeof fetch>();
    await expect(
      connect({
        endpoint: "https://example.test/rest/services/Utilities/Geometry/GeometryServer",
        protocol: "ogc-features",
        authorizationScopeFingerprint: "anonymous",
        clientOptions: { fetchFn },
      }),
    ).rejects.toMatchObject({ name: "HonuaDiscoveryError", code: "invalid-endpoint" });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("honors cancellation before and between metadata requests", async () => {
    const preAborted = new AbortController();
    preAborted.abort();
    const preFetch = vi.fn<typeof fetch>();
    await expect(
      discoverGeoServices({
        endpoint: "https://example.test/rest/services/Analysis/Tools/GPServer",
        signal: preAborted.signal,
        clientOptions: { fetchFn: preFetch },
      }),
    ).rejects.toBeInstanceOf(HonuaAbortError);
    expect(preFetch).not.toHaveBeenCalled();

    const controller = new AbortController();
    const requests: string[] = [];
    const fetchFn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(new URL(new Request(input, init).url).pathname);
      controller.abort();
      return json(gpMetadata);
    });
    await expect(
      discoverGeoServices({
        endpoint: "https://example.test/rest/services/Analysis/Tools/GPServer",
        signal: controller.signal,
        clientOptions: { fetchFn },
      }),
    ).rejects.toBeInstanceOf(HonuaAbortError);
    expect(requests).toEqual(["/rest/services/Analysis/Tools/GPServer"]);
  });

  it("cancels a pending metadata body read when the caller aborts", async () => {
    const controller = new AbortController();
    let bodyCancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull: () => new Promise<void>(() => undefined),
      cancel: () => {
        bodyCancelled = true;
      },
    });
    const fetchFn = vi.fn(async () => {
      setTimeout(() => controller.abort(), 0);
      return new Response(body, { headers: { "Content-Type": "application/json" } });
    });

    await expect(
      discoverGeoServices({
        endpoint: "https://example.test/rest/services/Utilities/Geometry/GeometryServer",
        signal: controller.signal,
        clientOptions: { fetchFn },
      }),
    ).rejects.toBeInstanceOf(HonuaAbortError);
    expect(bodyCancelled).toBe(true);
  });
});
