import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import {
  CREATE_APP_PIN_SITES,
  PIN_SYNC_REMEDY,
  ZERO_TO_MAP_CONFIGS,
  compareVersions,
  isMcpPinLiveVerificationEnabled,
  parsePackagePin,
  releaseLineage,
  satisfiesUnderNpmDefaults,
  verifyClientPairCoInstallable,
  verifyCreateAppPins,
  verifyMcpPinLineage,
  verifyMcpPinPublication,
  verifyZeroToMapConfigPins,
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

async function readManifest(relativePath: string) {
  return JSON.parse(await readFile(path.join(projectRoot, relativePath), "utf8")) as {
    name: string;
    version: string;
    peerDependencies?: Record<string, string>;
  };
}

describe("generated MCP client configuration pin", () => {
  it("keeps every create-honua-app SDK pin on the coordinated pair", async () => {
    const sdk = await readManifest("package.json");
    expect(verifyCreateAppPins({ sdkName: sdk.name, expectedVersion: LOCAL_INSTALL_MCP_PACKAGE_VERSION })).toEqual(
      CREATE_APP_PIN_SITES.map((relativePath: string) => ({
        relativePath,
        pin: `${sdk.name}@${LOCAL_INSTALL_MCP_PACKAGE_VERSION}`,
      })),
    );
  });

  it("rejects a create-honua-app pin that drifts from the coordinated pair", () => {
    expect(() =>
      verifyCreateAppPins({
        sdkName: "@honua/sdk-js",
        expectedVersion: "0.1.9-beta.0",
        readConfig: (relativePath: string) =>
          relativePath.endsWith("templates.manifest.json")
            ? { sdk: { package: "@honua/sdk-js", version: "0.1.4-beta.0" } }
            : { dependencies: { "@honua/sdk-js": "0.1.4-beta.0" } },
      }),
    ).toThrow(/sync:mcp-pin/);
  });

  it("keeps every shipped zero-to-map config on the coordinated pin", () => {
    expect(verifyZeroToMapConfigPins({ expectedPin: LOCAL_INSTALL_MCP_PACKAGE })).toEqual(
      ZERO_TO_MAP_CONFIGS.map((relativePath: string) => ({ relativePath, pin: LOCAL_INSTALL_MCP_PACKAGE })),
    );
  });

  it("rejects a shipped config that drifts to an unpublished or floating pin", () => {
    const config = (pin: string) => ({ mcpServers: { honua: { args: ["-y", "--package", pin, "honua-mcp-proxy"] } } });
    expect(() =>
      verifyZeroToMapConfigPins({
        expectedPin: LOCAL_INSTALL_MCP_PACKAGE,
        readConfig: () => config("@honua/mcp-server@0.1.7-beta.0"),
      }),
    ).toThrow(/coordinated, registry-served pair/);
    expect(() =>
      verifyZeroToMapConfigPins({
        expectedPin: LOCAL_INSTALL_MCP_PACKAGE,
        readConfig: () => config("@honua/mcp-server@latest"),
      }),
    ).toThrow(/exact version/);
  });

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

  it("rejects a name that is not one npm package name, so the registry path cannot be redirected", () => {
    // An npm name carries at most one "/" -- the scope separator. Extra
    // separators would address a different registry path while the version and
    // integrity assertions below still compared whatever they found there.
    for (const malformed of [
      "@honua/mcp-server/../other@0.1.4-beta.0",
      "@honua/nested/name@0.1.4-beta.0",
      "@honua/mcp server@0.1.4-beta.0",
    ]) {
      expect(() => parsePackagePin(malformed)).toThrow(/valid npm package/);
    }
  });

  it("requests the pinned package as one fully encoded registry path segment", async () => {
    const requestedUrls: string[] = [];
    const fetchFn = vi.fn(async (url: string) => {
      requestedUrls.push(url);
      return new Response(
        JSON.stringify({
          version: LOCAL_INSTALL_MCP_PACKAGE_VERSION,
          dist: { integrity: LOCAL_INSTALL_MCP_PACKAGE_INTEGRITY, tarball: "https://registry.npmjs.org/x.tgz" },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    await verifyMcpPinPublication({
      pin: LOCAL_INSTALL_MCP_PACKAGE,
      integrity: LOCAL_INSTALL_MCP_PACKAGE_INTEGRITY,
      fetchFn,
    });
    expect(requestedUrls).toHaveLength(1);
    const requested = new URL(String(requestedUrls[0]));
    expect(requested.origin).toBe("https://registry.npmjs.org");
    // Encoded, the scoped name is a single segment: /<name>/<version>.
    expect(requested.pathname.split("/").filter(Boolean)).toEqual([
      encodeURIComponent(LOCAL_INSTALL_MCP_PACKAGE_NAME),
      LOCAL_INSTALL_MCP_PACKAGE_VERSION,
    ]);
    expect(requested.pathname).toContain("%2F");
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

describe("pinned client pair co-installability (#1529)", () => {
  it("applies npm's real prerelease rule: only a same-tuple prerelease comparator admits a prerelease", () => {
    // Measured against the `semver` in this repository's lockfile. Bounds are
    // irrelevant to the prerelease test, which is why widening a range cannot
    // fix an excluded prerelease -- even `*` excludes it.
    for (const range of ["^0.1.8-beta.0", ">=0.1.8-beta.0 <0.2.0-0", ">=0.1.8-beta.0", "0.1.x", "*"]) {
      expect(satisfiesUnderNpmDefaults("0.1.9-beta.0", range)).toBe(false);
    }
    expect(satisfiesUnderNpmDefaults("0.1.9-beta.0", "^0.1.9-beta.0")).toBe(true);
    // What `^0.1.8-beta.0` does and does not accept.
    expect(satisfiesUnderNpmDefaults("0.1.8-beta.0", "^0.1.8-beta.0")).toBe(true);
    expect(satisfiesUnderNpmDefaults("0.1.8-beta.1", "^0.1.8-beta.0")).toBe(true);
    expect(satisfiesUnderNpmDefaults("0.1.9", "^0.1.8-beta.0")).toBe(true);
    expect(satisfiesUnderNpmDefaults("0.1.10-beta.0", "^0.1.8-beta.0")).toBe(false);
    expect(satisfiesUnderNpmDefaults("0.2.0-beta.0", "^0.1.8-beta.0")).toBe(false);
    // A union re-anchors the range on the tuple in question.
    expect(satisfiesUnderNpmDefaults("0.1.9-beta.0", "^0.1.8-beta.0 || ^0.1.9-beta.0")).toBe(true);
  });

  it("keeps ordinary stable-range semantics intact", () => {
    expect(satisfiesUnderNpmDefaults("1.2.3", "^1.0.0")).toBe(true);
    expect(satisfiesUnderNpmDefaults("2.0.0", "^1.0.0")).toBe(false);
    expect(satisfiesUnderNpmDefaults("1.2.3", "~1.2.0")).toBe(true);
    expect(satisfiesUnderNpmDefaults("1.3.0", "~1.2.0")).toBe(false);
    expect(satisfiesUnderNpmDefaults("0.0.5", "^0.0.4")).toBe(false);
    expect(satisfiesUnderNpmDefaults("0.1.5", "0.1.x")).toBe(true);
    expect(satisfiesUnderNpmDefaults("0.2.0", "0.1.x")).toBe(false);
  });

  it("keeps caret semantics when the range carries a wildcard", () => {
    // A caret over an X-range holds the leftmost part the token actually
    // specifies, which is not the band the X-range alone denotes: `^1.2.x`
    // reaches into 1.9.x, while `1.2.x` and `~1.2.x` stop below 1.3.0.
    expect(satisfiesUnderNpmDefaults("1.9.9", "^1.2.x")).toBe(true);
    expect(satisfiesUnderNpmDefaults("1.9.9", "~1.2.x")).toBe(false);
    expect(satisfiesUnderNpmDefaults("1.9.9", "1.2.x")).toBe(false);
    expect(satisfiesUnderNpmDefaults("2.0.0", "^1.2.x")).toBe(false);
    expect(satisfiesUnderNpmDefaults("1.2.0", "^1.2")).toBe(true);
    expect(satisfiesUnderNpmDefaults("1.9.9", "^1.2")).toBe(true);
    // A wildcard minor widens caret and tilde alike to the whole major.
    expect(satisfiesUnderNpmDefaults("1.9.9", "^1.x")).toBe(true);
    expect(satisfiesUnderNpmDefaults("1.9.9", "~1.x")).toBe(true);
    expect(satisfiesUnderNpmDefaults("2.0.0", "~1.x")).toBe(false);
    // Zero majors: the parts the token omits must not be read as a
    // leftmost-zero, so `^0.0.x` covers the minor rather than a single patch.
    expect(satisfiesUnderNpmDefaults("0.0.5", "^0.0.x")).toBe(true);
    expect(satisfiesUnderNpmDefaults("0.1.0", "^0.0.x")).toBe(false);
    expect(satisfiesUnderNpmDefaults("0.0.5", "^0.0.4")).toBe(false);
    expect(satisfiesUnderNpmDefaults("0.2.9", "^0.2.x")).toBe(true);
    expect(satisfiesUnderNpmDefaults("0.3.0", "^0.2.x")).toBe(false);
    expect(satisfiesUnderNpmDefaults("0.9.9", "^0.x")).toBe(true);
    expect(satisfiesUnderNpmDefaults("1.0.0", "^0.x")).toBe(false);
  });

  it("refuses a range shape it cannot reason about rather than assuming it is satisfied", () => {
    // Failing closed matters more than coverage here: a parser that shrugs at
    // an unfamiliar token would report every pair as co-installable.
    for (const range of ["not-a-range", ">=1.0.0 - 2.0.0 broken", "^"]) {
      expect(() => satisfiesUnderNpmDefaults("1.0.0", range)).toThrow();
    }
  });

  it("rejects the exact pair honua-release#205 could not install", () => {
    // @honua/sdk-js@0.1.7-beta.0 was the newest published SDK while
    // @honua/mcp-server@0.1.8-beta.0 was the newest published proxy, and
    // `npm install` of that pair fails ERESOLVE.
    expect(() =>
      verifyClientPairCoInstallable({
        sdkName: "@honua/sdk-js",
        sdkVersion: "0.1.7-beta.0",
        mcpName: "@honua/mcp-server",
        mcpVersion: "0.1.8-beta.0",
        peerRange: "^0.1.8-beta.0",
      }),
    ).toThrow(/does NOT consider satisfied/);
  });

  it("rejects a pin held behind the SDK it ships beside", () => {
    // The regression this repository actually shipped: the pin was held at the
    // newest *published* proxy without checking that its peer range still
    // admitted the SDK version being published next to it.
    expect(() =>
      verifyClientPairCoInstallable({
        sdkName: "@honua/sdk-js",
        sdkVersion: "0.1.9-beta.0",
        mcpName: "@honua/mcp-server",
        mcpVersion: "0.1.4-beta.0",
        peerRange: "^0.1.4-beta.0",
      }),
    ).toThrow(/does NOT consider satisfied/);
  });

  it("rejects an MCP artifact that declares no peer range at all", () => {
    expect(() =>
      verifyClientPairCoInstallable({
        sdkName: "@honua/sdk-js",
        sdkVersion: "0.1.9-beta.0",
        mcpName: "@honua/mcp-server",
        mcpVersion: "0.1.9-beta.0",
        peerRange: undefined,
      }),
    ).toThrow(/must declare a @honua\/sdk-js peer range/);
  });

  it("proves the pair this working tree would cut co-installs", async () => {
    const [sdk, mcp] = await Promise.all([readManifest("package.json"), readManifest("mcp/package.json")]);
    expect(() =>
      verifyClientPairCoInstallable({
        sdkName: sdk.name,
        sdkVersion: sdk.version,
        mcpName: mcp.name,
        mcpVersion: mcp.version,
        peerRange: mcp.peerDependencies?.[sdk.name],
      }),
    ).not.toThrow();
  });

  it("either co-installs the pinned pair or is exactly the state the publish gate refuses", async () => {
    const sdk = await readManifest("package.json");
    // release-please writes the peer range as a caret on the MCP version at the
    // commit that cut it, so that is the range the pinned tarball carries; the
    // live lane re-reads it from the registry rather than trusting this.
    const pinned = {
      sdkName: sdk.name,
      sdkVersion: sdk.version,
      mcpName: LOCAL_INSTALL_MCP_PACKAGE_NAME,
      mcpVersion: LOCAL_INSTALL_MCP_PACKAGE_VERSION,
      peerRange: `^${LOCAL_INSTALL_MCP_PACKAGE_VERSION}`,
    };
    if (LOCAL_INSTALL_MCP_PACKAGE_VERSION === sdk.version) {
      expect(() => verifyClientPairCoInstallable(pinned)).not.toThrow();
      return;
    }
    // Between a release-please bump and the coordinated MCP publish the pin
    // legitimately lags, and no edit can fix it until the MCP half reaches the
    // registry -- asserting green here would redden every release PR with
    // nothing a contributor could do about it. The state is still not allowed
    // to ship, so assert the gate that stops it actually fires.
    expect(() => verifyClientPairCoInstallable(pinned)).toThrow(/does NOT consider satisfied/);
  });

  it("tells a lagging pin exactly how to catch up, publish first", () => {
    // A gate that fails without naming its remedy is a gate people route
    // around. The pin cannot advance before the coordinated publish, so the
    // message has to say that rather than just "update the pin".
    let message = "";
    try {
      verifyClientPairCoInstallable({
        sdkName: "@honua/sdk-js",
        sdkVersion: "0.1.10-beta.0",
        mcpName: "@honua/mcp-server",
        mcpVersion: "0.1.9-beta.0",
        peerRange: "^0.1.9-beta.0",
        remedy: PIN_SYNC_REMEDY,
      });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/npm run sync:mcp-pin/);
    expect(message).toMatch(/publish the coordinated @honua\/mcp-server cut/);
    expect(message).toMatch(/LOCAL_INSTALL_MCP_PACKAGE_INTEGRITY/);
  });
});
