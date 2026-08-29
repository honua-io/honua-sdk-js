import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { isMainEntrypoint } from "../src/entrypoint.js";

/**
 * The published bins are guarded so that importing them from a test does not start a
 * server. That guard used to compare `process.argv[1]` to the module path as raw strings,
 * which never matches when npm invokes the bin through its `node_modules/.bin` symlink:
 * the process started, matched nothing, and exited 0 in silence (#1528).
 */
describe("isMainEntrypoint", () => {
  const roots: string[] = [];
  const originalArgv1 = process.argv[1];

  function scratch(): string {
    const root = mkdtempSync(join(tmpdir(), "honua-entrypoint-"));
    roots.push(root);
    return root;
  }

  afterEach(() => {
    process.argv[1] = originalArgv1;
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("matches when the module file is invoked by its own path", () => {
    const root = scratch();
    const moduleFile = join(root, "proxy.js");
    writeFileSync(moduleFile, "");

    process.argv[1] = moduleFile;

    expect(isMainEntrypoint(pathToFileURL(moduleFile).href)).toBe(true);
  });

  it("matches when npm invokes the bin through its node_modules/.bin symlink", () => {
    // The regression. This is exactly how a published `honua-mcp-proxy` is run.
    const root = scratch();
    const moduleFile = join(root, "proxy.js");
    writeFileSync(moduleFile, "");
    const binDir = join(root, "node_modules", ".bin");
    mkdirSync(binDir, { recursive: true });
    const shim = join(binDir, "honua-mcp-proxy");
    symlinkSync(moduleFile, shim);

    process.argv[1] = shim;

    expect(isMainEntrypoint(pathToFileURL(moduleFile).href)).toBe(true);
  });

  it("does not match a different module in the same package", () => {
    // The guard must still keep an imported module from running itself.
    const root = scratch();
    const moduleFile = join(root, "proxy.js");
    const otherFile = join(root, "index.js");
    writeFileSync(moduleFile, "");
    writeFileSync(otherFile, "");

    process.argv[1] = otherFile;

    expect(isMainEntrypoint(pathToFileURL(moduleFile).href)).toBe(false);
  });

  it("does not match when the module is imported rather than invoked", () => {
    const root = scratch();
    const moduleFile = join(root, "proxy.js");
    writeFileSync(moduleFile, "");

    process.argv[1] = undefined as unknown as string;

    expect(isMainEntrypoint(pathToFileURL(moduleFile).href)).toBe(false);
  });

  it("reports false rather than throwing when the invoked path no longer exists", () => {
    const root = scratch();
    const moduleFile = join(root, "proxy.js");
    writeFileSync(moduleFile, "");

    process.argv[1] = join(root, "deleted-by-a-cleanup.js");

    expect(isMainEntrypoint(pathToFileURL(moduleFile).href)).toBe(false);
  });
});
