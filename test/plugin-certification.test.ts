import { describe, expect, it } from "vitest";
import {
  HONUA_PLUGIN_API_VERSION,
  HONUA_PLUGIN_CAPABILITY_REQUIRED_GRANTS,
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
    expect(result.manifest).toStrictEqual(manifest);
    expect(result.manifest).not.toBe(manifest);
    expect(result.diagnostics).toEqual([]);
  });

  it("rejects unknown fields, unsafe entrypoints, wildcard origins, and capability inflation", () => {
    const result = validateHonuaPluginManifest({
      ...manifest,
      hiddenLoader: "eval(payload)",
      package: { ...manifest.package, entrypoint: "../../steal.js" },
      capabilities: ["read", "admin"],
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

  it("derives mutation and storage authority from machine-readable capability semantics", () => {
    expect(HONUA_PLUGIN_CAPABILITY_REQUIRED_GRANTS.protocol.edit).toEqual({ mutation: true });
    expect(HONUA_PLUGIN_CAPABILITY_REQUIRED_GRANTS["source-format"].write).toEqual({ mutation: true });
    expect(HONUA_PLUGIN_CAPABILITY_REQUIRED_GRANTS.cache.write).toEqual({ storage: "scoped" });
    expect(Object.isFrozen(HONUA_PLUGIN_CAPABILITY_REQUIRED_GRANTS)).toBe(true);
    expect(Object.isFrozen(HONUA_PLUGIN_CAPABILITY_REQUIRED_GRANTS.protocol)).toBe(true);
    expect(Object.isFrozen(HONUA_PLUGIN_CAPABILITY_REQUIRED_GRANTS.protocol.edit)).toBe(true);
    expect(Reflect.deleteProperty(HONUA_PLUGIN_CAPABILITY_REQUIRED_GRANTS.protocol, "edit")).toBe(false);

    const editing = validateHonuaPluginManifest({
      ...manifest,
      kind: "protocol",
      capabilities: ["edit"],
      requestedGrants: {},
      data: { ...manifest.data, cache: "none", authentication: "none", mutation: "none" },
    });
    expect(editing.diagnostics.map((item) => item.code)).toEqual([
      "CAPABILITY_MUTATION_GRANT_REQUIRED",
      "CAPABILITY_MUTATION_SEMANTICS_REQUIRED",
    ]);

    const writing = validateHonuaPluginManifest({
      ...manifest,
      capabilities: ["write"],
      requestedGrants: {},
      data: { ...manifest.data, cache: "none", authentication: "none", mutation: "none" },
    });
    expect(writing.diagnostics.map((item) => item.code)).toEqual([
      "CAPABILITY_MUTATION_GRANT_REQUIRED",
      "CAPABILITY_MUTATION_SEMANTICS_REQUIRED",
    ]);

    const cacheWrite = validateHonuaPluginManifest({
      ...manifest,
      kind: "cache",
      capabilities: ["write"],
      requestedGrants: {},
      data: { ...manifest.data, cache: "memory", authentication: "none" },
    });
    expect(cacheWrite.diagnostics.map((item) => item.code)).toEqual([
      "CAPABILITY_STORAGE_GRANT_REQUIRED",
      "CAPABILITY_STORAGE_SEMANTICS_REQUIRED",
    ]);
  });

  it("accepts capability-derived authorities only when semantics and grants agree", () => {
    expect(
      validateHonuaPluginManifest({
        ...manifest,
        kind: "protocol",
        capabilities: ["edit"],
        requestedGrants: { mutation: true },
        data: { ...manifest.data, cache: "none", authentication: "none", mutation: "explicit" },
      }).ok,
    ).toBe(true);
    expect(
      validateHonuaPluginManifest({
        ...manifest,
        kind: "cache",
        capabilities: ["write"],
        requestedGrants: { storage: "scoped" },
        data: { ...manifest.data, cache: "persistent", authentication: "none" },
      }).ok,
    ).toBe(true);
  });

  it("rejects accessors, proxies, inherited objects, and non-JSON values without invoking getters", () => {
    let getterCalls = 0;
    const withGetter = { ...manifest } as Record<string, unknown>;
    Object.defineProperty(withGetter, "id", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return manifest.id;
      },
    });
    expect(validateHonuaPluginManifest(withGetter).diagnostics[0]?.code).toBe("INPUT_ACCESSOR_OR_HIDDEN_PROPERTY");
    expect(getterCalls).toBe(0);

    expect(validateHonuaPluginManifest(new Proxy({ ...manifest }, {})).diagnostics[0]?.code).toBe(
      "INPUT_NOT_INERT_JSON",
    );
    expect(
      validateHonuaPluginManifest(Object.assign(Object.create({ inherited: true }), manifest)).diagnostics[0]?.code,
    ).toBe("INPUT_NON_PLAIN_OBJECT");
    expect(validateHonuaPluginManifest(Symbol("manifest")).diagnostics[0]?.code).toBe("INPUT_NON_JSON_VALUE");
  });

  it("decodes the entrypoint before rejecting traversal and absolute escapes", () => {
    for (const entrypoint of ["./%2e%2e/secret.js", "./%252e%252e/secret.js", "%2fetc/passwd", "./C:%5csecret.js"]) {
      const result = validateHonuaPluginManifest({ ...manifest, package: { ...manifest.package, entrypoint } });
      expect(
        result.diagnostics.map((item) => item.code),
        entrypoint,
      ).toContain("ENTRYPOINT_UNSAFE");
    }

    const benign = validateHonuaPluginManifest({
      ...manifest,
      package: { ...manifest.package, entrypoint: "./%70lugin.js" },
    });
    expect(benign.ok).toBe(true);
    expect(benign.manifest?.package.entrypoint).toBe("./plugin.js");
  });

  it("returns a normalized deep-frozen snapshot detached from the caller", () => {
    const caller = structuredClone(manifest) as unknown as HonuaPluginManifest<"source-format">;
    const result = validateHonuaPluginManifest(caller);
    expect(result.ok).toBe(true);
    expect(Object.isFrozen(result.manifest)).toBe(true);
    expect(Object.isFrozen(result.manifest?.package)).toBe(true);
    expect(Object.isFrozen(result.manifest?.capabilities)).toBe(true);
    expect(result.manifest).not.toBe(caller);
  });
});

describe("plugin manifest certification", () => {
  it("emits a deterministic, machine-readable report", () => {
    const first = certifyHonuaPluginManifest(manifest, host);
    const second = certifyHonuaPluginManifest(structuredClone(manifest), structuredClone(host));

    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(first).toMatchObject({
      reportVersion: 1,
      plugin: { id: manifest.id, version: manifest.version, kind: "source-format" },
      status: "certified",
    });
    expect(first.manifest.snapshot).toMatchObject({
      package: { entrypoint: "./plugin.js" },
      capabilities: ["read", "stream"],
      requestedGrants: { credentialScopes: ["data:read"], networkOrigins: ["https://data.example.com"] },
    });
    expect(first.manifest.sha256).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(first.host.snapshot).toMatchObject({
      environment: "browser",
      peers: { "apache-arrow": "18.1.0" },
      grants: { credentialScopes: ["data:read"], networkOrigins: ["https://data.example.com"] },
    });
    expect(first.host.sha256).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(first.sha256).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.manifest.snapshot)).toBe(true);
    expect(Object.isFrozen(first.host.snapshot)).toBe(true);
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

  it("binds archived reports to complete manifest and host snapshots", () => {
    const baseline = certifyHonuaPluginManifest(manifest, host);
    const changedCapability = certifyHonuaPluginManifest({ ...manifest, capabilities: ["read"] }, host);
    const changedEntrypoint = certifyHonuaPluginManifest(
      { ...manifest, package: { ...manifest.package, entrypoint: "./alternate.js" } },
      host,
    );
    const changedSemantics = certifyHonuaPluginManifest(
      { ...manifest, data: { ...manifest.data, freshness: "ttl" } },
      host,
    );
    const changedHostPeer = certifyHonuaPluginManifest(manifest, {
      ...host,
      peers: { "apache-arrow": "18.2.0" },
    });
    const changedHostGrant = certifyHonuaPluginManifest(manifest, {
      ...host,
      grants: { ...host.grants, credentialScopes: ["data:read", "data:audit"] },
    });

    expect(
      new Set([
        baseline.manifest.sha256,
        changedCapability.manifest.sha256,
        changedEntrypoint.manifest.sha256,
        changedSemantics.manifest.sha256,
      ]),
    ).toHaveLength(4);
    expect(changedHostPeer.host.sha256).not.toBe(baseline.host.sha256);
    expect(changedHostGrant.host.sha256).not.toBe(baseline.host.sha256);
    expect(
      new Set([baseline.sha256, changedCapability.sha256, changedEntrypoint.sha256, changedSemantics.sha256]),
    ).toHaveLength(4);
    expect(changedHostPeer.sha256).not.toBe(baseline.sha256);
    expect(changedHostGrant.sha256).not.toBe(baseline.sha256);
  });

  it("hashes dangerous own keys without __proto__ collisions and escapes diagnostic pointers", () => {
    const json = JSON.stringify(manifest);
    const first = JSON.parse(`${json.slice(0, -1)},"__proto__":"first","a/b~c":1}`);
    const second = JSON.parse(`${json.slice(0, -1)},"__proto__":"second","a/b~c":1}`);
    const firstReport = certifyHonuaPluginManifest(first, host);
    const secondReport = certifyHonuaPluginManifest(second, host);

    expect(firstReport.manifest.snapshot).toHaveProperty("__proto__", "first");
    expect(firstReport.manifest.sha256).not.toBe(secondReport.manifest.sha256);
    expect(firstReport.sha256).not.toBe(secondReport.sha256);
    expect(firstReport.diagnostics.map((item) => item.path)).toEqual(
      expect.arrayContaining(["/__proto__", "/a~1b~0c"]),
    );

    const hostileHost = certifyHonuaPluginManifest(manifest, {
      ...host,
      peers: { ...host.peers, "bad/name~peer": "not-semver" },
    });
    expect(hostileHost.diagnostics.map((item) => item.path)).toContain("/host/peers/bad~1name~0peer");
  });

  it("runtime-validates hostile host values into structured rejection reports", () => {
    let getterCalls = 0;
    const getterHost = { ...host } as Record<string, unknown>;
    Object.defineProperty(getterHost, "sdkVersion", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return host.sdkVersion;
      },
    });
    const getterReport = certifyHonuaPluginManifest(manifest, getterHost);
    expect(getterReport.status).toBe("rejected");
    expect(getterReport.diagnostics[0]?.code).toBe("INPUT_ACCESSOR_OR_HIDDEN_PROPERTY");
    expect(getterCalls).toBe(0);

    for (const hostile of [
      Symbol("host"),
      new Proxy({ ...host }, {}),
      { ...host, peers: { "apache-arrow": Symbol("v") } },
    ]) {
      expect(() => certifyHonuaPluginManifest(manifest, hostile)).not.toThrow();
      expect(certifyHonuaPluginManifest(manifest, hostile).status).toBe("rejected");
    }
  });

  it("uses SemVer ASCII ordering independent of the process locale", () => {
    const asciiManifest = {
      ...manifest,
      compatibility: { ...manifest.compatibility, minimumSdk: "1.0.0-alpha.B", maximumSdkExclusive: "1.0.0" },
    };
    const report = certifyHonuaPluginManifest(asciiManifest, { ...host, sdkVersion: "1.0.0-alpha.a" });
    expect(report.diagnostics.map((item) => item.code)).not.toContain("HOST_SDK_TOO_OLD");
  });

  it("compares arbitrary-size numeric prerelease identifiers without precision loss", () => {
    const numericManifest = {
      ...manifest,
      compatibility: {
        ...manifest.compatibility,
        minimumSdk: "1.0.0-alpha.9007199254740993",
        maximumSdkExclusive: "1.0.0",
      },
    };
    const older = certifyHonuaPluginManifest(numericManifest, {
      ...host,
      sdkVersion: "1.0.0-alpha.9007199254740992",
    });
    expect(older.diagnostics.map((item) => item.code)).toContain("HOST_SDK_TOO_OLD");

    const hugeMinimum = `1.0.0-alpha.${"9".repeat(10_000)}`;
    const hugeHost = `1.0.0-alpha.${"1".repeat(9_999)}`;
    const huge = certifyHonuaPluginManifest(
      { ...numericManifest, compatibility: { ...numericManifest.compatibility, minimumSdk: hugeMinimum } },
      { ...host, sdkVersion: hugeHost },
    );
    expect(huge.diagnostics.map((item) => item.code)).toContain("HOST_SDK_TOO_OLD");

    const laterIdentifier = certifyHonuaPluginManifest(
      {
        ...numericManifest,
        compatibility: { ...numericManifest.compatibility, minimumSdk: "1.0.0-alpha.1.2" },
      },
      { ...host, sdkVersion: "1.0.0-alpha.1.1" },
    );
    expect(laterIdentifier.diagnostics.map((item) => item.code)).toContain("HOST_SDK_TOO_OLD");

    const equal = certifyHonuaPluginManifest(
      {
        ...numericManifest,
        compatibility: { ...numericManifest.compatibility, minimumSdk: "1.0.0-alpha.1.1" },
      },
      { ...host, sdkVersion: "1.0.0-alpha.1.1" },
    );
    expect(equal.diagnostics.map((item) => item.code)).not.toContain("HOST_SDK_TOO_OLD");
  });
});
