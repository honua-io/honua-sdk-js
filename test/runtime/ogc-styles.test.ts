import { describe, expect, test } from "vitest";

import { HonuaClient } from "../../src/core/client.js";
import {
  MAPLIBRE_STYLE_MEDIA_TYPE,
  OgcStylesClient,
  createOgcStyleRefResolver,
  styleDocumentToRefBody,
} from "../../src/runtime/index.js";
import type { HonuaStyleSpecification } from "../../src/style/specification.js";

interface RecordedRequest {
  readonly url: string;
  readonly accept: string | null;
}

describe("OgcStylesClient", () => {
  test("listStyles fetches /ogc/styles and normalizes entries + default", async () => {
    const requests: RecordedRequest[] = [];
    const client = makeClient(requests, async (url) => {
      expect(url).toBe("https://mock.honua.test/ogc/styles");
      return jsonResponse({
        styles: [
          {
            id: "topo",
            title: "Topographic",
            links: [{ rel: "stylesheet", type: MAPLIBRE_STYLE_MEDIA_TYPE, href: "/ogc/styles/topo" }],
          },
          { id: "imagery" },
          { notAStyle: true },
        ],
        default: "topo",
      });
    });

    const list = await new OgcStylesClient({ client }).listStyles();

    expect(list.default).toBe("topo");
    expect(list.styles.map((s) => s.id)).toEqual(["topo", "imagery"]);
    expect(list.styles[0].title).toBe("Topographic");
    expect(list.styles[0].links?.[0].rel).toBe("stylesheet");
  });

  test("getStyle content-negotiates the MapLibre media type", async () => {
    const requests: RecordedRequest[] = [];
    const client = makeClient(requests, async () => jsonResponse(sampleStyleDoc()));

    const style = await new OgcStylesClient({ client }).getStyle("topo");

    expect(requests[0].url).toBe("https://mock.honua.test/ogc/styles/topo");
    expect(requests[0].accept).toContain(MAPLIBRE_STYLE_MEDIA_TYPE);
    expect(style.layers.map((l) => l.id)).toEqual(["parcels-fill", "parcels-outline"]);
  });

  test("getStyle encodes the styleId and respects a custom path prefix", async () => {
    const requests: RecordedRequest[] = [];
    const client = makeClient(requests, async () => jsonResponse(sampleStyleDoc()));

    await new OgcStylesClient({ client, pathPrefix: "/custom/styles/" }).getStyle("city blocks");

    expect(requests[0].url).toBe("https://mock.honua.test/custom/styles/city%20blocks");
  });

  test("getStyle throws a typed error when the body is not a MapLibre style", async () => {
    const client = makeClient([], async () => jsonResponse({ id: "topo", not: "a style" }));

    await expect(new OgcStylesClient({ client }).getStyle("topo")).rejects.toMatchObject({
      name: "HonuaMapPackageError",
      stage: "style-compose",
    });
  });

  test("getStyleMetadata fetches the /metadata sub-resource", async () => {
    const requests: RecordedRequest[] = [];
    const client = makeClient(requests, async () => jsonResponse({ id: "topo", layers: [] }));

    const metadata = await new OgcStylesClient({ client }).getStyleMetadata("topo");

    expect(requests[0].url).toBe("https://mock.honua.test/ogc/styles/topo/metadata");
    expect(metadata.id).toBe("topo");
  });
});

describe("styleDocumentToRefBody", () => {
  test("projects layers into a per-layer override body and drops structural fields", () => {
    const body = styleDocumentToRefBody(sampleStyleDoc());

    expect(Object.keys(body)).toEqual(["parcels-fill", "parcels-outline"]);
    expect(body["parcels-fill"]).toEqual({ paint: { "fill-color": "#ff0000" } });
    // `source` / `type` are not carried into the override.
    expect(body["parcels-fill"]).not.toHaveProperty("source");
    expect(body["parcels-outline"]).toEqual({
      paint: { "line-color": "#000000" },
      minzoom: 4,
    });
  });

  test("omits layers that carry no override-relevant fields", () => {
    const body = styleDocumentToRefBody({
      version: 8,
      sources: {},
      layers: [{ id: "bare", type: "background", source: "parcels" }],
    });
    expect(body).toEqual({});
  });
});

describe("createOgcStyleRefResolver", () => {
  test("resolves a styleId via /ogc/styles/{styleId} into an override body", async () => {
    const requests: RecordedRequest[] = [];
    const client = makeClient(requests, async () => jsonResponse(sampleStyleDoc()));

    const resolve = createOgcStyleRefResolver({ client });
    const body = await resolve("topo");

    expect(requests[0].url).toBe("https://mock.honua.test/ogc/styles/topo");
    expect(requests[0].accept).toContain(MAPLIBRE_STYLE_MEDIA_TYPE);
    expect(body["parcels-fill"]).toEqual({ paint: { "fill-color": "#ff0000" } });
  });
});

function sampleStyleDoc(): HonuaStyleSpecification {
  return {
    version: 8,
    sources: { parcels: { type: "geojson", data: { type: "FeatureCollection", features: [] } } },
    layers: [
      { id: "parcels-fill", type: "fill", source: "parcels", paint: { "fill-color": "#ff0000" } },
      { id: "parcels-outline", type: "line", source: "parcels", paint: { "line-color": "#000000" }, minzoom: 4 },
    ],
  };
}

function makeClient(
  requests: RecordedRequest[],
  fetchFn: (url: string, init?: RequestInit) => Promise<Response>,
): HonuaClient {
  return new HonuaClient({
    baseUrl: "https://mock.honua.test",
    fetchFn: async (url, init) => {
      requests.push({ url: String(url), accept: new Headers(init?.headers).get("accept") });
      return fetchFn(String(url), init);
    },
  });
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
