/**
 * Independent out-of-tree query protocol fixture for issue #655.
 *
 * The fixture imports public contract/plugin entrypoints only and proves that
 * a third-party compiler + executor pair can register, compile
 * deterministically, execute through an explicitly discovered handle, and
 * dispose without SDK-internal construction paths.
 */
import { describe, expect, it } from "vitest";

import { type SourceDescriptor, capabilities } from "../src/contract/index.js";
import { HonuaPluginRegistry, certifyHonuaPluginManifest } from "../src/plugin/index.js";
import {
  type PortableQueryExtension,
  createFakePortableQueryReader,
  portableQueryManifest,
  portableQueryPlugin,
} from "./fixtures/plugins/portable-query/index.js";

const HOST = JSON.stringify({
  pluginApi: "1.0",
  sdkVersion: "0.1.0-beta.0",
  environment: "node",
  peers: {},
  grants: {},
});

const descriptor = {
  id: "portable-incidents",
  protocol: "portable-query",
  locator: {
    url: "https://data.example.test/api/",
    collectionId: "incidents",
  },
  capabilities: capabilities(["query"]),
} satisfies SourceDescriptor<"portable-query">;

describe("portable query protocol-module certification (#655)", () => {
  it("certifies and executes the public compiler/executor seam without SDK internals", async () => {
    const certification = certifyHonuaPluginManifest(JSON.stringify(portableQueryManifest), HOST);
    expect(certification.status).toBe("certified");

    const reader = createFakePortableQueryReader();
    const registry = new HonuaPluginRegistry({ host: HOST });
    await registry.register([portableQueryPlugin(reader)]);
    const extension = registry.get<"protocol", PortableQueryExtension>("protocol", portableQueryManifest.id);
    if (!extension) throw new Error("portable query extension was not registered");

    const discovered = extension.module.discover(descriptor);
    if (discovered instanceof Promise) throw new Error("portable query discovery must be synchronous");
    const input = {
      source: {
        endpoint: "https://data.example.test/api",
        collection: "incidents",
      },
      query: {
        equals: { field: "status", value: "open" },
        limit: 1,
      },
      operation: "query" as const,
    };
    const first = extension.module.compile(input);
    const second = extension.module.compile(input);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(first).toEqual({
      compiler: "portable-query-v1",
      endpoint: "https://data.example.test/api",
      collection: "incidents",
      params: [
        ["equals", "open"],
        ["field", "status"],
        ["limit", "1"],
      ],
    });

    const result = await extension.module.execute<{ id: number; status: string }>(discovered, {
      compiled: first,
      operation: "query",
      query: {},
    });
    expect(result.features).toEqual([
      {
        attributes: { id: 1, status: "open" },
        geometry: null,
      },
    ]);
    expect(result.exceededTransferLimit).toBe(true);
    expect(result.totalCount).toBe(2);
    expect(reader.calls).toHaveLength(1);
    expect(reader.calls[0]?.endpoint).toBe("https://data.example.test/api");

    await discovered.dispose();
    await discovered.dispose();
    expect(reader.disposedEndpoints).toEqual(["https://data.example.test/api"]);
    await registry.dispose();
  });

  it("keeps credentials out of compiler identity and rejects cross-handle execution", async () => {
    const reader = createFakePortableQueryReader();
    const registry = new HonuaPluginRegistry({ host: HOST });
    await registry.register([portableQueryPlugin(reader)]);
    const extension = registry.get<"protocol", PortableQueryExtension>("protocol", portableQueryManifest.id);
    if (!extension) throw new Error("portable query extension was not registered");
    const discovered = extension.module.discover(descriptor);
    if (discovered instanceof Promise) throw new Error("portable query discovery must be synchronous");

    expect(() =>
      extension.module.compile({
        source: {
          endpoint: "https://user:secret@data.example.test/api",
          collection: "incidents",
        },
        query: {},
        operation: "query",
      }),
    ).toThrow(/must not contain credentials/);

    await expect(
      extension.module.execute(discovered, {
        compiled: {
          compiler: "portable-query-v1",
          endpoint: "https://other.example.test/api",
          collection: "incidents",
          params: [],
        },
        operation: "query",
        query: {},
      }),
    ).rejects.toThrow(/does not match the discovered handle/);
    expect(reader.calls).toHaveLength(0);

    await discovered.dispose();
    await registry.dispose();
  });
});
