import { describe, expect, it } from "vitest";
import {
  HONUA_PLUGIN_API_VERSION,
  HONUA_PLUGIN_MANIFEST_VERSION,
  type HonuaPluginCertificationHost,
  type HonuaPluginManifest,
  certifyHonuaPluginManifest,
  validateHonuaPluginManifest,
} from "../src/plugin/index.js";

const manifest = {
  manifestVersion: HONUA_PLUGIN_MANIFEST_VERSION,
  id: "io.honua.partner.parquet",
  version: "2.1.0-beta.1",
  kind: "source-format",
  package: { name: "@partner/honua-parquet", entrypoint: "./plugin.js" },
  compatibility: {
    pluginApi: HONUA_PLUGIN_API_VERSION,
    minimumSdk: "0.1.0-beta.0",
    maximumSdkExclusive: "0.2.0",
    environments: ["browser", "worker"],
  },
  capabilities: ["read", "stream"],
  peers: [
    { name: "apache-arrow", minimumVersion: "18.0.0" },
    { name: "optional-observer", minimumVersion: "1.0.0", optional: true },
  ],
  requestedGrants: {
    networkOrigins: ["https://data.example.com"],
    credentialScopes: ["data:read"],
    storage: "scoped",
  },
  data: {
    cache: "persistent",
    freshness: "snapshot",
    authentication: "application-grant",
    provenance: "preserved",
    mutation: "none",
    realtime: "none",
  },
  lifecycle: { initialization: "explicit", disposal: "required" },
  support: "partner",
} as const satisfies HonuaPluginManifest<"source-format">;

const host = {
  pluginApi: HONUA_PLUGIN_API_VERSION,
  sdkVersion: "0.1.0-beta.2",
  environment: "browser",
  peers: { "apache-arrow": "18.1.0" },
  grants: {
    networkOrigins: ["https://data.example.com"],
    credentialScopes: ["data:read"],
    storage: "scoped",
  },
} as const satisfies HonuaPluginCertificationHost;

describe("plugin manifest validation", () => {
  it("accepts a strict, versioned manifest without executing its entrypoint", () => {
    const result = validateHonuaPluginManifest(manifest);
    expect(result.ok).toBe(true);
    expect(result.manifest).toBe(manifest);
    expect(result.diagnostics).toEqual([]);
  });

  it("rejects unknown fields, unsafe entrypoints, wildcard origins, and capability inflation", () => {
    const result = validateHonuaPluginManifest({
      ...manifest,
      hiddenLoader: "eval(payload)",
      package: { ...manifest.package, entrypoint: "../../steal.js" },
      capabilities: ["read", "write", "admin"],
      requestedGrants: {
        ...manifest.requestedGrants,
        networkOrigins: ["https://*.example.com", "https://data.example.com/path"],
      },
    });

    expect(result.ok).toBe(false);
    expect(result.diagnostics.map((item) => item.code)).toEqual([
      "CAPABILITY_KIND_MISMATCH",
      "MANIFEST_UNKNOWN_FIELD",
      "ENTRYPOINT_UNSAFE",
      "NETWORK_ORIGIN_UNSAFE",
      "NETWORK_ORIGIN_UNSAFE",
    ]);
  });

  it("requires declared data semantics to match requested authorities", () => {
    const result = validateHonuaPluginManifest({
      ...manifest,
      requestedGrants: {},
      data: { ...manifest.data, mutation: "explicit" },
    });

    expect(result.diagnostics.map((item) => item.code)).toEqual([
      "CREDENTIAL_SCOPE_REQUIRED",
      "MUTATION_GRANT_REQUIRED",
      "STORAGE_GRANT_REQUIRED",
    ]);
  });

  it("rejects non-canonical semantic versions", () => {
    const result = validateHonuaPluginManifest({ ...manifest, version: "2.1.0-01" });
    expect(result.diagnostics).toEqual([expect.objectContaining({ code: "SEMVER_INVALID", path: "/version" })]);
  });
});

describe("plugin manifest certification", () => {
  it("emits a deterministic, machine-readable report", () => {
    const first = certifyHonuaPluginManifest(manifest, host);
    const second = certifyHonuaPluginManifest(structuredClone(manifest), structuredClone(host));

    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(first).toMatchObject({
      reportVersion: 1,
      manifestVersion: 1,
      plugin: { id: manifest.id, version: manifest.version, kind: "source-format" },
      status: "certified",
    });
    expect(first.diagnostics).toEqual([
      expect.objectContaining({ code: "OPTIONAL_PEER_MISSING", severity: "warning" }),
    ]);
    expect(first.checks).toHaveLength(6);
  });

  it("rejects incompatible hosts and authorities that were not explicitly granted", () => {
    const report = certifyHonuaPluginManifest(manifest, {
      ...host,
      sdkVersion: "0.2.0",
      environment: "node",
      peers: { "apache-arrow": "17.0.0" },
      grants: {},
    });

    expect(report.status).toBe("rejected");
    expect(report.diagnostics.map((item) => item.code)).toEqual([
      "HOST_ENVIRONMENT_UNSUPPORTED",
      "HOST_SDK_TOO_NEW",
      "HOST_PEER_TOO_OLD",
      "OPTIONAL_PEER_MISSING",
      "CREDENTIAL_GRANT_MISSING",
      "NETWORK_GRANT_MISSING",
      "STORAGE_GRANT_MISSING",
    ]);
    expect(report.checks.filter((check) => check.status === "failed").map((check) => check.check)).toEqual([
      "compatibility",
      "environment",
      "peers",
      "security-boundary",
    ]);
  });

  it("never certifies malformed input when identity cannot be trusted", () => {
    const report = certifyHonuaPluginManifest({ manifestVersion: 99, id: "BAD" }, host);
    expect(report.status).toBe("rejected");
    expect(report.plugin).toBeNull();
    expect(report.diagnostics.length).toBeGreaterThan(5);
  });
});
