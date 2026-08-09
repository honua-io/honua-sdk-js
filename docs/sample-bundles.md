# Sample browser bundle publication (#642 and #656, completing #401 REQ-003)

The samples gallery at [samples.honua.io](https://samples.honua.io)
(honua-io/honua-samples#3) renders `samples/dist/honua-site-samples.v3.json`
metadata but cannot embed a *running* sample from that projection alone --
it needs the actual built browser bundle. This is the publication leg #401's
REQ-003 defined and left unimplemented.

## What gets built

`scripts/build-sample-bundles.mjs` publishes **every** `samples/catalog.v2.json`
entry the eligibility audit clears, and records a machine-readable exclusion
reason for every entry it does not (see "The eligibility audit" below). As of
honua-io/honua-sdk-js#656 that is 13 of 32 entries; the remaining 19 each carry
a structured `excluded[]` reason.

`INCLUDED_SAMPLES` is no longer a hand-maintained list: it is *derived* from
`SAMPLE_BUNDLE_AUDIT` by `deriveSampleBundleDecisions`, so an id can only
appear there by clearing the policy.

Each build:

1. strips every `VITE_*` environment variable before invoking the sample's
   existing `npm run demo:<x>:build` Vite production build, so the emitted
   bundle can only ever reflect the sample's own committed default (never an
   ambient live override);
2. copies the resulting `examples/<id>/dist/` into
   `.artifacts/sample-bundles/<id>/` (gitignored -- nothing this script writes is
   committed);
3. hashes every emitted file (SHA-256 + a Subresource-Integrity string).

The result is written to `.artifacts/sample-bundles/sample-bundles.v2.json`,
validated against `samples/contract/v2/schemas/sample-bundles.schema.json`
(format `honua.sdk.sample-bundles.v2`). Each bundled sample entry carries
`id`, `entrypoint`, `dataMode`, `configDefaults` (see below),
`builtFrom: { commit, packageVersion }`, and `files[]`, plus the publication
truth honua-io/honua-sdk-js#656 REQ-005 requires:

| Field | Meaning |
| --- | --- |
| `runtimeHosting` | The audited data-origin verdict (`self-contained` or `same-origin-fixture-service` -- the only two publishable kinds). |
| `runnability` | `standalone` (opens and runs on any static host) or `requires-host-fixture-service`. |
| `hostFixtureRoutes` | The same-origin path prefixes the embedding host must serve. Empty for `standalone`. |
| `support` | `{ tier, track, validationProfile }`, copied from the catalog. |
| `lifecycle` | `{ state, reason }` plus `targetRelease` / `replacement` when the catalog declares them. |

`configDefaults` is the sample's **browser-public** config surface only:
exactly the catalog `data.configClassifications` entries whose `exposure` is
`browser-public`, with `null` meaning no override was applied. It is
deliberately *not* `data.config`, which is the sample's whole configuration
surface and mixes in server-only settings (`ai-spatial-app-builder`'s
`HONUA_AGENT_HOST_URL` / `HONUA_LIVE_DATA_URL`, `service-explorer`'s live
toggle). Publishing those in a field defined as the browser-public surface
would overstate what a consumer can influence and leak backend topology into a
public artifact.

### `hostFixtureRoutes` matching, and derived URLs

Each entry matches its own exact path and everything beneath it as a
**path-segment prefix**: `/fixtures/cog/` covers `/fixtures/cog/assets/x`, and
`/rest/services/OahuCog/ImageServer` covers `.../ImageServer/exportImage`, but
`/fixtures/cog` never covers `/fixtures/cognition`.
`routeCoveredByHostFixtureRoutes` in `scripts/build-sample-bundles.mjs` is the
reference implementation.

Routes must account for URLs the journey *derives from fixture responses*, not
only the ones it requests first. `imagery-cog-quickstart` is the worked
example: its STAC item at `/fixtures/cog/item.json` carries relative asset
hrefs (`./assets/<key>`) that resolve against the item URL, so the bundle then
reads `/fixtures/cog/assets/<key>`. Declaring only the item route left all
seven assets uncovered, and a host provisioning exactly the stated
prerequisites would still have 404'd; the declared prefix is now
`/fixtures/cog/`. A test drives the sample's real fixture server, follows every
asset href, and asserts both that the resolved path is covered and that the
host actually serves it.

`builtFrom.commit` is the source SHA and `builtFrom.packageVersion` the SDK
version; `files[].sha256` / `files[].integrity` are the integrity hashes.

### Runnability is part of the contract

A `runnability: "requires-host-fixture-service"` bundle is fixture-safe,
credential-free, and deterministic, but its default lane addresses same-origin
fixture routes that are **not inside the bundle** (the sample's
`mock-server.mjs` defines them). Consumers **must not** present such a bundle
as runnable unless the embedding host also serves its `hostFixtureRoutes`;
`samples/dist/honua-site-samples.v3.json`'s `sampleBundles.published[]` carries
the same fields, including `requires-live-endpoint`, so a gallery card can say
so without fetching the bundle manifest. The frozen v2 projection and v1
handoff remain available for existing consumers.

This closes a real overstatement: `maplibre-quickstart` has been published
since honua-io/honua-sdk-js#642 with an undeclared prerequisite of exactly this
kind (`endpointFromEnvironment` resolves to
`${location.origin}/rest/services/natural-earth/FeatureServer/0` with no
`public/` directory to serve it from).

## Manifest format v1 -> v2 (retirement, not extension)

honua-io/honua-sdk-js#656 publishes the manifest as
`honua.sdk.sample-bundles.v2` (`sample-bundles.v2.json`,
`$id: .../sample-bundles.v2.schema.json`, `schemaVersion: 2`) and **retires
v1**. The schema filename stays `sample-bundles.schema.json`, matching the
repo convention that the version lives in `$id` / `format` / `schemaVersion`
and in the generated artifact's filename (cf. `sample-ci-selection.schema.json`
producing `samples/dist/sample-ci-selection.v2.json`, and
`site-consumer-fixture.schema.json` bumped in place from v2 to v3).

A version bump is required rather than optional. Both the manifest object and
every sample object are `additionalProperties: false`, so the v2 fields break
compatibility in *both* directions: a consumer validating against pinned v1
rejects a newly generated manifest for unknown properties, and the updated
schema rejects a previously valid v1 manifest for missing required fields.
Keeping `format` and `schemaVersion` at v1 through that change would have been
a silent breaking change.

**v1 is retired rather than dual-published**, for two reasons:

- v1 has no field that can express a runtime prerequisite. Any v1 manifest
  listing `requires-host-fixture-service` or `requires-live-endpoint` bundles is
  misleading by construction. Continuing to emit v1 would preserve exactly the
  overstatement this contract exists to remove.
- `sample-bundles.tar.gz` is a single rolling asset built from the v2 sample
  set. A left-behind `sample-bundles.v1.json` would pair stale per-file hashes
  with fresh bundle bytes and fail every integrity check it exists to support,
  which is worse than a clean 404. The release job therefore deletes the v1
  asset after uploading v2.

There is no migration artifact under `samples/contract/v2/migrations/` because
there is nothing to migrate: unlike `catalog.v1-to-v2.json`, which is a
script input that transforms a committed source file, this manifest is
regenerated from source on every build. Migrating means pointing at the new
asset name and format string, both of which are discoverable from the site
projection (`sampleBundles.publication.manifestAsset` and
`sampleBundles.format`), so a consumer that follows the documented discovery
path moves over without a code change.

```sh
npm run samples:bundles:build    # build every included sample + write the manifest
npm run samples:bundles:test     # unit-test the inclusion/exclusion derivation logic
npm run samples:bundles:verify   # run the unit tests, then re-hash .artifacts/sample-bundles/** against the manifest
```

### `overture-geoparquet`'s bundle is much larger than the rest

`overture-geoparquet` self-hosts the `@duckdb/duckdb-wasm` main module and
worker plus the ~3 MB pinned Parquet extension under `duckdb/` in its build
output (see `examples/overture-geoparquet/vite.config.ts`'s
`selfHostDuckDb` plugin). Its bundle is roughly **37 MB**, versus roughly
1-2 MB for every other included sample -- expanding total published bundle
weight by more than 4x. This was the reason the original pass deferred it
("plus a much heavier bundle"); this pass wires up the missing prepare-step
orchestration (which is what made the exclusion mechanical to resolve) but
does not otherwise change or budget that payload. If CI artifact-size,
GitHub Release asset, or gallery download-weight limits become a concern,
revisit whether this sample should publish as a bundle at all, publish
lazily (e.g. a "load DuckDB" affordance instead of an eagerly-fetched
worker), or move the DuckDB-WASM asset itself out of the per-commit bundle
and behind a separately-cacheable, version-pinned CDN reference.

## Exclusion reasons (honua-io/honua-sdk-js#656 REQ-004)

Every `samples/catalog.v2.json` entry that is not in `INCLUDED_SAMPLES` is
projected into the manifest's `excluded[]` array as `{ id, category, reason
}`, and from there into the site projection's `sampleBundles.excluded[]`
(`samples/dist/honua-site-samples.v3.json`, `generateSiteProjection` in
`scripts/sample-contract.mjs`) so the gallery can render *why* a card has no
runnable bundle instead of just omitting one.

`category` is one of a fixed, schema-enumerated set
(`EXCLUDED_SAMPLE_CATEGORIES` in `scripts/build-sample-bundles.mjs`,
mirrored in both `sample-bundles.schema.json` and
`site-projection.v3.schema.json`; a unit test also holds the frozen v2 enum
unchanged):

| Category | Meaning |
| --- | --- |
| `requires-api-key` | The catalog classifies at least one config name as `exposure: browser-public` *and* `valueKind: credential`; a static bundle may not embed one. |
| `requires-live-backend` | `runtimeHosting: external-live-endpoint` without one of the two explicit live publication policies -- the default build resolves to an unqualified off-bundle endpoint. |
| `requires-companion-server` | `runtimeHosting: companion-process` -- the default flow needs its own running server process as a participant, not just a data origin. |
| `non-browser-app` | `runtimeHosting: server-side-app` -- no Vite config, no browser renderer. |
| `non-runtime-sample` | `runtimeHosting: not-a-runtime-sample` -- a docs snippet or migration-codemod test input. |
| `legacy-unsafe-configuration` | Catalog `data.configurationStatus` is `legacy-unsafe`; the browser config surface predates the current policy. |
| `unsupported-support-tier` | Catalog `supportTier` is `internal` or `deprecated`, which may not gain a new public runnable surface. |
| `lifecycle-not-active` | `samples/catalog.v2.json` `lifecycle.state` is not `"active"` (rework/retire/merge/replace); the `reason` is generated verbatim from that entry's own `lifecycle.reason` (plus `targetRelease`/`replacement` when present), not hand-duplicated. |
| `needs-prepare-step`, `replay-mode-undecided`, `agent-shaped` | Retained but unused: each was superseded by an audited `runtimeHosting` verdict. |
| `audit-pending` | Escape hatch for a newly-promoted active sample whose audit has not been performed yet. Currently unused. |

## The eligibility audit (#656 REQ-001)

The audit is **data plus a deterministic verifier**, not prose. Every catalog
entry gets exactly one decision, and nothing about that decision is
hand-written twice.

### What is derived, and from where

Almost every audit dimension is read straight from `samples/catalog.v2.json`,
so it cannot drift from the catalog:

| Dimension | Source |
| --- | --- |
| Lifecycle | `lifecycle.state` (+ `reason` / `targetRelease` / `replacement`) |
| Support tier | `supportTier`, checked against `INELIGIBLE_SUPPORT_TIERS` |
| Configuration classification | `data.configurationStatus` |
| Browser-secret policy | `data.configClassifications[]` -- any `browser-public` + `credential` name blocks publication (`browserExposedCredentials`) |
| Data mode | `data.mode` |
| Vite-buildability | `<sourcePath>/vite.config.ts` on disk, plus the declared `buildScript` existing in `package.json` *and* pointing at that sample's Vite config |
| Companion fixture service | `<sourcePath>/mock-server.mjs` on disk |

### What is hand-audited

Exactly one dimension resists derivation: **where a sample's default build
gets its data**. `SAMPLE_BUNDLE_AUDIT` carries one record per *active* catalog
entry declaring `runtimeHosting` (see `RUNTIME_HOSTING_KINDS`), the
`hostFixtureRoutes` it needs when applicable, its `buildScript`, and
`auditedVia` -- the committed source location that establishes the claim, so a
reviewer can re-derive it and the projected `reason` explains *why*, not just
*that*. Non-active entries deliberately have **no** record, so a catalog
promotion forces a fresh audited decision instead of inheriting a guess.

`PUBLISHED_LIVE_SAMPLE_POLICY` is a separate fail-closed exception table. It
contains only `maplibre-quickstart` and `service-explorer`, binds each to one
exact HTTPS origin, and defines the bounded GeoJSON probe that must pass during
the browser-bundle smoke. It does not make `external-live-endpoint` generically
publishable.

`verifySampleBundleAudit(catalog)` then machine-checks every structural
consequence of those declarations against the tree, and runs on every
`samples:bundles:build`:

- a structural kind (`server-side-app` / `not-a-runtime-sample`) must have **no**
  `vite.config.ts`, and every other kind must have one;
- a declared `buildScript` must exist and must build that sample's Vite config;
- `same-origin-fixture-service` must declare at least one sorted, absolute
  `hostFixtureRoutes` entry *and* have a `mock-server.mjs` defining them;
- every other kind must declare no host routes.

### The policy

`evaluateSampleBundleEligibility(catalogEntry, auditRecord)` is a pure function
from those facts to a decision. Blockers are collected in a fixed precedence
order, the first supplies the machine-readable `category`, and the projected
`reason` is composed from every blocker's detail plus `auditedVia` -- so a
reason can never drift from the decision that produced it:

1. structural `runtimeHosting` (not a browser app at all -- the most
   fundamental truth, so it wins the reported category even when a lower gate
   also fails);
2. ineligible support tier;
3. `legacy-unsafe` configuration status;
4. a browser-public credential;
5. non-publishable `runtimeHosting` (`external-live-endpoint` unless the sample
   has one of the two literal live policies, or `companion-process`).

No blockers means publish, with `runnability` derived 1:1 from
`runtimeHosting`: live-backed exceptions are `requires-live-endpoint`, never
`standalone`. `deriveSampleBundleDecisions` additionally throws if an audit
record names an unknown id, an id is audited twice, a record covers a
non-active entry, or an **active** entry has no record at all.

`deriveExcludedSamples(catalog)` / `derivePublishedSamples(catalog)` are thin
projections of that one decision list, and are what
`scripts/sample-contract.mjs` imports -- there is exactly one authoritative
source for both halves.

### What this pass changed

honua-io/honua-sdk-js#656 completed the audit for all 32 entries and grew the
published set from 8 to 13. Five entries were promoted:

| Sample | Verdict | Why it was previously excluded |
| --- | --- | --- |
| `ai-spatial-app-builder` | `standalone` | Excluded as `agent-shaped` -- a presentation preference, not an eligibility fact. `src/main.ts` imports only `./safe-agent.js` and issues no `fetch`/`EventSource`/`WebSocket`; both config names are server-only, so no host-model lane is reachable from a bundle. |
| `service-explorer` | `requires-live-endpoint` | Its published, non-localhost default is `https://demo.pygeoapi.io/master`; the bundle is admitted only through the exact-origin live policy and semantic `lakes` FeatureCollection smoke. Local source tests retain `${origin}/fixtures/ogc`. |
| `planning-permitting-workbench` | `requires-host-fixture-service` | Was `audit-pending`. Catalog declares no config surface at all (`configurationStatus: not-required`, `authMode: none`); the default addresses `${origin}/rest/services/Maui/Planning/FeatureServer`. |
| `imagery-cog-quickstart` | `requires-host-fixture-service` | Was `requires-live-backend`. With `VITE_HONUA_IMAGERY_BASE_URL` unset, `resolveImageryCogConfig` resolves mode `fixture-safe` against the document origin, and `normalizeBaseUrl` rejects any cross-origin, query-bearing, or credential-bearing override. |
| `react-quickstart` | `requires-host-fixture-service` | Was `requires-api-key`. No `VITE_HONUA_REACT_*` name is catalog-classified as a credential and its `mock-server.mjs` asserts no authorization header, so the catalog's `api-key` `authMode` describes a live lane a bundle cannot reach. |

Two exclusions were re-derived with more accurate reasons:
`realtime-incident-dashboard` moves from `replay-mode-undecided` to
`requires-live-backend` (its default really does resolve to
`DEFAULT_DEMO_BASE_URL` = `https://demo.honua.io`), and `oauth-signin` keeps
`requires-companion-server` now backed by an audited `companion-process`
verdict. The remaining four active exclusions
(`arcgis-source-app`, `automatic-source-workflow`, `node-backend-quickstart`,
`shared-renderer-state`) are structurally not browser bundles, and 13 entries
remain mechanically blocked by a non-`"active"` catalog lifecycle -- those need
a catalog promotion, not a bundling change.

## Reproducibility

The manifest intentionally carries no wall-clock timestamp so a rebuild at
the same commit with the same `package-lock.json` (hashed into
`build.lockfileSha256`) reproduces byte-identical file hashes -- Vite/Rollup
content-hashed chunk names are a pure function of chunk content given a
pinned toolchain. No other nondeterminism was observed across repeated local
builds; if CI ever needs to tolerate a nondeterministic asset, prefer fixing
the underlying build (as `examples/_kit/vite.config.ts`'s
`honua-sample-sdk-resolution.json` evidence already does) over relaxing this
manifest's hash checks.

## Publication

Built bundles and the manifest are **not** committed to the tree (`dist/` is
gitignored, and this repository binds golden-journey qualification receipts
to a source digest over the tracked files that can affect sample behavior --
see `scripts/sample-gate-receipt.mjs`'s `evidenceNeutralSourceDigest`, and the
existing `dist/browser/honua-sdk.browser-artifacts.v1.json` SDK CDN-bundle
manifest, which is likewise built fresh rather than committed). Committing
contenthashed build output would churn that digest, and therefore every
qualified receipt, on every trunk push.

> **Derived-artifact decoupling (honua-io/honua-sdk-js#677).** Feature PRs do
> **not** reseal sample evidence or regenerate any derived artifact. PR CI runs
> the sample-publication contract and the llms/comparison/api/bench/migration
> freshness gates in a relaxed mode (`HONUA_DERIVED_ARTIFACTS_RELAX`) that still
> validates evidence schema, freshness, artifact digests, and catalog/dist
> coherence, but does not require the evidence-neutral source digest to match
> the PR's tree. After merge, the trunk-only
> `.github/workflows/regenerate-derived-artifacts.yml` workflow rebuilds every
> derived artifact, reseals evidence **strictly** bound to the trunk source
> digest, and commits the result back to trunk. That workflow -- not the feature
> PR -- is where reproducibility is enforced. The evidence-neutral digest also
> excludes clearly-derived, non-runtime paths (`.github`, the generated
> report docs, `llms*.txt`, `api-report`, `bench/cross-sdk/corpus.json`, and
> `examples/migration-workbench/public/artifacts`), so regenerating them cannot
> re-stale a receipt.

> **Digest narrowing (honua-io/honua-sdk-js#746 REQ-003).** The digest is now
> an allowlist, not "everything except the exclusions above": only
> `examples/`, `docs/examples/`, `src/`, `samples/` (minus the exclusions
> above), `test/`, `bench/` (minus `bench/cross-sdk/corpus.json`, itself an
> excluded generated report), `scripts/`, `config/`, `package.json`,
> `package-lock.json`, `tsconfig.json`, `vitest.config.ts`, `.nvmrc`,
> `LICENSE`, and `playwright.config.mjs` / `playwright.first-map.config.mjs`
> (the root Playwright configs every sample loads implicitly or via an
> explicit `playwrightConfig` override -- the latter carries
> maplibre-quickstart's release-matrix Firefox/xvfb projects from #736) are
> inside it. `test/`, `bench/`, `scripts/`, and the four root files above are
> not sample-specific by themselves -- they are exactly the SDK build inputs
> `scripts/lib/prepared-sdk-artifact.mjs`'s `BUILD_INPUT_ROOTS` /
> `BUILD_INPUT_FILES` track, because packed-mode sample evidence
> (`sample-runner.mjs`'s `preparePackedSdk`) `npm pack`s and hashes the real
> `dist/` tsc compiles from `src`+`test`+`bench` (tsconfig's `rootDir: "."`
> pulls in anything transitively reachable, not just its `include` globs --
> see honua-io/honua-sdk-js#652) and embeds those hashes in the packed-build
> gate report; leaving any of them out of the digest would let a change there
> keep verifying against a previously sealed receipt's stored hashes even
> though a rebuild could produce different packed bytes. A merge that only
> touches `docs/` prose (outside `docs/examples/`), `mcp/`, `conformance/`,
> or `eval/` still leaves the digest untouched, so
> `regenerate-derived-artifacts.yml`'s `paths:`-filtered trunk-push trigger
> (mirroring this same allowlist) skips it and existing evidence stays valid
> without a reseal. A change to a sample's Playwright spec, either root
> Playwright config, or any SDK build input above still changes the digest,
> so a weakened assertion, a dropped browser-matrix project, or a build
> config change cannot verify against a previously sealed receipt.

### Frozen legacy evidence archive

The frozen v1 site handoff is validated with
`honua-site-consumer-legacy-receipts.v2.json`. This additive archive leaves the
v1 receipt archive and handoff byte-for-byte unchanged, while making historical
validation independent of the mutable evidence tree and Git history. V2 embeds
the exact receipt reports, screenshots, packed SDK tarballs and declared sample
dist files, live evidence, and live producer sources that `validateGateReceipt`
rehashes. It deliberately excludes unrelated files from the old run roots.

Artifact paths form a closed inventory derived from the frozen handoff, its three
bound projection/matrix/visual-evidence inputs, and its content-addressed reports.
The current archive has 139 paths, 120 deduplicated blobs, 12,883,315 unique
decoded bytes, and 6,288,496 gzip bytes (an 8,709,539 byte JSON fixture after
base64 and metadata). The three handoff inputs account for 587,347 decoded bytes
and 45,178 gzip bytes; the receipt and transitive evidence payload remains
12,295,968 decoded bytes. Validation caps the archive at
160 paths, 128 blobs, 16 MiB decoded unique content, 8 MiB compressed content,
32 MiB referenced content, and 4 MiB per blob. It rejects missing, extra,
duplicate, escaped, cross-run, stale, oversized, and decompression-bomb content.

Git is permitted only in the explicit one-time capture command
`npm run samples:archive-legacy-visual-receipts`, which resolves the already
content-addressed historical bytes before writing v2. Normal `samples:verify`,
source-extract, shallow-clone, and package validation reads only the committed
v2 archive and never invokes Git for frozen evidence.

Instead, `.github/workflows/ci.yml`:

- builds and schema/hash-verifies the manifest on every PR and trunk push
  (`js-sdk` job, "Build sample bundles" / "Verify sample bundle manifest"
  steps) so a broken build fails CI like any other gate;
- on trunk pushes only, uploads `.artifacts/sample-bundles/` as a versioned
  workflow artifact (`sample-bundles`, same pattern as `sdk-coverage-v1`);
- on trunk pushes only, a dedicated `sample-bundles-release` job (`needs:
  js-sdk`, scoped `permissions: contents: write`) rebuilds and publishes the
  manifest plus a `sample-bundles.tar.gz` of every bundle directory as
  assets on a rolling `sample-bundles-latest` GitHub Release, updated
  (`--clobber`) on every trunk push. This gives honua-samples a stable,
  plain-HTTPS-fetchable URL that does not depend on a workflow-artifact run
  ID or Actions API auth:

  ```sh
  gh release download sample-bundles-latest -R honua-io/honua-sdk-js \
    -p 'sample-bundles.v2.json' -p 'sample-bundles.tar.gz'
  ```

## Discovery from the site projection

`samples/dist/honua-site-samples.v3.json` (`generateSiteProjection` in
`scripts/sample-contract.mjs`) carries a `sampleBundles` pointer -- format,
the release/asset location above, the list of bundled sample IDs (kept in
sync with `INCLUDED_SAMPLE_IDS`), a `published[]` list carrying each bundle's
`runnability` and `hostFixtureRoutes`, and the `excluded[]` reason list above
(all three imported directly from `scripts/build-sample-bundles.mjs` --
`INCLUDED_SAMPLE_IDS`, `derivePublishedSamples`, `deriveExcludedSamples` -- so
there is exactly one authoritative source for each) -- so a consumer that
already fetches the projection can find the manifest, state every runnable
card's prerequisites, and explain every un-bundled card, without guessing a
path, a prerequisite, or a reason.

`sampleBundles.excluded` and `sampleBundles.published` remain optional in the
projection schemas for compatibility. The committed v2 projection, v1
handoff, and v3 consumer fixture remain byte-bound legacy artifacts; current
generation emits the additive v3 projection, v2 handoff, and v4 fixture.

## Remaining scope

- 13 of 32 catalog entries are bundled; the other 19 carry a structured
  `excluded[]` reason (see "Exclusion reasons" above). 13 of those are
  mechanically blocked by a non-`"active"` catalog lifecycle
  (`lifecycle-not-active`) and need a catalog promotion, not a bundling
  change; the remaining 6 are audited exclusions:
  - `realtime-incident-dashboard` (`requires-live-backend`) -- becoming
    eligible needs its default lane to resolve to a bundled replay rather
    than `https://demo.honua.io`. That is a sample change, not a bundling
    change.
  - `oauth-signin` (`requires-companion-server`) -- its flow needs a live
    identity-provider participant; a static bundle cannot complete it.
  - `node-backend-quickstart` (`non-browser-app`), `arcgis-source-app`,
    `automatic-source-workflow`, `shared-renderer-state`
    (`non-runtime-sample`) -- structurally not embeddable Vite apps;
    unlikely to change without a different kind of gallery card.
- **Serving the fixture data for `requires-host-fixture-service` bundles is
  still open.** Five published bundles resolve their default lane to
  same-origin fixture routes that are not inside the bundle; they now declare
  exactly which routes (`hostFixtureRoutes`) instead of leaving the
  requirement implicit, but this repository does not yet *ship* a static
  fixture tree or worker that satisfies them. Until honua-samples serves those
  routes, a consumer should either embed only `runnability: "standalone"`
  bundles or provide its own fixture origin. Making one of these samples
  `standalone` -- by materialising its mock-server responses as committed
  `public/` assets -- is the natural follow-up, and would be a per-sample
  change with no contract change here.
- Bundle weight is dominated by `overture-geoparquet` (37.7 MB of the 53.0 MB
  total). The five samples #656 added contribute roughly 6.9 MB combined
  (167 KiB to 2.1 MB each), so the size callout above is still the only
  budget concern.
