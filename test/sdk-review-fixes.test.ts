import { describe, expect, it, vi } from "vitest";

import { DatasetImportTaskClient } from "../src/control-plane/dataset-import/client.js";
import { HonuaAdminClient } from "../src/control-plane/index.js";
import { clientCredentials, oauth2 } from "../src/core/auth/index.js";
import { requestToken } from "../src/core/auth/token-endpoint.js";
import { HonuaClient } from "../src/core/client.js";
import { HonuaHttpError, HonuaNetworkError } from "../src/core/errors.js";
import { geoJsonToGeoServices, geoServicesGeometryToGeoJSON } from "../src/core/geoservices-geojson.js";
import { encodePathSegment, encodePathSegments, encodeServiceIdPath } from "../src/core/path-utils.js";
import { spatialIntersects } from "../src/core/spatial-filter.js";
import { HonuaGeocodingClient } from "../src/geocoding/index.js";

describe("SDK review fixes — path traversal & protocol-relative URL protection", () => {
  it("rejects dot segments in encodePathSegment, encodeServiceIdPath, and encodePathSegments", () => {
    for (const bad of [".", ".."]) {
      expect(() => encodePathSegment(bad)).toThrow(/path traversal/i);
      expect(() => encodeServiceIdPath(bad)).toThrow(/path traversal|must not contain "\." or "\.\." path segments/i);
      expect(() => encodePathSegments(bad)).toThrow(/path traversal/i);
    }

    for (const nested of ["folder/../secret", "a/./b", "/../escape", "a/b/.."]) {
      expect(() => encodeServiceIdPath(nested)).toThrow(
        /path traversal|must not contain "\." or "\.\." path segments/i,
      );
      expect(() => encodePathSegments(nested)).toThrow(/path traversal/i);
    }

    expect(encodePathSegment("v1.0")).toBe("v1.0");
    expect(encodePathSegment(".hidden")).toBe(".hidden");
    expect(encodePathSegment("...")).toBe("...");
    expect(encodeServiceIdPath("folder.v1/my.service")).toBe("folder.v1/my.service");
    expect(encodePathSegments("/a//b/")).toBe("/a//b/");
  });

  it("rejects dot-segment path parameters in HonuaAdminClient", async () => {
    const fetchFn = vi.fn(async () => Response.json({}));
    const client = new HonuaAdminClient({
      baseUrl: "https://admin.example.test",
      fetchFn: fetchFn as unknown as typeof fetch,
    });

    await expect(client.call("getConnection", { path: { id: ".." } })).rejects.toThrow(/path traversal/i);
    await expect(client.call("getConnection", { path: { id: "." } })).rejects.toThrow(/path traversal/i);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("rejects protocol-relative URLs when HonuaClient baseUrl is empty", async () => {
    const fetchFn = vi.fn(async () => Response.json({}));
    const client = new HonuaClient({
      baseUrl: "",
      fetchFn: fetchFn as unknown as typeof fetch,
    });

    await expect(client.request({ path: "//evil.example/steal" })).rejects.toThrow(/Protocol-relative/i);
    await expect(client.request({ path: "/\\evil.example/steal" })).rejects.toThrow(/Protocol-relative/i);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("rejects protocol-relative URLs mutated by a before-interceptor when baseUrl is empty", async () => {
    const fetchFn = vi.fn(async () => Response.json({}));
    const client = new HonuaClient({
      baseUrl: "",
      fetchFn: fetchFn as unknown as typeof fetch,
      interceptors: [
        {
          before: () => ({ url: "//evil.example/steal" }),
        },
      ],
    });

    await expect(client.request({ path: "/rest/services" })).rejects.toThrow(/Protocol-relative/i);
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

describe("SDK review fixes — fetch binding, redirects & credential transport security", () => {
  it("binds default globalThis.fetch in HonuaAdminClient so strict browser receivers succeed", async () => {
    const realFetch = globalThis.fetch;
    const strictFetch = function (this: unknown): Promise<Response> {
      if (this !== undefined && this !== globalThis) {
        throw new TypeError("Illegal invocation");
      }
      return Promise.resolve(Response.json({ data: [] }));
    };
    globalThis.fetch = strictFetch as unknown as typeof fetch;
    try {
      const client = new HonuaAdminClient({ baseUrl: "https://admin.example.test" });
      const result = await client.call("listAdminApiKeys", {});
      expect(result.data).toEqual({ data: [] });
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("refuses cross-origin redirects in HonuaAdminClient without leaking credentials", async () => {
    const seenOrigins: string[] = [];
    const client = new HonuaAdminClient({
      baseUrl: "https://admin.example.test",
      adminKey: "top-secret-admin-key",
      headers: { Authorization: "Bearer top-secret-token" },
      fetchFn: async (input, init) => {
        const url = new URL(String(input));
        seenOrigins.push(url.origin);
        expect(init?.redirect).toBe("manual");
        return new Response(null, {
          status: 302,
          headers: { location: "https://attacker.example/collect" },
        });
      },
    });

    await expect(client.call("listAdminApiKeys", {})).rejects.toThrow(HonuaNetworkError);
    expect(seenOrigins).toEqual(["https://admin.example.test"]);
  });

  it("follows same-origin redirects in HonuaAdminClient", async () => {
    const seenUrls: string[] = [];
    const client = new HonuaAdminClient({
      baseUrl: "https://admin.example.test",
      adminKey: "admin-key",
      fetchFn: async (input) => {
        const url = String(input);
        seenUrls.push(url);
        if (seenUrls.length === 1) {
          return new Response(null, {
            status: 307,
            headers: { location: "/api/v1/admin/api-keys?redirected=1" },
          });
        }
        return Response.json({ data: [{ id: "k1" }] });
      },
    });

    const result = await client.call("listAdminApiKeys", {});
    expect(seenUrls).toEqual([
      "https://admin.example.test/api/v1/admin/api-keys",
      "https://admin.example.test/api/v1/admin/api-keys?redirected=1",
    ]);
    expect(result.data).toEqual({ data: [{ id: "k1" }] });
  });

  it("routes gRPC-web connectTransportOptions fetch through fetchWithSafeRedirects", async () => {
    const seenOrigins: string[] = [];
    const client = new HonuaClient({
      baseUrl: "https://grpc.example.test",
      transport: "grpc-web",
      apiKey: "grpc-secret",
      fetchFn: async (input, init) => {
        const url = new URL(String(input));
        seenOrigins.push(url.origin);
        expect(init?.redirect).toBe("manual");
        return new Response(null, {
          status: 307,
          headers: { location: "https://attacker.example/grpc-steal" },
        });
      },
    });

    const transportOpts = (
      client as unknown as { connectTransportOptions(): { fetch: typeof fetch } }
    ).connectTransportOptions();
    await expect(
      transportOpts.fetch("https://grpc.example.test/geospatial.v1.FeatureService/QueryFeatures", {
        method: "POST",
        headers: { "X-API-Key": "grpc-secret" },
        body: new Uint8Array([1, 2, 3]),
      }),
    ).rejects.toThrow(/Cross-origin/i);
    expect(seenOrigins).toEqual(["https://grpc.example.test"]);
  });

  it("passes a relative-base grpc-web method URL through unchanged and still refuses protocol-relative URLs", async () => {
    const seenUrls: string[] = [];
    const client = new HonuaClient({
      baseUrl: "/api",
      transport: "grpc-web",
      fetchFn: async (input) => {
        seenUrls.push(String(input));
        return new Response(null, { status: 200 });
      },
    });
    const transportOpts = (
      client as unknown as { connectTransportOptions(): { fetch: typeof fetch } }
    ).connectTransportOptions();
    await transportOpts.fetch("/api/geospatial.v1.FeatureService/QueryFeatures", { method: "POST" });
    expect(seenUrls).toEqual(["/api/geospatial.v1.FeatureService/QueryFeatures"]);
    await expect(transportOpts.fetch("//attacker.example/steal", { method: "POST" })).rejects.toThrow(
      /Protocol-relative/i,
    );
  });

  it("enforces assertSecureCredentialedBaseUrl in HonuaGeocodingClient", () => {
    expect(() => new HonuaGeocodingClient({ baseUrl: "http://geo.example.test", apiKey: "k" })).toThrow(
      /refuses to send credentials/,
    );
    expect(() => new HonuaGeocodingClient({ baseUrl: "http://geo.example.test", bearerToken: "t" })).toThrow(
      /refuses to send credentials/,
    );
    expect(() => new HonuaGeocodingClient({ baseUrl: "http://geo.example.test" })).not.toThrow();
    expect(() => new HonuaGeocodingClient({ baseUrl: "http://localhost:8080", apiKey: "k" })).not.toThrow();
    expect(
      () => new HonuaGeocodingClient({ baseUrl: "http://geo.example.test", apiKey: "k", allowInsecureHttp: true }),
    ).not.toThrow();
  });

  it("enforces assertSecureCredentialedBaseUrl in OAuth2 token endpoint and auth providers", async () => {
    const fetchFn = vi.fn(async () => Response.json({ access_token: "tok" }));

    await expect(
      requestToken({
        fetchFn: fetchFn as unknown as typeof fetch,
        tokenEndpoint: "http://idp.example.test/token",
        params: { grant_type: "client_credentials", client_id: "c", client_secret: "s" },
      }),
    ).rejects.toThrow(/refuses to send credentials/);

    expect(() =>
      clientCredentials({
        tokenEndpoint: "http://idp.example.test/token",
        clientId: "c",
        clientSecret: "s",
        fetchFn: fetchFn as unknown as typeof fetch,
      }),
    ).toThrow(/refuses to send credentials/);

    expect(() =>
      oauth2({
        authorizationEndpoint: "https://idp.example.test/authorize",
        tokenEndpoint: "http://idp.example.test/token",
        clientId: "c",
        redirectUri: "https://app.example.test/cb",
        fetchFn: fetchFn as unknown as typeof fetch,
      }),
    ).toThrow(/refuses to send credentials/);

    expect(fetchFn).not.toHaveBeenCalled();

    // Loopback and explicit allowInsecureHttp opt-in still succeed.
    await expect(
      requestToken({
        fetchFn: fetchFn as unknown as typeof fetch,
        tokenEndpoint: "http://127.0.0.1:8080/token",
        params: { grant_type: "client_credentials", client_id: "c", client_secret: "s" },
      }),
    ).resolves.toMatchObject({ accessToken: "tok" });
  });

  it("enforces assertSecureCredentialedBaseUrl in DatasetImportWorkspaceTransport when headers are configured", () => {
    expect(
      () =>
        new DatasetImportTaskClient({
          baseUrl: "http://import.example.test",
          workspaceId: "ws-1",
          targetId: "tgt-1",
          headers: () => ({ Authorization: "Bearer secret" }),
        }),
    ).toThrow(/refuses to send credentials/);

    expect(
      () =>
        new DatasetImportTaskClient({
          baseUrl: "http://localhost:5000",
          workspaceId: "ws-1",
          targetId: "tgt-1",
          headers: () => ({ Authorization: "Bearer secret" }),
        }),
    ).not.toThrow();

    expect(
      () =>
        new DatasetImportTaskClient({
          baseUrl: "http://import.example.test",
          workspaceId: "ws-1",
          targetId: "tgt-1",
        }),
    ).not.toThrow();

    expect(
      () =>
        new DatasetImportTaskClient({
          baseUrl: "http://import.example.test",
          workspaceId: "ws-1",
          targetId: "tgt-1",
          headers: () => ({ Authorization: "Bearer secret" }),
          allowInsecureHttp: true,
        }),
    ).not.toThrow();
  });
});

describe("SDK review fixes — 3D Z/M coordinates & antimeridian envelopes", () => {
  it("does not place M into GeoJSON Z slot when hasM is true and hasZ is false", () => {
    expect(
      geoServicesGeometryToGeoJSON({
        hasM: true,
        hasZ: false,
        paths: [
          [
            [0, 0, 100],
            [1, 1, 200],
          ],
        ],
      }),
    ).toEqual({
      type: "LineString",
      coordinates: [
        [0, 0],
        [1, 1],
      ],
    });

    expect(
      geoServicesGeometryToGeoJSON({
        hasM: true,
        points: [
          [10, 20, 50],
          [30, 40, 60],
        ],
      }),
    ).toEqual({
      type: "MultiPoint",
      coordinates: [
        [10, 20],
        [30, 40],
      ],
    });
  });

  it("does not emit invalid [x, y, null, m] for sparse ZM points or vertices", () => {
    expect(geoServicesGeometryToGeoJSON({ x: 1, y: 2, z: null, m: 42 } as Record<string, unknown>)).toEqual({
      type: "Point",
      coordinates: [1, 2],
    });

    expect(
      geoServicesGeometryToGeoJSON({
        hasZ: true,
        hasM: true,
        paths: [
          [
            [0, 0, 15, 100],
            [1, 1, null, 200],
          ],
        ],
      } as Record<string, unknown>),
    ).toEqual({
      type: "LineString",
      coordinates: [
        [0, 0, 15],
        [1, 1],
      ],
    });
  });

  it("sets hasZ: true (and hasM: true for 4D) in geoJsonToGeoServices for 3D/4D geometries", () => {
    expect(
      geoJsonToGeoServices({
        type: "MultiPoint",
        coordinates: [
          [0, 0, 10],
          [1, 1, 20],
        ],
      }),
    ).toEqual({
      points: [
        [0, 0, 10],
        [1, 1, 20],
      ],
      hasZ: true,
    });

    expect(
      geoJsonToGeoServices({
        type: "LineString",
        coordinates: [
          [0, 0, 10],
          [1, 1, 20],
        ],
      }),
    ).toEqual({
      paths: [
        [
          [0, 0, 10],
          [1, 1, 20],
        ],
      ],
      hasZ: true,
    });

    expect(
      geoJsonToGeoServices({
        type: "MultiLineString",
        coordinates: [
          [
            [0, 0, 10, 1],
            [1, 1, 20, 2],
          ],
        ],
      }),
    ).toEqual({
      paths: [
        [
          [0, 0, 10, 1],
          [1, 1, 20, 2],
        ],
      ],
      hasZ: true,
      hasM: true,
    });

    const poly3d = geoJsonToGeoServices({
      type: "Polygon",
      coordinates: [
        [
          [0, 0, 5],
          [1, 0, 5],
          [1, 1, 5],
          [0, 1, 5],
          [0, 0, 5],
        ],
      ],
    });
    expect(poly3d).toMatchObject({ hasZ: true });
    expect(poly3d).not.toHaveProperty("hasM");

    const multiPoly4d = geoJsonToGeoServices({
      type: "MultiPolygon",
      coordinates: [
        [
          [
            [0, 0, 5, 1],
            [1, 0, 5, 2],
            [1, 1, 5, 3],
            [0, 1, 5, 4],
            [0, 0, 5, 1],
          ],
        ],
      ],
    });
    expect(multiPoly4d).toMatchObject({ hasZ: true, hasM: true });
  });

  it("allows antimeridian-crossing geographic envelopes while still rejecting invalid bounds", () => {
    expect(spatialIntersects({ xmin: 170, ymin: -20, xmax: -170, ymax: 20 }).geometryType).toBe("esriGeometryEnvelope");
    expect(
      spatialIntersects({ xmin: 175, ymin: -15, xmax: -175, ymax: 15, spatialReference: { wkid: 4326 } }).geometryType,
    ).toBe("esriGeometryEnvelope");

    expect(() => spatialIntersects({ xmin: 170, ymin: 20, xmax: -170, ymax: -20 })).toThrow();
    expect(() => spatialIntersects({ xmin: 190, ymin: -20, xmax: -170, ymax: 20 })).toThrow();
    expect(() =>
      spatialIntersects({ xmin: 170, ymin: -20, xmax: -170, ymax: 20, spatialReference: { wkid: 3857 } }),
    ).toThrow();
  });
});

describe("SDK review fixes — pagination, relative baseUrl & error interceptors", () => {
  it("enforces maxRecords on grpc-web in queryFeaturesAll", async () => {
    const client = new HonuaClient({
      baseUrl: "https://example.test",
      transport: "grpc-web",
      fetchFn: async () => new Response("{}", { status: 200 }),
    });
    const allRows = [
      { attributes: { OBJECTID: 1 } },
      { attributes: { OBJECTID: 2 } },
      { attributes: { OBJECTID: 3 } },
      { attributes: { OBJECTID: 4 } },
      { attributes: { OBJECTID: 5 } },
    ];
    vi.spyOn(client, "queryFeatures").mockImplementation(async (request) => {
      const offset = request.resultOffset ?? 0;
      const count = request.resultRecordCount ?? 2;
      return {
        objectIdFieldName: "OBJECTID",
        features: allRows.slice(offset, offset + count),
      };
    });

    const features = await client.featureLayer("Parcels", 0).queryFeaturesAll({ pageSize: 2, maxRecords: 3 });
    expect(features).toHaveLength(3);
    expect(features.map((f) => f.attributes.OBJECTID)).toEqual([1, 2, 3]);
  });

  it("handles empty and relative baseUrl when following OData @odata.nextLink", async () => {
    for (const baseUrl of ["", "/honua"]) {
      const seenUrls: string[] = [];
      const client = new HonuaClient({
        baseUrl,
        fetchFn: async (input) => {
          const url = String(input);
          seenUrls.push(url);
          if (seenUrls.length === 1) {
            return Response.json({
              value: [{ id: 1 }],
              "@odata.nextLink": `${baseUrl}/odata/Parcels?$skiptoken=p2`,
            });
          }
          return Response.json({ value: [{ id: 2 }] });
        },
      });

      const page = await client.odata("Parcels").queryAll();
      expect(page.rows).toEqual([{ id: 1 }, { id: 2 }]);
      expect(seenUrls).toEqual([`${baseUrl}/odata/Parcels`, `${baseUrl}/odata/Parcels?%24skiptoken=p2`]);
    }
  });

  it("handles empty and relative baseUrl when canonicalizing WFS capabilities URLs", async () => {
    const capabilitiesXml = `<?xml version="1.0" encoding="UTF-8"?>
<wfs:WFS_Capabilities version="2.0.0"
  xmlns:wfs="http://www.opengis.net/wfs/2.0"
  xmlns:ows="http://www.opengis.net/ows/1.1"
  xmlns:xlink="http://www.w3.org/1999/xlink">
  <ows:OperationsMetadata>
    <ows:Operation name="GetFeature">
      <ows:DCP>
        <ows:HTTP>
          <ows:Get xlink:href="/wfs"/>
          <ows:Post xlink:href="/wfs"/>
        </ows:HTTP>
      </ows:DCP>
      <ows:Parameter name="outputFormat">
        <ows:AllowedValues>
          <ows:Value>application/geo+json</ows:Value>
        </ows:AllowedValues>
      </ows:Parameter>
    </ows:Operation>
  </ows:OperationsMetadata>
  <wfs:FeatureTypeList>
    <wfs:FeatureType>
      <wfs:Name>parcels:lot</wfs:Name>
    </wfs:FeatureType>
  </wfs:FeatureTypeList>
</wfs:WFS_Capabilities>`;

    for (const baseUrl of ["", "/honua"]) {
      const seenUrls: string[] = [];
      const client = new HonuaClient({
        baseUrl,
        fetchFn: async (input) => {
          const url = String(input);
          seenUrls.push(url);
          if (url.includes("request=GetCapabilities")) {
            return new Response(capabilitiesXml, {
              status: 200,
              headers: { "Content-Type": "application/xml" },
            });
          }
          return Response.json({ type: "FeatureCollection", features: [] });
        },
      });

      const wfs = client.wfs("/wfs");
      const caps = await wfs.capabilities();
      expect(caps.operations.get("GetFeature")?.getUrl).toBe("/wfs");

      const result = await wfs.featureType("parcels:lot").getFeature({});
      expect(result.kind).toBe("json");
      expect(seenUrls[0]).toBe(`${baseUrl}/wfs?service=WFS&version=2.0.0&request=GetCapabilities`);
      expect(seenUrls[1]).toContain(`${baseUrl}/wfs?service=WFS&version=2.0.0&request=GetFeature`);
    }
  });

  it("invokes error interceptors exactly once on HTTP-200 GeoServices error envelopes", async () => {
    for (const mode of ["json", "metadata", "preferBinary"] as const) {
      const errorSpy = vi.fn();
      const client = new HonuaClient({
        baseUrl: "https://example.test",
        preferBinary: mode === "preferBinary",
        interceptors: [{ error: errorSpy }],
        fetchFn: async () =>
          new Response(JSON.stringify({ error: { code: 499, message: "Token Required" } }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
      });

      const call =
        mode === "metadata"
          ? client.getLayerMetadata("svc", 0)
          : client.queryFeatures({ serviceId: "svc", layerId: 0, where: "1=1" });

      await expect(call).rejects.toThrow(HonuaHttpError);
      expect(errorSpy).toHaveBeenCalledTimes(1);
    }
  });
});
