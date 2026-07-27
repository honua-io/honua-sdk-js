/**
 * First-party WFS 2.0 QueryCapableProtocolModule parity for issue #823.
 *
 * These tests exercise only the public contract, query-planner, and plugin
 * entrypoints around the built-in implementation. The existing WFS contract
 * suite remains the exhaustive wire-conformance oracle.
 */
import { describe, expect, it } from "vitest";

import { PROTOCOL_DEFAULT_CAPABILITIES, type SourceDescriptor, createDataset } from "../src/contract/index.js";
import type { WfsCapabilitiesSnapshot } from "../src/core/wfs-capabilities.js";
import {
  HonuaAbortError,
  HonuaCapabilityNotSupportedError,
  HonuaNetworkError,
  serializeHonuaError,
} from "../src/index.js";
import {
  HONUA_PLUGIN_API_VERSION,
  HONUA_PLUGIN_MANIFEST_VERSION,
  type HonuaPluginExtension,
  type HonuaPluginFactory,
  type HonuaPluginManifest,
  HonuaPluginRegistry,
  certifyHonuaPluginManifest,
} from "../src/plugin/index.js";
import {
  HonuaWfsProtocolError,
  type QueryExecutionPlanV1,
  type WfsProtocolModule,
  canonicalStringify,
  compileWfsQuery,
  createQueryIr,
  executeQueryPlan,
  explainQuery,
  parseQueryPlan,
  serializeQueryPlan,
  sha256,
  toJsonValue,
  wfsProtocolModule,
} from "../src/query-planner/index.js";
import { wfsProtocolResultFromGeoJson } from "../src/query-planner/wfs-protocol-module.js";
import {
  PARCEL_FEATURES,
  type ParcelAttrs,
  jsonResponse,
  makeMockClient,
  wfsCapabilitiesXml,
  wfsGeoJsonResponse,
  xmlResponse,
} from "./contract/shared.js";

const descriptor = {
  id: "parcels-wfs",
  protocol: "wfs",
  locator: {
    url: "https://mock.honua.test/wfs",
    typeName: "parcels:lot",
    featureNamespace: "http://parcels.example.test/ns",
  },
  capabilities: PROTOCOL_DEFAULT_CAPABILITIES.wfs,
} satisfies SourceDescriptor;

const REGISTRY_HOST = JSON.stringify({
  pluginApi: HONUA_PLUGIN_API_VERSION,
  sdkVersion: "0.1.0-beta.0",
  environment: "node",
  peers: {},
  grants: {},
});

function previousReleaseWfsPlan(plan: QueryExecutionPlanV1): QueryExecutionPlanV1 {
  if (plan.ir.source.protocol !== "wfs") throw new Error("expected a WFS plan");
  const steps = plan.steps.map((step) => {
    if (step.engine !== "remote") return step;
    let query = step.query;
    if (step.operation === "queryAll") {
      const pagination = query.pagination;
      if (!pagination || pagination.offset !== 0 || pagination.limit === undefined) {
        throw new Error("expected a bounded queryAll input");
      }
      query = {
        ...query,
        pagination: { offset: 0, limit: pagination.limit + 1 },
      };
    }
    return {
      ...step,
      query,
      compiled: compileWfsQuery(plan.ir.source, query),
    };
  });
  return refingerprintWfsPlan({ ...plan, steps });
}

function refingerprintWfsPlan(plan: QueryExecutionPlanV1): QueryExecutionPlanV1 {
  const { id: _id, fingerprint: _fingerprint, ...unsigned } = plan;
  const fingerprint = sha256(canonicalStringify(toJsonValue(unsigned)));
  return {
    ...unsigned,
    id: `plan_${fingerprint.slice("sha256:".length, "sha256:".length + 16)}`,
    fingerprint,
  } as QueryExecutionPlanV1;
}

describe("WFS query-capable protocol-module seam (#823)", () => {
  it("uses the planner's exact deterministic compiler hook and executes against its discovered handle", async () => {
    let capabilitiesRequests = 0;
    let featureRequests = 0;
    let getFeatureUrl: URL | undefined;
    const client = makeMockClient({
      routes: [
        [
          "/wfs",
          (url) => {
            const request = url.searchParams.get("request");
            if (request === "GetCapabilities") {
              capabilitiesRequests += 1;
              return xmlResponse(wfsCapabilitiesXml());
            }
            if (request === "GetFeature") {
              featureRequests += 1;
              getFeatureUrl = url;
              return jsonResponse(wfsGeoJsonResponse(PARCEL_FEATURES.slice(0, 2)));
            }
            return new Response("not found", { status: 404 });
          },
        ],
      ],
    });
    const module = wfsProtocolModule(client);
    const discovered = module.discover(descriptor);
    if (discovered instanceof Promise) throw new Error("WFS discovery must remain synchronous");
    expect(capabilitiesRequests).toBe(0);
    expect(featureRequests).toBe(0);

    const plan = explainQuery<ParcelAttrs>({
      descriptor,
      query: {
        where: "STATE = 'CA'",
        outFields: ["OBJECTID", "STATE"],
        orderBy: [{ field: "ACRES", direction: "desc" }],
        pagination: { limit: 2 },
      },
    });
    const step = plan.steps[0];
    if (!step || step.engine !== "remote") throw new Error("expected one remote WFS step");
    const compiled = module.compile({
      source: plan.ir.source,
      query: plan.ir.query,
      operation: "query",
    });

    expect(JSON.stringify(compiled)).toBe(JSON.stringify(step.compiled));
    expect(compiled).toMatchObject({
      compiler: "wfs-2.0-protocol-query-v1",
      operation: "query",
      endpoint: "https://mock.honua.test/wfs",
      typeName: "parcels:lot",
      method: "GET",
      propertyName: ["OBJECTID", "STATE", "the_geom"],
      sortBy: "ACRES D",
      count: 2,
    });
    expect(capabilitiesRequests).toBe(0);
    expect(featureRequests).toBe(0);

    const result = await module.execute<ParcelAttrs>(discovered, {
      compiled,
      operation: "query",
      query: {},
    });
    expect(result.features).toHaveLength(2);
    expect(result.features[0]?.attributes.STATE).toBe("CA");
    expect(getFeatureUrl?.searchParams.get("propertyName")).toBe("OBJECTID,STATE,the_geom");
    expect(getFeatureUrl?.searchParams.get("sortBy")).toBe("ACRES D");
    expect(getFeatureUrl?.searchParams.get("NAMESPACES")).toBe("xmlns(parcels,http://parcels.example.test/ns)");
    expect(capabilitiesRequests).toBe(1);
    expect(featureRequests).toBe(1);
  });

  it("preserves spatial SRS/axis evidence and operation-bound plan persistence", () => {
    const query = {
      spatialFilter: {
        geometry: { x: -157.8, y: 21.3, spatialReference: { wkid: 4326 } },
        geometryType: "esriGeometryPoint" as const,
      },
      outSr: 3857,
      pagination: { limit: 2 },
    };
    const plan = explainQuery({ descriptor, query });
    const step = plan.steps[0];
    if (!step || step.engine !== "remote") throw new Error("expected one remote WFS step");
    if (step.compiled.compiler !== "wfs-2.0-protocol-query-v1") {
      throw new Error("expected the executable WFS compiler");
    }
    expect(step.compiled.filterSrsName).toBe("urn:ogc:def:crs:EPSG::4326");
    expect(step.compiled.srsName).toBe("urn:ogc:def:crs:EPSG::3857");
    expect(step.compiled.filter).toContain('srsName="urn:ogc:def:crs:EPSG::4326"');
    expect(step.compiled.filter).toContain("<gml:pos>21.3 -157.8</gml:pos>");
    expect(step.compiled.filter).not.toContain('srsName="urn:ogc:def:crs:EPSG::3857"');

    const roundTrip = parseQueryPlan(serializeQueryPlan(plan));
    expect(roundTrip).toEqual(plan);
    const roundTripStep = roundTrip.steps[0];
    if (!roundTripStep || roundTripStep.engine !== "remote") {
      throw new Error("expected one persisted WFS step");
    }
    expect(roundTripStep.compiled).toMatchObject({
      compiler: "wfs-2.0-protocol-query-v1",
      operation: "query",
      count: 2,
    });
  });

  it("binds exact capability evidence and emits qualified GET/POST namespace syntax", async () => {
    const longWhere = `STATE = '${"x".repeat(8_000)}'`;
    const spatialQuery = {
      where: longWhere,
      spatialFilter: {
        geometry: { x: -157.8, y: 21.3, spatialReference: { wkid: 4326 } },
        geometryType: "esriGeometryPoint" as const,
      },
      outSr: 3857,
      pagination: { limit: 1 },
    };
    let postBody = "";
    let postRequests = 0;
    const postClient = makeMockClient({
      routes: [
        [
          "/wfs",
          (url, init) => {
            if (url.searchParams.get("request") === "GetCapabilities") {
              return xmlResponse(wfsCapabilitiesXml());
            }
            if (init?.method === "POST") {
              postRequests += 1;
              postBody = String(init.body);
              return jsonResponse(wfsGeoJsonResponse(PARCEL_FEATURES.slice(0, 1)));
            }
            return new Response("unexpected", { status: 500 });
          },
        ],
      ],
    });
    const postModule = wfsProtocolModule(postClient);
    const postHandle = postModule.discover(descriptor);
    if (postHandle instanceof Promise) throw new Error("WFS discovery must remain synchronous");
    const postIr = createQueryIr({ descriptor, query: spatialQuery });
    const postCompiled = postModule.compile({
      source: postIr.source,
      query: postIr.query,
      operation: "query",
    });
    expect(postCompiled).toMatchObject({
      method: "POST",
      filterSrsName: "urn:ogc:def:crs:EPSG::4326",
      srsName: "urn:ogc:def:crs:EPSG::3857",
    });
    await postModule.execute(postHandle, {
      compiled: postCompiled,
      operation: "query",
      query: {},
    });
    expect(postRequests).toBe(1);
    expect(postBody).toContain('xmlns:parcels="http://parcels.example.test/ns"');
    expect(postBody).toContain('<wfs:Query typeNames="parcels:lot" srsName="urn:ogc:def:crs:EPSG::3857">');
    expect(postBody).toContain('srsName="urn:ogc:def:crs:EPSG::4326"');

    let getOnlyFeatureRequests = 0;
    const getOnlyCapabilities = wfsCapabilitiesXml().replace("<ows:Get/><ows:Post/>", "<ows:Get/>");
    const getOnlyClient = makeMockClient({
      routes: [
        [
          "/wfs",
          (url) => {
            if (url.searchParams.get("request") === "GetCapabilities") {
              return xmlResponse(getOnlyCapabilities);
            }
            getOnlyFeatureRequests += 1;
            return new Response("unexpected", { status: 500 });
          },
        ],
      ],
    });
    const getOnlyModule = wfsProtocolModule(getOnlyClient);
    const getOnlyHandle = getOnlyModule.discover(descriptor);
    if (getOnlyHandle instanceof Promise) throw new Error("WFS discovery must remain synchronous");
    await expect(
      getOnlyModule.execute(getOnlyHandle, {
        compiled: postCompiled,
        operation: "query",
        query: {},
      }),
    ).rejects.toBeInstanceOf(HonuaCapabilityNotSupportedError);
    expect(getOnlyFeatureRequests).toBe(0);
  });

  it("cannot promote mutable capability evidence before or after first execution", async () => {
    const getOnlyCapabilities = wfsCapabilitiesXml().replace("<ows:Get/><ows:Post/>", "<ows:Get/>");
    let featureRequests = 0;
    const client = makeMockClient({
      routes: [
        [
          "/wfs",
          (url) => {
            if (url.searchParams.get("request") === "GetCapabilities") {
              return xmlResponse(getOnlyCapabilities);
            }
            featureRequests += 1;
            return jsonResponse(wfsGeoJsonResponse(PARCEL_FEATURES.slice(0, 1)));
          },
        ],
      ],
    });
    const module = wfsProtocolModule(client);
    const handle = module.discover(descriptor);
    if (handle instanceof Promise) throw new Error("WFS discovery must remain synchronous");
    const snapshot = await client.wfs(descriptor.locator.url).capabilities();
    const operation = snapshot.operations.get("GetFeature");
    const featureType = snapshot.featureTypes[0];
    if (!operation || !featureType?.namespace) throw new Error("expected complete immutable WFS evidence");

    const attemptEvidenceMutation = () => {
      expect(() => (operation.methods as unknown as string[]).push("POST")).toThrow(TypeError);
      expect(() => (operation.outputFormats as unknown as string[]).splice(0, 1, "application/json")).toThrow(
        TypeError,
      );
      expect(() =>
        (snapshot.operations as unknown as Map<string, unknown>).set("GetFeature", {
          methods: ["POST"],
          outputFormats: ["application/json"],
        }),
      ).toThrow(TypeError);
      expect(() =>
        (snapshot.outputFormatsByOp as unknown as Map<string, readonly string[]>).set("GetFeature", [
          "application/json",
        ]),
      ).toThrow(TypeError);
      expect(() => {
        (operation as unknown as { postUrl: string }).postUrl = "https://mock.honua.test/wfs";
      }).toThrow(TypeError);
      expect(() => {
        (featureType as unknown as { name: string }).name = descriptor.locator.typeName;
      }).toThrow(TypeError);
      expect(() => {
        (featureType as unknown as { defaultCrs: string }).defaultCrs = "EPSG:3857";
      }).toThrow(TypeError);
      expect(() => (featureType.otherCrs as unknown as string[]).push("EPSG:32604")).toThrow(TypeError);
      expect(() => {
        (featureType.namespace as { uri: string }).uri = "urn:evil";
      }).toThrow(TypeError);
      expect(() => (snapshot.featureTypes as unknown as unknown[]).splice(0, 1)).toThrow(TypeError);
    };

    attemptEvidenceMutation();
    const getIr = createQueryIr({ descriptor, query: { pagination: { limit: 1 } } });
    const getCompiled = module.compile({ source: getIr.source, query: getIr.query, operation: "query" });
    await expect(
      module.execute(handle, { compiled: getCompiled, operation: "query", query: {} }),
    ).resolves.toMatchObject({
      features: [{ attributes: { OBJECTID: 1 } }],
    });
    expect(featureRequests).toBe(1);

    attemptEvidenceMutation();
    const postIr = createQueryIr({ descriptor, query: { where: `STATE = '${"x".repeat(8_000)}'` } });
    const postCompiled = module.compile({ source: postIr.source, query: postIr.query, operation: "query" });
    expect(postCompiled.method).toBe("POST");
    await expect(
      module.execute(handle, { compiled: postCompiled, operation: "query", query: {} }),
    ).rejects.toBeInstanceOf(HonuaCapabilityNotSupportedError);
    expect(featureRequests).toBe(1);
  });

  it("accepts canonical CRS aliases while keeping EPSG:4326 distinct from OGC CRS84", async () => {
    const executeAliases = async (advertisedDefault: string, requestedAliases: readonly string[]) => {
      let featureRequests = 0;
      const capabilities = wfsCapabilitiesXml().replace("urn:ogc:def:crs:EPSG::4326", advertisedDefault);
      const client = makeMockClient({
        routes: [
          [
            "/wfs",
            (url) => {
              if (url.searchParams.get("request") === "GetCapabilities") {
                return xmlResponse(capabilities);
              }
              featureRequests += 1;
              return jsonResponse(wfsGeoJsonResponse(PARCEL_FEATURES.slice(0, 1)));
            },
          ],
        ],
      });
      const module = wfsProtocolModule(client);
      const handle = module.discover(descriptor);
      if (handle instanceof Promise) throw new Error("WFS discovery must remain synchronous");
      const ir = createQueryIr({ descriptor, query: { pagination: { limit: 1 } } });
      const baseCompiled = module.compile({
        source: ir.source,
        query: ir.query,
        operation: "query",
      });
      for (const srsName of requestedAliases) {
        await expect(
          module.execute(handle, {
            compiled: { ...baseCompiled, srsName },
            operation: "query",
            query: {},
          }),
        ).resolves.toMatchObject({ features: [{ attributes: { OBJECTID: 1 } }] });
      }
      expect(featureRequests).toBe(requestedAliases.length);
    };

    await executeAliases("urn:ogc:def:crs:OGC:1.3:CRS84", [
      "CRS84",
      "CRS:84",
      "OGC:CRS84",
      "urn:x-ogc:def:crs:OGC:1.3:CRS84",
      "https://www.opengis.net/def/crs/OGC/1.3/CRS84",
    ]);
    await executeAliases("http://www.opengis.net/def/crs/EPSG/0/4326", [
      "4326",
      "EPSG:4326",
      "urn:ogc:def:crs:EPSG::4326",
      "https://www.opengis.net/def/crs/EPSG/0/4326",
      "http://www.opengis.net/gml/srs/epsg.xml#4326",
    ]);
    await executeAliases("http://www.opengis.net/gml/srs/epsg.xml#4326", ["EPSG:4326"]);

    let rejectedFeatureRequests = 0;
    const crs84OnlyCapabilities = wfsCapabilitiesXml()
      .replace("urn:ogc:def:crs:EPSG::4326", "urn:ogc:def:crs:OGC:1.3:CRS84")
      .replace("      <wfs:OtherCRS>urn:ogc:def:crs:EPSG::3857</wfs:OtherCRS>\n", "");
    const rejectedClient = makeMockClient({
      routes: [
        [
          "/wfs",
          (url) => {
            if (url.searchParams.get("request") === "GetCapabilities") {
              return xmlResponse(crs84OnlyCapabilities);
            }
            rejectedFeatureRequests += 1;
            return jsonResponse(wfsGeoJsonResponse(PARCEL_FEATURES.slice(0, 1)));
          },
        ],
      ],
    });
    const rejectedModule = wfsProtocolModule(rejectedClient);
    const rejectedHandle = rejectedModule.discover(descriptor);
    if (rejectedHandle instanceof Promise) throw new Error("WFS discovery must remain synchronous");
    const rejectedIr = createQueryIr({ descriptor, query: {} });
    const rejectedCompiled = rejectedModule.compile({
      source: rejectedIr.source,
      query: rejectedIr.query,
      operation: "query",
    });
    const secret = "crs-secret";
    for (const srsName of [
      "EPSG:4326",
      "EPSG:999999999999999999999999",
      "urn:example:def:crs:LOCAL::84",
      `https://user:${secret}@www.opengis.net/def/crs/EPSG/0/4326?token=${secret}`,
    ]) {
      let thrown: unknown;
      try {
        await rejectedModule.execute(rejectedHandle, {
          compiled: { ...rejectedCompiled, srsName },
          operation: "query",
          query: {},
        });
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(HonuaCapabilityNotSupportedError);
      if (!(thrown instanceof HonuaCapabilityNotSupportedError)) throw thrown;
      expect(thrown.message).not.toContain(secret);
      expect(JSON.stringify(serializeHonuaError(thrown))).not.toContain(secret);
    }
    expect(rejectedFeatureRequests).toBe(0);

    for (const srsName of ["EPSG:0", "0"]) {
      await expect(
        rejectedModule.execute(rejectedHandle, {
          compiled: { ...rejectedCompiled, srsName },
          operation: "query",
          query: {},
        }),
      ).rejects.toBeInstanceOf(HonuaCapabilityNotSupportedError);
    }
    expect(rejectedFeatureRequests).toBe(0);

    const unknownDefaultClient = makeMockClient({
      routes: [
        [
          "/wfs",
          (url) =>
            url.searchParams.get("request") === "GetCapabilities"
              ? xmlResponse(
                  wfsCapabilitiesXml().replace("urn:ogc:def:crs:EPSG::4326", "urn:example:def:crs:LOCAL::4326"),
                )
              : new Response("unexpected", { status: 500 }),
        ],
      ],
    });
    const unknownDefaultModule = wfsProtocolModule(unknownDefaultClient);
    const unknownDefaultHandle = unknownDefaultModule.discover(descriptor);
    if (unknownDefaultHandle instanceof Promise) throw new Error("WFS discovery must remain synchronous");
    await expect(
      unknownDefaultModule.execute(unknownDefaultHandle, {
        compiled: rejectedCompiled,
        operation: "query",
        query: {},
      }),
    ).rejects.toBeInstanceOf(HonuaWfsProtocolError);
  });

  it("uses the namespace declaration in scope for the advertised feature QName", async () => {
    let observedNamespaces: string | null = null;
    const elementScopedCapabilities = wfsCapabilitiesXml()
      .replace(' xmlns:parcels="http://parcels.example.test/ns"', "")
      .replace(
        "<wfs:Name>parcels:lot</wfs:Name>",
        '<wfs:Name xmlns:parcels="http://parcels.example.test/ns">parcels:lot</wfs:Name>',
      );
    const client = makeMockClient({
      routes: [
        [
          "/wfs",
          (url) => {
            if (url.searchParams.get("request") === "GetCapabilities") {
              return xmlResponse(elementScopedCapabilities);
            }
            observedNamespaces = url.searchParams.get("NAMESPACES");
            return jsonResponse(wfsGeoJsonResponse(PARCEL_FEATURES.slice(0, 1)));
          },
        ],
      ],
    });
    const module = wfsProtocolModule(client);
    const handle = module.discover(descriptor);
    if (handle instanceof Promise) throw new Error("WFS discovery must remain synchronous");
    const ir = createQueryIr({ descriptor, query: {} });
    const compiled = module.compile({ source: ir.source, query: ir.query, operation: "query" });
    await expect(module.execute(handle, { compiled, operation: "query", query: {} })).resolves.toBeDefined();
    expect(observedNamespaces).toBe("xmlns(parcels,http://parcels.example.test/ns)");

    let shadowedFeatureRequests = 0;
    const shadowedClient = makeMockClient({
      routes: [
        [
          "/wfs",
          (url) => {
            if (url.searchParams.get("request") === "GetCapabilities") {
              return xmlResponse(
                wfsCapabilitiesXml().replace(
                  "<wfs:Name>parcels:lot</wfs:Name>",
                  '<wfs:Name xmlns:parcels="urn:shadowed">parcels:lot</wfs:Name>',
                ),
              );
            }
            shadowedFeatureRequests += 1;
            return new Response("unexpected", { status: 500 });
          },
        ],
      ],
    });
    const shadowedModule = wfsProtocolModule(shadowedClient);
    const shadowedHandle = shadowedModule.discover(descriptor);
    if (shadowedHandle instanceof Promise) throw new Error("WFS discovery must remain synchronous");
    await expect(
      shadowedModule.execute(shadowedHandle, { compiled, operation: "query", query: {} }),
    ).rejects.toBeInstanceOf(HonuaWfsProtocolError);
    expect(shadowedFeatureRequests).toBe(0);
  });

  it("preserves legacy root-namespace snapshots and copies their mutable execution evidence", async () => {
    let observedNamespaces: string | null = null;
    let featureRequests = 0;
    const client = makeMockClient({
      routes: [
        [
          "/wfs",
          (url) => {
            featureRequests += 1;
            observedNamespaces = url.searchParams.get("NAMESPACES");
            return jsonResponse(wfsGeoJsonResponse(PARCEL_FEATURES.slice(0, 1)));
          },
        ],
      ],
    });
    const methods: Array<"GET" | "POST"> = ["GET"];
    const formats = ["application/geo+json"];
    const namespaces = new Map([["parcels", "http://parcels.example.test/ns"]]);
    const snapshot = {
      version: "2.0.0",
      operations: new Map([
        [
          "GetFeature",
          {
            name: "GetFeature",
            methods,
            outputFormats: formats,
            getUrl: descriptor.locator.url,
          },
        ],
      ]),
      outputFormatsByOp: new Map([["GetFeature", formats]]),
      featureTypes: [
        {
          name: "parcels:lot",
          defaultCrs: "EPSG:4326",
          otherCrs: ["EPSG:3857"],
        },
      ],
      namespaces,
      filterCapabilities: { spatial: [], scalar: [], temporal: [] },
      storedQueryNames: [],
    } satisfies WfsCapabilitiesSnapshot;
    const root = client.wfs(descriptor.locator.url);
    root.capabilities = async () => snapshot;

    const module = wfsProtocolModule(client);
    const handle = module.discover(descriptor);
    if (handle instanceof Promise) throw new Error("WFS discovery must remain synchronous");
    const getIr = createQueryIr({ descriptor, query: { pagination: { limit: 1 } } });
    const getCompiled = module.compile({ source: getIr.source, query: getIr.query, operation: "query" });
    await expect(
      module.execute(handle, { compiled: getCompiled, operation: "query", query: {} }),
    ).resolves.toBeDefined();
    expect(observedNamespaces).toBe("xmlns(parcels,http://parcels.example.test/ns)");
    expect(featureRequests).toBe(1);

    methods.push("POST");
    formats.splice(0, 1, "application/json");
    namespaces.set("parcels", "urn:promoted");
    const postIr = createQueryIr({ descriptor, query: { where: `STATE = '${"x".repeat(8_000)}'` } });
    const postCompiled = module.compile({ source: postIr.source, query: postIr.query, operation: "query" });
    expect(postCompiled.method).toBe("POST");
    await expect(
      module.execute(handle, { compiled: postCompiled, operation: "query", query: {} }),
    ).rejects.toBeInstanceOf(HonuaCapabilityNotSupportedError);
    expect(featureRequests).toBe(1);
  });

  it("fails closed before GetFeature when version, type, namespace, CRS, or output evidence is incomplete", async () => {
    const cases = [
      {
        name: "version",
        xml: wfsCapabilitiesXml().replace('version="2.0.0"', 'version="1.1.0"'),
        query: {},
        error: HonuaWfsProtocolError,
      },
      {
        name: "feature type",
        xml: wfsCapabilitiesXml().replace("<wfs:Name>parcels:lot</wfs:Name>", "<wfs:Name>parcels:other</wfs:Name>"),
        query: {},
        error: HonuaWfsProtocolError,
      },
      {
        name: "DCP authority",
        xml: wfsCapabilitiesXml().replace(
          "<ows:Get/><ows:Post/>",
          '<ows:Get xlink:href="https://evil.example.test/wfs"/><ows:Post/>',
        ),
        query: {},
        error: HonuaWfsProtocolError,
      },
      {
        name: "namespace",
        xml: wfsCapabilitiesXml().replace(' xmlns:parcels="http://parcels.example.test/ns"', ""),
        query: {},
        error: HonuaWfsProtocolError,
      },
      {
        name: "element namespace undeclaration",
        xml: wfsCapabilitiesXml().replace(
          "<wfs:Name>parcels:lot</wfs:Name>",
          '<wfs:Name xmlns:parcels="">parcels:lot</wfs:Name>',
        ),
        query: {},
        error: HonuaWfsProtocolError,
      },
      {
        name: "default CRS",
        xml: wfsCapabilitiesXml().replace("<wfs:DefaultCRS>urn:ogc:def:crs:EPSG::4326</wfs:DefaultCRS>", ""),
        query: {},
        error: HonuaWfsProtocolError,
      },
      {
        name: "requested CRS",
        xml: wfsCapabilitiesXml(),
        query: { outSr: 32604 },
        error: HonuaCapabilityNotSupportedError,
      },
      {
        name: "filter CRS",
        xml: wfsCapabilitiesXml(),
        query: {
          spatialFilter: {
            geometry: { x: 600_000, y: 2_350_000, spatialReference: { wkid: 32604 } },
            geometryType: "esriGeometryPoint",
          },
        },
        error: HonuaCapabilityNotSupportedError,
      },
      {
        name: "output",
        xml: wfsCapabilitiesXml().replace("<ows:Value>application/geo+json</ows:Value>", ""),
        query: {},
        error: HonuaCapabilityNotSupportedError,
      },
    ] as const;
    for (const scenario of cases) {
      let featureRequests = 0;
      const client = makeMockClient({
        routes: [
          [
            "/wfs",
            (url) => {
              if (url.searchParams.get("request") === "GetCapabilities") {
                return xmlResponse(scenario.xml);
              }
              featureRequests += 1;
              return new Response("unexpected", { status: 500 });
            },
          ],
        ],
      });
      const module = wfsProtocolModule(client);
      const handle = module.discover(descriptor);
      if (handle instanceof Promise) throw new Error("WFS discovery must remain synchronous");
      const ir = createQueryIr({ descriptor, query: scenario.query });
      const compiled = module.compile({ source: ir.source, query: ir.query, operation: "query" });
      await expect(
        module.execute(handle, { compiled, operation: "query", query: {} }),
        scenario.name,
      ).rejects.toBeInstanceOf(scenario.error);
      expect(featureRequests, scenario.name).toBe(0);
    }
  });

  it("validates and migrates previous-release persisted WFS plans before parse or execution", async () => {
    const currentQueryPlan = explainQuery({
      descriptor,
      query: { outFields: ["OBJECTID"], pagination: { limit: 2 } },
    });
    const legacyQueryPlan = previousReleaseWfsPlan(
      explainQuery({
        descriptor,
        query: { outFields: ["OBJECTID"], pagination: { limit: 2 } },
        sourceAuthorityFingerprint: null,
      }),
    );
    const legacyQuery = legacyQueryPlan.steps[0];
    if (!legacyQuery || legacyQuery.engine !== "remote") throw new Error("expected a legacy remote query");
    expect(legacyQuery.compiled).toMatchObject({
      compiler: "wfs-2.0-get-feature-v1",
      count: 2,
    });
    expect(legacyQueryPlan.fingerprint).not.toBe(currentQueryPlan.fingerprint);
    expect(parseQueryPlan(JSON.stringify(legacyQueryPlan))).toEqual(currentQueryPlan);
    expect(serializeQueryPlan(legacyQueryPlan)).toBe(serializeQueryPlan(currentQueryPlan));

    const tamperedStep = {
      ...legacyQuery,
      compiled: { ...legacyQuery.compiled, count: 99 },
    };
    const tamperedPlan = refingerprintWfsPlan({ ...legacyQueryPlan, steps: [tamperedStep] });
    expect(() => parseQueryPlan(JSON.stringify(tamperedPlan))).toThrow(
      expect.objectContaining({ code: "invalid-plan" }),
    );

    const currentQueryAllPlan = explainQuery<ParcelAttrs>({
      descriptor,
      query: { aggregation: { metrics: [{ fn: "sum", field: "ACRES" }] } },
      capabilityPolicy: "degraded",
      fallback: { mode: "bounded-local", maxRows: 1 },
    });
    const legacyQueryAllPlan = previousReleaseWfsPlan(
      explainQuery<ParcelAttrs>({
        descriptor,
        query: { aggregation: { metrics: [{ fn: "sum", field: "ACRES" }] } },
        capabilityPolicy: "degraded",
        fallback: { mode: "bounded-local", maxRows: 1 },
        sourceAuthorityFingerprint: null,
      }),
    );
    const legacyRemote = legacyQueryAllPlan.steps[0];
    if (!legacyRemote || legacyRemote.engine !== "remote") throw new Error("expected a legacy remote input");
    expect(legacyRemote.query.pagination).toEqual({ offset: 0, limit: 2 });
    expect(legacyRemote.compiled).toMatchObject({
      compiler: "wfs-2.0-get-feature-v1",
      count: 2,
    });
    expect(parseQueryPlan(JSON.stringify(legacyQueryAllPlan))).toEqual(currentQueryAllPlan);

    let observedCount: string | null = null;
    const client = makeMockClient({
      routes: [
        [
          "/wfs",
          (url) => {
            const request = url.searchParams.get("request");
            if (request === "GetCapabilities") return xmlResponse(wfsCapabilitiesXml());
            if (request === "GetFeature") {
              observedCount = url.searchParams.get("count");
              return jsonResponse({
                ...wfsGeoJsonResponse(PARCEL_FEATURES.slice(0, 1)),
                numberMatched: 1,
              });
            }
            return new Response("not found", { status: 404 });
          },
        ],
      ],
    });
    const source = createDataset({
      id: "wfs-legacy-plan-migration",
      client,
      skipCompatibilityCheck: true,
      sources: [descriptor],
    }).source<ParcelAttrs>(descriptor.id);
    if (!source) throw new Error("expected WFS source");

    const execution = await executeQueryPlan(legacyQueryAllPlan, source);
    expect(observedCount).toBe("2");
    expect(execution.planId).toBe(currentQueryAllPlan.id);
    expect(execution.fingerprint).toBe(currentQueryAllPlan.fingerprint);
    expect(execution.result.aggregateRows).toEqual([{ sum_ACRES: PARCEL_FEATURES[0]?.attributes.ACRES }]);
  });

  it("preserves built-in query, bounded queryAll, stream, and typed escape-hatch behavior", async () => {
    const observedPages: Array<{ count: number; startIndex: number }> = [];
    const client = makeMockClient({
      routes: [
        [
          "/wfs",
          (url) => {
            const request = url.searchParams.get("request");
            if (request === "GetCapabilities") return xmlResponse(wfsCapabilitiesXml());
            if (request === "GetFeature") {
              const count = Number(url.searchParams.get("count") ?? "2000");
              const startIndex = Number(url.searchParams.get("startIndex") ?? "0");
              observedPages.push({ count, startIndex });
              const body = wfsGeoJsonResponse(PARCEL_FEATURES.slice(startIndex, startIndex + count));
              return jsonResponse({ ...body, numberMatched: PARCEL_FEATURES.length });
            }
            return new Response("not found", { status: 404 });
          },
        ],
      ],
    });
    const source = createDataset({
      id: "wfs-module-parity",
      client,
      skipCompatibilityCheck: true,
      sources: [descriptor],
    }).source<ParcelAttrs>(descriptor.id);
    if (!source) throw new Error("expected WFS source");

    expect(source.protocol("wfs")?.typeName).toBe("parcels:lot");
    const queryResult = await source.query({ pagination: { limit: 1 } });
    expect(queryResult.features).toHaveLength(1);

    const allResult = await source.queryAll({ pagination: { limit: 2 } });
    expect(allResult.features).toHaveLength(2);
    expect(allResult.exceededTransferLimit).toBe(true);
    expect(allResult.totalCount).toBe(PARCEL_FEATURES.length);

    const tailResult = await source.queryAll({ pagination: { offset: 1, limit: 2 } });
    expect(tailResult.features).toHaveLength(2);
    expect(tailResult.exceededTransferLimit).toBe(false);
    expect(tailResult.totalCount).toBe(PARCEL_FEATURES.length);

    const streamed: number[] = [];
    for await (const page of source.stream({ pagination: { limit: 2 } })) {
      streamed.push(...page.features.map((feature) => feature.attributes.OBJECTID));
    }
    expect(streamed).toEqual([1, 2, 3]);
    expect(observedPages).toEqual([
      { count: 1, startIndex: 0 },
      { count: 3, startIndex: 0 },
      { count: 3, startIndex: 1 },
      { count: 2, startIndex: 0 },
      { count: 2, startIndex: 2 },
    ]);
  });

  it("continues queryAll and stream across server-clamped short pages and rejects zero progress", async () => {
    const observed: Array<{ phase: "all" | "stream"; startIndex: number }> = [];
    let phase: "all" | "stream" = "all";
    const clampedClient = makeMockClient({
      routes: [
        [
          "/wfs",
          (url) => {
            const request = url.searchParams.get("request");
            if (request === "GetCapabilities") return xmlResponse(wfsCapabilitiesXml());
            if (request === "GetFeature") {
              const startIndex = Number(url.searchParams.get("startIndex") ?? "0");
              observed.push({ phase, startIndex });
              return jsonResponse({
                ...wfsGeoJsonResponse(PARCEL_FEATURES.slice(startIndex, startIndex + 1)),
                numberMatched: PARCEL_FEATURES.length,
                numberReturned: startIndex < PARCEL_FEATURES.length ? 1 : 0,
              });
            }
            return new Response("not found", { status: 404 });
          },
        ],
      ],
    });
    const source = createDataset({
      id: "wfs-clamped-pages",
      client: clampedClient,
      skipCompatibilityCheck: true,
      sources: [descriptor],
    }).source<ParcelAttrs>(descriptor.id);
    if (!source) throw new Error("expected WFS source");

    const all = await source.queryAll();
    expect(all.features.map((feature) => feature.attributes.OBJECTID)).toEqual([1, 2, 3]);
    expect(all.exceededTransferLimit).toBe(false);
    expect(all.totalCount).toBe(3);

    phase = "stream";
    const streamed: number[] = [];
    for await (const page of source.stream({ pagination: { limit: 2 } })) {
      streamed.push(...page.features.map((feature) => feature.attributes.OBJECTID));
    }
    expect(streamed).toEqual([1, 2, 3]);
    expect(observed).toEqual([
      { phase: "all", startIndex: 0 },
      { phase: "all", startIndex: 1 },
      { phase: "all", startIndex: 2 },
      { phase: "stream", startIndex: 0 },
      { phase: "stream", startIndex: 1 },
      { phase: "stream", startIndex: 2 },
    ]);

    const stalledClient = makeMockClient({
      routes: [
        [
          "/wfs",
          (url) =>
            url.searchParams.get("request") === "GetCapabilities"
              ? xmlResponse(wfsCapabilitiesXml())
              : jsonResponse({
                  type: "FeatureCollection",
                  features: [],
                  numberMatched: 3,
                  numberReturned: 0,
                }),
        ],
      ],
    });
    const stalledModule = wfsProtocolModule(stalledClient);
    const stalledHandle = stalledModule.discover(descriptor);
    if (stalledHandle instanceof Promise) throw new Error("WFS discovery must remain synchronous");
    const stalledIr = createQueryIr({ descriptor });
    const stalledCompiled = stalledModule.compile({
      source: stalledIr.source,
      query: stalledIr.query,
      operation: "queryAll",
    });
    await expect(
      stalledModule.execute(stalledHandle, {
        compiled: stalledCompiled,
        operation: "queryAll",
        query: {},
      }),
    ).rejects.toMatchObject({ reason: "paging-stalled" });

    const stalledSource = createDataset({
      id: "wfs-stalled-stream",
      client: stalledClient,
      skipCompatibilityCheck: true,
      sources: [descriptor],
    }).source<ParcelAttrs>(descriptor.id);
    if (!stalledSource) throw new Error("expected WFS source");
    await expect(
      stalledSource
        .stream({ pagination: { limit: 2 } })
        [Symbol.asyncIterator]()
        .next(),
    ).rejects.toMatchObject({ reason: "paging-stalled" });
  });

  it("rejects repeated pages with known or unknown numberMatched in queryAll and stream", async () => {
    for (const numberMatched of [8, "unknown"] as const) {
      const observedOffsets: number[] = [];
      const client = makeMockClient({
        routes: [
          [
            "/wfs",
            (url) => {
              if (url.searchParams.get("request") === "GetCapabilities") {
                return xmlResponse(wfsCapabilitiesXml());
              }
              const startIndex = Number(url.searchParams.get("startIndex") ?? "0");
              observedOffsets.push(startIndex);
              return jsonResponse({
                ...wfsGeoJsonResponse(PARCEL_FEATURES.slice(0, 2)),
                numberMatched,
              });
            },
          ],
        ],
      });
      const module = wfsProtocolModule(client);
      const handle = module.discover(descriptor);
      if (handle instanceof Promise) throw new Error("WFS discovery must remain synchronous");
      const ir = createQueryIr({ descriptor });
      const compiled = module.compile({ source: ir.source, query: ir.query, operation: "queryAll" });

      await expect(
        module.execute(handle, {
          compiled,
          operation: "queryAll",
          query: {},
        }),
      ).rejects.toMatchObject({ reason: "paging-stalled" });

      const source = createDataset({
        id: `wfs-repeated-${numberMatched}`,
        client,
        skipCompatibilityCheck: true,
        sources: [descriptor],
      }).source<ParcelAttrs>(descriptor.id);
      if (!source) throw new Error("expected WFS source");
      const iterator = source.stream({ pagination: { limit: 2 } })[Symbol.asyncIterator]();
      await expect(iterator.next()).resolves.toMatchObject({ done: false });
      await expect(iterator.next()).rejects.toMatchObject({ reason: "paging-stalled" });
      expect(observedOffsets).toEqual([0, 2, 0, 2]);
    }
  });

  it("requests only the remaining queryAll lookahead budget across clamped pages", async () => {
    const rows = Array.from({ length: 8 }, (_, index) => ({
      attributes: { OBJECTID: index + 1, STATE: "CA", ACRES: index + 1 },
      geometry: { x: -120 - index, y: 38 },
    }));
    const observedCounts: number[] = [];
    let deliveredRows = 0;
    const client = makeMockClient({
      routes: [
        [
          "/wfs",
          (url) => {
            if (url.searchParams.get("request") === "GetCapabilities") {
              return xmlResponse(wfsCapabilitiesXml());
            }
            const requested = Number(url.searchParams.get("count") ?? "2000");
            const startIndex = Number(url.searchParams.get("startIndex") ?? "0");
            const delivered = rows.slice(startIndex, startIndex + Math.min(requested, 4));
            observedCounts.push(requested);
            deliveredRows += delivered.length;
            return jsonResponse({
              ...wfsGeoJsonResponse(delivered),
              numberMatched: rows.length,
            });
          },
        ],
      ],
    });
    const module = wfsProtocolModule(client);
    const handle = module.discover(descriptor);
    if (handle instanceof Promise) throw new Error("WFS discovery must remain synchronous");
    const ir = createQueryIr({ descriptor, query: { pagination: { limit: 4 } } });
    const compiled = module.compile({ source: ir.source, query: ir.query, operation: "queryAll" });
    const direct = await module.execute<ParcelAttrs>(handle, {
      compiled,
      operation: "queryAll",
      query: { logicalLimit: 4 },
    });
    expect(direct.features).toHaveLength(4);
    expect(direct.exceededTransferLimit).toBe(true);
    expect(observedCounts).toEqual([5, 1]);
    expect(deliveredRows).toBe(5);

    observedCounts.length = 0;
    deliveredRows = 0;
    const source = createDataset({
      id: "wfs-lookahead-budget",
      client,
      skipCompatibilityCheck: true,
      sources: [descriptor],
    }).source<ParcelAttrs>(descriptor.id);
    if (!source) throw new Error("expected WFS source");
    const builtIn = await source.queryAll({ pagination: { limit: 4 } });
    expect(builtIn.features).toHaveLength(4);
    expect(builtIn.exceededTransferLimit).toBe(true);
    expect(observedCounts).toEqual([5, 1]);
    expect(deliveredRows).toBe(5);
  });

  it("rejects pages that exceed the requested count or safe paging range", async () => {
    const client = makeMockClient({
      routes: [
        [
          "/wfs",
          (url) => {
            const request = url.searchParams.get("request");
            if (request === "GetCapabilities") return xmlResponse(wfsCapabilitiesXml());
            if (request === "GetFeature") {
              if (url.searchParams.get("startIndex") === String(Number.MAX_SAFE_INTEGER)) {
                return jsonResponse({
                  ...wfsGeoJsonResponse(PARCEL_FEATURES.slice(0, 1)),
                  numberMatched: "unknown",
                });
              }
              return jsonResponse(wfsGeoJsonResponse(PARCEL_FEATURES.slice(0, 2)));
            }
            return new Response("not found", { status: 404 });
          },
        ],
      ],
    });
    const module = wfsProtocolModule(client);
    const discovered = module.discover(descriptor);
    if (discovered instanceof Promise) throw new Error("WFS discovery must remain synchronous");

    const overCountIr = createQueryIr({ descriptor, query: { pagination: { limit: 1 } } });
    const overCount = module.compile({
      source: overCountIr.source,
      query: overCountIr.query,
      operation: "query",
    });
    await expect(
      module.execute(discovered, {
        compiled: overCount,
        operation: "query",
        query: {},
      }),
    ).rejects.toMatchObject({
      reason: "invalid-feature-response",
      message: expect.stringMatching(/requested count/),
    });

    const unsafeOffsetIr = createQueryIr({
      descriptor,
      query: { pagination: { offset: Number.MAX_SAFE_INTEGER, limit: 1 } },
    });
    const unsafeOffset = module.compile({
      source: unsafeOffsetIr.source,
      query: unsafeOffsetIr.query,
      operation: "query",
    });
    await expect(
      module.execute(discovered, {
        compiled: unsafeOffset,
        operation: "query",
        query: {},
      }),
    ).rejects.toMatchObject({
      reason: "invalid-feature-response",
      message: expect.stringMatching(/safe-integer range/),
    });
  });

  it("rejects colliding operation swaps and queryAll context tampering before I/O", async () => {
    let requests = 0;
    const client = makeMockClient({
      routes: [
        [
          "/wfs",
          () => {
            requests += 1;
            return new Response("unexpected", { status: 500 });
          },
        ],
      ],
    });
    const module = wfsProtocolModule(client);
    const discovered = module.discover(descriptor);
    if (discovered instanceof Promise) throw new Error("WFS discovery must remain synchronous");
    const queryPlan = explainQuery({ descriptor, query: { pagination: { limit: 2 } } });
    const queryAllIr = createQueryIr({ descriptor, query: { pagination: { limit: 1 } } });
    const queryStep = queryPlan.steps[0];
    if (!queryStep || queryStep.engine !== "remote") throw new Error("expected one remote WFS step");
    if (queryStep.compiled.compiler !== "wfs-2.0-protocol-query-v1") {
      throw new Error("expected executable WFS artifact");
    }
    const queryAllArtifact = module.compile({
      source: queryAllIr.source,
      query: queryAllIr.query,
      operation: "queryAll",
    });
    expect(queryStep.compiled.count).toBe(2);
    expect(queryAllArtifact.count).toBe(2);

    await expect(
      module.execute(discovered, {
        compiled: queryStep.compiled,
        operation: "queryAll",
        query: { logicalLimit: 1 },
      }),
    ).rejects.toThrow(/compiled operation does not match/);
    await expect(
      module.execute(discovered, {
        compiled: queryAllArtifact,
        operation: "query",
        query: {},
      }),
    ).rejects.toThrow(/compiled operation does not match/);
    await expect(
      module.execute(discovered, {
        compiled: queryAllArtifact,
        operation: "queryAll",
        query: { logicalLimit: 2 },
      }),
    ).rejects.toThrow(/compiled count does not match/);
    await expect(
      module.execute(discovered, {
        compiled: { ...queryStep.compiled, method: "POST" },
        operation: "query",
        query: {},
      }),
    ).rejects.toThrow(/method does not match the filter budget/);
    await expect(
      module.execute(discovered, {
        compiled: {
          ...queryStep.compiled,
          headers: { Authorization: "Bearer must-not-reach-the-wire" },
        } as typeof queryStep.compiled,
        operation: "query",
        query: {},
      }),
    ).rejects.toThrow(/contains unsupported fields/);
    expect(requests).toBe(0);
  });

  it("rejects credential-bearing compilation and cross-client/cross-handle authority substitution before I/O", async () => {
    let requestsA = 0;
    let requestsB = 0;
    const clientA = makeMockClient({
      routes: [
        [
          "/wfs",
          () => {
            requestsA += 1;
            return new Response("unexpected", { status: 500 });
          },
        ],
      ],
    });
    const clientB = makeMockClient({
      routes: [
        [
          "/wfs",
          () => {
            requestsB += 1;
            return new Response("unexpected", { status: 500 });
          },
        ],
      ],
    });
    const moduleA = wfsProtocolModule(clientA);
    const moduleB = wfsProtocolModule(clientB);
    expect(() =>
      moduleA.discover({
        ...descriptor,
        protocol: "odata",
      } as SourceDescriptor),
    ).toThrow(/cannot discover protocol "odata"/);
    const handleA = moduleA.discover(descriptor);
    const handleB = moduleB.discover(descriptor);
    if (handleA instanceof Promise || handleB instanceof Promise) {
      throw new Error("WFS discovery must remain synchronous");
    }
    const ir = createQueryIr({ descriptor, query: { pagination: { limit: 1 } } });
    const compiled = moduleA.compile({ source: ir.source, query: ir.query, operation: "query" });

    expect(() =>
      moduleA.compile({
        source: { ...ir.source, endpoint: "https://user:secret@mock.honua.test/wfs" },
        query: ir.query,
        operation: "query",
      }),
    ).toThrow(/must not contain credentials/);
    await expect(
      moduleA.execute(handleB, {
        compiled,
        operation: "query",
        query: {},
      }),
    ).rejects.toThrow(/not discovered by this module instance/);

    const otherDescriptor = {
      ...descriptor,
      id: "other-wfs",
      locator: { ...descriptor.locator, url: "https://mock.honua.test/other-wfs" },
    } satisfies SourceDescriptor;
    const otherHandle = moduleA.discover(otherDescriptor);
    if (otherHandle instanceof Promise) throw new Error("WFS discovery must remain synchronous");
    await expect(
      moduleA.execute(otherHandle, {
        compiled,
        operation: "query",
        query: {},
      }),
    ).rejects.toThrow(/does not match the discovered protocol handle/);

    const queryBoundA = {
      ...descriptor,
      locator: { ...descriptor.locator, url: "https://mock.honua.test/wfs?token=alpha-secret" },
    } satisfies SourceDescriptor;
    const queryBoundB = {
      ...descriptor,
      locator: { ...descriptor.locator, url: "https://mock.honua.test/wfs?token=beta-secret" },
    } satisfies SourceDescriptor;
    const queryHandleA = moduleA.discover(queryBoundA);
    const queryHandleB = moduleA.discover(queryBoundB);
    if (queryHandleA instanceof Promise || queryHandleB instanceof Promise) {
      throw new Error("WFS discovery must remain synchronous");
    }
    const queryBoundIr = createQueryIr({ descriptor: queryBoundA });
    const queryBoundCompiled = moduleA.compile({
      source: queryBoundIr.source,
      query: queryBoundIr.query,
      operation: "query",
    });
    expect(JSON.stringify(queryBoundCompiled)).not.toContain("alpha-secret");
    expect(JSON.stringify(queryBoundCompiled)).not.toContain("beta-secret");
    await expect(
      moduleA.execute(queryHandleB, {
        compiled: queryBoundCompiled,
        operation: "query",
        query: {},
      }),
    ).rejects.toThrow(/compiled authority does not match/);

    const scopedHandleA = moduleA.discover(descriptor, { authorizationScope: ["parcels:read"] });
    const scopedHandleB = moduleA.discover(descriptor, { authorizationScope: ["parcels:restricted"] });
    if (scopedHandleA instanceof Promise || scopedHandleB instanceof Promise) {
      throw new Error("WFS discovery must remain synchronous");
    }
    const scopedIr = createQueryIr({
      descriptor,
      authorizationScope: ["parcels:read"],
    });
    const scopedCompiled = moduleA.compile({
      source: scopedIr.source,
      query: scopedIr.query,
      operation: "query",
    });
    await expect(
      moduleA.execute(scopedHandleB, {
        compiled: scopedCompiled,
        operation: "query",
        query: {},
      }),
    ).rejects.toThrow(/compiled authority does not match/);
    expect(requestsA).toBe(0);
    expect(requestsB).toBe(0);
  });

  it("uses one lookahead row for a zero queryAll ceiling", async () => {
    let observedCount: string | null = null;
    const client = makeMockClient({
      routes: [
        [
          "/wfs",
          (url) => {
            const request = url.searchParams.get("request");
            if (request === "GetCapabilities") return xmlResponse(wfsCapabilitiesXml());
            if (request === "GetFeature") {
              observedCount = url.searchParams.get("count");
              return jsonResponse(wfsGeoJsonResponse(PARCEL_FEATURES.slice(0, 1)));
            }
            return new Response("not found", { status: 404 });
          },
        ],
      ],
    });
    const module = wfsProtocolModule(client);
    const discovered = module.discover(descriptor);
    if (discovered instanceof Promise) throw new Error("WFS discovery must remain synchronous");
    const ir = createQueryIr({ descriptor, query: { pagination: { limit: 0 } } });
    const compiled = module.compile({ source: ir.source, query: ir.query, operation: "queryAll" });
    const result = await module.execute(discovered, {
      compiled,
      operation: "queryAll",
      query: { logicalLimit: 0 },
    });

    expect(compiled.count).toBe(1);
    expect(observedCount).toBe("1");
    expect(result.features).toHaveLength(0);
    expect(result.exceededTransferLimit).toBe(true);
  });

  it("propagates cancellation and fails closed on GML-only capability evidence", async () => {
    const cancelClient = makeMockClient({
      routes: [
        [
          "/wfs",
          (_url, init) =>
            new Promise<Response>((_resolve, reject) => {
              const abort = () => reject(new DOMException("aborted", "AbortError"));
              if (init?.signal?.aborted) abort();
              else init?.signal?.addEventListener("abort", abort, { once: true });
            }),
        ],
      ],
    });
    const cancelModule = wfsProtocolModule(cancelClient);
    const cancelHandle = cancelModule.discover(descriptor);
    if (cancelHandle instanceof Promise) throw new Error("WFS discovery must remain synchronous");
    const ir = createQueryIr({ descriptor, query: { pagination: { limit: 1 } } });
    const compiled = cancelModule.compile({ source: ir.source, query: ir.query, operation: "query" });
    const controller = new AbortController();
    const pending = cancelModule.execute(cancelHandle, {
      compiled,
      operation: "query",
      query: {},
      signal: controller.signal,
    });
    controller.abort();
    await expect(pending).rejects.toBeInstanceOf(HonuaAbortError);

    let getFeatureRequests = 0;
    const gmlOnly = wfsCapabilitiesXml().replace("<ows:Value>application/geo+json</ows:Value>", "");
    const gmlClient = makeMockClient({
      routes: [
        [
          "/wfs",
          (url) => {
            if (url.searchParams.get("request") === "GetCapabilities") return xmlResponse(gmlOnly);
            getFeatureRequests += 1;
            return new Response("unexpected", { status: 500 });
          },
        ],
      ],
    });
    const gmlModule = wfsProtocolModule(gmlClient);
    const gmlHandle = gmlModule.discover(descriptor);
    if (gmlHandle instanceof Promise) throw new Error("WFS discovery must remain synchronous");
    await expect(
      gmlModule.execute(gmlHandle, {
        compiled,
        operation: "query",
        query: {},
      }),
    ).rejects.toBeInstanceOf(HonuaCapabilityNotSupportedError);
    expect(getFeatureRequests).toBe(0);
  });

  it("tracks evidence by root snapshot without invalidating sibling handles on disposal", async () => {
    let capabilityRequests = 0;
    let featureRequests = 0;
    const gmlOnlyCapabilities = wfsCapabilitiesXml().replace("<ows:Value>application/geo+json</ows:Value>", "");
    const client = makeMockClient({
      routes: [
        [
          "/wfs",
          (url) => {
            if (url.searchParams.get("request") === "GetCapabilities") {
              capabilityRequests += 1;
              return xmlResponse(capabilityRequests === 1 ? wfsCapabilitiesXml() : gmlOnlyCapabilities);
            }
            featureRequests += 1;
            return jsonResponse(wfsGeoJsonResponse(PARCEL_FEATURES.slice(0, 1)));
          },
        ],
      ],
    });
    const module = wfsProtocolModule(client);
    const first = module.discover(descriptor);
    const second = module.discover(descriptor);
    if (first instanceof Promise || second instanceof Promise) {
      throw new Error("WFS discovery must remain synchronous");
    }
    const ir = createQueryIr({ descriptor, query: { pagination: { limit: 1 } } });
    const compiled = module.compile({ source: ir.source, query: ir.query, operation: "query" });

    await module.execute(first, { compiled, operation: "query", query: {} });
    await module.execute(second, { compiled, operation: "query", query: {} });
    expect(capabilityRequests).toBe(1);
    expect(featureRequests).toBe(2);

    await first.dispose();
    await second.adapter.root.capabilities();
    expect(capabilityRequests).toBe(1);

    second.adapter.root.refresh();
    await expect(module.execute(second, { compiled, operation: "query", query: {} })).rejects.toBeInstanceOf(
      HonuaCapabilityNotSupportedError,
    );
    expect(capabilityRequests).toBe(2);
    expect(featureRequests).toBe(2);
  });

  it("wraps malformed GetCapabilities parsing in the sanitized WFS protocol taxonomy", async () => {
    const client = makeMockClient({
      routes: [["/wfs", () => xmlResponse("<wfs:WFS_Capabilities>")]],
    });
    const module = wfsProtocolModule(client);
    const handle = module.discover(descriptor);
    if (handle instanceof Promise) throw new Error("WFS discovery must remain synchronous");
    const ir = createQueryIr({ descriptor, query: { pagination: { limit: 1 } } });
    const compiled = module.compile({ source: ir.source, query: ir.query, operation: "query" });

    let failure: unknown;
    try {
      await module.execute(handle, { compiled, operation: "query", query: {} });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(HonuaWfsProtocolError);
    if (!(failure instanceof HonuaWfsProtocolError)) throw new Error("expected typed WFS protocol error");
    expect(failure).toMatchObject({
      reason: "invalid-capabilities",
      sdkCode: "query.execution.wfs-protocol",
      cause: expect.any(Error),
    });
    const envelope = serializeHonuaError(failure);
    expect(envelope.context).toEqual({ reason: "invalid-capabilities" });
    expect(envelope.cause).toEqual({ name: expect.any(String) });
    expect(JSON.stringify(envelope)).not.toContain("WFS_Capabilities");
  });

  it("validates every GeoJSON geometry shape with finite coordinates and bounded recursion", () => {
    const validGeometries: unknown[] = [
      { type: "Point", coordinates: [1, 2] },
      {
        type: "MultiPoint",
        coordinates: [
          [1, 2],
          [3, 4, 5],
        ],
      },
      {
        type: "LineString",
        coordinates: [
          [1, 2],
          [3, 4],
        ],
      },
      {
        type: "MultiLineString",
        coordinates: [
          [
            [1, 2],
            [3, 4],
          ],
        ],
      },
      {
        type: "Polygon",
        coordinates: [
          [
            [0, 0],
            [1, 0],
            [1, 1],
            [0, 0],
          ],
        ],
      },
      {
        type: "MultiPolygon",
        coordinates: [
          [
            [
              [0, 0],
              [1, 0],
              [1, 1],
              [0, 0],
            ],
          ],
        ],
      },
      {
        type: "GeometryCollection",
        geometries: [
          { type: "Point", coordinates: [] },
          { type: "LineString", coordinates: [] },
        ],
      },
    ];
    const collection = (geometry: unknown) => ({
      type: "FeatureCollection",
      features: [{ type: "Feature", properties: {}, geometry }],
    });
    for (const geometry of validGeometries) {
      expect(wfsProtocolResultFromGeoJson(collection(geometry)).features).toHaveLength(1);
    }

    let tooDeep: unknown = { type: "Point", coordinates: [1, 2] };
    for (let depth = 0; depth < 33; depth += 1) {
      tooDeep = { type: "GeometryCollection", geometries: [tooDeep] };
    }
    const invalidGeometries: unknown[] = [
      { type: "Point", coordinates: ["1", 2] },
      { type: "Point", coordinates: [Number.NaN, 2] },
      { type: "LineString", coordinates: [[1, 2]] },
      { type: "MultiLineString", coordinates: [[1, 2]] },
      {
        type: "Polygon",
        coordinates: [
          [
            [0, 0],
            [1, 0],
            [1, 1],
            [2, 2],
          ],
        ],
      },
      { type: "MultiPolygon", coordinates: [[[1, 2]]] },
      { type: "GeometryCollection", geometries: "not-an-array" },
      tooDeep,
    ];
    for (const geometry of invalidGeometries) {
      expect(() => wfsProtocolResultFromGeoJson(collection(geometry))).toThrow(HonuaWfsProtocolError);
    }
  });

  it("coalesces concurrent capability loads while isolating caller cancellation", async () => {
    let capabilityRequests = 0;
    let featureRequests = 0;
    const client = makeMockClient({
      routes: [
        [
          "/wfs",
          (url, init) => {
            if (url.searchParams.get("request") === "GetCapabilities") {
              capabilityRequests += 1;
              return new Promise<Response>((resolve, reject) => {
                const timer = setTimeout(() => resolve(xmlResponse(wfsCapabilitiesXml())), 20);
                const abort = () => {
                  clearTimeout(timer);
                  reject(new DOMException("aborted", "AbortError"));
                };
                if (init?.signal?.aborted) abort();
                else init?.signal?.addEventListener("abort", abort, { once: true });
              });
            }
            featureRequests += 1;
            return jsonResponse(wfsGeoJsonResponse(PARCEL_FEATURES.slice(0, 1)));
          },
        ],
      ],
    });
    const module = wfsProtocolModule(client);
    const handle = module.discover(descriptor);
    if (handle instanceof Promise) throw new Error("WFS discovery must remain synchronous");
    const ir = createQueryIr({ descriptor, query: { pagination: { limit: 1 } } });
    const compiled = module.compile({ source: ir.source, query: ir.query, operation: "query" });
    const controller = new AbortController();
    const cancelled = module.execute(handle, {
      compiled,
      operation: "query",
      query: {},
      signal: controller.signal,
    });
    const survivor = module.execute(handle, {
      compiled,
      operation: "query",
      query: {},
    });
    controller.abort();

    await expect(cancelled).rejects.toBeInstanceOf(HonuaAbortError);
    await expect(survivor).resolves.toMatchObject({ features: [{ attributes: { OBJECTID: 1 } }] });
    expect(capabilityRequests).toBe(1);
    expect(featureRequests).toBe(1);

    await module.execute(handle, { compiled, operation: "query", query: {} });
    expect(capabilityRequests).toBe(1);
    expect(featureRequests).toBe(2);
  });

  it("cancels a disposed handle's capability subscriber without poisoning a sibling", async () => {
    let capabilityRequests = 0;
    let featureRequests = 0;
    const client = makeMockClient({
      routes: [
        [
          "/wfs",
          (url, init) => {
            if (url.searchParams.get("request") === "GetCapabilities") {
              capabilityRequests += 1;
              return new Promise<Response>((resolve, reject) => {
                const timer = setTimeout(() => resolve(xmlResponse(wfsCapabilitiesXml())), 20);
                const abort = () => {
                  clearTimeout(timer);
                  reject(new DOMException("aborted", "AbortError"));
                };
                if (init?.signal?.aborted) abort();
                else init?.signal?.addEventListener("abort", abort, { once: true });
              });
            }
            featureRequests += 1;
            return jsonResponse(wfsGeoJsonResponse(PARCEL_FEATURES.slice(0, 1)));
          },
        ],
      ],
    });
    const module = wfsProtocolModule(client);
    const disposed = module.discover(descriptor);
    const survivor = module.discover(descriptor);
    if (disposed instanceof Promise || survivor instanceof Promise) {
      throw new Error("WFS discovery must remain synchronous");
    }
    const ir = createQueryIr({ descriptor, query: { pagination: { limit: 1 } } });
    const compiled = module.compile({ source: ir.source, query: ir.query, operation: "query" });

    const disposedExecution = module.execute(disposed, { compiled, operation: "query", query: {} });
    const survivingExecution = module.execute(survivor, { compiled, operation: "query", query: {} });
    const disposedRejected = expect(disposedExecution).rejects.toBeInstanceOf(HonuaAbortError);
    await disposed.dispose();

    await disposedRejected;
    await expect(survivingExecution).resolves.toMatchObject({ features: [{ attributes: { OBJECTID: 1 } }] });
    expect(capabilityRequests).toBe(1);
    expect(featureRequests).toBe(1);
  });

  it("rejects malformed or oversized GeoJSON responses with typed bounded errors", async () => {
    let malformedFeatureResponses = 0;
    const malformedClient = makeMockClient({
      routes: [
        [
          "/wfs",
          (url) => {
            if (url.searchParams.get("request") === "GetCapabilities") {
              return xmlResponse(wfsCapabilitiesXml());
            }
            malformedFeatureResponses += 1;
            if (malformedFeatureResponses === 1) {
              return jsonResponse({ type: "FeatureCollection", features: "not-an-array" });
            }
            if (malformedFeatureResponses === 2) {
              return new Response("{malformed", {
                headers: { "Content-Type": "application/geo+json" },
              });
            }
            return jsonResponse({
              ...wfsGeoJsonResponse(PARCEL_FEATURES.slice(0, 1)),
              numberMatched: 0,
            });
          },
        ],
      ],
    });
    const malformedModule = wfsProtocolModule(malformedClient);
    const malformedHandle = malformedModule.discover(descriptor);
    if (malformedHandle instanceof Promise) throw new Error("WFS discovery must remain synchronous");
    const ir = createQueryIr({ descriptor });
    const malformedCompiled = malformedModule.compile({
      source: ir.source,
      query: ir.query,
      operation: "query",
    });
    await expect(
      malformedModule.execute(malformedHandle, {
        compiled: malformedCompiled,
        operation: "query",
        query: {},
      }),
    ).rejects.toMatchObject({
      name: "HonuaWfsProtocolError",
      reason: "invalid-feature-response",
    });
    await expect(
      malformedModule.execute(malformedHandle, {
        compiled: malformedCompiled,
        operation: "query",
        query: {},
      }),
    ).rejects.toMatchObject({
      name: "HonuaWfsProtocolError",
      reason: "invalid-feature-response",
    });
    await expect(
      malformedModule.execute(malformedHandle, {
        compiled: malformedCompiled,
        operation: "query",
        query: {},
      }),
    ).rejects.toMatchObject({
      name: "HonuaWfsProtocolError",
      reason: "invalid-feature-response",
    });

    const oversizedClient = makeMockClient({
      routes: [
        [
          "/wfs",
          (url) =>
            url.searchParams.get("request") === "GetCapabilities"
              ? xmlResponse(wfsCapabilitiesXml())
              : new Response("{}", {
                  headers: {
                    "Content-Type": "application/geo+json",
                    "Content-Length": String(32 * 1024 * 1024 + 1),
                  },
                }),
        ],
      ],
    });
    const oversizedModule = wfsProtocolModule(oversizedClient);
    const oversizedHandle = oversizedModule.discover(descriptor);
    if (oversizedHandle instanceof Promise) throw new Error("WFS discovery must remain synchronous");
    const oversizedCompiled = oversizedModule.compile({
      source: ir.source,
      query: ir.query,
      operation: "query",
    });
    await expect(
      oversizedModule.execute(oversizedHandle, {
        compiled: oversizedCompiled,
        operation: "query",
        query: {},
      }),
    ).rejects.toBeInstanceOf(HonuaNetworkError);

    let boundedFeatureRequests = 0;
    const oversizedCapabilitiesClient = makeMockClient({
      routes: [
        [
          "/wfs",
          (url) => {
            if (url.searchParams.get("request") === "GetCapabilities") {
              return new Response("<wfs:WFS_Capabilities/>", {
                headers: {
                  "Content-Type": "application/xml",
                  "Content-Length": String(2 * 1024 * 1024 + 1),
                },
              });
            }
            boundedFeatureRequests += 1;
            return new Response("unexpected", { status: 500 });
          },
        ],
      ],
    });
    const oversizedCapabilitiesModule = wfsProtocolModule(oversizedCapabilitiesClient);
    const oversizedCapabilitiesHandle = oversizedCapabilitiesModule.discover(descriptor);
    if (oversizedCapabilitiesHandle instanceof Promise) {
      throw new Error("WFS discovery must remain synchronous");
    }
    const oversizedCapabilitiesCompiled = oversizedCapabilitiesModule.compile({
      source: ir.source,
      query: ir.query,
      operation: "query",
    });
    await expect(
      oversizedCapabilitiesModule.execute(oversizedCapabilitiesHandle, {
        compiled: oversizedCapabilitiesCompiled,
        operation: "query",
        query: {},
      }),
    ).rejects.toBeInstanceOf(HonuaNetworkError);
    expect(boundedFeatureRequests).toBe(0);
  });

  it("certifies through the public plugin registry and disposes handles repeatedly", async () => {
    let featureRequests = 0;
    let registryDisposals = 0;
    const client = makeMockClient({
      routes: [
        [
          "/wfs",
          (url) => {
            const request = url.searchParams.get("request");
            if (request === "GetCapabilities") return xmlResponse(wfsCapabilitiesXml());
            if (request === "GetFeature") {
              featureRequests += 1;
              return jsonResponse(wfsGeoJsonResponse(PARCEL_FEATURES.slice(0, 1)));
            }
            return new Response("not found", { status: 404 });
          },
        ],
      ],
    });
    const manifest: HonuaPluginManifest<"protocol"> = {
      manifestVersion: HONUA_PLUGIN_MANIFEST_VERSION,
      id: "io.honua.protocols.wfs-test",
      version: "1.0.0",
      kind: "protocol",
      package: { name: "@example/wfs-protocol", entrypoint: "./index.js" },
      compatibility: {
        pluginApi: HONUA_PLUGIN_API_VERSION,
        minimumSdk: "0.1.0-beta.0",
        environments: ["browser", "node", "worker"],
      },
      capabilities: ["query", "stream"],
      requestedGrants: {},
      data: {
        cache: "memory",
        freshness: "snapshot",
        authentication: "none",
        provenance: "preserved",
        mutation: "none",
        realtime: "none",
      },
      lifecycle: { initialization: "explicit", disposal: "required" },
      support: "honua",
    };
    interface WfsExtension extends HonuaPluginExtension<"protocol"> {
      readonly module: WfsProtocolModule;
    }
    const factory: HonuaPluginFactory<"protocol", WfsExtension> = {
      manifest: JSON.stringify(manifest),
      initialize(context) {
        return {
          extension: {
            id: context.manifest.id,
            kind: "protocol",
            module: wfsProtocolModule(client),
          },
          dispose() {
            registryDisposals += 1;
          },
        };
      },
    };
    expect(certifyHonuaPluginManifest(factory.manifest, REGISTRY_HOST).status).toBe("certified");

    const registry = new HonuaPluginRegistry({ host: REGISTRY_HOST });
    await registry.register([factory]);
    const extension = registry.get<"protocol", WfsExtension>("protocol", manifest.id);
    if (!extension) throw new Error("WFS protocol extension was not registered");
    const discovered = extension.module.discover(descriptor);
    if (discovered instanceof Promise) throw new Error("WFS discovery must remain synchronous");
    const ir = createQueryIr({ descriptor, query: { pagination: { limit: 1 } } });
    const compiled = extension.module.compile({
      source: ir.source,
      query: ir.query,
      operation: "query",
    });
    const result = await extension.module.execute<ParcelAttrs>(discovered, {
      compiled,
      operation: "query",
      query: {},
    });
    expect(result.features[0]?.attributes.OBJECTID).toBe(1);
    expect(featureRequests).toBe(1);

    await discovered.dispose();
    await discovered.dispose();
    await expect(
      extension.module.execute(discovered, {
        compiled,
        operation: "query",
        query: {},
      }),
    ).rejects.toThrow(/handle has been disposed/);
    expect(featureRequests).toBe(1);
    await registry.dispose();
    expect(registryDisposals).toBe(1);
  });
});
