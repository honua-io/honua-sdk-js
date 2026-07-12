import { describe, expect, it, vi } from "vitest";
import {
  HONUA_PLUGIN_API_VERSION,
  HONUA_PLUGIN_CAPABILITY_REQUIRED_GRANTS,
  HONUA_PLUGIN_MANIFEST_VERSION,
  type HonuaPluginCertificationHost,
  type HonuaPluginManifest,
  certifyHonuaPluginManifest as certifyJsonText,
  validateHonuaPluginManifest as validateJsonText,
  verifyHonuaPluginCertificationReport,
} from "../src/plugin/index.js";

function validateHonuaPluginManifest(value: unknown) {
  return validateJsonText(jsonText(value));
}

function certifyHonuaPluginManifest(manifestValue: unknown, hostValue: unknown) {
  return certifyJsonText(jsonText(manifestValue), jsonText(hostValue));
}

function jsonText(value: unknown): string {
  const text = JSON.stringify(value);
  if (text === undefined) throw new TypeError("test fixture is not JSON serializable");
  return text;
}

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

  it("rejects raw objects, accessors, proxies, and noncloneable values without invoking user code", () => {
    let getterCalls = 0;
    const withGetter = { ...manifest } as Record<string, unknown>;
    Object.defineProperty(withGetter, "id", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return manifest.id;
      },
    });
    expect(validateJsonText(withGetter as never).diagnostics[0]?.code).toBe("INPUT_JSON_TEXT_REQUIRED");
    expect(getterCalls).toBe(0);

    const traps = { getPrototypeOf: 0, ownKeys: 0, getOwnPropertyDescriptor: 0, get: 0 };
    const proxy = new Proxy(
      {},
      {
        getPrototypeOf() {
          traps.getPrototypeOf += 1;
          return Object.prototype;
        },
        ownKeys() {
          traps.ownKeys += 1;
          return [];
        },
        getOwnPropertyDescriptor() {
          traps.getOwnPropertyDescriptor += 1;
          return undefined;
        },
        get() {
          traps.get += 1;
          return undefined;
        },
      },
    );
    expect(validateJsonText(proxy as never).diagnostics[0]?.code).toBe("INPUT_JSON_TEXT_REQUIRED");
    expect(traps).toEqual({ getPrototypeOf: 0, ownKeys: 0, getOwnPropertyDescriptor: 0, get: 0 });

    for (const value of [Symbol("manifest"), 1n, () => undefined, new Date()]) {
      expect(validateJsonText(value as never).diagnostics[0]?.code).toBe("INPUT_JSON_TEXT_REQUIRED");
    }
  });

  it("rejects wide dense array and object text before JSON.parse materializes values", () => {
    const parse = vi.spyOn(JSON, "parse");
    const wideArray = `[${new Array(20_000).fill("0").join(",")}]`;
    const wideObject = `{${Array.from({ length: 20_000 }, (_, index) => `"field-${index}":${index}`).join(",")}}`;

    expect(validateJsonText(wideArray).diagnostics).toEqual([
      expect.objectContaining({ code: "INPUT_TOO_LARGE", path: "/" }),
    ]);
    expect(validateJsonText(wideObject).diagnostics).toEqual([
      expect.objectContaining({ code: "INPUT_TOO_LARGE", path: "/" }),
    ]);
    expect(parse).not.toHaveBeenCalled();
    parse.mockRestore();
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
    expect(first.checks).toHaveLength(7);
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
    const getterReport = certifyJsonText(jsonText(manifest), getterHost as never);
    expect(getterReport.status).toBe("rejected");
    expect(getterReport.diagnostics[0]?.code).toBe("INPUT_JSON_TEXT_REQUIRED");
    expect(getterCalls).toBe(0);

    const trapCalls = { getPrototypeOf: 0, ownKeys: 0, getOwnPropertyDescriptor: 0, get: 0 };
    const proxyHost = new Proxy(
      {},
      {
        getPrototypeOf() {
          trapCalls.getPrototypeOf += 1;
          return Object.prototype;
        },
        ownKeys() {
          trapCalls.ownKeys += 1;
          return [];
        },
        getOwnPropertyDescriptor() {
          trapCalls.getOwnPropertyDescriptor += 1;
          return undefined;
        },
        get() {
          trapCalls.get += 1;
          return undefined;
        },
      },
    );
    expect(certifyJsonText(jsonText(manifest), proxyHost as never).status).toBe("rejected");
    expect(trapCalls).toEqual({ getPrototypeOf: 0, ownKeys: 0, getOwnPropertyDescriptor: 0, get: 0 });

    for (const hostile of [Symbol("host"), 1n, () => undefined]) {
      expect(() => certifyJsonText(jsonText(manifest), hostile as never)).not.toThrow();
      expect(certifyJsonText(jsonText(manifest), hostile as never).status).toBe("rejected");
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

describe("plugin support-status program", () => {
  it("certifies a well-formed support-status attestation and exposes it in the snapshot", () => {
    const report = certifyHonuaPluginManifest(
      {
        ...manifest,
        supportStatus: {
          state: "deprecated",
          since: "2.0.0",
          removedIn: "3.0.0",
          replacement: "io.honua.partner.arrow2",
        },
      },
      host,
    );
    expect(report.status).toBe("certified");
    expect((report.manifest.snapshot as { supportStatus?: unknown }).supportStatus).toEqual({
      state: "deprecated",
      since: "2.0.0",
      removedIn: "3.0.0",
      replacement: "io.honua.partner.arrow2",
    });
    expect(report.checks.find((check) => check.check === "support")?.status).toBe("passed");
  });

  it("rejects a deprecated status that names neither a removal version nor a replacement", () => {
    const report = certifyHonuaPluginManifest({ ...manifest, supportStatus: { state: "deprecated" } }, host);
    expect(report.status).toBe("rejected");
    expect(report.diagnostics.map((item) => item.code)).toContain("SUPPORT_DEPRECATION_INCOMPLETE");
    expect(report.checks.find((check) => check.check === "support")?.status).toBe("failed");
  });

  it("rejects an unknown support state and a non-semver since", () => {
    const report = certifyHonuaPluginManifest(
      { ...manifest, supportStatus: { state: "sunset", since: "yesterday" } },
      host,
    );
    expect(report.status).toBe("rejected");
    const codes = report.diagnostics.map((item) => item.code);
    expect(codes).toContain("MANIFEST_ENUM");
    expect(codes).toContain("SEMVER_INVALID");
  });
});

describe("signed certification report verification", () => {
  it("verifies an untampered report by recomputing every digest", () => {
    const report = certifyHonuaPluginManifest(manifest, host);
    const verification = verifyHonuaPluginCertificationReport(JSON.stringify(report));
    expect(verification.ok).toBe(true);
    expect(verification.status).toBe("certified");
    expect(verification.diagnostics).toEqual([]);
  });

  it("detects a tampered diagnostic even when the top-level digest is left intact", () => {
    const report = JSON.parse(JSON.stringify(certifyHonuaPluginManifest(manifest, host)));
    report.status = "rejected";
    const verification = verifyHonuaPluginCertificationReport(JSON.stringify(report));
    expect(verification.ok).toBe(false);
    expect(verification.diagnostics.map((item) => item.code)).toContain("REPORT_SIGNATURE_MISMATCH");
  });

  it("detects a swapped manifest snapshot whose fingerprint no longer matches", () => {
    const report = JSON.parse(JSON.stringify(certifyHonuaPluginManifest(manifest, host)));
    (report.manifest.snapshot as { id: string }).id = "io.honua.impostor";
    const verification = verifyHonuaPluginCertificationReport(JSON.stringify(report));
    expect(verification.ok).toBe(false);
    expect(verification.diagnostics.map((item) => item.code)).toContain("REPORT_FINGERPRINT_MISMATCH");
  });

  it("rejects non-JSON report text without executing accessors", () => {
    const verification = verifyHonuaPluginCertificationReport("not json");
    expect(verification.ok).toBe(false);
    expect(verification.status).toBeNull();
  });
});
