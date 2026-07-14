import { describe, expect, it } from "vitest";
import { isHonuaError } from "../src/index.js";
import {
  HONUA_PLUGIN_API_VERSION,
  HONUA_PLUGIN_MANIFEST_VERSION,
  type HonuaPluginFactory,
  type HonuaPluginKind,
  type HonuaPluginManifest,
  HonuaPluginRegistry,
  HonuaPluginRegistryError,
} from "../src/plugin/index.js";
import { type ExternalStyleExtension, externalStylePlugin } from "./fixtures/plugins/external-style.js";

const host = JSON.stringify({
  pluginApi: HONUA_PLUGIN_API_VERSION,
  sdkVersion: "0.1.0-beta.0",
  environment: "worker",
  peers: {},
  grants: {
    networkOrigins: ["https://tiles.example.test"],
    credentialScopes: ["tiles.read"],
    storage: "scoped",
    mutation: true,
  },
});

function manifest<K extends HonuaPluginKind>(id: string, kind: K, version = "1.0.0"): HonuaPluginManifest<K> {
  const capabilities = {
    protocol: ["query"],
    "source-format": ["read"],
    renderer: ["2d"],
    auth: ["authorize"],
    "geocoder-routing": ["geocode"],
    analysis: ["execute"],
    style: ["validate"],
    cache: ["read"],
    realtime: ["subscribe"],
  } as const;
  return {
    manifestVersion: HONUA_PLUGIN_MANIFEST_VERSION,
    id,
    version,
    kind,
    package: { name: `@fixture/${id}`, entrypoint: "./plugin.js" },
    compatibility: {
      pluginApi: HONUA_PLUGIN_API_VERSION,
      minimumSdk: "0.1.0-beta.0",
      environments: ["worker"],
    },
    capabilities: capabilities[kind],
    requestedGrants: {},
    data: {
      cache: "none",
      freshness: "snapshot",
      authentication: "none",
      provenance: "preserved",
      mutation: "none",
      realtime: "none",
    },
    lifecycle: { initialization: "explicit", disposal: "required" },
    support: "community",
  } as HonuaPluginManifest<K>;
}

function factory<K extends HonuaPluginKind>(
  declaration: HonuaPluginManifest<K>,
  events: string[] = [],
  options: Partial<HonuaPluginFactory<K>> = {},
): HonuaPluginFactory<K> {
  return {
    manifest: JSON.stringify(declaration),
    initialize(context) {
      events.push(`initialize:${declaration.id}`);
      return {
        extension: { id: context.manifest.id, kind: declaration.kind } as never,
        start() {
          events.push(`start:${declaration.id}`);
        },
        stop() {
          events.push(`stop:${declaration.id}`);
        },
        dispose() {
          events.push(`dispose:${declaration.id}`);
        },
      };
    },
    ...options,
  };
}

describe("HonuaPluginRegistry", () => {
  it("orders dependencies deterministically and disposes exactly once in reverse order", async () => {
    const events: string[] = [];
    const a = manifest("com.example.a", "style");
    const b = manifest("com.example.b", "analysis");
    const registry = new HonuaPluginRegistry({ host });
    let resolvedDependency: unknown;
    await registry.register([
      factory(b, events, {
        dependencies: [{ id: a.id, version: a.version, kind: a.kind }],
        initialize(context) {
          events.push(`initialize:${b.id}`);
          resolvedDependency = context.resolve("style", a.id);
          return { extension: { id: context.manifest.id, kind: "analysis" }, dispose() {} };
        },
      }),
      factory(a, events),
    ]);
    expect(events).toEqual(["initialize:com.example.a", "start:com.example.a", "initialize:com.example.b"]);
    expect(resolvedDependency).toMatchObject({ id: a.id, kind: "style" });
    expect(registry.get("style", a.id)).toMatchObject({ id: a.id, kind: "style" });
    expect(registry.get("analysis", a.id)).toBeUndefined();
    const first = registry.dispose();
    expect(registry.dispose()).toBe(first);
    await first;
    expect(events.slice(-2)).toEqual(["stop:com.example.a", "dispose:com.example.a"]);
  });

  it("keeps same plugin id and different versions isolated per application", async () => {
    const first = new HonuaPluginRegistry({ host });
    const second = new HonuaPluginRegistry({ host });
    await Promise.all([
      first.register([factory(manifest("com.example.shared", "style", "1.0.0"))]),
      second.register([factory(manifest("com.example.shared", "style", "2.0.0"))]),
    ]);
    expect(first.diagnostics[0]?.plugin?.version).toBe("1.0.0");
    expect(second.diagnostics[0]?.plugin?.version).toBe("2.0.0");
    await Promise.all([first.dispose(), second.dispose()]);
  });

  it("serializes concurrent registrations and rejects duplicates, conflicts, and cycles", async () => {
    const registry = new HonuaPluginRegistry({ host });
    const a = manifest("com.example.concurrent-a", "style");
    const b = manifest("com.example.concurrent-b", "analysis");
    await Promise.all([registry.register([factory(a)]), registry.register([factory(b)])]);
    await expect(registry.register([factory(a)])).rejects.toMatchObject({ code: "PLUGIN_DUPLICATE_ID" });
    const versionConflict = factory(manifest("com.example.conflict", "renderer"), [], {
      dependencies: [{ id: a.id, version: "9.0.0" }],
    });
    await expect(registry.register([versionConflict])).rejects.toMatchObject({
      code: "PLUGIN_DEPENDENCY_VERSION_CONFLICT",
    });
    const c = factory(manifest("com.example.c", "style"), [], { dependencies: [{ id: "com.example.d" }] });
    const d = factory(manifest("com.example.d", "style"), [], { dependencies: [{ id: "com.example.c" }] });
    await expect(registry.register([c, d])).rejects.toMatchObject({ code: "PLUGIN_DEPENDENCY_CYCLE" });
    const duplicateDependency = factory(manifest("com.example.duplicate-dependency", "style"), [], {
      dependencies: [{ id: a.id }, { id: a.id }],
    });
    await expect(registry.register([duplicateDependency])).rejects.toMatchObject({
      code: "PLUGIN_DEPENDENCY_DUPLICATE",
    });
    await registry.dispose();
  });

  it("does not resolve an undeclared plugin dependency", async () => {
    const registry = new HonuaPluginRegistry({ host });
    const dependency = manifest("com.example.explicit-dependency", "auth");
    await registry.register([factory(dependency)]);
    const consumer = manifest("com.example.hidden-dependency", "style");
    let hidden: unknown = "not-run";
    await registry.register([
      factory(consumer, [], {
        initialize(context) {
          hidden = context.resolve("auth", dependency.id);
          return { extension: { id: context.manifest.id, kind: "style" }, dispose() {} };
        },
      }),
    ]);
    expect(hidden).toBeUndefined();
    await registry.dispose();
  });

  it("rolls back partial initialization and preserves primary and cleanup failures", async () => {
    const events: string[] = [];
    const a = manifest("com.example.rollback-a", "style");
    const b = manifest("com.example.rollback-b", "analysis");
    const first = factory(a, events, {
      initialize(context) {
        events.push("initialize:a");
        return {
          extension: { id: context.manifest.id, kind: "style" },
          start() {
            events.push("start:a");
          },
          stop() {
            events.push("stop:a");
            throw new Error("cleanup secret");
          },
          dispose() {
            events.push("dispose:a");
          },
        };
      },
    });
    const second = factory(b, events, {
      dependencies: [{ id: a.id }],
      initialize() {
        events.push("initialize:b");
        throw new Error("primary secret");
      },
    });
    const registry = new HonuaPluginRegistry({ host });
    const error = await registry.register([second, first]).catch((value: unknown) => value);
    expect(error).toBeInstanceOf(HonuaPluginRegistryError);
    expect(isHonuaError(error)).toBe(true);
    expect(error).toMatchObject({
      code: "PLUGIN_REGISTRATION_FAILED",
      sdkCode: "plugin.lifecycle.activation",
      context: { reasonCode: "PLUGIN_REGISTRATION_FAILED" },
    });
    expect((error as HonuaPluginRegistryError).cleanupErrors).toHaveLength(1);
    expect((error as HonuaPluginRegistryError).cause).toMatchObject({ message: "primary secret" });
    expect(JSON.stringify(error)).not.toContain("primary secret");
    expect(JSON.stringify(error)).not.toContain("cleanup secret");
    expect(events.slice(-2)).toEqual(["stop:a", "dispose:a"]);
    expect(registry.get("style", a.id)).toBeUndefined();
    expect(JSON.stringify(registry.diagnostics)).not.toContain("secret");
    expect(registry.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "PLUGIN_INITIALIZE_FAILED",
        phase: "initialize",
        status: "failed",
        plugin: expect.objectContaining({ id: b.id }),
      }),
    );
    await registry.dispose();
  });

  it("rolls back every initialized dependency in reverse order after a later start fails", async () => {
    const events: string[] = [];
    const a = manifest("com.example.reverse-a", "style");
    const b = manifest("com.example.reverse-b", "analysis");
    const c = manifest("com.example.reverse-c", "renderer");
    const pluginA = factory(a, events);
    const pluginB = factory(b, events, { dependencies: [{ id: a.id }] });
    const pluginC = factory(c, events, {
      dependencies: [{ id: b.id }],
      initialize(context) {
        events.push(`initialize:${c.id}`);
        return {
          extension: { id: context.manifest.id, kind: "renderer" },
          start() {
            events.push(`start:${c.id}`);
            throw new Error("start failed");
          },
          dispose() {
            events.push(`dispose:${c.id}`);
          },
        };
      },
    });
    const registry = new HonuaPluginRegistry({ host });
    await expect(registry.register([pluginC, pluginB, pluginA])).rejects.toMatchObject({
      code: "PLUGIN_REGISTRATION_FAILED",
    });
    expect(events.slice(-6)).toEqual([
      `start:${c.id}`,
      `dispose:${c.id}`,
      `stop:${b.id}`,
      `dispose:${b.id}`,
      `stop:${a.id}`,
      `dispose:${a.id}`,
    ]);
    expect(registry.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "PLUGIN_START_FAILED",
        phase: "start",
        status: "failed",
        plugin: expect.objectContaining({ id: c.id }),
      }),
    );
    await registry.dispose();
  });

  it("cancels after an in-flight initialize and rolls the initialized instance back", async () => {
    const controller = new AbortController();
    const events: string[] = [];
    const declaration = manifest("com.example.cancel", "style");
    const plugin = factory(declaration, events, {
      async initialize(context) {
        events.push("initialize");
        controller.abort("stop");
        return {
          extension: { id: context.manifest.id, kind: "style" },
          dispose(context) {
            context.signal.throwIfAborted();
            events.push("dispose");
          },
        };
      },
    });
    const registry = new HonuaPluginRegistry({ host });
    await expect(registry.register([plugin], { signal: controller.signal })).rejects.toMatchObject({
      code: "PLUGIN_REGISTRATION_CANCELLED",
    });
    expect(events).toEqual(["initialize", "dispose"]);
    expect(registry.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "PLUGIN_INITIALIZE_CANCELLED",
        phase: "initialize",
        status: "cancelled",
        plugin: expect.objectContaining({ id: declaration.id }),
      }),
    );
    await registry.dispose();
  });

  it("records start cancellation with plugin identity and rolls back a started instance", async () => {
    const controller = new AbortController();
    const events: string[] = [];
    const declaration = manifest("com.example.cancel-start", "style");
    const plugin = factory(declaration, events, {
      initialize(context) {
        return {
          extension: { id: context.manifest.id, kind: "style" },
          start() {
            events.push("start");
            controller.abort("stop");
          },
          stop() {
            events.push("stop");
          },
          dispose() {
            events.push("dispose");
          },
        };
      },
    });
    const registry = new HonuaPluginRegistry({ host });
    await expect(registry.register([plugin], { signal: controller.signal })).rejects.toMatchObject({
      code: "PLUGIN_REGISTRATION_CANCELLED",
    });
    expect(events).toEqual(["start", "stop", "dispose"]);
    expect(registry.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "PLUGIN_START_CANCELLED",
        phase: "start",
        status: "cancelled",
        plugin: expect.objectContaining({ id: declaration.id }),
      }),
    );
    await registry.dispose();
  });

  it("enforces required disposal while allowing inert no-disposal manifests", async () => {
    const required = manifest("com.example.required-disposal", "style");
    const registry = new HonuaPluginRegistry({ host });
    await expect(
      registry.register([
        factory(required, [], {
          initialize(context) {
            return { extension: { id: context.manifest.id, kind: "style" } };
          },
        }),
      ]),
    ).rejects.toMatchObject({ code: "PLUGIN_DISPOSE_HOOK_REQUIRED" });
    expect(registry.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "PLUGIN_INITIALIZE_FAILED",
        phase: "initialize",
        status: "failed",
        plugin: expect.objectContaining({ id: required.id }),
      }),
    );

    const inert = {
      ...manifest("com.example.inert-no-disposal", "style"),
      lifecycle: { initialization: "explicit" as const, disposal: "none" as const },
    };
    await registry.register([
      factory(inert, [], {
        initialize(context) {
          return { extension: { id: context.manifest.id, kind: "style" } };
        },
      }),
    ]);
    expect(registry.get("style", inert.id)).toMatchObject({ id: inert.id });
    await registry.dispose();
  });

  it("injects only declared services and enforces origin and credential scope", async () => {
    const declaration = {
      ...manifest("com.example.grants", "protocol"),
      requestedGrants: {
        networkOrigins: ["https://tiles.example.test"],
        credentialScopes: ["tiles.read"],
      },
      data: { ...manifest("x.y.grants", "protocol").data, authentication: "application-grant" as const },
    };
    let captured: Record<string, unknown> | undefined;
    const registry = new HonuaPluginRegistry({
      host,
      services: {
        network: { request: async (url) => url },
        credentials: { get: async (scope) => scope },
        mutation: { execute: async () => "must-not-leak" },
        storage: { get: async () => undefined, set: async () => {}, delete: async () => {} },
      },
    });
    await registry.register([
      factory(declaration, [], {
        initialize(context) {
          captured = context.services as Record<string, unknown>;
          return { extension: { id: context.manifest.id, kind: "protocol" }, dispose() {} };
        },
      }),
    ]);
    expect(Object.keys(captured ?? {}).sort()).toEqual(["credentials", "network"]);
    await expect(
      (captured?.network as { request(url: string): Promise<unknown> }).request("https://evil.test/a"),
    ).rejects.toMatchObject({ code: "PLUGIN_NETWORK_ORIGIN_DENIED" });
    expect(() => (captured?.credentials as { get(scope: string): Promise<unknown> }).get("admin")).toThrowError(
      HonuaPluginRegistryError,
    );
    await registry.dispose();
  });

  it("returns immutable machine diagnostics and never invokes factory accessors", async () => {
    let invoked = 0;
    const hostile = Object.create(null, {
      manifest: {
        get() {
          invoked += 1;
          return "{}";
        },
        enumerable: true,
      },
      initialize: { value: () => ({}) },
    });
    const registry = new HonuaPluginRegistry({ host });
    await expect(registry.register([hostile])).rejects.toBeInstanceOf(TypeError);
    expect(invoked).toBe(0);
    const events: string[] = [];
    await registry.register([externalStylePlugin(manifest("com.external.style", "style"), events)]);
    expect(registry.get<"style", ExternalStyleExtension>("style", "com.external.style")?.validateStyle("{}")).toBe(
      true,
    );
    const diagnostics = registry.diagnostics;
    expect(Object.isFrozen(diagnostics)).toBe(true);
    expect(Object.isFrozen(diagnostics[0])).toBe(true);
    expect(Object.isFrozen(diagnostics[0]?.plugin)).toBe(true);
    expect(() => (diagnostics as HonuaPluginRegistry["diagnostics"] & unknown[]).push(diagnostics[0]!)).toThrow();
    expect(events).toEqual(["initialize:com.external.style", "start:com.external.style"]);
    await registry.dispose();
  });
});
