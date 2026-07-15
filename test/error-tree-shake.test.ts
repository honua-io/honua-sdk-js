import path from "node:path";
import * as esbuild from "esbuild";
import { describe, expect, it } from "vitest";

import { ERROR_LEAF_FORBIDDEN_MODULES, errorModulePolicyFailures } from "../scripts/lib/error-tree-shake.mjs";

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
});
