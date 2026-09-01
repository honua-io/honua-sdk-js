import fs from "node:fs";
import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { createServer } from "vite";
import { describe, expect, it, vi } from "vitest";

import { SampleCleanupRegistry } from "../examples/_kit/cleanup.js";
import { createSampleViteConfig, resolveContainedExport, resolveRuntimePeer } from "../examples/_kit/vite.config.js";

describe("shared sample kit", () => {
  it("drains cleanup registered while disposal is in flight and shares one completion", async () => {
    const registry = new SampleCleanupRegistry();
    const calls: string[] = [];
    registry.add(async () => {
      calls.push("outer");
      await Promise.resolve();
      registry.add(() => {
        calls.push("inner");
      });
    });

    const first = registry.dispose();
    const second = registry.dispose();
    expect(first).toBe(second);
    await Promise.all([first, second]);
    expect(calls).toEqual(["outer", "inner"]);
    expect(registry.disposed).toBe(true);
    expect(() => registry.add(() => undefined)).toThrow("after disposal completed");
  });

  it("runs every cleanup despite rejection and reports one aggregate failure", async () => {
    const registry = new SampleCleanupRegistry();
    const survivor = vi.fn();
    registry.add(survivor);
    registry.add(async () => {
      throw new Error("async cleanup failed");
    });
    registry.add(() => {
      throw new Error("sync cleanup failed");
    });

    await expect(registry.dispose()).rejects.toMatchObject({ errors: expect.arrayContaining([expect.any(Error)]) });
    expect(survivor).toHaveBeenCalledOnce();
    await expect(registry.dispose()).rejects.toBeInstanceOf(AggregateError);
  });

  it("protects truthful reserved Vite defines and undeclared SDK subpaths", () => {
    expect(() =>
      createSampleViteConfig(new URL("../examples/maplibre-quickstart/vite.config.ts", import.meta.url).href, {
        sdkEntrypoints: ["@honua/sdk-js"],
        define: { __HONUA_SAMPLE_SDK_MODE__: JSON.stringify("packed") },
      }),
    ).toThrow("reserved");

    const config = createSampleViteConfig(
      new URL("../examples/maplibre-quickstart/vite.config.ts", import.meta.url).href,
      { sdkEntrypoints: ["@honua/sdk-js"] },
    );
    const guard = (config.plugins as Array<{ resolveId?: (source: string) => unknown }>)[0];
    expect(() => guard?.resolveId?.("@honua/sdk-js/private-internal")).toThrow("undeclared public SDK entrypoint");
    expect(() => guard?.resolveId?.("@honua/sdk-js")).not.toThrow();

    const subpathOnly = createSampleViteConfig(
      new URL("../examples/maplibre-quickstart/vite.config.ts", import.meta.url).href,
      { sdkEntrypoints: ["@honua/sdk-js/esri-compat"] },
    );
    const subpathGuard = (subpathOnly.plugins as Array<{ resolveId?: (source: string) => unknown }>)[0];
    expect(() => subpathGuard?.resolveId?.("@honua/sdk-js")).toThrow("undeclared public SDK entrypoint");
    expect(() => subpathGuard?.resolveId?.("@honua/sdk-js/esri-compat/internal")).toThrow(
      "undeclared public SDK entrypoint",
    );
    expect(() => subpathGuard?.resolveId?.("@honua/sdk-js/esri-compat")).not.toThrow();
  });

  it("resolves declared runtime peers beside packed SDK bytes", () => {
    const manifest = JSON.parse(fs.readFileSync("package.json", "utf8"));
    expect(resolveRuntimePeer(path.resolve("."), manifest, "maplibre-gl")).toBe(
      fs.realpathSync("node_modules/maplibre-gl/dist/maplibre-gl.mjs"),
    );
    expect(() => resolveRuntimePeer(path.resolve("."), manifest, "not-a-declared-peer")).toThrow(
      "not a declared SDK runtime peer",
    );
  });

  it("rejects traversal and symlink package export targets", async () => {
    const root = path.resolve("test-results/sample-kit-export-target");
    await rm(root, { recursive: true, force: true });
    await mkdir(path.join(root, "dist"), { recursive: true });
    await writeFile(path.join(root, "outside.js"), "export {};\n");
    await symlink(path.join(root, "outside.js"), path.join(root, "dist", "linked.js"));
    try {
      expect(() => resolveContainedExport(root, "./dist/../../outside.js")).toThrow("unsafe SDK export target");
      expect(() => resolveContainedExport(root, "./dist/linked.js")).toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("starts and closes the Vite dev server without invoking build-only final-byte attestation", async () => {
    const config = createSampleViteConfig(
      new URL("../examples/maplibre-quickstart/vite.config.ts", import.meta.url).href,
      { sdkEntrypoints: ["@honua/sdk-js"] },
    );
    const server = await createServer({
      ...config,
      server: { ...config.server, host: "127.0.0.1", port: 0 },
      logLevel: "silent",
    });
    try {
      await server.listen();
    } finally {
      await server.close();
    }
  });
});
