import type { SourceDescriptor } from "../../../../src/contract/index.js";
import type { HonuaPluginConformanceProbe, HonuaPluginConformanceSpec } from "../../../../src/plugin/index.js";
import { createFakeCloudTilesReader } from "./fake-cloud-tiles-reader.js";
import { cloudTilesProtocolManifest } from "./manifest.js";
import type { CloudTilesProtocolExtension } from "./plugin.js";
import { cloudTilesProtocolPlugin } from "./plugin.js";

/**
 * Drive exactly one canonical operation of the independent cloud-tiles
 * protocol plugin, mirroring `pmtilesProtocolProbe`
 * (`test/fixtures/plugins/pmtiles-protocol/conformance.ts`): discover a
 * fixture descriptor through the registered `ProtocolModule` extension, then
 * inspect the returned handle.
 */
export const cloudTilesProtocolProbe: HonuaPluginConformanceProbe = async (registry) => {
  const extension = registry.get<"protocol", CloudTilesProtocolExtension>("protocol", cloudTilesProtocolManifest.id);
  if (!extension) throw new Error("cloud-tiles protocol extension was not registered");

  const descriptor = {
    id: "conformance-cloud-basemap",
    protocol: "pmtiles",
    locator: { url: "https://tiles.example.test/conformance-cloud.tiles" },
    capabilities: new Set(["tiles"]),
  } as unknown as SourceDescriptor;
  const discovered = extension.module.discover(descriptor);
  const handle = discovered instanceof Promise ? await discovered : discovered;
  await handle.adapter.describe();
  await handle.dispose();
};

/**
 * Declared behavioral bounds for the independent cloud-tiles plugin. Same
 * "never touches a host service" shape as `pmtilesProtocolConformanceSpec`,
 * proving the identical certification/conformance harness (issue #392) works
 * for a completely independent `ProtocolModule` implementation (#538 REQ-004).
 */
export const cloudTilesProtocolConformanceSpec: HonuaPluginConformanceSpec = {
  factory: cloudTilesProtocolPlugin(createFakeCloudTilesReader()),
  probe: cloudTilesProtocolProbe,
  retries: { injectedFailures: 0, maxAttempts: 0 },
  performance: { maxServiceCalls: 0 },
  bundle: { minifiedBytes: 3241, gzipBytes: 1290, maxMinifiedBytes: 3566, maxGzipBytes: 1419 },
};
