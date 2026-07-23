# Sample browser bundle publication (#642, completing #401 REQ-003)

The samples gallery at [samples.honua.io](https://samples.honua.io)
(honua-io/honua-samples#3) renders `samples/dist/honua-site-samples.v2.json`
metadata but cannot embed a *running* sample from that projection alone --
it needs the actual built browser bundle. This is the publication leg #401's
REQ-003 defined and left unimplemented.

## What gets built

`scripts/build-sample-bundles.mjs` builds a fixed, tractable subset of
`samples/catalog.v2.json`'s browser-buildable, `lifecycle.state: "active"`
entries -- every one of `INCLUDED_SAMPLES` in that script builds fully
offline under its own committed fixture-mode default (no live network call,
mock server, or credential required to open the built bundle). Every other
catalog entry considered is listed in `EXCLUDED_SAMPLES` in the same file
with the reason it was left out of this pass (a live-backend preference, a
required companion server, a heavier prepare step, a non-"active" lifecycle
state, or an owning-contract question this issue does not settle).

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
(format `honua.sdk.sample-bundles.v1`). Each sample entry carries `id`,
`entrypoint`, `dataMode`, `configDefaults` (the sample's declared
browser-public config surface; `null` values mean no override was applied),
`builtFrom: { commit, packageVersion }`, and `files[]`.

```sh
npm run samples:bundles:build    # build every included sample + write the manifest
npm run samples:bundles:verify   # re-hash .artifacts/sample-bundles/** against the manifest
```

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
the release/asset location above, and the list of bundled sample IDs (kept
in sync with `INCLUDED_SAMPLE_IDS`, imported directly from
`scripts/build-sample-bundles.mjs` so there is exactly one authoritative
list) -- so a consumer that already fetches the projection can find the
manifest without guessing a path.

## Remaining scope

- Only 7 of 32 catalog entries are bundled today (see `EXCLUDED_SAMPLES`).
  Promoting more requires either resolving their live-backend/agent
  questions or orchestrating their extra prepare steps (e.g.
  `overture-geoparquet`'s pinned DuckDB extension).
- This issue publishes the bundle and its manifest; it does not solve
  serving the *data* a visitor's browser would fetch at runtime for samples
  whose default config resolves to a real endpoint rather than an in-bundle
  fixture (only `maplibre-quickstart` has any configurable endpoint, and its
  default with no override resolves to the versioned First Map fixture
  scenario, not a live call). honua-samples' iframe host is expected to keep
  using each sample's already-fixture-safe default.
