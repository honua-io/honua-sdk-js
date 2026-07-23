# Sample browser bundle publication (#642, completing #401 REQ-003)

The samples gallery at [samples.honua.io](https://samples.honua.io)
(honua-io/honua-samples#3) renders `samples/dist/honua-site-samples.v2.json`
metadata but cannot embed a *running* sample from that projection alone --
it needs the actual built browser bundle. This is the publication leg #401's
REQ-003 defined and left unimplemented.

## What gets built

`scripts/build-sample-bundles.mjs` builds a tractable subset of
`samples/catalog.v2.json`'s browser-buildable, `lifecycle.state: "active"`
entries -- every one of `INCLUDED_SAMPLES` in that script builds fully
offline under its own committed fixture-mode default (no live network call,
mock server, or credential required to open the built bundle), or -- for
`overture-geoparquet` -- through its existing `npm run demo:overture:build`
prepare-then-build chain, which fetches (or reuses a cache-hit for) a
SHA-256/byte-length/WebAssembly-magic-validated pinned DuckDB Parquet
extension before the Vite build runs.

Each build:

1. strips every `VITE_*` environment variable before invoking the sample's
   existing `npm run demo:<x>:build` Vite production build, so the emitted
   bundle can only ever reflect the sample's own committed default (never an
   ambient live override);
2. copies the resulting `examples/<id>/dist/` into
   `.artifacts/sample-bundles/<id>/` (gitignored -- nothing this script writes is
   committed);
3. hashes every emitted file (SHA-256 + a Subresource-Integrity string).

The result is written to `.artifacts/sample-bundles/sample-bundles.v1.json`,
validated against `samples/contract/v2/schemas/sample-bundles.schema.json`
(format `honua.sdk.sample-bundles.v1`). Each bundled sample entry carries
`id`, `entrypoint`, `dataMode`, `configDefaults` (the sample's declared
browser-public config surface; `null` values mean no override was applied),
`builtFrom: { commit, packageVersion }`, and `files[]`.

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
(`samples/dist/honua-site-samples.v2.json`, `generateSiteProjection` in
`scripts/sample-contract.mjs`) so the gallery can render *why* a card has no
runnable bundle instead of just omitting one.

`category` is one of a fixed, schema-enumerated set
(`EXCLUDED_SAMPLE_CATEGORIES` in `scripts/build-sample-bundles.mjs`,
mirrored in both `sample-bundles.schema.json` and
`site-projection.schema.json`; a unit test asserts the three stay in sync):

| Category | Meaning |
| --- | --- |
| `needs-prepare-step` | Needs a build-orchestration/prepare step not yet wired (reserved -- `overture-geoparquet` was the one instance and is now bundled). |
| `requires-api-key` | Hybrid data mode with a browser-exposed API key/credential and no safe fixture-only default. |
| `requires-live-backend` | Prefers or requires a live backend leg whose browser-public default has not been reviewed. |
| `requires-companion-server` | Needs its own running server process (e.g. a mock identity provider) at runtime; not a static bundle. |
| `replay-mode-undecided` | Realtime sample that prefers a live stream; a gallery-safe replay-only embedding mode is undecided. |
| `agent-shaped` | Agent-interaction-pattern demo with no map renderer; deferred product scoping. |
| `non-browser-app` | Server-side/non-Vite app; no browser renderer to bundle. |
| `non-runtime-sample` | Migration-codemod test input or a docs snippet, not a Honua-runtime Vite package. |
| `lifecycle-not-active` | `samples/catalog.v2.json` `lifecycle.state` is not `"active"` (rework/retire/merge/replace); the `reason` is generated verbatim from that entry's own `lifecycle.reason` (plus `targetRelease`/`replacement` when present), not hand-duplicated. |
| `audit-pending` | Active, Vite-buildable candidate this pass did not audit against REQ-001's full checklist (see below). |

`scripts/build-sample-bundles.mjs`'s exported `deriveExcludedSamples(catalog)`
is the single generator both `build-sample-bundles.mjs` and
`sample-contract.mjs` call: it combines the hand-classified
`EXCLUDED_SAMPLES` table with every remaining non-`"active"` catalog entry
(auto-derived, `lifecycle-not-active`), and throws (drift-checked, both at
build time and in `test/scripts/build-sample-bundles.test.mjs`) if:

- a hand-classified id doesn't exist in the catalog, or is also `INCLUDED_SAMPLES`;
- a `"lifecycle-not-active"` entry's catalog lifecycle is actually `"active"`
  (this pass found and fixed exactly this bug -- see below);
- any *other* category is used on a catalog entry whose lifecycle is *not*
  `"active"` (those categories assert the sample is otherwise buildable);
- an active catalog sample has no `INCLUDED_SAMPLES`/`EXCLUDED_SAMPLES` entry
  at all -- a newly active sample forces an explicit human decision rather
  than a guessed category.

### Stale-data bug found and fixed in this pass

The pre-#656 version of this file's `EXCLUDED_SAMPLES` comment claimed
"every remaining catalog entry... has a non-`\"active\"` lifecycle.state",
naming 14 ids including `planning-permitting-workbench` and
`service-explorer`. Both are actually `lifecycle.state: "active"` and
Vite-buildable today; the claim was wrong (likely stale relative to a
catalog lifecycle promotion after the original comment was written). This
pass reclassifies both as `audit-pending`: they are structurally similar to
several already-included fixture/hybrid samples, but REQ-001's full audit
(support tier, browser-secret policy, fixture determinism, runtime
dependencies -- for `service-explorer`, specifically confirming its
`HONUA_SERVICE_EXPLORER_LIVE_ENABLED` toggle resolves to a fixture-safe
default) was not performed for them in this pass. Promoting them is a
follow-up decision, not resolved here.

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
    -p 'sample-bundles.v1.json' -p 'sample-bundles.tar.gz'
  # or, plain HTTPS:
  curl -LO https://github.com/honua-io/honua-sdk-js/releases/download/sample-bundles-latest/sample-bundles.v1.json
  ```

## Discovery from the site projection

`samples/dist/honua-site-samples.v2.json` (`generateSiteProjection` in
`scripts/sample-contract.mjs`) carries a `sampleBundles` pointer -- format,
the release/asset location above, the list of bundled sample IDs (kept in
sync with `INCLUDED_SAMPLE_IDS`), and the `excluded[]` reason list above
(kept in sync with `deriveExcludedSamples`, both imported directly from
`scripts/build-sample-bundles.mjs` so there is exactly one authoritative
source for each) -- so a consumer that already fetches the projection can
find the manifest, and explain every un-bundled card, without guessing a
path or a reason. `sampleBundles.excluded` is optional in
`site-projection.schema.json` (unlike `sample-bundles.schema.json`'s
`excluded`, which is required) so that the currently-committed
`samples/dist/honua-site-samples.v2.json` -- generated before honua-io/honua-sdk-js#656
and not resealed by this feature PR per the derived-artifact decoupling
policy below -- stays schema-valid until the next scheduled
`regenerate-derived-artifacts.yml` run picks up the new field.

## Remaining scope

- 8 of 32 catalog entries are bundled today; the other 24 carry a structured
  `excluded[]` reason (see "Exclusion reasons" above). Of those, 13 are
  mechanically blocked by a non-`"active"` catalog lifecycle
  (`lifecycle-not-active`) and will need a catalog promotion, not a bundling
  change, before they're eligible. The remaining 11 are active,
  Vite-buildable candidates this pass deliberately left excluded because
  promoting them is a product decision honua-io/honua-sdk-js#656 does not
  settle:
  - `react-quickstart` (`requires-api-key`) -- what backend credential
    policy, if any, a static gallery bundle may embed or proxy.
  - `realtime-incident-dashboard` (`replay-mode-undecided`) -- whether a
    gallery-safe replay-only embedding mode should exist, and what it looks
    like.
  - `ai-spatial-app-builder` (`agent-shaped`) -- whether
    agent-interaction-pattern demos with no map renderer belong in a
    map-gallery at all, or need a different presentation. (`mcp-gis-assistant`
    is the same kind of agent-shaped demo but is also `lifecycle.state:
    "rework"`, so it's mechanically excluded as `lifecycle-not-active` and
    doesn't need this product decision resolved to become eligible on its
    own -- its catalog promotion does.)
  - `planning-permitting-workbench`, `service-explorer` (`audit-pending`) --
    both are active, Vite-buildable, and structurally similar to
    already-included samples, but this pass did not run the REQ-001 audit
    (support tier, browser-secret policy, fixture determinism, runtime
    dependencies) for either. They were previously miscategorized in this
    file as non-active lifecycle -- see docs/sample-bundles.md's "Stale-data
    bug found and fixed in this pass" note above.
  - `imagery-cog-quickstart` (`requires-live-backend`), `oauth-signin`
    (`requires-companion-server`) -- unchanged from the original pass's
    assessment.
  - `node-backend-quickstart` (`non-browser-app`), `arcgis-source-app`,
    `automatic-source-workflow`, `shared-renderer-state`
    (`non-runtime-sample`) -- structurally not embeddable Vite apps;
    unlikely to change without a different kind of gallery card.
- This issue publishes the bundle and its manifest; it does not solve
  serving the *data* a visitor's browser would fetch at runtime for samples
  whose default config resolves to a real endpoint rather than an in-bundle
  fixture (only `maplibre-quickstart` has any configurable endpoint, and its
  default with no override resolves to the versioned First Map fixture
  scenario, not a live call). honua-samples' iframe host is expected to keep
  using each sample's already-fixture-safe default.
