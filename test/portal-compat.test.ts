import { afterEach, describe, expect, it } from "vitest";

import { PortalCompat, PortalError, identityManager } from "../src/esri-compat-entry.js";

interface RecordedRequest {
  url: string;
  init?: RequestInit;
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/**
 * Build a fake `fetch` that records requested URLs/inits and returns canned
 * responses keyed by a substring match on the path.
 */
function makeFakeFetch(routes: { match: string; body: unknown }[]): {
  fetchFn: typeof fetch;
  requests: RecordedRequest[];
} {
  const requests: RecordedRequest[] = [];
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    requests.push({ url, init });
    const route = routes.find((candidate) => url.includes(candidate.match));
    if (!route) {
      throw new Error(`Unexpected request: ${url}`);
    }
    return jsonResponse(route.body);
  }) as typeof fetch;
  return { fetchFn, requests };
}

function samplePortalItem(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "item-1",
    owner: "surveyor",
    created: 1_700_000_000_000,
    modified: 1_700_000_500_000,
    type: "Feature Service",
    typeKeywords: ["ArcGIS Server", "Feature Service"],
    title: "Roads",
    snippet: "Road centerlines",
    description: "All the roads",
    tags: ["transport"],
    url: "https://honua.example/rest/services/roads/FeatureServer",
    access: "public",
    extent: [
      [-158, 21],
      [-157, 22],
    ],
    spatialReference: "4326",
    culture: "en-us",
    numComments: 0,
    numViews: 12,
    ...overrides,
  };
}

afterEach(() => {
  identityManager.reset();
});

describe("PortalCompat.generateToken", () => {
  it("posts to /sharing/rest/generateToken and maps expires ms to expiresAtMs", async () => {
    const expires = Date.now() + 3_600_000;
    const { fetchFn, requests } = makeFakeFetch([
      { match: "/generateToken", body: { token: "portal-token-1", expires, ssl: true } },
    ]);
    const portal = new PortalCompat({ portalUrl: "https://honua.example", fetchFn });

    const credential = await portal.generateToken({ username: "u", password: "p" });

    expect(credential.token).toBe("portal-token-1");
    expect(credential.expiresAtMs).toBe(expires);
    expect(credential.ssl).toBe(true);
    expect(portal.getToken()).toBe("portal-token-1");

    const request = requests[0];
    expect(request?.url).toBe("https://honua.example/sharing/rest/generateToken");
    expect(request?.init?.method).toBe("POST");
    const body = String(request?.init?.body);
    expect(body).toContain("username=u");
    expect(body).toContain("password=p");
    expect(body).toContain("f=json");
  });

  it("throws a PortalError on the Esri error envelope", async () => {
    const { fetchFn } = makeFakeFetch([
      {
        match: "/generateToken",
        body: { error: { code: 400, message: "Invalid username or password.", details: [] } },
      },
    ]);
    const portal = new PortalCompat({ portalUrl: "https://honua.example", fetchFn });

    await expect(portal.generateToken({ username: "u", password: "bad" })).rejects.toBeInstanceOf(PortalError);
    await expect(portal.generateToken({ username: "u", password: "bad" })).rejects.toThrow(
      "Invalid username or password.",
    );
  });
});

describe("PortalCompat.search", () => {
  it("parses results and the nextStart sentinel", async () => {
    const { fetchFn, requests } = makeFakeFetch([
      {
        match: "/search",
        body: {
          query: "roads",
          total: 1,
          start: 1,
          num: 10,
          nextStart: -1,
          results: [samplePortalItem()],
        },
      },
    ]);
    const portal = new PortalCompat({ portalUrl: "https://honua.example", token: "tok-9", fetchFn });

    const result = await portal.search({ q: "roads", num: 10 });

    expect(result.total).toBe(1);
    expect(result.start).toBe(1);
    expect(result.nextStart).toBe(-1);
    expect(result.results).toHaveLength(1);
    expect(result.results[0]?.url).toContain("/rest/services/roads/FeatureServer");

    const url = requests[0]?.url ?? "";
    expect(url).toContain("/sharing/rest/search?");
    expect(url).toContain("q=roads");
    expect(url).toContain("num=10");
    expect(url).toContain("token=tok-9");
  });
});

describe("PortalCompat.getItem", () => {
  it("fetches a single item and attaches the token", async () => {
    const { fetchFn, requests } = makeFakeFetch([{ match: "/content/items/item-1", body: samplePortalItem() }]);
    const portal = new PortalCompat({ portalUrl: "https://honua.example", token: "tok-item", fetchFn });

    const item = await portal.getItem("item-1");

    expect(item.id).toBe("item-1");
    expect(item.type).toBe("Feature Service");
    const url = requests[0]?.url ?? "";
    expect(url).toContain("/sharing/rest/content/items/item-1?");
    expect(url).toContain("token=tok-item");
  });
});

describe("PortalCompat.getPortalSelf", () => {
  it("attaches the token to the portals/self call", async () => {
    const { fetchFn, requests } = makeFakeFetch([
      {
        match: "/portals/self",
        body: { id: "org1", isPortal: true, name: "Honua", portalName: "Honua", user: { username: "u" } },
      },
    ]);
    const portal = new PortalCompat({ portalUrl: "https://honua.example", token: "self-tok", fetchFn });

    const self = await portal.getPortalSelf();

    expect(self.isPortal).toBe(true);
    expect(self.user?.username).toBe("u");
    const url = requests[0]?.url ?? "";
    expect(url).toContain("/sharing/rest/portals/self?");
    expect(url).toContain("token=self-tok");
  });
});

describe("PortalCompat.openFeatureLayer", () => {
  it("resolves a portal item URL to a /rest/services FeatureServer base and attaches the token to layer requests", async () => {
    const { fetchFn, requests } = makeFakeFetch([
      { match: "/content/items/item-1", body: samplePortalItem() },
      { match: "/FeatureServer/0/query", body: { features: [] } },
    ]);
    const portal = new PortalCompat({ portalUrl: "https://honua.example", token: "layer-tok", fetchFn });

    const opened = await portal.openFeatureLayer("item-1");

    expect(opened.type).toBe("feature-service");
    expect(opened.baseUrl).toBe("https://honua.example");
    expect(opened.serviceId).toBe("roads");
    if (opened.type !== "feature-service") {
      throw new Error("expected a feature-service result");
    }
    expect(opened.layer.serviceId).toBe("roads");
    expect(opened.layer.layerId).toBe(0);

    await opened.layer.queryFeatures({ where: "1=1", outFields: ["*"], returnGeometry: false });

    const queryRequest = requests.find((request) => request.url.includes("/FeatureServer/0/query"));
    expect(queryRequest).toBeDefined();
    expect(queryRequest?.url).toContain("token=layer-tok");
  });

  it("returns a resolved service handle for Map Service items without throwing", async () => {
    const portal = new PortalCompat({
      portalUrl: "https://honua.example",
      token: "map-tok",
      fetchFn: makeFakeFetch([]).fetchFn,
    });
    const item = samplePortalItem({
      id: "map-1",
      type: "Map Service",
      url: "https://honua.example/rest/services/basemap/MapServer",
    }) as never;

    const opened = await portal.openFeatureLayer(item);

    expect(opened.type).toBe("map-service");
    expect(opened.baseUrl).toBe("https://honua.example");
    expect(opened.serviceId).toBe("basemap");
  });
});

describe("PortalCompat.registerWithIdentityManager", () => {
  it("registers the portal token under the /sharing/rest server", async () => {
    const { fetchFn } = makeFakeFetch([
      { match: "/generateToken", body: { token: "reg-tok", expires: Date.now() + 3_600_000, ssl: true } },
    ]);
    const portal = new PortalCompat({ portalUrl: "https://honua.example", fetchFn });

    await portal.generateToken({ username: "u", password: "p" });
    portal.registerWithIdentityManager();

    const credential = identityManager.findCredential("https://honua.example/sharing/rest/portals/self");
    expect(credential?.token).toBe("reg-tok");
  });
});
