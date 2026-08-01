/**
 * Certifies the renderer seam (issue #566): an external-style OpenLayers
 * plugin (`test/fixtures/plugins/openlayers/`) registers through the public
 * #392 plugin manifest/registry kit and mounts through the same
 * `connection.mount()` facade (#534) as the built-in MapLibre adapter,
 * proving the seam is renderer-neutral without editing SDK core. The
 * OpenLayers peer is a lightweight structural fake (see `fake-ol.ts`); no
 * `ol` dependency is added anywhere in the tree.
 */
import { describe, expect, it, vi } from "vitest";

import type { HonuaConnection } from "../src/connect.js";
import type { SourceDiscoveryInspection } from "../src/contract/discovery.js";
import type { Dataset, Result, Source, SourceDescriptor, SourceId } from "../src/contract/types.js";
import { PROTOCOL_DEFAULT_CAPABILITIES } from "../src/contract/types.js";
import { createHonuaKernel } from "../src/kernel/index.js";
import type { RendererMountRequest } from "../src/kernel/renderer.js";
import { HonuaPluginRegistry, certifyHonuaPluginManifest } from "../src/plugin/index.js";
import type { FakeOlMapOptions, FakeOpenLayersPeer } from "./fixtures/plugins/openlayers/fake-ol.js";
import {
  FakeOlMap,
  FakeOlProjectionRegistry,
  FakeOlViewImpl,
  classifyOpenLayersCrsFidelity,
  createFakeOpenLayersPeer,
  openLayersRenderer,
  openLayersRendererManifest,
  openLayersRendererPlugin,
} from "./fixtures/plugins/openlayers/index.js";
import type { OpenLayersRendererExtension } from "./fixtures/plugins/openlayers/plugin.js";
import type { OpenLayersRendererOptions } from "./fixtures/plugins/openlayers/renderer-adapter.js";

const REGISTRY_HOST = JSON.stringify({
  pluginApi: "1.0",
  sdkVersion: "0.1.0-beta.0",
  environment: "browser",
  peers: {},
  grants: {},
});

function emptyResult<T>(): Result<T> {
  return { features: [], exceededTransferLimit: false };
}

function pointResult<T>(count: number): Result<T> {
  return {
    features: Array.from({ length: count }, (_, index) => ({
      attributes: { name: `feature-${index}` } as T,
      geometry: { x: index, y: index },
    })),
    exceededTransferLimit: false,
  };
}

function fixture<T>(
  descriptor: SourceDescriptor,
  query: (...args: unknown[]) => Promise<Result<T>>,
): { readonly connection: HonuaConnection; readonly source: unknown } {
  const source = {
    descriptor,
    capabilities: descriptor.capabilities,
    query,
    queryAll: query,
  };
  const inspection: SourceDiscoveryInspection = {
    descriptor,
    discovery: "metadata",
    provenance: [
      {
        source: `${descriptor.locator.url}/metadata`,
        retrievedAt: "2026-07-16T00:00:00.000Z",
        validator: '"revision-1"',
      },
    ],
    capabilityDecisions: [...descriptor.capabilities].map((capability) => ({
      capability,
      effective: true,
      code: "enabled",
      evidence: [{ kind: "metadata", supported: true, provenance: [] }],
      adapterSupported: true,
      positiveEvidence: true,
      policyAllowed: true,
      reason: `${capability} advertised by fixture metadata`,
    })),
    diagnostics: [],
  };
  const dataset = {
    id: "openlayers-mount-fixture",
    sourceDescriptors: [descriptor],
    sourceIds: () => [descriptor.id],
    source: (id: SourceId) => (id === descriptor.id ? source : undefined),
  } as unknown as Dataset;
  return {
    source,
    connection: {
      id: "openlayers-mount-fixture",
      dataset,
      inspection: {
        id: "openlayers-mount-fixture",
        endpoint: descriptor.locator.url,
        protocol: descriptor.protocol,
        defaultSourceId: descriptor.id,
        sources: [inspection],
        diagnostics: [],
        cacheIdentity: {
          version: 1,
          endpoint: descriptor.locator.url,
          protocol: descriptor.protocol,
          authorizationScopeDigest: `sha256:${"0".repeat(64)}`,
          key: "openlayers-mount-fixture",
        },
        cacheStatus: "miss",
      },
      source: (id?: SourceId) => {
        if (id !== undefined && id !== descriptor.id) throw new Error("fixture source mismatch");
        return source;
      },
    } as unknown as HonuaConnection,
  };
}

function vectorDescriptor(id: string): SourceDescriptor {
  return {
    id,
    protocol: "ogc-features",
    locator: { url: "https://features.example.test/ogc", collectionId: id },
    capabilities: PROTOCOL_DEFAULT_CAPABILITIES["ogc-features"],
  };
}

function rasterDescriptor(id: string): SourceDescriptor {
  return {
    id,
    protocol: "ogc-tiles",
    locator: { url: `https://tiles.example.test/${id}` },
    capabilities: PROTOCOL_DEFAULT_CAPABILITIES["ogc-tiles"],
  };
}

async function connectFixture<T>(descriptor: SourceDescriptor, query: (...args: unknown[]) => Promise<Result<T>>) {
  const data = fixture<T>(descriptor, query);
  const kernel = createHonuaKernel({ connectDelegate: async () => data.connection });
  const connection = await kernel.connect(descriptor.locator.url, { protocol: descriptor.protocol });
  return { kernel, connection };
}

function ownedMap(): FakeOlMap {
  return new FakeOlMap({ view: new FakeOlViewImpl({ projection: "EPSG:3857" }) });
}

/**
 * Build a minimal `RendererMountRequest` and call the adapter's `mount()`
 * directly, bypassing `connection.mount()`'s credential-safe error wrapping.
 * The negative-path tests below assert on this adapter's own stable `.code`
 * diagnostics, which is exactly how a plugin author unit-tests their own
 * adapter contract; the positive-path tests elsewhere in this file already
 * drive the same adapter through the full kernel `connection.mount()` seam.
 */
function directRequest(
  id: string,
  signal: AbortSignal = new AbortController().signal,
): RendererMountRequest<Record<string, unknown>, OpenLayersRendererOptions> {
  const descriptor = rasterDescriptor(id);
  const query = vi.fn(async () => emptyResult<Record<string, unknown>>());
  const source = { descriptor, capabilities: descriptor.capabilities, query, queryAll: query } as unknown as Source;
  return {
    source,
    ownership: "borrowed",
    signal,
    queryIntent: "default",
    execution: { signal },
    planQuery: async () => {
      throw new Error("planQuery should not be called for a raster mount");
    },
  };
}

describe("OpenLayers renderer-seam certification (#566)", () => {
  it("certifies the manifest through the #392 kit without editing the built-in registry", () => {
    const report = certifyHonuaPluginManifest(JSON.stringify(openLayersRendererManifest), REGISTRY_HOST);
    expect(report.status).toBe("certified");
    expect(report.checks.every((check) => check.status === "passed")).toBe(true);
    expect(report.plugin).toEqual({
      id: "org.example.honua.openlayers",
      version: "1.0.0",
      kind: "renderer",
    });
  });

  it("registers and starts through HonuaPluginRegistry, then resolves the seam-compatible adapter", async () => {
    const events: string[] = [];
    const registry = new HonuaPluginRegistry({ host: REGISTRY_HOST });
    await registry.register([openLayersRendererPlugin(createFakeOpenLayersPeer(), events)]);
    const extension = registry.get<"renderer", OpenLayersRendererExtension>("renderer", "org.example.honua.openlayers");
    expect(extension).toBeDefined();
    expect(extension?.adapter.kind).toBe("org.example.honua.openlayers");
    expect(events).toContain("initialize:org.example.honua.openlayers");
    await registry.dispose();
  });

  it("classifies non-Web-Mercator CRS fidelity: exact, reprojected-equivalent, approximate, unsupported", () => {
    const projections = new FakeOlProjectionRegistry();
    projections.register({ code: "EPSG:3035", native: false });
    projections.register({ code: "EPSG:2263", native: false, approximate: true, accuracyMeters: 250 });

    expect(classifyOpenLayersCrsFidelity(projections, "EPSG:4326")).toMatchObject({ fidelity: "exact" });
    expect(classifyOpenLayersCrsFidelity(projections, "EPSG:3035")).toMatchObject({
      fidelity: "reprojected-equivalent",
    });
    expect(classifyOpenLayersCrsFidelity(projections, "EPSG:2263")).toMatchObject({
      fidelity: "approximate",
      accuracyMeters: 250,
    });
    expect(classifyOpenLayersCrsFidelity(projections, "EPSG:99999")).toMatchObject({ fidelity: "unsupported" });
  });

  it("mounts a bounded vector fixture into an owned host with an exact non-Web-Mercator projection", async () => {
    const descriptor = vectorDescriptor("parcels");
    const query = vi.fn(async () => pointResult<Record<string, unknown>>(2));
    const { kernel, connection } = await connectFixture(descriptor, query);
    const peer = createFakeOpenLayersPeer();

    const mounted = await connection.mount("#map", {
      renderer: openLayersRenderer(peer),
      rendererOptions: { projection: "EPSG:4326", resource: "vector" },
    });
    await mounted.ready;

    expect(mounted.diagnostics).toContainEqual(
      expect.objectContaining({ code: "crs-fidelity-exact", severity: "info", strategy: "vector" }),
    );
    const map = mounted.raw("org.example.honua.openlayers");
    expect(map).toBeInstanceOf(FakeOlMap);
    expect(map?.getView().getProjection().getCode()).toBe("EPSG:4326");
    expect(map?.getLayerById("honua:parcels")?.data).toHaveLength(2);
    expect(query).toHaveBeenCalled();

    await mounted.dispose();
    expect(map?.getLayerById("honua:parcels")).toBeUndefined();
    expect(map?.disposed).toBe(true);
    await kernel.dispose();
  });

  it("mounts a raster/tiled fixture into a borrowed host, reprojected-equivalent, and leaves it usable", async () => {
    const descriptor = rasterDescriptor("imagery");
    const query = vi.fn(async () => emptyResult<Record<string, unknown>>());
    const { kernel, connection } = await connectFixture(descriptor, query);

    const projections = new FakeOlProjectionRegistry();
    projections.register({ code: "EPSG:3035", native: false });
    const peer = createFakeOpenLayersPeer(projections);
    const view = new FakeOlViewImpl({ projection: "EPSG:3035" });
    const map = new peer.Map({ view });
    map.addLayer({ id: "preexisting-basemap", kind: "tile", honuaOwned: false, data: {} });

    const mounted = await connection.mount(map, {
      renderer: openLayersRenderer(peer),
      rendererOptions: {
        projection: "EPSG:3035",
        resource: "raster",
        tileUrlTemplate: "https://tiles.example.test/imagery/{z}/{x}/{y}.png",
      },
    });
    map.renderSync();
    await mounted.ready;

    expect(mounted.diagnostics).toContainEqual(
      expect.objectContaining({ code: "crs-fidelity-reprojected-equivalent", severity: "info", strategy: "raster" }),
    );
    expect(map.getLayerById("honua:imagery")).toBeDefined();
    expect(query).not.toHaveBeenCalled();

    await mounted.dispose();
    expect(map.getLayerById("honua:imagery")).toBeUndefined();
    expect(map.getLayerById("preexisting-basemap")).toBeDefined();
    expect(map.disposed).toBe(false);
    await kernel.dispose();
  });

  it("reports approximate fidelity with a warning diagnostic", async () => {
    const descriptor = vectorDescriptor("contours");
    const { kernel, connection } = await connectFixture(
      descriptor,
      vi.fn(async () => pointResult<Record<string, unknown>>(1)),
    );
    const projections = new FakeOlProjectionRegistry();
    projections.register({ code: "EPSG:2263", native: false, approximate: true, accuracyMeters: 250 });
    const peer = createFakeOpenLayersPeer(projections);

    const mounted = await connection.mount("#map", {
      renderer: openLayersRenderer(peer),
      rendererOptions: { projection: "EPSG:2263", resource: "vector" },
    });
    await mounted.ready;

    expect(mounted.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "crs-fidelity-approximate",
        severity: "warning",
        message: expect.stringContaining("250m"),
      }),
    );
    await mounted.dispose();
    await kernel.dispose();
  });

  it("fails closed on an unrecognized CRS rather than defaulting to Web Mercator", async () => {
    const peer = createFakeOpenLayersPeer();
    const map = new peer.Map({ view: new FakeOlViewImpl({ projection: "EPSG:99999" }) });
    const adapter = openLayersRenderer(peer);
    const request = directRequest("parcels");

    await expect(
      adapter.mount(map, {
        ...request,
        rendererOptions: {
          projection: "EPSG:99999",
          resource: "raster",
          tileUrlTemplate: "https://tiles.example.test/{z}/{x}/{y}.png",
        },
      }),
    ).rejects.toMatchObject({ code: "crs-unsupported" });
    expect(map.getLayers()).toHaveLength(0);
    expect(map.disposed).toBe(false);
  });

  it("rejects duplicate renderer IDs without disturbing the adopted mount", async () => {
    const peer = createFakeOpenLayersPeer();
    const map = new peer.Map({ view: new FakeOlViewImpl({ projection: "EPSG:4326" }) });
    const adapter = openLayersRenderer(peer);
    const rendererOptions: OpenLayersRendererOptions = {
      projection: "EPSG:4326",
      resource: "raster",
      tileUrlTemplate: "https://tiles.example.test/{z}/{x}/{y}.png",
    };

    const first = await adapter.mount(map, { ...directRequest("parcels"), rendererOptions });

    await expect(adapter.mount(map, { ...directRequest("parcels"), rendererOptions })).rejects.toMatchObject({
      code: "source-conflict",
    });
    expect(map.getLayers()).toHaveLength(1);

    map.renderSync();
    await first.ready;
    await first.dispose();
    expect(map.getLayers()).toHaveLength(0);
  });

  it("aborts first-frame readiness and rolls back the adopted borrowed-map resources", async () => {
    const descriptor = vectorDescriptor("parcels");
    const { kernel, connection } = await connectFixture(
      descriptor,
      vi.fn(async () => emptyResult<Record<string, unknown>>()),
    );
    const peer = createFakeOpenLayersPeer();
    const map = new peer.Map({ view: new FakeOlViewImpl({ projection: "EPSG:4326" }) });
    const controller = new AbortController();

    const mounted = await connection.mount(map, {
      renderer: openLayersRenderer(peer),
      rendererOptions: { projection: "EPSG:4326", resource: "vector" },
      signal: controller.signal,
    });
    const readiness = expect(mounted.ready).rejects.toBeInstanceOf(Error);

    controller.abort();
    await readiness;
    expect(map.getLayers()).toHaveLength(0);
    expect(map.disposed).toBe(false);
    await expect(mounted.dispose()).resolves.toBeUndefined();
    await kernel.dispose();
  });

  it("rolls back a partial owned-map mutation and disposes the created map without leaking it", async () => {
    const createdMaps: FakeOlMap[] = [];
    class FailingOwnedMap extends FakeOlMap {
      public constructor(options: FakeOlMapOptions) {
        super(options);
        this.failLayerAfterMutation = true;
        createdMaps.push(this);
      }
    }
    const peer: FakeOpenLayersPeer = { ...createFakeOpenLayersPeer(), Map: FailingOwnedMap };
    const adapter = openLayersRenderer(peer);

    await expect(
      adapter.mount("#map", {
        ...directRequest("parcels"),
        rendererOptions: {
          projection: "EPSG:4326",
          resource: "raster",
          tileUrlTemplate: "https://tiles.example.test/{z}/{x}/{y}.png",
        },
      }),
    ).rejects.toMatchObject({ code: "map-mutation-failed" });

    expect(createdMaps).toHaveLength(1);
    expect(createdMaps[0]?.getLayers()).toHaveLength(0);
    expect(createdMaps[0]?.disposed).toBe(true);
  });

  it("disposes idempotently: repeated dispose() calls do not throw or double-remove", async () => {
    const descriptor = vectorDescriptor("parcels");
    const { kernel, connection } = await connectFixture(
      descriptor,
      vi.fn(async () => emptyResult<Record<string, unknown>>()),
    );
    const map = ownedMap();
    const peer = createFakeOpenLayersPeer();

    const mounted = await connection.mount(map, {
      renderer: openLayersRenderer(peer),
      rendererOptions: { projection: "EPSG:3857", resource: "vector" },
    });
    map.renderSync();
    await mounted.ready;

    const first = mounted.dispose();
    const second = mounted.dispose();
    expect(second).toBe(first);
    await Promise.all([first, second]);
    expect(map.getLayers()).toHaveLength(0);
    await expect(mounted.dispose()).resolves.toBeUndefined();
    await kernel.dispose();
  });

  it("mounts both resource kinds into both ownership modes across one adapter lifecycle", async () => {
    const scenarios: readonly { readonly ownership: "owned" | "borrowed"; readonly resource: "vector" | "raster" }[] = [
      { ownership: "owned", resource: "vector" },
      { ownership: "owned", resource: "raster" },
      { ownership: "borrowed", resource: "vector" },
      { ownership: "borrowed", resource: "raster" },
    ];

    for (const scenario of scenarios) {
      const descriptor =
        scenario.resource === "vector"
          ? vectorDescriptor(`v-${scenario.ownership}`)
          : rasterDescriptor(`r-${scenario.ownership}`);
      const query = vi.fn(async () => pointResult<Record<string, unknown>>(1));
      const { kernel, connection } = await connectFixture(descriptor, query);
      const peer = createFakeOpenLayersPeer();
      const target =
        scenario.ownership === "owned"
          ? "#map"
          : new peer.Map({ view: new FakeOlViewImpl({ projection: "EPSG:4326" }) });

      const mounted = await connection.mount(target, {
        renderer: openLayersRenderer(peer),
        rendererOptions:
          scenario.resource === "vector"
            ? { projection: "EPSG:4326", resource: "vector" }
            : {
                projection: "EPSG:4326",
                resource: "raster",
                tileUrlTemplate: "https://tiles.example.test/{z}/{x}/{y}.png",
              },
      });
      if (scenario.ownership === "borrowed") (target as FakeOlMap).renderSync();
      await mounted.ready;

      const map = mounted.raw("org.example.honua.openlayers");
      expect(map).toBeInstanceOf(FakeOlMap);
      expect(map?.getLayers()).toHaveLength(1);

      await mounted.dispose();
      expect(map?.getLayers()).toHaveLength(0);
      expect(map?.disposed).toBe(scenario.ownership === "owned");
      await kernel.dispose();
    }
  });
});
