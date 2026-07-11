# Plugin manifest and certification contract

The experimental `@honua/sdk-js/plugin` entrypoint is the first bounded slice
of the plugin SDK tracked by [issue #392](https://github.com/honua-io/honua-sdk-js/issues/392).
It lets a third-party package describe its compatibility and authority boundary
as inert JSON, then produces a deterministic report for a specific host.

This slice does **not** import plugin code, install packages, maintain a global
registry, or pass credentials to an extension. A certified manifest means only
that its declaration is well formed and compatible with the supplied host
snapshot. Behavioral fixtures, cancellation, retries, cleanup, performance,
runtime registration, and support-program review remain future certification
phases.

## Authoring a manifest

```ts
import {
  HONUA_PLUGIN_API_VERSION,
  HONUA_PLUGIN_MANIFEST_VERSION,
  certifyHonuaPluginManifest,
  type HonuaPluginManifest,
} from "@honua/sdk-js/plugin";

const manifest = {
  manifestVersion: HONUA_PLUGIN_MANIFEST_VERSION,
  id: "com.example.cloud-tiles",
  version: "1.0.0",
  kind: "protocol",
  package: { name: "@example/honua-cloud-tiles", entrypoint: "./plugin.js" },
  compatibility: {
    pluginApi: HONUA_PLUGIN_API_VERSION,
    minimumSdk: "0.1.0-beta.0",
    maximumSdkExclusive: "0.2.0",
    environments: ["browser", "worker"],
  },
  capabilities: ["tiles"],
  requestedGrants: { networkOrigins: ["https://tiles.example.com"] },
  data: {
    cache: "memory",
    freshness: "ttl",
    authentication: "none",
    provenance: "preserved",
    mutation: "none",
    realtime: "none",
  },
  lifecycle: { initialization: "explicit", disposal: "required" },
  support: "community",
} as const satisfies HonuaPluginManifest<"protocol">;

const report = certifyHonuaPluginManifest(manifest, {
  pluginApi: HONUA_PLUGIN_API_VERSION,
  sdkVersion: "0.1.0-beta.0",
  environment: "browser",
  grants: { networkOrigins: ["https://tiles.example.com"] },
});
```

The report contains no time, machine path, or random identifier, so the same
manifest and host snapshot serialize identically. CI can reject when `status`
is `"rejected"` and archive the JSON as certification evidence.

## Compatibility policy

- `manifestVersion` and `pluginApi` are exact versions. Unknown versions fail
  closed; consumers must not guess how to reinterpret them.
- SDK and peer bounds use exact SemVer values rather than arbitrary range
  expressions. `minimumSdk` is inclusive and `maximumSdkExclusive` is optional.
- Prerelease ordering follows SemVer, so `0.1.0-beta.2` satisfies a
  `0.1.0-beta.0` minimum but does not satisfy `0.1.0`.
- Environment and peer checks use only the explicit host snapshot. A missing
  required peer rejects certification; a missing optional peer is a warning.
- This experimental API is not yet the GA compatibility promise requested by
  #392. Promotion requires the remaining runtime and independent-kit phases.

## Security boundary

- Network grants are exact HTTPS origins. Wildcards, paths, embedded
  credentials, and non-TLS origins are rejected.
- Credential grants contain scope identifiers only—never tokens, passwords,
  headers, environment-variable names, or credential values.
- Persistent data requires scoped storage. Declared mutation requires an
  explicit mutation grant. Authenticated access requires credential scopes.
- Certification fails if the application grant set is weaker than the plugin
  request. A report is not itself an enforcement mechanism; the future host
  runtime must inject only the certified grants and must never expose ambient
  credentials or mutation authority.
- The package entrypoint is validated as a traversal-free package-relative
  path, but this API never resolves or executes it.

## Extension inventory

The closed `HONUA_PLUGIN_KINDS` and `HONUA_PLUGIN_CAPABILITIES` registries cover
protocol, source/format, renderer, auth, geocoder/routing, analysis, style,
cache, and realtime declarations. Capability names are kind-specific so a
manifest cannot inflate its advertised surface with unknown strings. The
manifest also records support status and cache, freshness, auth, provenance,
mutation, realtime, peer, environment, and disposal semantics for inventory
tools.

## Remaining work in #392

- typed lifecycle hooks and explicit per-application registration/DI;
- behavioral conformance fixtures for semantics, cancellation, retries,
  cleanup, bundle metadata, and performance;
- an independently installable runner/CLI and signed or golden reports;
- an external-style plugin proving runtime registration without core imports;
- deprecation, naming, support, security-review, and certification governance.
