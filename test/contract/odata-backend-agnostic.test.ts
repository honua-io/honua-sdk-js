/**
 * Backend-agnostic OData v4. The OData adapter was already capability-
 * negotiated via `$metadata` and addresses arbitrary service roots through
 * `locator.url` (the trailing path becomes the service basePath). This test
 * proves the same typed `Source.query()` runs against a public third-party
 * OData root (the OASIS TripPin reference service mounted at
 * `/TripPinRESTierService`) with no Honua `/odata` facade.
 *
 * Fixtures recorded from services.odata.org (see
 * `test/fixtures/backend-agnostic/odata/`); no network here.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { PROTOCOL_DEFAULT_CAPABILITIES, type SourceDescriptor, createDataset } from "../../src/contract/index.js";
import { HonuaClient } from "../../src/core/client.js";

const FIXTURES = fileURLToPath(new URL("../fixtures/backend-agnostic/odata/", import.meta.url));
const METADATA_XML = readFileSync(`${FIXTURES}trippin-metadata.xml`, "utf8");
const PEOPLE_PAGE = JSON.parse(readFileSync(`${FIXTURES}people-page.json`, "utf8"));

describe("odata backend-agnostic / arbitrary service root", () => {
  it("resolves basePath from locator.url and queries a public OData root without a facade", async () => {
    const requested: string[] = [];
    const client = new HonuaClient({
      baseUrl: "https://services.odata.org",
      fetchFn: async (input) => {
        const url = new URL(String(input));
        requested.push(url.pathname);
        if (url.pathname.endsWith("/$metadata")) {
          return new Response(METADATA_XML, { status: 200, headers: { "Content-Type": "application/xml" } });
        }
        if (url.pathname.endsWith("/People")) {
          return new Response(JSON.stringify(PEOPLE_PAGE), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response("not found", { status: 404 });
      },
    });
    const source = createDataset({
      id: "trippin",
      client,
      skipCompatibilityCheck: true,
      sources: [
        {
          id: "people",
          protocol: "odata",
          locator: { url: "https://services.odata.org/TripPinRESTierService", entitySet: "People" },
          capabilities: PROTOCOL_DEFAULT_CAPABILITIES.odata,
        } satisfies SourceDescriptor,
      ],
    }).source<{ UserName: string; FirstName: string }>("people")!;

    const result = await source.query({ pagination: { limit: 2 } });
    expect(result.features).toHaveLength(2);
    expect(result.features[0].attributes.UserName).toBe("russellwhyte");
    expect(result.totalCount).toBe(20);

    // Requests addressed the third-party service root, not a Honua /odata facade.
    expect(requested).toContain("/TripPinRESTierService/People");
    expect(requested.some((p) => p.startsWith("/odata/"))).toBe(false);
  });
});
