# Documentation versions and compatibility

You are reading the documentation for `@honua/sdk-js` **{{SDK_DOCS_CURRENT_VERSION}}**.
The version navigation in every hosted guide is generated from
[`docs/versions.json`](https://honua-io.github.io/honua-sdk-js/versions.json), which is derived from `package.json`,
`.release-please-manifest.json`, and released `CHANGELOG.md` entries. A version
cannot appear in the selector unless those authoritative sources agree.

## Release documentation

{{SDK_DOCS_VERSION_TABLE}}

The current release has hosted guides and a generated TypeDoc API reference.
Older prereleases did not publish immutable TypeDoc sites, so their selector
destinations are explicitly labelled source fallbacks: they open the README at
the exact release tag and link to that release's changelog evidence. They are
never relabelled as current or silently redirected to today's API.

## Compatibility and migration

- The exact Node and optional-peer ranges are published in
  [`versions.json`](https://honua-io.github.io/honua-sdk-js/versions.json) from the current package metadata.
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
