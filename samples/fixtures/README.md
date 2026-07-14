# Deterministic sample fixture packs

Each pack is immutable and versioned. Its `manifest.json` records data identity,
schema, CRS, extent, counts, provenance, license, attribution, freshness, and
SHA-256 checksums. Checksums cover exact data-file bytes. The manifest excludes
itself to avoid a recursive self-hash; provenance/license/identity are covered
separately by a canonical, recursively key-sorted semantic fingerprint over
every manifest field except the recursive `integrity` object. Component hashes
make provenance and license review explicit.

Verify every pack:

```sh
node samples/fixtures/verify.mjs
```

Preview a refresh after changing source data:

```sh
node samples/fixtures/verify.mjs first-map
```

Review the report's `checksumChanges` and `metadataChanges` fields (including
the `provenance` and `license` components). After reviewing upstream terms and attribution, update
the checksums and metadata fingerprint explicitly:

```sh
node samples/fixtures/verify.mjs --write first-map
```

The write mode never accepts semantic metadata changes. It only records current
data-file hashes and intentionally exits nonzero while unaccepted semantic drift
remains. After separately reviewing identity, schema, CRS, extent,
counts, freshness, provenance, license, and attribution, accept their hashes
with an explicit second flag:

```sh
node samples/fixtures/verify.mjs --accept-metadata first-map
```

Metadata acceptance is symmetric: it never accepts changed data-file bytes and
exits nonzero until their checksums are reviewed with `--write`. When both
reviews happen together, apply the preflighted updates in one invocation:

```sh
node samples/fixtures/verify.mjs --write --accept-metadata first-map
```
