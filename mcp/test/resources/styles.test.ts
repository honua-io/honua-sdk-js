import { describe, expect, it, vi } from "vitest";
import { read, readCatalog, uri, uriTemplate } from "../../src/resources/styles.js";
import { asClient, createMockClient } from "../test-helpers.js";

describe("styles resource", () => {
  it("has the correct catalog URI and template", () => {
    expect(uri).toBe("honua://styles");
    expect(uriTemplate).toBe("honua://styles/{styleId}");
  });

  it("lists styles with canonical URIs in the catalog", async () => {
    const mock = createMockClient();
    const result = await readCatalog(asClient(mock));

    expect(result.contents).toHaveLength(1);
    expect(result.contents[0].uri).toBe("honua://styles");
    expect(result.contents[0].mimeType).toBe("application/json");

    const parsed = JSON.parse(result.contents[0].text);
    expect(parsed.default).toBe("topographic");
    expect(parsed.styles).toHaveLength(2);
    expect(parsed.styles[0]).toEqual({
      styleId: "topographic",
      title: "Topographic",
      uri: "honua://styles/topographic",
    });
  });

  it("projects a single style into a StyleRef with inlined MapLibre encoding", async () => {
    const mock = createMockClient();
    const result = await read(asClient(mock), "topographic");

    expect(result.contents[0].uri).toBe("honua://styles/topographic");
    const styleRef = JSON.parse(result.contents[0].text);

    expect(styleRef.styleId).toBe("topographic");
    expect(styleRef.title).toBe("Topographic");
    expect(styleRef.description).toBe("Default topographic basemap style");
    expect(styleRef.styleVersion).toBe(3);
    expect(styleRef.legendUrl).toBe("https://example.test/ogc/styles/topographic/preview");

    const mapbox = styleRef.encodings.find((e: { encoding: string }) => e.encoding === "mapbox-style");
    expect(mapbox.contentType).toBe("application/vnd.mapbox.style+json");
    expect(mapbox.inlineBody).toEqual({
      version: 8,
      name: "Topographic",
      layers: [{ id: "background", type: "background" }],
    });

    const sld10 = styleRef.encodings.find((e: { encoding: string }) => e.encoding === "sld-1.0.0");
    expect(sld10.storageRef).toBe("https://example.test/ogc/styles/topographic");
  });

  it("URL-encodes style IDs in the resource URI", async () => {
    const mock = createMockClient({
      pipelineFetch: vi.fn(async (_m: string, path: string) => {
        if (path === "/ogc/styles/my%20style/metadata") {
          return new Response(JSON.stringify({ id: "my style", title: "My Style" }), { status: 200 });
        }
        return new Response(JSON.stringify({ version: 8, layers: [] }), { status: 200 });
      }),
    });
    const result = await read(asClient(mock), "my style");
    expect(result.contents[0].uri).toBe("honua://styles/my%20style");
  });

  it("falls back to styleId when metadata is unavailable", async () => {
    const mock = createMockClient({
      pipelineFetch: vi.fn(async (_m: string, path: string) => {
        if (path.endsWith("/metadata")) {
          throw new Error("metadata unavailable");
        }
        return new Response(JSON.stringify({ version: 8, layers: [] }), { status: 200 });
      }),
    });
    const result = await read(asClient(mock), "orphan");
    const styleRef = JSON.parse(result.contents[0].text);
    expect(styleRef.title).toBe("orphan");
    expect(styleRef.description).toBeNull();
    expect(styleRef.styleVersion).toBeNull();
  });
});
