import { describe, expect, it } from "vitest";
import {
  HONUA_PLUGIN_KINDS,
  type HonuaPluginHostServices,
  HonuaPluginRegistry,
  certifyHonuaPluginManifest,
} from "../src/plugin/index.js";
import {
  REFERENCE_HOST,
  type ReferenceAnalysisExtension,
  type ReferenceAuthExtension,
  type ReferenceCacheExtension,
  type ReferenceGeocoderExtension,
  type ReferenceProtocolExtension,
  type ReferenceRealtimeExtension,
  type ReferenceRendererExtension,
  type ReferenceSourceFormatExtension,
  referenceAnalysisManifest,
  referenceAnalysisPlugin,
  referenceAuthManifest,
  referenceAuthPlugin,
  referenceCacheManifest,
  referenceCachePlugin,
  referenceGeocoderManifest,
  referenceGeocoderPlugin,
  referenceProtocolManifest,
  referenceProtocolPlugin,
  referenceRealtimeManifest,
  referenceRealtimePlugin,
  referenceRendererManifest,
  referenceRendererPlugin,
  referenceSourceFormatManifest,
  referenceSourceFormatPlugin,
} from "./fixtures/plugins/reference/index.js";

const ALL_MANIFESTS = [
  referenceProtocolManifest,
  referenceSourceFormatManifest,
  referenceRendererManifest,
  referenceAuthManifest,
  referenceGeocoderManifest,
  referenceAnalysisManifest,
  referenceCacheManifest,
  referenceRealtimeManifest,
];

function referenceServices(): { services: HonuaPluginHostServices; store: Map<string, unknown> } {
  const store = new Map<string, unknown>();
  return {
    store,
    services: {
      network: { request: async () => "2" },
      credentials: { get: async () => "token-123" },
      storage: {
        get: async (key) => store.get(key),
        set: async (key, value) => {
          store.set(key, value);
        },
        delete: async (key) => {
          store.delete(key);
        },
      },
      realtime: { subscribe: async (request) => ({ subscribed: request, active: true }) },
    },
  };
}

describe("reference plugin samples", () => {
  it("covers every declared plugin kind with an external-style sample", () => {
    const covered = new Set([...ALL_MANIFESTS.map((manifest) => manifest.kind), "style"]);
    expect([...covered].sort()).toEqual([...HONUA_PLUGIN_KINDS].sort());
  });

  it("certifies each reference manifest against the reference host", () => {
    for (const manifest of ALL_MANIFESTS) {
      const report = certifyHonuaPluginManifest(JSON.stringify(manifest), REFERENCE_HOST);
      expect(report.status, manifest.id).toBe("certified");
      expect(
        report.checks.every((check) => check.status === "passed"),
        manifest.id,
      ).toBe(true);
    }
  });

  it("registers, injects only granted services, and disposes every sample", async () => {
    const events: string[] = [];
    const { services, store } = referenceServices();
    const registry = new HonuaPluginRegistry({ host: REFERENCE_HOST, services });

    await registry.register([
      referenceProtocolPlugin(events),
      referenceSourceFormatPlugin(events),
      referenceRendererPlugin(events),
      referenceAuthPlugin(events),
      referenceGeocoderPlugin(events),
      referenceAnalysisPlugin(events),
      referenceCachePlugin(events),
      referenceRealtimePlugin(events),
    ]);

    const protocol = registry.get<"protocol", ReferenceProtocolExtension>("protocol", referenceProtocolManifest.id);
    expect(await protocol?.countInBbox([0, 0, 20, 20])).toBe(2);

    const source = registry.get<"source-format", ReferenceSourceFormatExtension>(
      "source-format",
      referenceSourceFormatManifest.id,
    );
    expect(source?.read("0,0\n 10,10 \n")).toEqual([
      [0, 0],
      [10, 10],
    ]);

    const renderer = registry.get<"renderer", ReferenceRendererExtension>("renderer", referenceRendererManifest.id);
    expect(renderer?.draw([[1, 2]])).toEqual([{ op: "point", x: 1, y: 2 }]);

    const auth = registry.get<"auth", ReferenceAuthExtension>("auth", referenceAuthManifest.id);
    expect(await auth?.authorize()).toBe("Bearer token-123");

    const geocoder = registry.get<"geocoder-routing", ReferenceGeocoderExtension>(
      "geocoder-routing",
      referenceGeocoderManifest.id,
    );
    expect(geocoder?.geocode("Honolulu")).toEqual({ lng: -157.8583, lat: 21.3069 });

    const analysis = registry.get<"analysis", ReferenceAnalysisExtension>("analysis", referenceAnalysisManifest.id);
    expect(await analysis?.execute([1, 2, 3])).toBe(14);
    const aborted = new AbortController();
    aborted.abort();
    await expect(analysis?.execute([1, 2, 3], aborted.signal)).rejects.toThrow();

    const cache = registry.get<"cache", ReferenceCacheExtension>("cache", referenceCacheManifest.id);
    await cache?.write("layer:1", { hits: 3 });
    expect(store.get("layer:1")).toEqual({ hits: 3 });
    expect(await cache?.read("layer:1")).toEqual({ hits: 3 });
    await cache?.invalidate("layer:1");
    expect(await cache?.read("layer:1")).toBeUndefined();

    const realtime = registry.get<"realtime", ReferenceRealtimeExtension>("realtime", referenceRealtimeManifest.id);
    const handle = await realtime?.subscribe("incidents", new AbortController().signal);
    expect(handle).toEqual({ subscribed: "incidents", active: true });

    await registry.dispose();

    for (const manifest of ALL_MANIFESTS) {
      expect(events).toContain(`dispose:${manifest.id}`);
    }
  });
});
