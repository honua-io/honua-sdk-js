/**
 * OGC API Maps wire + Source-adapter conformance. Covers
 * dataset / collection map renders, the styled-map path, and the
 * `Source.adapter("ogc-maps")` escape hatch for render-only adapters.
 */

import { describe, expect, it } from "vitest";

import {
  PROTOCOL_DEFAULT_CAPABILITIES,
  createDataset,
  type SourceDescriptor,
} from "../../src/contract/index.js";
import { HonuaCapabilityNotSupportedError } from "../../src/core/errors.js";
import { HonuaOgcCollectionMap, HonuaOgcMaps } from "../../src/core/ogc-maps.js";

import { makeMockClient } from "./shared.js";

function pngResponse(): Response {
  return new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), {
    status: 200,
    headers: { "Content-Type": "image/png" },
  });
}

describe("ogc-maps / wire", () => {
  it("renders a dataset-level map and serializes the bbox + crs envelope", async () => {
    let observedQuery: URLSearchParams | undefined;
    const client = makeMockClient({
      routes: [
        [
          "/ogc/maps/map",
          (url) => {
            observedQuery = url.searchParams;
            return pngResponse();
          },
        ],
      ],
    });
    const map = await client.ogcMaps().map({
      width: 512,
      height: 256,
      bbox: [-122, 37, -120, 38],
      crs: "http://www.opengis.net/def/crs/OGC/1.3/CRS84",
      collections: ["parcels", "roads"],
    });
    expect(map.contentType).toBe("image/png");
    expect(observedQuery?.get("bbox")).toBe("-122,37,-120,38");
    expect(observedQuery?.get("crs")).toContain("CRS84");
    expect(observedQuery?.get("collections")).toBe("parcels,roads");
  });

  it("normalizes media-type formats to the server's short-name `f` token and sets the Accept header", async () => {
    // The OGC API Maps server validates `f` against short tokens only
    // (`png`, `jpeg`, `jpg`, `tiff`, `tif`). Callers who pass a media
    // type (`image/png`) still get a valid request because the SDK
    // normalizes the wire value while keeping the Accept header as the
    // media type.
    let observedFormat: string | null = null;
    let observedAccept: string | null = null;
    const client = makeMockClient({
      routes: [
        [
          "/ogc/maps/map",
          (url, init) => {
            observedFormat = url.searchParams.get("f");
            const headers = new Headers(init?.headers);
            observedAccept = headers.get("Accept");
            return pngResponse();
          },
        ],
      ],
    });
    await client.ogcMaps().map({
      width: 256,
      height: 256,
      bbox: [-122, 37, -120, 38],
      format: "image/png",
    });
    expect(observedFormat).toBe("png");
    expect(observedAccept).toBe("image/png");
  });

  it("does not forward a `filter` query parameter (server Maps request model has no filter field)", async () => {
    let observedQuery: URLSearchParams | undefined;
    const client = makeMockClient({
      routes: [
        [
          "/ogc/maps/map",
          (url) => {
            observedQuery = url.searchParams;
            return pngResponse();
          },
        ],
      ],
    });
    await client.ogcMaps().map({
      width: 256,
      height: 256,
      bbox: [-122, 37, -120, 38],
      // Callers who want an extension parameter can wedge it through
      // extraParams, but the public request shape no longer carries a
      // `filter` field because honua-server's OgcMapRequest has none.
      extraParams: { customFilter: "ignored-by-server" },
    });
    expect(observedQuery?.has("filter")).toBe(false);
    expect(observedQuery?.get("customFilter")).toBe("ignored-by-server");
  });

  it("routes collection-level styled renders through the collection + styles segments", async () => {
    let observedPath = "";
    const client = makeMockClient({
      routes: [
        [
          "/ogc/maps/collections/parcels/styles/topographic/map",
          (url) => {
            observedPath = url.pathname;
            return pngResponse();
          },
        ],
      ],
    });
    await client.ogcMaps().collection("parcels", "topographic").map({
      width: 1024,
      height: 1024,
    });
    expect(observedPath).toBe("/ogc/maps/collections/parcels/styles/topographic/map");
  });
});

describe("ogc-maps / Source adapter", () => {
  it("registers as a render-only Source and exposes the maps adapter", () => {
    const client = makeMockClient({ routes: [] });
    const dataset = createDataset({
      id: "parcels",
      client,
      skipCompatibilityCheck: true,
      sources: [
        {
          id: "parcels-map",
          protocol: "ogc-maps",
          locator: { url: "https://mock/", collectionId: "parcels", styleId: "topographic" },
          capabilities: PROTOCOL_DEFAULT_CAPABILITIES["ogc-maps"],
        } satisfies SourceDescriptor,
      ],
    });
    const source = dataset.source("parcels-map")!;
    expect(source.capabilities.has("render")).toBe(true);
    const adapter = source.adapter("ogc-maps");
    expect(adapter).toBeInstanceOf(HonuaOgcCollectionMap);
  });

  it("falls back to the dataset-level maps client when no collection scope is set", () => {
    const client = makeMockClient({ routes: [] });
    const dataset = createDataset({
      id: "dataset",
      client,
      skipCompatibilityCheck: true,
      sources: [
        {
          id: "dataset-map",
          protocol: "ogc-maps",
          locator: { url: "https://mock/" },
          capabilities: PROTOCOL_DEFAULT_CAPABILITIES["ogc-maps"],
        } satisfies SourceDescriptor,
      ],
    });
    const source = dataset.source("dataset-map")!;
    const adapter = source.adapter("ogc-maps");
    expect(adapter).toBeInstanceOf(HonuaOgcMaps);
  });

  it("query() throws because maps do not expose a feature-query path", async () => {
    const client = makeMockClient({ routes: [] });
    const dataset = createDataset({
      id: "parcels",
      client,
      skipCompatibilityCheck: true,
      sources: [
        {
          id: "parcels-map",
          protocol: "ogc-maps",
          locator: { url: "https://mock/", collectionId: "parcels" },
          capabilities: PROTOCOL_DEFAULT_CAPABILITIES["ogc-maps"],
        } satisfies SourceDescriptor,
      ],
    });
    const source = dataset.source("parcels-map")!;
    await expect(source.query({ where: "1=1" })).rejects.toThrow(HonuaCapabilityNotSupportedError);
  });
});
