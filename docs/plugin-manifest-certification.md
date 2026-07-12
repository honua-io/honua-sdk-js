# Plugin manifest and certification contract

The experimental `@honua/sdk-js/plugin` entrypoint is the first bounded slice
of the plugin SDK tracked by [issue #392](https://github.com/honua-io/honua-sdk-js/issues/392).
It lets a third-party package describe its compatibility and authority boundary
as inert JSON, then produces a deterministic report for a specific host.

The SDK does **not** import plugin code, install packages, or maintain a global
registry. A certified manifest means only that its declaration is well formed
and compatible with the supplied host snapshot. Applications explicitly import
factories and may run them through the application-local lifecycle described
below. Behavioral performance certification and support-program review remain
separate phases.

## Authoring a manifest

```ts doc-test=compile
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

const host = {
  pluginApi: HONUA_PLUGIN_API_VERSION,
  sdkVersion: "0.1.0-beta.0",
  environment: "browser",
  grants: { networkOrigins: ["https://tiles.example.com"] },
};

// The trust boundary accepts JSON text, never executable object values.
const report = certifyHonuaPluginManifest(JSON.stringify(manifest), JSON.stringify(host));
```

`JSON.stringify` is appropriate for trusted application-owned literals like
the example above. Do not import an untrusted plugin module and stringify its
exports: serialization itself can run getters or Proxy traps before the SDK is
called. Read third-party manifest bytes as text (for example, from the package
file or an HTTP response) and pass that text directly to the validator.

The report contains no time, machine path, or random identifier, so the same
manifest and host snapshot serialize identically. Its `manifest` and `host`
blocks contain the complete canonical snapshots plus SHA-256 fingerprints;
changing an entrypoint, capability, data semantic, requested authority, peer,
grant, environment, API version, or SDK version changes the corresponding
fingerprint. CI can reject when `status` is `"rejected"` and archive the deeply
frozen JSON as certification evidence without permitting manifest/host swaps.
The top-level `sha256` covers every other report field, including both complete
snapshots, their hashes, status, checks, and diagnostics. It is an integrity
receipt for externally archived evidence, not a signature or proof of issuer.

## Compatibility policy

- `manifestVersion` and `pluginApi` are exact versions. Unknown versions fail
  closed; consumers must not guess how to reinterpret them.
- SDK and peer bounds use exact SemVer values rather than arbitrary range
  expressions. `minimumSdk` is inclusive and `maximumSdkExclusive` is optional.
- Prerelease ordering follows SemVer, so `0.1.0-beta.2` satisfies a
  `0.1.0-beta.0` minimum but does not satisfy `0.1.0`.
- SemVer parsing is linear-time over ASCII input and comparison uses SemVer's
  deterministic ASCII identifier order rather than the process locale.
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
- Capability semantics also fail closed. `protocol:edit` and
  `source-format:write` require both `data.mutation: "explicit"` and a mutation
  grant; `cache:write` and `cache:invalidate` require persistent-cache semantics
  and scoped storage. The full machine-readable mapping is exported as
  `HONUA_PLUGIN_CAPABILITY_REQUIRED_GRANTS`.
- Certification fails if the application grant set is weaker than the plugin
  request. A report is not itself an enforcement mechanism; the future host
  runtime must inject only the certified grants and must never expose ambient
  credentials or mutation authority.
- The package entrypoint is repeatedly percent-decoded to a stable form before
  validation, normalized in the certified snapshot, and rejected on encoded or
  literal traversal, absolute escape, backslashes, query/fragment suffixes, or
  malformed/excessive encoding. This API never resolves or executes it.
- Manifest and host inputs must be JSON text. Raw objects—including accessors,
  proxies, custom prototypes, symbols, functions, and other executable or
  noncloneable values—are rejected from their primitive `typeof` result before
  any reflection or user code can run. A side-effect-free lexical pass enforces
  text, depth, and node-count bounds before `JSON.parse` materializes values.
  Validation and fingerprinting then use only the parser-created, detached,
  deeply frozen snapshot; caller objects are never reflected on or returned.

## Extension inventory

The closed `HONUA_PLUGIN_KINDS` and `HONUA_PLUGIN_CAPABILITIES` registries cover
protocol, source/format, renderer, auth, geocoder/routing, analysis, style,
cache, and realtime declarations. Capability names are kind-specific so a
manifest cannot inflate its advertised surface with unknown strings. The
manifest also records support status and cache, freshness, auth, provenance,
mutation, realtime, peer, environment, and disposal semantics for inventory
tools.

## Application-local registry and lifecycle

`HonuaPluginRegistry` turns certified declarations into explicit application
instances without adding plugins to root SDK workflows:

```ts doc-test=compile
import {
  HonuaPluginRegistry,
  type HonuaPluginFactory,
  type HonuaPluginManifest,
} from "@honua/sdk-js/plugin";

declare const manifest: HonuaPluginManifest<"style">;
declare const host: unknown;

const stylePlugin: HonuaPluginFactory<"style"> = {
  manifest: JSON.stringify(manifest),
  initialize(context) {
    return {
      extension: { id: context.manifest.id, kind: "style" },
      start() {},
      stop() {},
      dispose() {},
    };
  },
};

const registry = new HonuaPluginRegistry({
  host: JSON.stringify(host),
  services: {},
});
await registry.register([stylePlugin]);
const extension = registry.get("style", manifest.id);
await registry.dispose();
```

- A factory carries inert manifest JSON plus an optional exact dependency list.
  The registry certifies every declaration, builds a stable id-sorted
  topological order, and certifies again immediately before `initialize`.
  `context.resolve()` exposes only dependencies named by that factory; it cannot
  discover another plugin merely because both share an application registry.
- `initialize`, `start`, `stop`, and `dispose` are typed by all nine extension
  kinds. Only `initialize` is universally required; `dispose` is also required
  when the certified manifest declares required disposal, while inert plugins
  that declare no disposal pay for no empty hooks.
- Factories, callbacks, dependencies, host services, and registration options
  are captured before an asynchronous boundary. Registration operations on one
  registry are serialized; separate registries have no shared state and may run
  concurrently in browsers, workers, Node, or SSR.
- Context exposes only services supplied to that registry and allowed by the
  certified declaration. Network calls are origin-restricted, credential
  lookups are scope-restricted, and mutation/storage/realtime services appear
  only when their matching grants and data semantics permit them. No ambient
  credential, environment variable, fetch override, or global cache is used.
- Batch registration is transactional. Cancellation or a hook failure stops
  and disposes initialized plugins in reverse order. Cleanup continues after a
  cleanup failure; `HonuaPluginRegistryError.cleanupErrors` preserves those
  failures separately, so the primary `cause` is not hidden. Cleanup receives a
  fresh non-aborted signal even when the registration signal caused rollback.
- `dispose()` is idempotent, returns the same promise to concurrent callers, and
  performs reverse stop/dispose exactly once. Duplicate ids prevent implicit
  upgrades or state migration; because manifest v1 has no state-migration
  declaration, replacement is refused rather than guessed.
- `diagnostics` returns immutable, sequence-stable machine events with codes,
  phases, statuses, and certified identities. Thrown error messages are not
  copied into diagnostics, preventing accidental credential/PII persistence.

Plugin modules remain external to SDK core. Merely importing the root SDK or an
unrelated subpath does not import a plugin factory, initialize a registry, or
pull mapping/database peers into the bundle.

## Reference plugins for every kind

Every declared kind ships a minimal, external-style reference implementation so
authors can copy a working shape rather than a bare interface. Each is a small
factory carrying inert manifest JSON, a typed extension, and lifecycle hooks;
none of them are imported by SDK core. They live beside the tests at
`test/fixtures/plugins/` (`external-style.ts` plus `reference/`) and are
exercised end to end — certification, registration, extension call, and
disposal — in `test/plugin-reference-samples.test.ts`.

| Kind | Reference plugin | Capabilities | What it demonstrates |
| --- | --- | --- | --- |
| `protocol` | `referenceProtocolPlugin` | `query` | Bounding-box feature count over the origin-restricted network service |
| `source-format` | `referenceSourceFormatPlugin` | `read` | Read-only `lng,lat` text parsing with no requested authority |
| `renderer` | `referenceRendererPlugin` | `2d` | Pure point-to-draw-command translation |
| `auth` | `referenceAuthPlugin` | `authorize` | Header resolution from a scope-restricted credential service |
| `geocoder-routing` | `referenceGeocoderPlugin` | `geocode` | Offline gazetteer lookup |
| `analysis` | `referenceAnalysisPlugin` | `execute`, `cancel` | Cancellable reduction honouring an `AbortSignal` |
| `cache` | `referenceCachePlugin` | `read`, `write`, `invalidate` | Persistent cache over granted scoped storage |
| `realtime` | `referenceRealtimePlugin` | `subscribe` | Push subscription through the realtime service |
| `style` | `externalStylePlugin` | `validate` | The original external-style sample (issue #424/#466) |

Each manifest certifies against one shared host that grants exactly the
authorities the samples request, so the security boundary stays honest: the
`auth` sample only ever receives the `reference.read` scope identifier, the
`cache` sample only writes through scoped storage, and the `protocol` sample's
network calls are restricted to its declared origin.

## Running the certification kit independently

The certification logic is also exposed as a runnable kit so a third party can
validate their own plugin outside this repository. Installing the SDK provides
the `honua-plugin-certify` bin, which reads a manifest and a host snapshot as
inert JSON text, certifies one against the other, prints the deterministic
report to stdout (or `--out`), and resolves an exit code:

```sh
# 0 = certified, 1 = rejected, 2 = usage/input error
npx honua-plugin-certify --manifest ./manifest.json --host ./host.json --pretty
```

The bin never resolves or executes the plugin entrypoint; it only reads the two
JSON documents. The same logic is available programmatically through the
`certifyHonuaPluginManifest` public API shown above, and the CLI core
(`runPluginCertificationCli`) takes an injected I/O boundary so it can run in
any host, not just Node. This makes the harness suitable for a plugin author's
own CI: fail the build when `status` is `"rejected"`, and archive the frozen
report — bound to both canonical snapshots by SHA-256 — as certification
evidence.

## Remaining work in #392

- behavioral conformance fixtures for semantics, retries, bundle metadata, and
  performance golden reports beyond the current schema/capability, cancellation,
  and cleanup coverage;
- signed reports and a formal support-status program;
- deprecation, naming, support, security-review, and certification governance.
