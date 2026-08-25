import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import {
  compareVersions,
  isMcpPinLiveVerificationEnabled,
  parsePackagePin,
  releaseLineage,
  verifyMcpPinLineage,
  verifyMcpPinPublication,
  // @ts-expect-error - plain ESM verification script without type declarations
} from "../scripts/verify-mcp-pin.mjs";
import {
  LOCAL_INSTALL_MCP_PACKAGE,
  LOCAL_INSTALL_MCP_PACKAGE_INTEGRITY,
  LOCAL_INSTALL_MCP_PACKAGE_NAME,
  LOCAL_INSTALL_MCP_PACKAGE_VERSION,
} from "../src/local-install.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function repoInputs() {
  const [changelog, packageJson] = await Promise.all([
    readFile(path.join(projectRoot, "mcp/CHANGELOG.md"), "utf8"),
    readFile(path.join(projectRoot, "mcp/package.json"), "utf8"),
  ]);
  return { changelog, packageVersion: (JSON.parse(packageJson) as { version: string }).version };
}

describe("generated MCP client configuration pin", () => {
  it("names an exact published candidate version, never a floating reference", () => {
    expect(LOCAL_INSTALL_MCP_PACKAGE).toBe(`${LOCAL_INSTALL_MCP_PACKAGE_NAME}@${LOCAL_INSTALL_MCP_PACKAGE_VERSION}`);
    expect(parsePackagePin(LOCAL_INSTALL_MCP_PACKAGE)).toEqual({
      name: LOCAL_INSTALL_MCP_PACKAGE_NAME,
      version: LOCAL_INSTALL_MCP_PACKAGE_VERSION,
    });
    for (const floating of ["@honua/mcp-server@latest", "@honua/mcp-server@^0.1.4-beta.0", "@honua/mcp-server@*"]) {
      expect(() => parsePackagePin(floating)).toThrow(/exact version/);
    }
  });

  it("proves the pin is in this repository's release lineage and never ahead of mcp/package.json", async () => {
    const { changelog, packageVersion } = await repoInputs();
    const result = verifyMcpPinLineage({
      pin: LOCAL_INSTALL_MCP_PACKAGE,
      integrity: LOCAL_INSTALL_MCP_PACKAGE_INTEGRITY,
      changelog,
      packageVersion,
      packageName: LOCAL_INSTALL_MCP_PACKAGE_NAME,
    });
    expect(result.version).toBe(LOCAL_INSTALL_MCP_PACKAGE_VERSION);
    expect(releaseLineage(changelog)).toContain(LOCAL_INSTALL_MCP_PACKAGE_VERSION);
    expect(compareVersions(LOCAL_INSTALL_MCP_PACKAGE_VERSION, packageVersion)).toBeLessThanOrEqual(0);
  });

  it("rejects a pin bumped ahead of the working tree, which can never have been published", async () => {
    const { changelog, packageVersion } = await repoInputs();
    expect(() =>
      verifyMcpPinLineage({
        pin: "@honua/mcp-server@99.0.0-beta.0",
        integrity: LOCAL_INSTALL_MCP_PACKAGE_INTEGRITY,
        changelog: `${changelog}\n## [99.0.0-beta.0](https://example.invalid) (2099-01-01)\n`,
        packageVersion,
        packageName: LOCAL_INSTALL_MCP_PACKAGE_NAME,
      }),
    ).toThrow(/runs ahead of mcp\/package\.json/);
  });

  it("orders prerelease versions so a lineage entry cannot outrank the package version by accident", () => {
    expect(compareVersions("0.1.4-beta.0", "0.1.7-beta.0")).toBe(-1);
    expect(compareVersions("0.1.7-beta.0", "0.1.7-beta.0")).toBe(0);
    expect(compareVersions("0.1.7", "0.1.7-beta.0")).toBe(1);
    expect(compareVersions("0.1.10-beta.0", "0.1.9-beta.0")).toBe(1);
  });

  it("keeps the registry lane behind its dedicated live gate", () => {
    expect(isMcpPinLiveVerificationEnabled({})).toBe(false);
    expect(isMcpPinLiveVerificationEnabled({ HONUA_MCP_PIN_LIVE_ENABLED: "false" })).toBe(false);
    expect(isMcpPinLiveVerificationEnabled({ HONUA_MCP_PIN_LIVE_ENABLED: "true" })).toBe(true);
  });

  it("fails loudly when the registry does not serve the pinned version", async () => {
    const fetchFn = vi.fn(async () => new Response("Not found", { status: 404 }));
    await expect(
      verifyMcpPinPublication({
        pin: "@honua/mcp-server@0.1.7-beta.0",
        integrity: LOCAL_INSTALL_MCP_PACKAGE_INTEGRITY,
        fetchFn,
      }),
    ).rejects.toThrow(/is NOT published to the public registry/);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("fails when the registry tarball integrity drifts from the recorded digest", async () => {
    const fetchFn = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            version: LOCAL_INSTALL_MCP_PACKAGE_VERSION,
            dist: { integrity: `sha512-${"A".repeat(86)}==`, tarball: "https://registry.npmjs.org/x.tgz" },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    await expect(
      verifyMcpPinPublication({
        pin: LOCAL_INSTALL_MCP_PACKAGE,
        integrity: LOCAL_INSTALL_MCP_PACKAGE_INTEGRITY,
        fetchFn,
      }),
    ).rejects.toThrow(/integrity drifted/);
  });

  it("accepts a registry manifest that matches the recorded version and integrity", async () => {
    const fetchFn = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            version: LOCAL_INSTALL_MCP_PACKAGE_VERSION,
            dist: {
              integrity: LOCAL_INSTALL_MCP_PACKAGE_INTEGRITY,
              tarball: `https://registry.npmjs.org/@honua/mcp-server/-/mcp-server-${LOCAL_INSTALL_MCP_PACKAGE_VERSION}.tgz`,
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    await expect(
      verifyMcpPinPublication({
        pin: LOCAL_INSTALL_MCP_PACKAGE,
        integrity: LOCAL_INSTALL_MCP_PACKAGE_INTEGRITY,
        fetchFn,
      }),
    ).resolves.toMatchObject({ version: LOCAL_INSTALL_MCP_PACKAGE_VERSION });
  });
});
