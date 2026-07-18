import type { RendererMountRequest } from "../../../../src/kernel/renderer.js";
import type { HonuaPluginConformanceProbe, HonuaPluginConformanceSpec } from "../../../../src/plugin/index.js";
import { PROTOCOL_DEFAULT_CAPABILITIES } from "../../../../src/contract/types.js";
import type { Source, SourceDescriptor } from "../../../../src/contract/types.js";
import { createFakeOpenLayersPeer } from "./fake-ol.js";
import { openLayersRendererManifest } from "./manifest.js";
import type { OpenLayersRendererExtension } from "./plugin.js";
import { openLayersRendererPlugin } from "./plugin.js";
import type { OpenLayersRendererOptions } from "./renderer-adapter.js";

/**
 * Drive exactly one canonical operation of the OpenLayers renderer plugin
 * through its registered `RendererAdapter` extension: mount a raster/tiled
 * fixture into an owned host, wait for first-usable-frame readiness, then
 * dispose. This is the same public renderer seam `connection.mount()` uses;
 * the probe calls the adapter directly (bypassing kernel discovery) so the
 * behavioral-conformance harness can drive it without a network fixture.
 */
export const openLayersRendererProbe: HonuaPluginConformanceProbe = async (registry) => {
  const extension = registry.get<"renderer", OpenLayersRendererExtension>(
    "renderer",
    openLayersRendererManifest.id,
  );
  if (!extension) throw new Error("openlayers renderer extension was not registered");

  const descriptor: SourceDescriptor = {
    id: "conformance-imagery",
    protocol: "ogc-tiles",
    locator: { url: "https://tiles.example.test/conformance" },
    capabilities: PROTOCOL_DEFAULT_CAPABILITIES["ogc-tiles"],
  };
  const emptyResult = { features: [], exceededTransferLimit: false } as const;
  const query = async () => emptyResult;
  const source = {
    descriptor,
    capabilities: descriptor.capabilities,
    query,
    queryAll: query,
  } as unknown as Source;

  const signal = new AbortController().signal;
  const request: RendererMountRequest<Record<string, unknown>, OpenLayersRendererOptions> = {
    source,
    rendererOptions: {
      projection: "EPSG:4326",
      resource: "raster",
      tileUrlTemplate: "https://tiles.example.test/conformance/{z}/{x}/{y}.png",
    },
    ownership: "owned",
    signal,
    queryIntent: "default",
    execution: { signal },
    planQuery: async () => {
      throw new Error("the raster conformance probe never plans a query");
    },
  };

  const session = await extension.adapter.mount("#map", request);
  await session.ready;
  await session.dispose();
};

/**
 * Declared behavioral bounds for the OpenLayers renderer plugin. It makes no
 * host-service calls (rendering consumes an already-accepted plan through the
 * injected `execution`/`planQuery` seam), so the retry/performance budgets are
 * the minimal "never touches a host service" bounds. `bundle` is the plugin's
 * own measured footprint (bundling `test/fixtures/plugins/openlayers/index.ts`
 * with esbuild --bundle --minify, target es2020, no externals — it never
 * imports `ol`) — unrelated to `bundle-budgets.json`, which tracks published
 * `src/` entrypoints only; this fixture is never published. Ceiling is
 * measured actual plus ~10% headroom, matching the reference plugins' policy.
 */
export const openLayersRendererConformanceSpec: HonuaPluginConformanceSpec = {
  factory: openLayersRendererPlugin(createFakeOpenLayersPeer()),
  probe: openLayersRendererProbe,
  retries: { injectedFailures: 0, maxAttempts: 0 },
  performance: { maxServiceCalls: 0 },
  bundle: { minifiedBytes: 102534, gzipBytes: 30361, maxMinifiedBytes: 112788, maxGzipBytes: 33397 },
};
