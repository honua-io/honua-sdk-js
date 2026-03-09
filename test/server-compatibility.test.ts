import { describe, expect, it } from "vitest";

import { HONUA_MINIMUM_SUPPORTED_SERVER_VERSION, HonuaClient } from "../src/index.js";

describe("HonuaClient server compatibility helpers", () => {
  it("reports supported servers and reuses cached compatibility for feature checks", async () => {
    let fetchCount = 0;

    const client = new HonuaClient({
      baseUrl: "https://example.test",
      fetchFn: async (input) => {
        fetchCount += 1;
        expect(String(input)).toBe("https://example.test/api/v1/admin/capabilities");
        return new Response(
          JSON.stringify(
            createCapabilitiesEnvelope({
              serverVersion: HONUA_MINIMUM_SUPPORTED_SERVER_VERSION,
              features: {
                metadataResources: true,
                manifestExport: true,
                manifestApply: true,
                manifestDryRun: true,
                manifestPrune: false,
              },
            }),
          ),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      },
    });

    const compatibility = await client.getCompatibility();
    const status = await client.checkCompatibility();
    const manifestApply = await client.supportsFeature("manifestApply");
    const manifestPrune = await client.supportsFeature("manifestPrune");

    expect(compatibility.serverVersion).toBe(HONUA_MINIMUM_SUPPORTED_SERVER_VERSION);
    expect(status.supported).toBe(true);
    expect(status.minimumSupportedServerVersion).toBe(HONUA_MINIMUM_SUPPORTED_SERVER_VERSION);
    expect(status.reasons).toEqual([]);
    expect(status.compatibility?.controlPlaneApi.major).toBe(1);
    expect(manifestApply).toBe(true);
    expect(manifestPrune).toBe(false);
    expect(fetchCount).toBe(1);
  });

  it("reports unsupported when the server version is below the minimum baseline", async () => {
    const client = new HonuaClient({
      baseUrl: "https://example.test",
      fetchFn: async () =>
        new Response(JSON.stringify(createCapabilitiesEnvelope({ serverVersion: "0.9.9" })), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    });

    const status = await client.checkCompatibility();

    expect(status.supported).toBe(false);
    expect(status.compatibility?.serverVersion).toBe("0.9.9");
    expect(status.reasons).toContain(
      `Server version 0.9.9 is older than the minimum supported ${HONUA_MINIMUM_SUPPORTED_SERVER_VERSION}.`,
    );
  });

  it("reports unsupported when the release channel is below the SDK baseline", async () => {
    const client = new HonuaClient({
      baseUrl: "https://example.test",
      fetchFn: async () =>
        new Response(JSON.stringify(createCapabilitiesEnvelope({ releaseChannel: "alpha" })), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    });

    const status = await client.checkCompatibility();

    expect(status.supported).toBe(false);
    expect(status.reasons).toContain(
      "Server release channel 'alpha' is below the minimum supported 'preview'.",
    );
  });

  it("reports unsupported when the server does not expose the compatibility contract", async () => {
    const client = new HonuaClient({
      baseUrl: "https://example.test",
      fetchFn: async () =>
        new Response(JSON.stringify({ message: "Not Found" }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        }),
    });

    const status = await client.checkCompatibility();

    expect(status.supported).toBe(false);
    expect(status.compatibility).toBeUndefined();
    expect(status.reasons).toEqual(["Server does not expose GET /api/v1/admin/capabilities."]);
  });
});

function createCapabilitiesEnvelope(
  overrides: {
    serverVersion?: string;
    releaseChannel?: string;
    controlPlaneApi?: {
      major?: number;
      basePath?: string;
      deprecated?: boolean;
    };
    metadataSchemas?: Array<{ version: string; deprecated: boolean }>;
    features?: {
      metadataResources: boolean;
      manifestExport: boolean;
      manifestApply: boolean;
      manifestDryRun: boolean;
      manifestPrune: boolean;
    };
  } = {},
) {
  return {
    success: true,
    data: {
      metadataApiVersions: ["honua.io/v1alpha1", "honua.io/v1alpha0"],
      resourceKinds: ["Layer"],
      compatibility: {
        serverVersion: overrides.serverVersion ?? HONUA_MINIMUM_SUPPORTED_SERVER_VERSION,
        releaseChannel: overrides.releaseChannel ?? "stable",
        controlPlaneApi: {
          major: overrides.controlPlaneApi?.major ?? 1,
          basePath: overrides.controlPlaneApi?.basePath ?? "/api/v1/admin",
          deprecated: overrides.controlPlaneApi?.deprecated ?? false,
        },
        metadataSchemas:
          overrides.metadataSchemas ?? [
            { version: "honua.io/v1alpha1", deprecated: false },
            { version: "honua.io/v1alpha0", deprecated: true },
          ],
        features: overrides.features ?? {
          metadataResources: true,
          manifestExport: true,
          manifestApply: true,
          manifestDryRun: true,
          manifestPrune: true,
        },
      },
    },
  };
}
