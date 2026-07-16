import path from "node:path";
import * as esbuild from "esbuild";
import { describe, expect, it } from "vitest";

import { ERROR_LEAF_FORBIDDEN_MODULES, errorModulePolicyFailures } from "../scripts/lib/error-tree-shake.mjs";
import { serializeHonuaError } from "../src/core/error-envelope.js";
import { HonuaGeometryError } from "../src/core/errors.js";
import { HonuaMapLibreSourceAdapterError } from "../src/map/source-to-maplibre.js";
import { HonuaRealtimeResumeError } from "../src/realtime/resumable.js";

describe("error tree-shake fixtures", () => {
  it("fails retained-module checks for the complete registry or serializer", () => {
    const policy = errorModulePolicyFailures(
      "tree-shake:error-leaf",
      [
        "/tmp/consumer/node_modules/@honua/sdk-js/dist/src/core/error-base.js",
        "/tmp/consumer/node_modules/@honua/sdk-js/dist/src/core/error-envelope.js",
      ],
      ["dist/src/core/error-base.js"],
      ERROR_LEAF_FORBIDDEN_MODULES,
    );
    expect(policy.failures).toEqual([
      "tree-shake:error-leaf: retained forbidden module: dist/src/core/error-envelope.js",
    ]);
    expect(policy.retained).not.toContain("/tmp/consumer");
  });

  it("bundles a leaf error with a credential- and path-safe JSON projection", async () => {
    const result = await esbuild.build({
      bundle: true,
      entryPoints: [path.resolve("scripts/bundle-size-fixtures/tree-shake-error-leaf.mjs")],
      format: "esm",
      legalComments: "none",
      minify: true,
      platform: "browser",
      target: ["es2020"],
      write: false,
    });
    const encoded = Buffer.from(result.outputFiles[0].contents).toString("base64");
    const fixture = (await import(`data:text/javascript;base64,${encoded}`)) as {
      leafErrorEvidence(): string;
    };
    const json = fixture.leafErrorEvidence();
    expect(JSON.parse(json)).toMatchObject({
      code: "realtime.protocol.terminal",
      context: { reasonCode: "delivery-failed" },
      domain: "realtime",
      name: "HonuaRealtimeResumeError",
    });
    for (const secret of ["leaf-token-secret", "/home/customer/private", "checkpoint.json", "message secret"]) {
      expect(json).not.toContain(secret);
    }
  });

  it("keeps rich geometry and map context behavior-compatible with the full serializer", () => {
    const geometry = new HonuaGeometryError("malformed-geometry", "geometry message secret", {
      keys: ["rings", "spatialReference"],
      bbox: [-158, 21, -157, 22],
      shape: {
        type: "polygon",
        rings: [
          [
            [-158, 21],
            [-157, 21],
            [-157, 22],
            [-158, 21],
          ],
        ],
      },
      key: "opaque-value-that-must-not-cross-the-envelope",
      authorization: "Bearer geometry-token-secret",
    });
    const map = new HonuaMapLibreSourceAdapterError("map-mutation-failed", "map message secret", {
      geometryKinds: ["point", "polygon"],
      operations: ["query", "setData", "remove-layer"],
      rollback: {
        attemptedLayerIds: ["incidents-point", "incidents-polygon"],
        failures: [{ stage: "remove-layer", count: 1 }],
      },
      endpoint: "https://maps.example.test/source?api_key=map-token-secret",
      callback: "https://maps.example.test/return?key=opaque-callback-value",
    });

    expect(geometry.toJSON().context).toEqual({
      keys: ["rings", "spatialReference"],
      bbox: [-158, 21, -157, 22],
      shape: {
        type: "polygon",
        rings: [
          [
            [-158, 21],
            [-157, 21],
            [-157, 22],
            [-158, 21],
          ],
        ],
      },
      key: "[REDACTED]",
      authorization: "[REDACTED]",
    });
    expect(map.toJSON().context).toEqual({
      geometryKinds: ["point", "polygon"],
      operations: ["query", "setData", "remove-layer"],
      rollback: {
        attemptedLayerIds: ["incidents-point", "incidents-polygon"],
        failures: [{ stage: "remove-layer", count: 1 }],
      },
      endpoint: "[REDACTED]",
      callback: "[REDACTED]",
    });
    expect(geometry.toJSON()).toEqual(serializeHonuaError(geometry));
    expect(map.toJSON()).toEqual(serializeHonuaError(map));
    expect(JSON.stringify([geometry, map])).not.toMatch(/geometry-token-secret|map-token-secret|message secret/);
  });

  it("bounds cyclic context without invoking accessors", () => {
    let accessorInvoked = false;
    const nested = Object.create(null) as Record<string, unknown>;
    nested.values = Array.from({ length: 101 }, (_, index) => index);
    nested.self = nested;
    const detail = { nested } as Record<string, unknown>;
    Object.defineProperty(detail, "authorization", {
      enumerable: true,
      get() {
        accessorInvoked = true;
        return "Bearer accessor-token-secret";
      },
    });

    const error = new HonuaGeometryError("malformed-geometry", "bad", detail);
    expect(accessorInvoked).toBe(false);
    expect(error.toJSON().context).toMatchObject({
      nested: {
        self: "[CIRCULAR]",
      },
      authorization: "[REDACTED]",
    });
    const values = (error.toJSON().context.nested as { readonly values: readonly unknown[] }).values;
    expect(values).toHaveLength(101);
    expect(values.at(-1)).toBe("[TRUNCATED]");
  });

  it("projects separately bundled SDK causes without trusting altered classifications", async () => {
    const result = await esbuild.build({
      bundle: true,
      stdin: {
        contents: `
          import { HonuaRealtimeResumeError } from "./dist/src/realtime/resumable.js";
          export const makeCause = () => new HonuaRealtimeResumeError("invalid-event", "foreign message secret");
        `,
        loader: "js",
        resolveDir: process.cwd(),
        sourcefile: "foreign-honua-error.mjs",
      },
      format: "esm",
      legalComments: "none",
      minify: true,
      platform: "browser",
      target: ["es2020"],
      write: false,
    });
    const encoded = Buffer.from(result.outputFiles[0].contents).toString("base64");
    const foreign = (await import(`data:text/javascript;base64,${encoded}`)) as {
      makeCause(): HonuaRealtimeResumeError;
    };
    const cause = foreign.makeCause();
    expect(cause).not.toBeInstanceOf(HonuaRealtimeResumeError);

    const outer = new HonuaMapLibreSourceAdapterError(
      "map-mutation-failed",
      "outer message secret",
      { operations: ["query", "setData"] },
      { cause },
    );
    const expectedCause = {
      name: "HonuaRealtimeResumeError",
      domain: "realtime",
      code: "realtime.protocol.terminal",
      category: "protocol",
      retryable: false,
    } as const;
    expect(outer.toJSON().cause).toEqual(expectedCause);
    expect(outer.toJSON()).toEqual(serializeHonuaError(outer));

    const descriptors = Object.getOwnPropertyDescriptors(cause);
    const altered = Object.create(Object.getPrototypeOf(cause)) as Record<PropertyKey, unknown>;
    Object.defineProperties(altered, {
      ...descriptors,
      category: { ...descriptors.category, value: "internal" },
    });
    const alteredOuter = new HonuaGeometryError("malformed-geometry", "bad", {}, { cause: altered });
    expect(alteredOuter.toJSON().cause).toEqual({ name: "Error" });
  });
});
