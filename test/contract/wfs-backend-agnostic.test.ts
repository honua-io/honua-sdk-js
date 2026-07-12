/**
 * Backend-agnostic WFS 2.0. The adapter drives a raw GetCapabilities
 * endpoint and — critically — issues GetFeature against the DCP operation
 * URL the server advertises (`ows:DCP/ows:HTTP/ows:Get/@xlink:href`), not
 * the assumed capabilities path. The GeoServer fixture is mounted at
 * `/geoserver/ows` but advertises its operation URL at `/geoserver/wfs`,
 * so a correct client sends GetFeature to `/geoserver/wfs`.
 *
 * Fixtures recorded from ahocevar.com/geoserver (see
 * `test/fixtures/backend-agnostic/geoserver-wfs/`); no network here.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { PROTOCOL_DEFAULT_CAPABILITIES, type SourceDescriptor, createDataset } from "../../src/contract/index.js";
import { HonuaClient } from "../../src/core/client.js";
import { parseWfsCapabilities } from "../../src/core/wfs-capabilities.js";

const FIXTURES = fileURLToPath(new URL("../fixtures/backend-agnostic/geoserver-wfs/", import.meta.url));
const CAPS_XML = readFileSync(`${FIXTURES}capabilities.xml`, "utf8");
const GETFEATURE = JSON.parse(readFileSync(`${FIXTURES}getfeature-countries.json`, "utf8"));

describe("wfs backend-agnostic / capabilities DCP URLs", () => {
  it("captures the DCP Get/Post operation URLs from a raw GeoServer GetCapabilities", () => {
    const snapshot = parseWfsCapabilities(CAPS_XML);
    const getFeature = snapshot.operations.get("GetFeature");
    expect(getFeature?.getUrl).toBe("https://ahocevar.com/geoserver/wfs");
    expect(getFeature?.postUrl).toBe("https://ahocevar.com/geoserver/wfs");
    expect(getFeature?.outputFormats).toContain("application/json");
    expect(snapshot.featureTypes[0].name).toBe("ne:ne_10m_admin_0_countries");
    expect(snapshot.namespaces.get("ne")).toBe("http://www.naturalearthdata.com");
  });
});

describe("wfs backend-agnostic / GetFeature honours the advertised DCP URL", () => {
  it("sends GetFeature to the DCP-advertised /geoserver/wfs, not the /geoserver/ows endpoint", async () => {
    const requested: string[] = [];
    const client = new HonuaClient({
      baseUrl: "https://ahocevar.com",
      fetchFn: async (input) => {
        const url = new URL(String(input));
        requested.push(url.pathname + url.search);
        if (url.searchParams.get("request") === "GetCapabilities") {
          return new Response(CAPS_XML, { status: 200, headers: { "Content-Type": "application/xml" } });
        }
        if (url.searchParams.get("request") === "GetFeature") {
          return new Response(JSON.stringify(GETFEATURE), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response("not found", { status: 404 });
      },
    });
    const source = createDataset({
      id: "gs",
      client,
      skipCompatibilityCheck: true,
      sources: [
        {
          id: "countries",
          protocol: "wfs",
          // Endpoint mounted at /geoserver/ows; the DCP href points at /geoserver/wfs.
          locator: { url: "https://ahocevar.com/geoserver/ows", typeName: "ne:ne_10m_admin_0_countries" },
          capabilities: PROTOCOL_DEFAULT_CAPABILITIES.wfs,
        } satisfies SourceDescriptor,
      ],
    }).source<{ name: string; sovereignt: string }>("countries")!;

    const result = await source.query({ pagination: { limit: 2 } });
    expect(result.features).toHaveLength(2);
    expect(result.features[0].attributes.name).toBe("Aruba");

    // GetCapabilities went to the configured endpoint (/geoserver/ows)...
    const caps = requested.find((r) => r.includes("GetCapabilities"));
    expect(caps).toBeDefined();
    expect(caps).toContain("/geoserver/ows");
    // ...but GetFeature went to the DCP-advertised /geoserver/wfs.
    const getFeature = requested.find((r) => r.includes("GetFeature"));
    expect(getFeature).toBeDefined();
    expect(getFeature).toContain("/geoserver/wfs");
    expect(getFeature).not.toContain("/geoserver/ows");
  });
});
