---
type: reference
title: "Plugin manifest and certification contract"
description: "The versioned plugin SDK: authoring a manifest, compatibility policy, the security boundary, the application-local registry, the certification kit, signed reports, support status and governance."
resource: "honua://capability/plugin.sdk"
---
# Plugin manifest and certification contract

The experimental `@honua/sdk-js/plugin` entrypoint is the versioned plugin SDK.
It lets a third-party package describe its compatibility and authority boundary
as inert JSON, produces a deterministic report for a specific host, and runs an
application-local lifecycle plus behavioral conformance without granting the
plugin ambient authority.

The SDK does **not** import plugin code, install packages, or maintain a global
registry. A certified manifest means only that its declaration is well formed
and compatible with the supplied host snapshot. Applications explicitly import
factories and may run them through the application-local lifecycle described
below. A separate, deterministic behavioral-conformance harness then proves a
certified plugin's runtime behavior (retries, performance bounds, and bundle
metadata) against committed golden reports, and a machine-readable
support-status program records each plugin's lifecycle stage.

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

The report uses the exported `HONUA_PLUGIN_CERTIFICATION_REPORT_VERSION` schema
version. The verifier fails closed on unsupported versions, missing required
fields, unknown fields, invalid digest shapes, or malformed check/diagnostic
records before it accepts any integrity receipt. The report contains no time, machine path, or random identifier, so the same
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
- The API remains experimental until its eventual 1.0 promotion. Experimental
  does not mean unversioned: hosts still fail closed on an unknown manifest,
  plugin API, certification report, conformance report, or signing-envelope
  version instead of guessing compatibility.

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
  request. A report is not itself an enforcement mechanism; the
  application-local registry injects only the certified grants and never
  exposes ambient credentials or mutation authority.
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
- `HonuaPluginRegistryError` participates in the common tagged SDK error
  envelope while preserving its existing `PLUGIN_*` `.code`, message,
  `instanceof`, primary `cause`, and frozen cleanup aggregate. Its grouped
  `.sdkCode` is always non-retryable. Serialization reports only a fixed known
  reason code plus safe cause classification; manifests, configuration/plugin
  identifiers, cause payloads, and cleanup failures stay local. Unknown runtime
  codes fail closed as `plugin.internal` / `PLUGIN_UNKNOWN` without coercion.
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

## Running the certification kit independently

The certification logic is also exposed as a runnable kit so a third party can
validate their own plugin outside this repository. Installing the SDK provides
the `honua-plugin-certify` bin — name the package with `npx -p`, since no npm
package is called `honua-plugin-certify` and a bare `npx honua-plugin-certify`
therefore fails to resolve. It reads a manifest and a host snapshot as
inert JSON text, certifies one against the other, prints the deterministic
report to stdout (or `--out`), and resolves an exit code:

```sh
# 0 = certified, 1 = rejected, 2 = usage/input error
npx -p @honua/sdk-js honua-plugin-certify --manifest ./manifest.json --host ./host.json --pretty
```

The bin never resolves or executes the plugin entrypoint; it only reads the two
JSON documents. The same logic is available programmatically through the
`certifyHonuaPluginManifest` public API shown above, and the CLI core
(`runPluginCertificationCli`) takes an injected I/O boundary so it can run in
any host, not just Node. This makes the harness suitable for a plugin author's
own CI: fail the build when `status` is `"rejected"`, and archive the frozen
report — bound to both canonical snapshots by SHA-256 — as certification
evidence.

## Signed reports and tamper-evident verification

Every certification report carries a top-level `sha256` receipt over all its
other fields (including both canonical snapshots and their fingerprints). The
kit re-checks that receipt so an archived report is verifiably tamper-evident:

```sh
# 0 = verified intact, 1 = tampered, 2 = usage/input error
npx -p @honua/sdk-js honua-plugin-certify --verify ./report.json
```

The same check is available programmatically as
`verifyHonuaPluginCertificationReport(reportText)`. It reads the report as inert
JSON text and recomputes every stored digest — the top-level receipt plus the
`manifest.sha256` and `host.sha256` snapshot fingerprints — from the report's own
content. Any altered field, swapped snapshot, or edited diagnostic changes a
recomputed digest and yields a structured `REPORT_SIGNATURE_MISMATCH` or
`REPORT_FINGERPRINT_MISMATCH` diagnostic. This is a deterministic in-repo
integrity proof, not a public-key signature: it proves a report is internally
self-consistent and unmodified since issue, not which authority issued it. A
trusted-issuer signing authority (which key, which registry) is a product
decision and is deliberately out of scope here.

### Host-mediated signing envelope (SDK-owned seam)

The SDK also exports `HONUA_PLUGIN_CERTIFICATION_SIGNING_ENVELOPE_VERSION` and
the versioned `HonuaPluginCertificationSigningEnvelope` shape. An envelope
contains the report, an opaque application-selected `keyId`, the fixed
`algorithm: "external"` marker, and a signature string. Hosts sign the exact
canonical payload returned by `createHonuaPluginCertificationSigningPayload`.

`verifyHonuaPluginCertificationSigningEnvelope` accepts an explicit
`HonuaPluginCertificationSignatureVerifier` callback. It parses inert JSON,
validates the envelope and embedded report, rejects non-certified or altered
reports, and only then calls the callback. A missing verifier, callback error,
unsupported version, malformed key identifier, or false result fails closed.
The callback owns key lookup, cryptographic algorithms, issuer policy, key
rotation, and distribution; the SDK stores no keys and makes no trust claim
about the opaque identifier. This is an integration seam, not a governance or
public-key-distribution implementation.

## Support-status program

`support` records who backs a plugin (`community`, `partner`, or `honua`). The
optional, machine-readable `supportStatus` attestation records the plugin's
lifecycle stage so applications and agents can act on it without loading code:

- `state` is `supported`, `experimental`, or `deprecated`.
- `since` and `removedIn` are exact SemVer values; `replacement` is a plugin id.
- Certification fails closed when `state` is `deprecated` but the manifest names
  neither a `removedIn` version nor a `replacement` id, so a deprecation always
  carries an actionable migration path. Support findings are reported under a
  dedicated `support` certification check.

The state vocabulary is exported as `HONUA_PLUGIN_SUPPORT_STATES`. The broader
governance program (who may set `partner`/`honua` tiers, security-review sign-off,
naming policy) is a process decision layered on top of this schema.

## Behavioral conformance and golden reports

`runHonuaPluginConformance(spec, host)` runs a certified plugin through a
deterministic behavioral suite and returns a frozen, digest-sealed
`HonuaPluginConformanceReport`. The harness registers the plugin in an
application-local registry with instrumented host services and counts integer
observations only — no wall-clock time, randomness, or host path — so the report
serializes identically on every run.

Three scenarios are covered, each an observation compared against a declared
bound:

| Scenario | What it proves |
| --- | --- |
| `retries` | The plugin recovers from injected transient host failures within its declared attempt budget (`hostAttempts <= maxAttempts`, `recovered`). |
| `performance` | One operation's host-interaction cost stays within bound and is identical across runs (`serviceCalls <= maxServiceCalls`, `deterministic`). |
| `cleanup` | The registry completes the probe and records exactly one successful disposal for the initialized plugin (`disposeCalls == 1`). |
| `bundle-metadata` | The declared bundle footprint stays within budget with complete inventory metadata (`minifiedBytes`, `gzipBytes`, `metadataComplete`). |

The report binds the certification digest it was run against, so a conformance
result cannot be replayed against a different manifest or host.

## Certification governance policy

Honua certification is a portable evidence format, not a central plugin
registry or certificate authority. The SDK validates inert declarations,
produces digest-bound reports, and verifies a host-mediated signing envelope
through an application-supplied callback. The consuming application remains the
policy authority: it selects trusted issuers and keys, decides which support
tier is acceptable, and may reject a schema-valid plugin for local policy
reasons. With no configured verifier or matching trust record, signed evidence
is untrusted and verification fails closed.

### Identity and naming

- A plugin id is either a scoped npm package name such as
  `@example/honua-cloud-tiles` or a lowercase reverse-DNS name such as
  `com.example.cloud-tiles`. The owner must control the corresponding npm scope
  or DNS name. Unscoped npm package names are valid package metadata but are not
  sufficient proof of a governed plugin id.
- The manifest id is the durable ecosystem identity; package name and
  entrypoint identify one distribution of it. Publishers must not reuse an id
  for a different plugin, kind, or authority owner. A rename publishes a new id
  and deprecates the old one with `replacement`; consumers do not infer aliases.
- An ownership transfer records the old and new owner, affected plugin id,
  report digest, effective version, and signer key ids in durable release
  evidence. During a planned transfer, applications may trust both owners for a
  bounded overlap. Losing control of the scope/domain is an immediate
  revocation event, not an implicit transfer.
- The reserved `honua` support tier and `io.honua.*` identities require Honua
  repository ownership and a Honua-controlled signer. Names that imply Honua
  ownership or certification without those controls are rejected by governance
  even when their manifest syntax is valid.

### Compatibility, peers, and deprecation

- Manifest, plugin API, report, conformance-report, and signing-envelope
  versions are exact. SDK bounds use an exact SemVer inclusive minimum and
  optional exclusive maximum. Manifest v1 peer requirements expose only an
  exact SemVer minimum; a schema-level peer maximum requires a new manifest
  version rather than heuristic fallback.
- Required peers must be present in the explicit host snapshot at a compatible
  version. Missing optional peers remain warnings: neither certification nor
  the registry installs, imports, or fetches them. A plugin must expose only
  capabilities that work with the injected peers and return a structured
  capability diagnostic when an optional implementation is unavailable. A
  plugin that cannot tolerate a later peer version must reject that peer at its
  runtime boundary and cannot claim `supported` for that host until a versioned
  upper-bound contract exists.
- Deprecation sets `supportStatus.state` to `deprecated` and names either an
  exact `removedIn` version or a `replacement` id. Publishers keep the old id
  immutable, document migration and authority changes, and do not silently
  repoint it. A removed plugin is absent from an approved inventory; consumers
  must not reinterpret absence as continued support.
- State migration is unsupported by manifest v1. Replacing a registered id or
  changing its persisted state format requires a future versioned migration
  contract; the current registry refuses to guess.

### Security review and support tiers

Support tier and lifecycle state are independent. `community` means the author
is the support authority and carries no Honua endorsement. `partner` requires a
current commercial/technical relationship, a partner-controlled identity and
signer, and recorded security approval by the consuming program. `honua` is
reserved for Honua-owned code with approval from a Honua maintainer who did not
author the reviewed change. Downgrading a tier or lifecycle state is permitted
immediately; upgrading requires fresh evidence.

Before `partner` or `honua` approval, the reviewer records all of the following
against the exact plugin version and certification digest:

1. A certified inert manifest with reviewed package ownership, entrypoint,
   compatibility bounds, capabilities, peers, environment, support status,
   lifecycle, and complete cache/freshness/auth/provenance/mutation/realtime
   semantics.
2. Least-privilege grants: exact HTTPS origins, scope identifiers rather than
   secrets, bounded storage, and explicit mutation/realtime authority. Reports,
   review records, diagnostics, and fixtures must contain no credentials,
   private keys, tokens, copied authorization headers, or customer payloads.
3. Reproducible semantic and adversarial fixtures covering invalid input,
   structured errors, cancellation, bounded retries, deterministic cleanup,
   data/secret boundaries, and any declared mutation or realtime behavior.
4. A digest-bound behavioral report showing the declared performance and
   bundle-metadata budgets, plus an installed-consumer/tree-shake check proving
   that an unused plugin adds no root runtime or optional peer.
5. Dependency and license review, the owner and response path for security
   findings, the approved signer key id, and a re-review trigger. A new grant,
   capability, required peer, entrypoint, ownership change, or incompatible
   major version always triggers re-review.

Community plugins may self-attest, but applications should apply the same
checklist when their risk warrants it. Certification status alone never upgrades
a support tier.

### Issuers, key rotation, revocation, and expiry

- Each application owns an allowlist mapping the envelope's opaque `keyId` to a
  verifier and local constraints such as allowed plugin ids, support tiers,
  report digests, validity window, and issuer identity. `keyId` has no global
  meaning and is never a lookup URL.
- Private keys and credential material stay outside the SDK and its evidence.
  The verification callback receives the canonical signing payload and returns
  only a decision; an error, unknown key, altered report, unsupported version,
  disallowed identity/tier, expired trust record, or false result rejects the
  envelope.
- Rotation adds the new key before issuance, optionally accepts old and new ids
  for a bounded overlap, reissues evidence under the new id, then removes the
  old trust record. Applications must not rewrite an archived envelope or treat
  a new key as equivalent without an explicit trust update.
- Revocation removes the key or affected plugin/report constraint immediately.
  Applications re-evaluate archived evidence at load/deploy time so a valid
  historical signature does not override current revocation policy.
- Signing envelopes intentionally contain no wall-clock timestamp. Expiry and
  `notBefore` are therefore properties of the application's external trust
  record, bound to the key id and optionally the plugin id/version/report
  digest. The verifier returns false outside that window. Adding timestamps or
  online status to the portable envelope requires a new envelope version.

This policy completes the SDK-owned governance contract without creating a
hosted marketplace, global key service, or implicit endorsement. A future
catalog may distribute inventories and trust records, but applications still
opt in to those roots explicitly.
