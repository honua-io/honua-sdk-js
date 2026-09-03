import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  HONUA_CONTROL_PLANE_BASE_PATH,
  HonuaControlPlaneClient,
  createHonuaControlPlane,
} from "../src/control-plane/index.js";
import { HonuaClient } from "../src/index.js";
import { getCapabilityReasonCode, hasCapability, isCapabilitySupported } from "../src/studio/index.js";

const fixturesDir = resolve(dirname(fileURLToPath(import.meta.url)), "fixtures/control-plane");

function fixture(name: string): {
  request: { method: string; path: string; headers?: Record<string, string>; body?: unknown };
  response: { status: number; headers?: Record<string, string>; body?: unknown };
} {
  return JSON.parse(readFileSync(resolve(fixturesDir, name), "utf8"));
}

function clientFor(
  handler: (request: { url: URL; init: RequestInit }) => Response | Promise<Response>,
): HonuaControlPlaneClient {
  return createHonuaControlPlane({
    client: new HonuaClient({
      baseUrl: "https://example.test",
      fetchFn: async (input, init) => handler({ url: new URL(String(input)), init: init ?? {} }),
    }),
  });
}

describe("control-plane client", () => {
  it("exports the experimental subpath constants and factory", () => {
    expect(HONUA_CONTROL_PLANE_BASE_PATH).toBe("/api/v1/admin");
    expect(createHonuaControlPlane).toBeTypeOf("function");
    expect(HonuaControlPlaneClient).toBeTypeOf("function");
  });

  it("lists hosted maps with cursor pagination and validators", async () => {
    const contract = fixture("hosted-map-list.v1.json");
    const requests: Array<{ path: string; headers: HeadersInit | undefined }> = [];
    const controlPlane = clientFor(({ url, init }) => {
      requests.push({ path: `${url.pathname}${url.search}`, headers: init.headers });
      return new Response(JSON.stringify(contract.response.body), {
        status: contract.response.status,
        headers: contract.response.headers,
      });
    });

    const result = await controlPlane.hostedMaps.list({ workspaceId: "workspace-ops", limit: 2 });

    expect(requests[0]?.path).toBe(contract.request.path);
    expect(requests[0]?.headers).toMatchObject({ Accept: "application/json" });
    expect(result.supported).toBe(true);
    if (!result.supported) return;
    expect(result.value.items[0]).toMatchObject({ id: "map-ops", packageId: "pkg-ops-ready" });
    expect(result.value.pagination).toMatchObject({ nextCursor: "cursor-next", limit: 2, total: 1 });
    expect(result.value.validator?.etag).toBe('"maps-v1"');
    expect(result.value.sourceUpdatedAt).toBe("Mon, 11 May 2026 10:00:00 GMT");
  });

  it("does not emit empty conditional headers for refreshes without validators", async () => {
    let headers: HeadersInit | undefined;
    const controlPlane = clientFor(({ init }) => {
      headers = init.headers;
      return new Response(JSON.stringify({ items: [], pagination: {} }), { status: 200 });
    });

    const result = await controlPlane.hostedMaps.list({ refresh: true });
    const requestHeaders = new Headers(headers);

    expect(result.supported).toBe(true);
    expect(requestHeaders.get("If-None-Match")).toBeNull();
    expect(requestHeaders.get("If-Modified-Since")).toBeNull();
  });

  it("handles conditional list 304 responses when validators are supplied", async () => {
    let headers: HeadersInit | undefined;
    const controlPlane = clientFor(({ init }) => {
      headers = init.headers;
      return new Response(null, { status: 304 });
    });

    const result = await controlPlane.hostedMaps.list({
      validator: { etag: '"maps-v1"', lastModified: "Mon, 11 May 2026 10:00:00 GMT" },
    });
    const requestHeaders = new Headers(headers);

    expect(requestHeaders.get("If-None-Match")).toBe('"maps-v1"');
    expect(requestHeaders.get("If-Modified-Since")).toBe("Mon, 11 May 2026 10:00:00 GMT");
    expect(result.supported).toBe(true);
    if (!result.supported) return;
    expect(result.value.items).toEqual([]);
    expect(result.value.validator).toEqual({
      etag: '"maps-v1"',
      lastModified: "Mon, 11 May 2026 10:00:00 GMT",
    });
  });

  it("passes optimistic concurrency validators when publishing packages", async () => {
    const contract = fixture("map-package-publish.v1.json");
    let body: unknown;
    let headers: HeadersInit | undefined;
    const controlPlane = clientFor(({ init }) => {
      body = JSON.parse(String(init.body));
      headers = init.headers;
      return new Response(JSON.stringify(contract.response.body), { status: contract.response.status });
    });

    const result = await controlPlane.packages.publish({
      ifMatch: '"map-ops-v2"',
      mapId: "map-ops",
      message: "Publish reviewed operations map",
      package: {
        mapPackageId: "pkg-ops-ready",
        format: "honua_map_package.v1",
        status: "Ready",
        sourceBindings: [],
        mapSpec: { version: 8, sources: {}, layers: [] },
      },
    });

    expect(headers).toMatchObject({ "If-Match": '"map-ops-v2"' });
    expect(body).toEqual(contract.request.body);
    expect(result.supported).toBe(true);
    if (result.supported) {
      expect(result.value.job).toMatchObject({ id: "job-publish-1", status: "queued" });
    }
  });

  it("redacts token secret fields while preserving one-time reveal shape", async () => {
    const contract = fixture("api-token-create.v1.json");
    const controlPlane = clientFor(() => new Response(JSON.stringify(contract.response.body), { status: 201 }));

    const result = await controlPlane.tokens.create({
      name: "CI deploy token",
      workspaceId: "workspace-ops",
      scopes: ["maps:read", "packages:publish"],
      expiresAt: "2026-06-11T00:00:00Z",
    });

    expect(result.supported).toBe(true);
    if (!result.supported) return;
    expect(result.value).toMatchObject({
      id: "tok_123",
      prefix: "hn_live_1234",
      value: "[REDACTED]",
      oneTimeReveal: "hn_live_1234_REDACTED_FIXTURE_ONLY",
    });
    expect(result.value.secret).toBeUndefined();
    expect(result.value.token).toBeUndefined();
  });

  it("returns typed unsupported results for deployments without a capability", async () => {
    const contract = fixture("unsupported-capability.v1.json");
    const controlPlane = clientFor(() => new Response(JSON.stringify(contract.response.body), { status: 404 }));

    const result = await controlPlane.hostedMaps.list();

    expect(result).toEqual({
      supported: false,
      capability: "hosted-maps",
      statusCode: 404,
      reason: "This deployment does not expose hosted map administration.",
      problem: contract.response.body,
    });
  });

  it("creates runtime handoff locators for hosted maps and packages", async () => {
    const controlPlane = clientFor(
      () =>
        new Response(
          JSON.stringify({
            id: "map-ops",
            title: "Operations Map",
            links: { mapPackage: "/api/v1/admin/maps/map-ops/package" },
          }),
          { status: 200 },
        ),
    );

    const hostedMapPackage = await controlPlane.hostedMaps.getPackageLocator("map-ops");
    expect(hostedMapPackage).toEqual({
      supported: true,
      value: { path: "/api/v1/admin/maps/map-ops/package" },
    });
    expect(controlPlane.packages.locator("pkg-ops-ready")).toEqual({
      path: "/api/v1/admin/packages/pkg-ops-ready",
    });
  });

  it("fetches the capability manifest from the server-wide path, not the admin base", async () => {
    const paths: string[] = [];
    const controlPlane = clientFor(({ url }) => {
      paths.push(`${url.pathname}${url.search}`);
      return new Response(
        JSON.stringify({
          schemaVersion: "honua.capability_manifest.v1",
          capabilities: [
            {
              id: "studio.map",
              category: "studio",
              lifecycle: "Implemented",
              optInRequired: false,
              supported: true,
              available: true,
            },
            {
              id: "studio.ai.generate",
              category: "studio",
              lifecycle: "Preview",
              optInRequired: true,
              supported: true,
              available: false,
              reasonCode: "entitlement-inactive",
            },
          ],
          packages: { families: [{ id: "map", kind: "storage", supported: true }] },
        }),
        { status: 200 },
      );
    });

    const result = await controlPlane.getCapabilityManifest();

    // The manifest is server-wide and must NOT be nested under /api/v1/admin.
    expect(paths[0]).toBe("/api/v1/capabilities/manifest");
    expect(result.supported).toBe(true);
    if (!result.supported) return;
    expect(result.value.schemaVersion).toBe("honua.capability_manifest.v1");
    expect(hasCapability(result.value, "studio.map")).toBe(true);
    expect(hasCapability(result.value, "studio.ai.generate")).toBe(false);
    expect(isCapabilitySupported(result.value, "studio.ai.generate")).toBe(true);
    expect(getCapabilityReasonCode(result.value, "studio.ai.generate")).toBe("entitlement-inactive");
  });

  it("appends environment and workspace scope query parameters to the manifest request", async () => {
    const paths: string[] = [];
    const controlPlane = clientFor(({ url }) => {
      paths.push(`${url.pathname}${url.search}`);
      return new Response(JSON.stringify({ schemaVersion: "honua.capability_manifest.v1", capabilities: [] }), {
        status: 200,
      });
    });

    await controlPlane.getCapabilityManifest({ environment: "prod env", workspaceId: "ws-1" });

    expect(paths[0]).toBe("/api/v1/capabilities/manifest?environment=prod+env&workspaceId=ws-1");
  });

  it("returns a typed unsupported result when the manifest endpoint is absent", async () => {
    const controlPlane = clientFor(() => new Response(JSON.stringify({ title: "Not Found" }), { status: 404 }));

    const result = await controlPlane.getCapabilityManifest();

    expect(result.supported).toBe(false);
    if (result.supported) return;
    expect(result.capability).toBe("capabilities");
    expect(result.statusCode).toBe(404);
  });

  it.each([
    ["id", { lifecycle: "Preview", optInRequired: false, supported: true, available: true }],
    ["lifecycle", { id: "studio.map", optInRequired: false, supported: true, available: true }],
    ["optInRequired", { id: "studio.map", lifecycle: "Preview", supported: true, available: true }],
    ["supported", { id: "studio.map", lifecycle: "Preview", optInRequired: false, available: true }],
    ["available", { id: "studio.map", lifecycle: "Preview", optInRequired: false, supported: true }],
  ])("rejects schema drift when capability entry %s is absent", async (_field, capability) => {
    const controlPlane = clientFor(
      () =>
        new Response(
          JSON.stringify({
            schemaVersion: "honua.capability_manifest.v1",
            capabilities: [capability],
          }),
        ),
    );

    await expect(controlPlane.getCapabilityManifest()).rejects.toMatchObject({
      name: "HonuaCapabilityManifestContractError",
    });
  });

  it.each([
    ["id", { id: 42, lifecycle: "Preview", optInRequired: false, supported: true, available: true }],
    ["lifecycle", { id: "studio.map", lifecycle: null, optInRequired: false, supported: true, available: true }],
    [
      "optInRequired",
      { id: "studio.map", lifecycle: "Preview", optInRequired: "false", supported: true, available: true },
    ],
    ["supported", { id: "studio.map", lifecycle: "Preview", optInRequired: false, supported: "true", available: true }],
    ["available", { id: "studio.map", lifecycle: "Preview", optInRequired: false, supported: true, available: "true" }],
  ])("rejects schema drift when capability entry %s has the wrong type", async (_field, capability) => {
    const controlPlane = clientFor(
      () =>
        new Response(
          JSON.stringify({
            schemaVersion: "honua.capability_manifest.v1",
            capabilities: [capability],
          }),
        ),
    );

    await expect(controlPlane.getCapabilityManifest()).rejects.toMatchObject({
      name: "HonuaCapabilityManifestContractError",
    });
  });
});
