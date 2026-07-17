# Canonical capability keys: crosswalk and coverage snapshot

honua-server publishes the canonical, dot-namespaced capability key vocabulary
(`capability-keys.v1.json`, 110 keys as of this writing) that joins every
Honua evidence source -- server tests, CITE, interop certification,
esri-assess scans, honua-samples runs, and the honua.io capability catalog.
This SDK **consumes** that vocabulary; it never copies or forks it. Two
artifacts in this repo join the SDK's own vocabularies to it:

| Artifact | Joins | Consumer |
| --- | --- | --- |
| `config/capability-crosswalk.v1.json` | `samples/catalog.v2.json` sample `capabilities` slugs -> canonical keys | The capability matrix counts SDK samples/golden journeys as evidence (honua-io/honua-sdk-js#635) |
| `config/sdk-coverage.v1.json` | canonical keys -> this SDK's implementation status | honua-evidence's aggregate capability matrix (honua-io/honua-sdk-js#618) |

Both are validated against the published key list via
`scripts/lib/capability-key-list.mjs`, which resolves in this order:

1. `KEY_LIST_URL` env var (an `http(s)` URL) -- fetched at run time. Point this
   at `https://raw.githubusercontent.com/honua-io/honua-server/trunk/docs/gis/data/capability-keys.v1.json`
   (or a pinned release) to validate against the live vocabulary.
2. `config/capability-keys.fixture.json` -- a pinned, loudly-marked,
   point-in-time snapshot committed so CI stays hermetic and
   network-independent by default. It is a fixture, not the vocabulary of
   record; regenerate it by copying the live document's `capabilities[].key`
   values when the vocabulary changes upstream.

This is the same KEY_LIST_URL / pinned-fixture pattern honua-samples and
honua-esri-assess use for the same artifact.

## `capability-crosswalk.v1.json` (#635)

Maps every distinct slug used in `samples/catalog.v2.json` entries'
`capabilities` array (an independent, SDK-feature vocabulary --
`agent-approval`, `query-planning`, `cog`, ... -- that stays as-is) to either:

- `{ "capabilityKeys": ["<key>", ...] }` -- one or more canonical keys, or
- `{ "internalOnly": true, "reason": "<why>" }` -- an explicit marker for
  slugs that describe SDK-internal architecture, dev tooling, or UI/rendering
  concerns with no corresponding platform capability (e.g. `codemod`,
  `direct-connect`, `react`).

`scripts/sample-contract.mjs` derives each catalog entry's `capabilityKeys`
field from this crosswalk and fails closed on:

- an unmapped slug (every slug used anywhere in the catalog must have a
  crosswalk entry),
- `capabilityKeys` drift (the committed field must exactly equal what the
  crosswalk derives from the entry's `capabilities`),
- an unknown canonical key (not present in the resolved key list), and
- an empty `capabilityKeys` array whose slugs are not *all* `internalOnly`.

An entry may legitimately end up with an empty `capabilityKeys` array --
that is the explicit "no platform capability" state, valid only when every
one of its `capabilities` slugs is `internalOnly` in the crosswalk (10 of the
32 current entries, e.g. `react-quickstart`, `web-components-basic`,
`migration-workbench`: dev-tooling, framework-binding, or SDK-internal
demos with no discrete platform capability to claim).

`samples/dist/honua-site-samples.v2.json` (the #401 site projection) carries
`capabilityKeys` through unchanged, letting honua.io's `?caps=` filtered views
link to relevant SDK samples.

Validated by `npm run samples:verify` (folded into the existing catalog
validation, not a separate gate); regenerate the catalog's derived fields with
`npm run samples:generate`.

## `sdk-coverage.v1.json` (#618)

Per canonical capability key: coverage `status` (`covered` or `partial`),
`sinceVersion`, `entrypoints` (main classes/functions), `evidence` (test file
paths), and -- required whenever `status` is `partial` -- a `note` explaining
where coverage stops. Capabilities this SDK does not touch are omitted
entirely; there is no padded `none` entry.

It is **generated**, not hand-maintained, by `scripts/sdk-coverage.mjs` from
two inputs:

1. `config/support-manifest.v1.json` -- this SDK's existing, hand-maintained,
   evidence-linked truth of implemented protocols and support claims. Most
   canonical keys (the GeoServices/OGC/WFS/STAC/WMS-WMTS/OData/PMTiles wire
   protocols, plus a few facade claims) are derived mechanically through
   `config/sdk-coverage-crosswalk.v1.json`'s `protocols` / `supportClaims`
   maps. A claim is `covered` only when its status is `supported` *and* it
   names a real operation beyond the `discovery` pseudo-operation (metadata
   discovery alone -- e.g. GeoServices Geometry/GP service discovery -- is
   always `partial`, with the claim's own explanatory note carried through).
2. `config/sdk-coverage-crosswalk.v1.json`'s `extras` -- a small, hand-specified
   set of SDK feature areas support-manifest.v1.json does not model as
   protocols/supportClaims (geocoding, routing, offline regions, the plugin
   SDK, COG range-reads, OGC API Styles, the esri-compat Portal facade, OAuth,
   diagnostics, and agent-safety). Each entry names existence-checked
   `sourceFiles` and `evidence` test paths, so a deleted or renamed file fails
   generation. `extras` entries take precedence over an auto-derived entry for
   the same key (used for `ai.agent-operations` and `ai.mcp-discovery`, where
   the hand-written note captures a facade-execution boundary the mechanical
   derivation cannot see).

Drift gate: `npm run sdk-coverage:check` regenerates the document in memory
and fails if it differs from the committed `config/sdk-coverage.v1.json` --
any SDK change that alters `support-manifest.v1.json`'s protocols/claims or
the coverage crosswalk without regenerating the snapshot (`npm run
sdk-coverage:generate`) fails CI. Schema: `config/sdk-coverage.schema.json`.

Published as a versioned build artifact (`sdk-coverage-v1`) on trunk pushes
in `.github/workflows/ci.yml`, for honua-evidence's aggregate ingestion.

### Honesty rules

- `partial` always carries a `note`.
- Capabilities the SDK doesn't touch are omitted, never padded with `none`.
- `sinceVersion` is the current `package.json` version for every entry in
  this initial snapshot (the SDK does not yet mine per-key introduction
  versions from history); treat it as "coverage confirmed as of this
  version," not a precise introduction date.
