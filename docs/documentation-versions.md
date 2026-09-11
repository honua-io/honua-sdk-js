# Documentation versions and compatibility

You are reading the documentation for `@honua/sdk-js` **{{SDK_DOCS_CURRENT_VERSION}}**.
Hosted pages are development documentation built from `trunk`, not immutable
documentation for the package baseline. Every built page and the deployed
`versions.json` identify the exact 40-character source commit.
The package baseline can equal the latest published version while `trunk`
already contains unreleased capabilities; a matching version string alone is
therefore not proof that development documentation describes the npm artifact.
The version navigation in every hosted guide is generated from
[`docs/versions.json`](https://honua-io.github.io/honua-sdk-js/versions.json), which is derived from `package.json`,
`.release-please-manifest.json`, and released `CHANGELOG.md` entries. A version
cannot appear in the selector unless those authoritative sources agree and the
release tag exists in the authoritative GitHub repository.

`config/docs-unpublished-releases.json` records Release Please cuts that never
published an SDK tag or npm artifact. These are excluded from the selector;
comparison links span the previous published tag. In particular, `0.1.8-beta.0`
was not published, so `0.1.9-beta.0` follows `0.1.7-beta.0` in the manifest.

Before npm publication, `node scripts/check-docs-release.mjs publish` requires
the generated manifest's latest release to equal the release tag and package
version. The Documentation release freshness trunk check queries both SDK npm
packages and fails if either has a newer prerelease. Pages uploads the generated
`dist/docs-site/versions.json` with the documentation, then verifies the public
file and exact source revision. The daily check also detects missed deployments.
To verify the file consumed by the site, run
`node scripts/check-docs-release.mjs hosted`.

## Release documentation

{{SDK_DOCS_VERSION_TABLE}}

The hosted guides and generated TypeDoc API are the development channel. The
released prereleases did not publish immutable TypeDoc sites, so every release
destination is explicitly labelled a source fallback: it opens the README at
the exact release tag and links to canonical release evidence. Released code is
never silently redirected to today's development API.

## Compatibility and migration

- The exact Node and optional-peer ranges are published in
  [`versions.json`](https://honua-io.github.io/honua-sdk-js/versions.json) from the current package metadata.
- There is no supported-prior line while the SDK has no GA stable release. The
  machine manifest records that state as `not-applicable`; the first stable
  line will establish a supported-prior designation policy.
- Stable and experimental entrypoint policy is defined in
  [Install and choose an entrypoint](../INSTALL.md) and checked against the
  package exports.
- Breaking ArcGIS-to-Honua changes and replacement imports are documented in
  [Migrate ArcGIS applications to Honua + MapLibre](./migration-honua-maplibre.md).
- Release-level changes are recorded in the tagged
  [changelog](../CHANGELOG.md).

When an archived guide lacks an equivalent page, use its tagged repository
source and release notes. Do not combine code from an archived guide with the
current API reference without following the migration notes.
