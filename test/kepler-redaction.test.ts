import { describe, expect, it } from "vitest";

import {
  KEPLER_REDACTED,
  assertCredentialFreeScalar,
  assertCredentialFreeUrl,
  credentialQueryParameters,
  isSensitiveKeplerKey,
  looksLikeCredentialValue,
  redactKeplerExportState,
} from "../src/kepler/index.js";

/** Shape of a real kepler.gl `KeplerGlSchema.getConfigToSave()` result. */
function savedMap() {
  return {
    version: "v1",
    config: {
      visState: {
        filters: [{ id: "replay", dataId: ["incidents"], name: ["reported_at"], type: "timeRange", value: [1, 2] }],
        layers: [{ id: "l1", type: "point", config: { dataId: "incidents", label: "Incidents" } }],
        interactionConfig: { tooltip: { enabled: true } },
      },
      mapState: { latitude: 37.8, longitude: -122.4, zoom: 11, bearing: 0, pitch: 0 },
      mapStyle: {
        styleType: "honua_ops_public",
        mapStyles: {
          honua_ops_public: {
            id: "honua_ops_public",
            label: "Honua Ops Streets",
            url: "https://tiles.example.com/style.json",
            accessToken: "pk.eyJhIjoicmVhbC10b2tlbi12YWx1ZSJ9",
            custom: true,
          },
          signed_imagery: {
            id: "signed_imagery",
            label: "Imagery",
            url: "https://imagery.example.com/{z}/{x}/{y}.png?X-Amz-Signature=deadbeefdeadbeef&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE",
          },
        },
      },
    },
    honua: {
      provenance: { sourceId: "incidents", planId: "plan-1", authorizationScope: "scope:public-read" },
      transport: {
        headers: { Authorization: "Bearer abcdefghijklmnop", "X-Correlation-Id": "req-1" },
        cookie: "session=deadbeefdeadbeef",
      },
    },
  };
}

describe("isSensitiveKeplerKey", () => {
  it("flags credential-bearing key names across naming conventions", () => {
    for (const key of [
      "accessToken",
      "access_token",
      "mapboxApiAccessToken",
      "X-API-Key",
      "apiKey",
      "Authorization",
      "cookie",
      "clientSecret",
      "password",
      "privateKey",
      "sasToken",
      "sig",
      "token",
      "headers",
      "requestHeaders",
    ]) {
      expect(isSensitiveKeplerKey(key), key).toBe(true);
    }
  });

  it("leaves ordinary config keys alone", () => {
    for (const key of ["url", "label", "styleType", "dataId", "keyword", "design", "sortOrder"]) {
      expect(isSensitiveKeplerKey(key), key).toBe(false);
    }
  });

  it("is fail-closed: a key merely containing a credential fragment is redacted", () => {
    expect(isSensitiveKeplerKey("signature_field_label")).toBe(true);
  });

  it("keeps the non-secret Honua authorization scope readable", () => {
    expect(isSensitiveKeplerKey("authorizationScope")).toBe(false);
    expect(redactKeplerExportState({ authorizationScope: "Bearer abcdefghijklmnop" }).state).toEqual({
      authorizationScope: KEPLER_REDACTED,
    });
  });

  it("honors caller-declared extra sensitive keys", () => {
    expect(isSensitiveKeplerKey("tenantSalt")).toBe(false);
    expect(redactKeplerExportState({ tenantSalt: "abc" }, { additionalSensitiveKeys: ["tenant_salt"] }).state).toEqual({
      tenantSalt: KEPLER_REDACTED,
    });
  });
});

describe("credentialQueryParameters", () => {
  it("detects AWS SigV4, Azure SAS, GCS, CloudFront, and bearer-style parameters", () => {
    expect(credentialQueryParameters("https://a.example/x?X-Amz-Signature=abc&other=1")).toEqual(["X-Amz-Signature"]);
    expect(credentialQueryParameters("https://a.example/x?sv=2021&sig=abc&se=2026")).toEqual(["se", "sig", "sv"]);
    expect(credentialQueryParameters("https://a.example/x?GoogleAccessId=a&Signature=b&Expires=1")).toEqual([
      "Expires",
      "GoogleAccessId",
      "Signature",
    ]);
    expect(credentialQueryParameters("https://a.example/x?Policy=p&Signature=s&Key-Pair-Id=k")).toEqual([
      "Key-Pair-Id",
      "Policy",
      "Signature",
    ]);
    expect(credentialQueryParameters("https://a.example/x?access_token=t")).toEqual(["access_token"]);
  });

  it("returns nothing for a credential-free URL or a non-URL string", () => {
    expect(credentialQueryParameters("https://tiles.example.com/{z}/{x}/{y}.png")).toEqual([]);
    expect(credentialQueryParameters("Incidents")).toEqual([]);
  });
});

describe("looksLikeCredentialValue", () => {
  it("recognizes bearer headers, JWTs, and provider token prefixes", () => {
    for (const value of [
      "Bearer abcdefghijklmnop",
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.signature",
      "pk.eyJhIjoiZXhhbXBsZSJ9",
      "AKIAIOSFODNN7EXAMPLE",
      "ghp_abcdefghijklmnopqrst",
      "xoxb-1234567890-abcdef",
      "glpat-abcdefghijkl",
    ]) {
      expect(looksLikeCredentialValue(value), value).toBe(true);
    }
  });

  it("does not flag ordinary metadata", () => {
    for (const value of ["City of Honua open data", "scope:public-read", "EPSG:4326", "plan-1"]) {
      expect(looksLikeCredentialValue(value), value).toBe(false);
    }
  });
});

describe("assertCredentialFreeUrl / assertCredentialFreeScalar", () => {
  it("accepts a credential-free tile template", () => {
    expect(assertCredentialFreeUrl("https://tiles.example.com/{z}/{x}/{y}.png", "source.tiles[0]")).toBe(
      "https://tiles.example.com/{z}/{x}/{y}.png",
    );
  });

  it("refuses userinfo credentials", () => {
    expect(() =>
      assertCredentialFreeUrl("https://user:secret@tiles.example.com/style.json", "source.url"),
    ).toThrowError(/must not embed userinfo credentials/);
  });

  it("refuses a credential-shaped authorization scope", () => {
    expect(() => assertCredentialFreeScalar("Bearer abcdefghijklmnop", "provenance.authorizationScope")).toThrowError(
      /looks like a credential/,
    );
  });
});

describe("redactKeplerExportState", () => {
  it("redacts private headers, bearer tokens, and signed-URL parameters from a saved map by default", () => {
    const result = redactKeplerExportState(savedMap());
    const state = result.state as ReturnType<typeof savedMap>;

    expect(result.redacted).toBe(true);
    expect(state.config.mapStyle.mapStyles.honua_ops_public.accessToken).toBe(KEPLER_REDACTED);
    expect(state.config.mapStyle.mapStyles.signed_imagery.url).toContain(
      `X-Amz-Signature=${encodeURIComponent(KEPLER_REDACTED)}`,
    );
    expect(state.config.mapStyle.mapStyles.signed_imagery.url).toContain(
      `X-Amz-Credential=${encodeURIComponent(KEPLER_REDACTED)}`,
    );
    expect(state.honua.transport.headers).toBe(KEPLER_REDACTED as never);
    expect(state.honua.transport.cookie).toBe(KEPLER_REDACTED);
  });

  it("preserves presentation state, provenance, and non-secret scope", () => {
    const state = redactKeplerExportState(savedMap()).state as ReturnType<typeof savedMap>;

    expect(state.config.mapState).toEqual({ latitude: 37.8, longitude: -122.4, zoom: 11, bearing: 0, pitch: 0 });
    expect(state.config.visState.filters).toEqual([
      { id: "replay", dataId: ["incidents"], name: ["reported_at"], type: "timeRange", value: [1, 2] },
    ]);
    expect(state.config.mapStyle.mapStyles.honua_ops_public.url).toBe("https://tiles.example.com/style.json");
    expect(state.honua.provenance).toEqual({
      sourceId: "incidents",
      planId: "plan-1",
      authorizationScope: "scope:public-read",
    });
  });

  it("reports every redaction with a path and kind", () => {
    const { redactions } = redactKeplerExportState(savedMap());
    const byPath = new Map(redactions.map((entry) => [entry.path, entry]));

    expect(byPath.get("config.mapStyle.mapStyles.honua_ops_public.accessToken")?.kind).toBe("sensitive-key");
    expect(byPath.get("config.mapStyle.mapStyles.signed_imagery.url")?.kind).toBe("signed-url-parameter");
    expect(byPath.get("honua.transport.headers")?.kind).toBe("sensitive-key");
  });

  it("strips URL userinfo credentials that the query and value scans cannot see", () => {
    const result = redactKeplerExportState({
      config: { mapStyle: { mapStyles: { custom: { url: "https://user:password@tiles.example.com/style.json" } } } },
    });
    const state = result.state as { config: { mapStyle: { mapStyles: { custom: { url: string } } } } };

    expect(state.config.mapStyle.mapStyles.custom.url).toBe("https://tiles.example.com/style.json");
    expect(result.redactions).toEqual([
      {
        path: "config.mapStyle.mapStyles.custom.url",
        kind: "url-userinfo",
        detail: "Removed userinfo credentials embedded in a URL.",
      },
    ]);
  });

  it("strips userinfo when only a password or only a username is present", () => {
    expect(redactKeplerExportState({ url: "https://:password@tiles.example.com/style.json" }).state).toEqual({
      url: "https://tiles.example.com/style.json",
    });
    expect(redactKeplerExportState({ url: "https://token@tiles.example.com/style.json" }).state).toEqual({
      url: "https://tiles.example.com/style.json",
    });
  });

  it("strips userinfo and signed parameters from the same URL", () => {
    const result = redactKeplerExportState({
      url: "https://user:password@tiles.example.com/{z}/{x}/{y}.png?X-Amz-Signature=deadbeef",
    });
    const state = result.state as { url: string };

    expect(state.url).not.toContain("user:password@");
    expect(state.url).toContain(`X-Amz-Signature=${encodeURIComponent(KEPLER_REDACTED)}`);
    expect(result.redactions.map((entry) => entry.kind)).toEqual(["url-userinfo", "signed-url-parameter"]);
  });

  it("leaves a credential-free URL untouched", () => {
    const result = redactKeplerExportState({ url: "https://tiles.example.com/{z}/{x}/{y}.png" });

    expect(result.redacted).toBe(false);
    expect((result.state as { url: string }).url).toBe("https://tiles.example.com/{z}/{x}/{y}.png");
  });

  it("does not mutate the caller's state", () => {
    const original = savedMap();
    redactKeplerExportState(original);

    expect(original.config.mapStyle.mapStyles.honua_ops_public.accessToken).toBe("pk.eyJhIjoicmVhbC10b2tlbi12YWx1ZSJ9");
  });

  it("reports a clean export as unredacted", () => {
    const result = redactKeplerExportState({ config: { mapState: { zoom: 3 } } });

    expect(result.redacted).toBe(false);
    expect(result.redactions).toEqual([]);
  });

  it("refuses to silently truncate a state deeper than the redaction depth budget", () => {
    let deep: Record<string, unknown> = { accessToken: "pk.eyJhIjoiZGVlcCJ9" };
    for (let level = 0; level < 40; level += 1) deep = { child: deep };

    expect(() => redactKeplerExportState(deep)).toThrowError(/redaction depth budget/);
  });

  it("redacts credentials inside arrays", () => {
    const result = redactKeplerExportState({
      layers: [{ token: "abcdefghijkl" }, { url: "https://a.example/x?sig=abcdef" }],
    });

    expect(result.redactions.map((entry) => entry.path)).toEqual(["layers.0.token", "layers.1.url"]);
  });
});
