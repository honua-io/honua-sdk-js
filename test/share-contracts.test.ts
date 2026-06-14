import { describe, expect, it } from "vitest";

import {
  HONUA_EMBED_AUDIENCES,
  HONUA_EMBED_TOKEN_FRAGMENT_PARAM,
  HONUA_SHARE_ACCESS_TIERS,
  HONUA_SHARE_DENIAL_MESSAGES,
  denialFromHttpStatus,
  denyShareAccess,
  grantShareAccess,
  hasQueryStringEmbedToken,
  isShareAccessDenied,
  isShareAccessGranted,
  parseEmbedTokenFromFragment,
  toDcatDataset,
  toSchemaOrgDataset,
} from "../src/share/index.js";
import type {
  HonuaEmbedRedemption,
  HonuaOpenDataReadProjection,
  HonuaPublicLinkResolution,
  HonuaShareProjection,
} from "../src/share/index.js";

describe("share contract vocabulary", () => {
  it("matches the canonical server access-tier and embed-audience names", () => {
    // These string literals are the honua-server JSON wire values; keep them in
    // lockstep so a parsed server response assigns straight into the SDK type.
    expect(HONUA_SHARE_ACCESS_TIERS).toEqual(["private", "organization", "public-link", "public-indexed"]);
    expect(HONUA_EMBED_AUDIENCES).toEqual(["map", "content"]);
  });

  it("accepts a server ConsoleShareProjection-shaped object without remapping", () => {
    const wire = {
      itemId: "item-1",
      itemName: "city-parcels",
      itemTitle: "City Parcels",
      itemType: "saved-map",
      ownerId: "user-7",
      accessTier: "public-link",
      publicLinkEnabled: true,
      publicLinkTokens: [
        {
          tokenId: "tok-1",
          token: null,
          itemId: "item-1",
          createdAt: "2026-05-01T00:00:00.000Z",
          expiresAt: null,
          createdById: "user-7",
          isExpired: false,
        },
      ],
      embedEnabled: true,
      embedAudience: "map",
      openDataEligible: false,
      callerPermissions: ["share", "embed", "administer"],
      anonymousEligible: true,
      endpoints: { self: "/api/v1/console/share/content/item-1" },
      updatedAt: "2026-05-02T00:00:00.000Z",
      updatedById: "user-7",
    };
    const projection: HonuaShareProjection = wire;
    expect(projection.accessTier).toBe("public-link");
    expect(projection.publicLinkTokens?.[0].token).toBeNull();
    expect(projection.embedAudience).toBe("map");
  });
});

describe("fragment-only embed token parsing", () => {
  it("extracts the token from a URL fragment", () => {
    const result = parseEmbedTokenFromFragment("https://app.example/embed/item-1#embed_token=abc.def.ghi");
    expect(result).toEqual({ ok: true, token: "abc.def.ghi", param: HONUA_EMBED_TOKEN_FRAGMENT_PARAM });
  });

  it("rejects a bearer token placed in the query string", () => {
    const result = parseEmbedTokenFromFragment("https://app.example/embed/item-1?embed_token=abc.def.ghi");
    expect(result).toEqual({ ok: false, reason: "query-string-token" });
  });

  it("rejects a query-string token even when a fragment token is also present", () => {
    const result = parseEmbedTokenFromFragment("https://app.example/embed?embed_token=leak#embed_token=safe");
    expect(result).toEqual({ ok: false, reason: "query-string-token" });
  });

  it("reports a missing token", () => {
    expect(parseEmbedTokenFromFragment("https://app.example/embed/item-1#theme=dark")).toEqual({
      ok: false,
      reason: "missing",
    });
  });

  it("reports an empty (blank) fragment token distinctly from missing", () => {
    expect(parseEmbedTokenFromFragment("https://app.example/embed#embed_token=")).toEqual({
      ok: false,
      reason: "empty",
    });
    expect(parseEmbedTokenFromFragment("https://app.example/embed#embed_token=%20%20")).toEqual({
      ok: false,
      reason: "empty",
    });
  });

  it("works with a bare fragment and a bare query", () => {
    expect(parseEmbedTokenFromFragment("#embed_token=xyz")).toEqual({
      ok: true,
      token: "xyz",
      param: HONUA_EMBED_TOKEN_FRAGMENT_PARAM,
    });
    expect(parseEmbedTokenFromFragment("?embed_token=xyz")).toEqual({
      ok: false,
      reason: "query-string-token",
    });
  });

  it("honors a custom fragment parameter name", () => {
    expect(parseEmbedTokenFromFragment("https://app.example/#t=zzz", { param: "t" })).toEqual({
      ok: true,
      token: "zzz",
      param: "t",
    });
    expect(parseEmbedTokenFromFragment("https://app.example/?t=zzz", { param: "t" })).toEqual({
      ok: false,
      reason: "query-string-token",
    });
  });

  it("decodes percent-encoded fragment tokens", () => {
    const result = parseEmbedTokenFromFragment("#embed_token=a%2Bb%2Fc");
    expect(result).toEqual({ ok: true, token: "a+b/c", param: HONUA_EMBED_TOKEN_FRAGMENT_PARAM });
  });

  it("hasQueryStringEmbedToken flags leak-prone placements", () => {
    expect(hasQueryStringEmbedToken("https://app.example/?embed_token=x")).toBe(true);
    expect(hasQueryStringEmbedToken("https://app.example/#embed_token=x")).toBe(false);
  });
});

describe("anonymous-safe denial states", () => {
  it("denies without leaking item identity and uses a constant message per kind", () => {
    const denied = denyShareAccess("public-link", "not-found");
    expect(denied).toEqual({
      status: "denied",
      kind: "public-link",
      reason: "not-found",
      message: HONUA_SHARE_DENIAL_MESSAGES["public-link"],
    });
    // The denial carries no item id/title field at all.
    expect(Object.keys(denied).sort()).toEqual(["kind", "message", "reason", "status"]);
  });

  it("uses identical message content across expired/not-found for the same kind (no oracle)", () => {
    const notFound = denyShareAccess("embed", "not-found");
    const expired = denyShareAccess("embed", "expired");
    expect(notFound.message).toBe(expired.message);
  });

  it("maps anonymous-endpoint HTTP statuses onto coarse denial reasons", () => {
    expect(denialFromHttpStatus("public-link", 404).reason).toBe("not-found");
    expect(denialFromHttpStatus("public-content", 200).reason).toBe("not-found");
    expect(denialFromHttpStatus("embed", 403).reason).toBe("forbidden");
    expect(denialFromHttpStatus("embed", 410).reason).toBe("expired");
  });

  it("narrows granted and denied states", () => {
    const resolution: HonuaPublicLinkResolution = {
      itemId: "item-1",
      itemType: "saved-map",
      title: "City Parcels",
      summary: "Public parcels layer",
      accessTier: "public-link",
      endpoints: { self: "/api/v1/console/share/content/item-1" },
    };
    const granted = grantShareAccess("public-link", resolution);
    expect(isShareAccessGranted(granted)).toBe(true);
    if (isShareAccessGranted(granted)) {
      expect(granted.resolution.itemId).toBe("item-1");
    }

    const denied = denyShareAccess("embed", "expired");
    expect(isShareAccessDenied(denied)).toBe(true);
  });

  it("grants a public-content read and denies a forbidden one explicitly", () => {
    // public (public-content) access kind, granted.
    const resolution: HonuaPublicLinkResolution = {
      itemId: "item-9",
      itemType: "open-data",
      accessTier: "public-indexed",
      endpoints: { self: "/api/v1/console/share/content/item-9" },
    };
    const granted = grantShareAccess("public-content", resolution);
    expect(granted.status).toBe("granted");
    expect(granted.kind).toBe("public-content");

    // forbidden denial built directly (not only via HTTP status mapping).
    const forbidden = denyShareAccess("embed", "forbidden");
    expect(forbidden.reason).toBe("forbidden");
    expect(forbidden.message).toBe(HONUA_SHARE_DENIAL_MESSAGES.embed);
    // Forbidden carries the same identity-free message as not-found (no oracle).
    expect(forbidden.message).toBe(denyShareAccess("embed", "not-found").message);
  });

  it("accepts a server ConsoleEmbedRedeemResponse-shaped object", () => {
    const wire = {
      itemId: "item-1",
      itemType: "saved-map",
      title: "City Parcels",
      audience: "map",
      expiresAt: "2026-05-29T12:00:00.000Z",
      endpoints: { self: "/api/v1/console/share/content/item-1" },
    };
    const redemption: HonuaEmbedRedemption = wire;
    const granted = grantShareAccess("embed", redemption);
    expect(granted.resolution.audience).toBe("map");
  });
});

describe("open-data read projection helpers", () => {
  const projection: HonuaOpenDataReadProjection = {
    itemId: "item-1",
    itemType: "open-data",
    title: "City Parcels",
    summary: "Authoritative parcel boundaries.",
    keywords: ["parcels", "cadastre"],
    license: "https://creativecommons.org/licenses/by/4.0/",
    publisher: "City of Example",
    modified: "2026-05-20T00:00:00.000Z",
    landingPageUrl: "https://data.example/datasets/item-1",
    distributions: [
      {
        title: "GeoJSON",
        mediaType: "application/geo+json",
        format: "GeoJSON",
        downloadUrl: "https://data.example/datasets/item-1.geojson",
      },
      {
        title: "OGC API - Features",
        format: "OGC API - Features",
        accessUrl: "https://data.example/ogc/collections/item-1",
      },
    ],
  };

  it("projects into a dcat:Dataset, omitting empty fields", () => {
    const dataset = toDcatDataset(projection);
    expect(dataset["@type"]).toBe("dcat:Dataset");
    expect(dataset.identifier).toBe("item-1");
    expect(dataset.title).toBe("City Parcels");
    expect(dataset.keyword).toEqual(["parcels", "cadastre"]);
    expect(dataset.landingPage).toBe("https://data.example/datasets/item-1");
    expect(dataset.distribution).toHaveLength(2);
    expect(dataset.distribution?.[0]).toEqual({
      "@type": "dcat:Distribution",
      title: "GeoJSON",
      mediaType: "application/geo+json",
      format: "GeoJSON",
      downloadURL: "https://data.example/datasets/item-1.geojson",
    });
    // The service distribution carries accessURL, not downloadURL.
    expect(dataset.distribution?.[1]).toEqual({
      "@type": "dcat:Distribution",
      title: "OGC API - Features",
      format: "OGC API - Features",
      accessURL: "https://data.example/ogc/collections/item-1",
    });
  });

  it("projects into a Schema.org Dataset JSON-LD node", () => {
    const dataset = toSchemaOrgDataset(projection);
    expect(dataset["@context"]).toBe("https://schema.org");
    expect(dataset["@type"]).toBe("Dataset");
    expect(dataset.identifier).toBe("item-1");
    expect(dataset.name).toBe("City Parcels");
    expect(dataset.publisher).toEqual({ "@type": "Organization", name: "City of Example" });
    expect(dataset.distribution?.[0]).toEqual({
      "@type": "DataDownload",
      name: "GeoJSON",
      encodingFormat: "application/geo+json",
      contentUrl: "https://data.example/datasets/item-1.geojson",
    });
    expect(JSON.stringify(dataset)).toContain('"@type":"Dataset"');
  });

  it("omits publisher and distributions when absent", () => {
    const minimal: HonuaOpenDataReadProjection = {
      itemId: "item-2",
      itemType: "open-data",
      title: "Minimal",
    };
    const dcat = toDcatDataset(minimal);
    expect(dcat).toEqual({ "@type": "dcat:Dataset", identifier: "item-2", title: "Minimal" });
    const schema = toSchemaOrgDataset(minimal);
    expect("publisher" in schema).toBe(false);
    expect("distribution" in schema).toBe(false);
  });
});
