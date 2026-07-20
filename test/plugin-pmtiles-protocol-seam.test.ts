/**
 * Certifies the protocol seam (issue #538): the built-in PMTiles adapter
 * (`pmtilesSource()`, wired internally through `createDataset()`) and the
 * first-party PMTiles protocol module registered through the public #392
 * plugin manifest/registry kit (`pmtilesProtocolPlugin`) both build their
 * `HonuaPmtilesArchive` through the exact same `pmtilesProtocolModule()`
 * factory (`src/contract/pmtiles.ts`). Registering the module through
 * `HonuaPluginRegistry` is not a privileged internal shortcut: it is the
 * identical public seam an out-of-tree module would use (see
 * `test/fixtures/plugins/cloud-tiles/` for a structurally equivalent
 * out-of-tree protocol module and `test/plugin-cloud-tiles-certification.test.ts`
 * for its independent certification).
 */
import { describe, expect, it } from "vitest";

import {
  HonuaPmtilesArchive,
  PROTOCOL_DEFAULT_CAPABILITIES,
  type SourceDescriptor,
  createDataset,
  pmtilesProtocolModule,
} from "../src/contract/index.js";
import { HonuaPluginRegistry, type PmtilesProtocolExtension, pmtilesProtocolPlugin } from "../src/plugin/index.js";
import { createFakePmtilesDeps } from "./fixtures/plugins/pmtiles-protocol/index.js";

const stubClient = { checkCompatibility: async () => ({ supported: true }) } as never;

const REGISTRY_HOST = JSON.stringify({
  pluginApi: "1.0",
  sdkVersion: "0.1.0-beta.0",
  environment: "node",
  peers: {},
  grants: {},
});

function descriptor(id: string): SourceDescriptor {
  return {
    id,
    protocol: "pmtiles",
    locator: { url: "pmtiles://https://example.com/basemap.pmtiles" },
    capabilities: PROTOCOL_DEFAULT_CAPABILITIES.pmtiles,
  };
}

describe("PMTiles protocol-module seam (#538)", () => {
  it("builds the same HonuaPmtilesArchive shape through the built-in Source path and pmtilesProtocolModule() directly", () => {
    const dataset = createDataset({
      id: "pmtiles-seam-ds",
      client: stubClient,
      skipCompatibilityCheck: true,
      sources: [descriptor("basemap")],
    });
    const source = dataset.source("basemap");
    if (!source) throw new Error("expected a pmtiles source");
    const viaSource = source.protocol("pmtiles");
    expect(viaSource).toBeInstanceOf(HonuaPmtilesArchive);
    expect(viaSource?.url).toBe("https://example.com/basemap.pmtiles");

    const module = pmtilesProtocolModule();
    const discovered = module.discover(descriptor("basemap"));
    if (discovered instanceof Promise) throw new Error("pmtiles discovery must be synchronous");
    expect(discovered.adapter).toBeInstanceOf(HonuaPmtilesArchive);
    expect(discovered.adapter.url).toBe(viaSource?.url);
    expect([...discovered.capabilities]).toEqual([...(source.capabilities as ReadonlySet<string>)]);
  });

  it("registers the first-party PMTiles protocol module through HonuaPluginRegistry and discovers the identical archive shape as the built-in Source path", async () => {
    const fakeDeps = createFakePmtilesDeps();
    const registry = new HonuaPluginRegistry({ host: REGISTRY_HOST });
    await registry.register([pmtilesProtocolPlugin(fakeDeps)]);

    const extension = registry.get<"protocol", PmtilesProtocolExtension>("protocol", "io.honua.protocols.pmtiles");
    if (!extension) throw new Error("pmtiles protocol extension was not registered");

    const target = descriptor("registry-basemap");
    const discovered = extension.module.discover(target);
    const handle = discovered instanceof Promise ? await discovered : discovered;
    expect(handle.adapter).toBeInstanceOf(HonuaPmtilesArchive);
    expect(handle.adapter.url).toBe("https://example.com/basemap.pmtiles");
    expect([...handle.capabilities]).toEqual(["tiles"]);

    // The built-in Source path resolves the same descriptor to the same archive
    // shape (module identity, not just structural equality) — proving the
    // registry-obtained module is not a parallel or divergent implementation.
    const dataset = createDataset({
      id: "pmtiles-seam-ds-2",
      client: stubClient,
      skipCompatibilityCheck: true,
      sources: [target],
    });
    const source = dataset.source("registry-basemap");
    const viaSource = source?.protocol("pmtiles");
    expect(viaSource).toBeInstanceOf(HonuaPmtilesArchive);
    expect(viaSource?.url).toBe(handle.adapter.url);

    const description = await handle.adapter.describe();
    expect(description.vectorLayers.map((layer) => layer.id)).toEqual(["conformance-layer"]);

    await handle.dispose();
    await registry.dispose();
  });
});
