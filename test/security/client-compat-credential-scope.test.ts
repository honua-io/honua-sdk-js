import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DirectionsViewModelCompat,
  PortalCompat,
  RouteLayerCompat,
  clientConfig,
  resetClientConfig,
} from "../../src/client-compat-entry.js";
import { isCredentialTargetTrusted } from "../../src/client-compat/client-config.js";
import { arcGisRouteServiceProvider, globalApiKeyForRouteService } from "../../src/client-compat/route-task.js";
import { encodeServiceIdPath, numericPathSegment } from "../../src/core/path-utils.js";

interface RecordedRequest {
  url: string;
  headers: Headers;
  init?: RequestInit;
}

function recordingFetch(body: unknown = { layers: [{ id: 0 }], features: [] }): {
  fetchFn: typeof fetch;
  requests: RecordedRequest[];
} {
  const requests: RecordedRequest[] = [];
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : undefined;
    const headers = new Headers(request?.headers ?? init?.headers);
    requests.push({ url: String(request?.url ?? input), headers, init });
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { fetchFn, requests };
}

function featureItem(url: string): never {
  return { id: "item-1", type: "Feature Service", title: "Roads", url } as never;
}

function carriesCredential(request: RecordedRequest | undefined, secret: string): boolean {
  if (!request) {
    return false;
  }
  const headerValues = [...request.headers.values()].join(" ");
  return request.url.includes(secret) || headerValues.includes(secret);
}

async function openAndQuery(portalUrl: string, itemUrl: string): Promise<RecordedRequest | undefined> {
  const { fetchFn, requests } = recordingFetch();
  const portal = new PortalCompat({ portalUrl, token: "portal-tok", apiKey: "portal-key", fetchFn });
  const opened = await portal.openFeatureLayer(featureItem(itemUrl));
  if (opened.type !== "feature-service") {
    throw new Error("expected a feature-service result");
  }
  await opened.layer.queryFeatures({ where: "1=1", outFields: ["*"], returnGeometry: false });
  return requests.find((request) => request.url.includes("/FeatureServer/0/query"));
}

afterEach(() => {
  resetClientConfig();
  vi.unstubAllGlobals();
});

describe("portal item credentials", () => {
  it("attaches the portal token and API key to a service on the portal origin", async () => {
    const query = await openAndQuery(
      "https://portal.example",
      "https://portal.example/rest/services/roads/FeatureServer",
    );

    expect(carriesCredential(query, "portal-tok")).toBe(true);
    expect(carriesCredential(query, "portal-key")).toBe(true);
  });

  it("sends no credential to an item URL on another origin", async () => {
    const query = await openAndQuery(
      "https://portal.example",
      "https://other.example/rest/services/roads/FeatureServer",
    );

    expect(query).toBeDefined();
    expect(carriesCredential(query, "portal-tok")).toBe(false);
    expect(carriesCredential(query, "portal-key")).toBe(false);
  });

  it("attaches credentials to another origin listed in trustedServers", async () => {
    clientConfig.request.trustedServers.push("https://gis.example");

    const query = await openAndQuery("https://portal.example", "https://gis.example/rest/services/roads/FeatureServer");

    expect(carriesCredential(query, "portal-tok")).toBe(true);
  });
});

describe("portal item credentials for hosted and non-feature items", () => {
  it("lets an ArcGIS Online portal authenticate its hosted services", async () => {
    const query = await openAndQuery(
      "https://org.maps.arcgis.com",
      "https://services1.arcgis.com/abc/arcgis/rest/services/roads/FeatureServer",
    );

    expect(carriesCredential(query, "portal-tok")).toBe(true);
  });

  it("returns an unauthenticated client for a Map Service item on another origin", async () => {
    const { fetchFn, requests } = recordingFetch({ layers: [] });
    const portal = new PortalCompat({ portalUrl: "https://portal.example", token: "portal-tok", fetchFn });
    const item = {
      id: "map-1",
      type: "Map Service",
      title: "Base",
      url: "https://other.example/rest/services/base/MapServer",
    };

    const opened = await portal.openFeatureLayer(item as never);
    await opened.client.getMapServiceMetadata(opened.serviceId);

    expect(requests).toHaveLength(1);
    expect(carriesCredential(requests[0], "portal-tok")).toBe(false);
  });
});

describe("isCredentialTargetTrusted", () => {
  it("matches the own origin, origin entries and bare host entries only", () => {
    clientConfig.request.trustedServers.push("https://gis.example", "maps.example:8443");

    expect(isCredentialTargetTrusted("https://portal.example/x", "https://portal.example/sharing/rest")).toBe(true);
    expect(isCredentialTargetTrusted("https://gis.example/rest", undefined)).toBe(true);
    expect(isCredentialTargetTrusted("http://gis.example/rest", undefined)).toBe(false);
    expect(isCredentialTargetTrusted("https://maps.example:8443/rest", undefined)).toBe(true);
    expect(isCredentialTargetTrusted("http://maps.example:8443/rest", undefined)).toBe(false);
    expect(isCredentialTargetTrusted("https://maps.example/rest", undefined)).toBe(false);
    expect(isCredentialTargetTrusted("https://gis.example.evil/rest", undefined)).toBe(false);
    expect(isCredentialTargetTrusted("not a url", "https://portal.example")).toBe(false);
  });
});

const ROUTE_STOPS = [
  { location: [-157.85, 21.3] as [number, number] },
  { location: [-157.9, 21.3] as [number, number] },
];

describe("route service API key", () => {
  it("keeps the global API key away from an untrusted route host", () => {
    clientConfig.apiKey = "global-key";

    expect(globalApiKeyForRouteService("https://route.arcgis.com/arcgis/rest/services/World/Route")).toBe("global-key");
    expect(globalApiKeyForRouteService("https://routes.attacker.example/rest/services/Route")).toBeUndefined();
    expect(globalApiKeyForRouteService("http://route.arcgis.com/arcgis/rest/services/World/Route")).toBeUndefined();
  });

  it("gives the global API key to the portal origin and trusted servers", () => {
    clientConfig.apiKey = "global-key";
    clientConfig.portalUrl = "https://portal.example";
    clientConfig.request.trustedServers.push("routes.example");

    expect(globalApiKeyForRouteService("https://portal.example/rest/services/Route/NAServer")).toBe("global-key");
    expect(globalApiKeyForRouteService("https://routes.example/rest/services/Route/NAServer")).toBe("global-key");
  });
});

describe("route requests carrying a credential", () => {
  it("solves against an untrusted host without the key and refuses redirects when a key is sent", async () => {
    clientConfig.apiKey = "global-key";
    const { fetchFn, requests } = recordingFetch({ routes: { features: [] } });
    vi.stubGlobal("fetch", fetchFn);

    const layer = new RouteLayerCompat();
    await arcGisRouteServiceProvider("https://routes.attacker.example/NAServer/Route", undefined)(ROUTE_STOPS, layer);
    await arcGisRouteServiceProvider("https://route.arcgis.com/NAServer/Route", undefined)(ROUTE_STOPS, layer);

    expect(requests[0]?.url).not.toContain("global-key");
    expect(requests[1]?.url).toContain("token=global-key");
    expect(requests[1]?.init?.redirect).toBe("error");
  });

  it("does not send the global key when the Directions view model loads travel modes from an untrusted host", async () => {
    clientConfig.apiKey = "global-key";
    const { fetchFn, requests } = recordingFetch({ supportedTravelModes: [] });
    vi.stubGlobal("fetch", fetchFn);

    await new DirectionsViewModelCompat({ routeServiceUrl: "https://routes.attacker.example/NAServer/Route" }).load();

    const modes = requests.find((request) => request.url.includes("/retrieveTravelModes"));
    expect(modes).toBeDefined();
    expect(modes?.url).not.toContain("global-key");
  });

  it("refuses redirects when the Directions view model sends a key for travel modes", async () => {
    clientConfig.apiKey = "global-key";
    const { fetchFn, requests } = recordingFetch({ supportedTravelModes: [] });
    vi.stubGlobal("fetch", fetchFn);

    await new DirectionsViewModelCompat({ routeServiceUrl: "https://route.arcgis.com/NAServer/Route" }).load();

    const modes = requests.find((request) => request.url.includes("/retrieveTravelModes"));
    expect(modes?.url).toContain("token=global-key");
    expect(modes?.init?.redirect).toBe("error");
  });
});

describe("service and layer path segments", () => {
  it("refuses dot segments in service ids", () => {
    for (const serviceId of ["..", ".", "Folder/../admin", "./roads", "Folder/."]) {
      expect(() => encodeServiceIdPath(serviceId)).toThrow(TypeError);
    }
    expect(encodeServiceIdPath("Folder/..roads")).toBe("Folder/..roads");
  });

  it("accepts only non-negative integer layer and object ids", () => {
    expect(numericPathSegment(3, "layerId")).toBe("3");
    expect(numericPathSegment("42", "objectId")).toBe("42");
    for (const value of [-1, 1.5, Number.NaN, "1/../2", "..", "", "0x1", "9999999999999999", undefined]) {
      expect(() => numericPathSegment(value, "layerId")).toThrow(TypeError);
    }
  });
});
