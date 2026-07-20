import type { SourceDescriptor } from "../../../../src/contract/index.js";
import { PROTOCOL_DEFAULT_CAPABILITIES } from "../../../../src/contract/index.js";
import type { HonuaPluginConformanceProbe, HonuaPluginConformanceSpec } from "../../../../src/plugin/index.js";
import { pmtilesProtocolManifest, pmtilesProtocolPlugin } from "../../../../src/plugin/index.js";
import type { PmtilesProtocolExtension } from "../../../../src/plugin/index.js";
import { createFakePmtilesDeps } from "./fake-pmtiles.js";

/**
 * Drive exactly one canonical operation of the first-party PMTiles protocol
 * plugin through its registered `ProtocolModule` extension: discover a
 * fixture descriptor, then inspect the returned archive handle. This is the
 * same public protocol seam `pmtilesSource()` uses internally (issue #538);
 * the probe reaches it only through the registered extension, never through
 * `src/contract/pmtiles.ts` directly.
 */
export const pmtilesProtocolProbe: HonuaPluginConformanceProbe = async (registry) => {
  const extension = registry.get<"protocol", PmtilesProtocolExtension>("protocol", pmtilesProtocolManifest.id);
  if (!extension) throw new Error("pmtiles protocol extension was not registered");

  const descriptor: SourceDescriptor = {
    id: "conformance-basemap",
    protocol: "pmtiles",
    locator: { url: "https://tiles.example.test/conformance.pmtiles" },
    capabilities: PROTOCOL_DEFAULT_CAPABILITIES.pmtiles,
  };
  const discovered = extension.module.discover(descriptor);
  const handle = discovered instanceof Promise ? await discovered : discovered;
  await handle.adapter.describe();
  await handle.dispose();
};

/**
 * Declared behavioral bounds for the first-party PMTiles protocol plugin. It
 * makes no calls to any `HonuaPluginHostServices` (the fake `pmtiles` reader
 * is injected directly into `pmtilesProtocolPlugin()`, never through the
 * registry's `network` service), so the retry/performance budgets are the
 * minimal "never touches a host service" bounds — the same shape as the
 * OpenLayers renderer conformance spec. `bundle` is this fixture's own
 * measured footprint (bundling `test/fixtures/plugins/pmtiles-protocol/index.ts`
 * with esbuild --bundle --minify, target es2020, no externals); unrelated to
 * `bundle-budgets.json`, which tracks published `src/` entrypoints only.
 * Ceiling is measured actual plus ~10% headroom, matching the reference
 * plugins' policy.
 */
export const pmtilesProtocolConformanceSpec: HonuaPluginConformanceSpec = {
  factory: pmtilesProtocolPlugin(createFakePmtilesDeps()),
  probe: pmtilesProtocolProbe,
  retries: { injectedFailures: 0, maxAttempts: 0 },
  performance: { maxServiceCalls: 0 },
  bundle: { minifiedBytes: 24310, gzipBytes: 9544, maxMinifiedBytes: 26741, maxGzipBytes: 10499 },
};
