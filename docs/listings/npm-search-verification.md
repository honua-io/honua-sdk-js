<!-- GENERATED FILE — do not edit by hand. -->
<!-- Regenerate with: npm run docs:npm-search -->
<!-- Inputs: docs/data/npm-search-observations.v1.json. -->
<!-- Re-observe against the live registry with: npm run docs:npm-search:observe -->
<!-- Freshness and drift are enforced by npm run docs:npm-search:check. -->

# npm search discoverability, as measured

Declaring keywords is not discoverability. This page records where the packages this
repository publishes **actually rank** in npm registry search for the discovery terms the
package metadata claims — including the queries where they do not rank at all, which is the
half a keyword list can never tell you.

Every row below is projected from a dated record in [`docs/data/npm-search-observations.v1.json`](../data/npm-search-observations.v1.json),
validated against
[`schemas/npm-search-observations.v1.json`](../../schemas/npm-search-observations.v1.json).
Each observation must report **every** tracked package, found or not, so a query where Honua
does not appear cannot be dropped from the page. Records are immutable per observation:
re-observing a query adds a record and the page projects the newest one, so a rank that got
worse stays in the file as provenance.

## How the numbers were taken

- **Endpoint:** `https://registry.npmjs.org/-/v1/search` — the registry itself, not a mirror or a third-party rank tracker.
- **Page size:** 20 results, matching npmjs.com's own paging. "Page 1" below means the first 20 ranked results.
- **Scan depth:** 250 ranked results per query. A package reported as "not in the top 250" is exactly that claim and no stronger.
- **Reproduce:**

```bash
npm run docs:npm-search:observe   # re-query the live registry and rewrite the records
npm run docs:npm-search           # regenerate this page from the committed records
```

Search ranking is a moving, unowned target: it depends on npm's own scoring, on download
counts, and on what else was published that week. Treat every row as an observation with a
date on it, not as a property of the package.

One consequence worth stating plainly: these ranks reflect the metadata **as published**, not
the metadata in the working tree. Improving a package's keywords cannot move its rank until
the next release carries them to the registry, so a row here can lag a merged fix by a whole
release cycle.

## Tracked packages

- `@honua/sdk-js`
- `@honua/mcp-server`
- `create-honua-app`

## Observed rankings

| Query | Package | Result | Observed | Registry matches |
| --- | --- | --- | --- | ---: |
| `maplibre arcgis migration` | `@honua/sdk-js` | page 5 (rank 86) | 2026-08-25 | 20,325 |
|  | `@honua/mcp-server` | not in the top 250 |  |  |
|  | `create-honua-app` | not in the top 250 |  |  |
| `arcgis migration` | `@honua/sdk-js` | **page 1** (rank 2) | 2026-08-25 | 19,260 |
|  | `@honua/mcp-server` | not in the top 250 |  |  |
|  | `create-honua-app` | not in the top 250 |  |  |
| `maplibre gis sdk` | `@honua/sdk-js` | page 7 (rank 130) | 2026-08-25 | 163,397 |
|  | `@honua/mcp-server` | not in the top 250 |  |  |
|  | `create-honua-app` | not in the top 250 |  |  |
| `ogc api features client` | `@honua/mcp-server` | page 11 (rank 209) | 2026-08-25 | 1,013,526 |
|  | `@honua/sdk-js` | not in the top 250 |  |  |
|  | `create-honua-app` | not in the top 250 |  |  |
| `stac client typescript` | `@honua/sdk-js` | not in the top 250 | 2026-08-25 | 600,845 |
|  | `@honua/mcp-server` | not in the top 250 |  |  |
|  | `create-honua-app` | not in the top 250 |  |  |
| `geocoding maplibre` | `@honua/sdk-js` | page 5 (rank 96) | 2026-08-25 | 2,446 |
|  | `@honua/mcp-server` | not in the top 250 |  |  |
|  | `create-honua-app` | not in the top 250 |  |  |
| `mcp server geospatial` | `@honua/sdk-js` | not in the top 250 | 2026-08-25 | 382,631 |
|  | `@honua/mcp-server` | not in the top 250 |  |  |
|  | `create-honua-app` | not in the top 250 |  |  |

## What each query is for

- `maplibre arcgis migration` **(tracked target)** — the exact success-metric query declared on #499 ("npm search for 'maplibre arcgis migration' surfaces @honua/sdk-js on page one"). Re-observe by 2026-11-25.
- `arcgis migration` — the `arcgis-migration` keyword's primary discovery term (REQ-004). Re-observe by 2026-11-25.
- `maplibre gis sdk` — the `maplibre` discovery term as a MapLibre developer shopping for a data client would type it (REQ-004). Re-observe by 2026-11-25.
- `ogc api features client` — the `ogc-api` discovery term (REQ-004). Re-observe by 2026-11-25.
- `stac client typescript` — the `stac` discovery term (REQ-004). Re-observe by 2026-11-25.
- `geocoding maplibre` — the `geocoding` discovery term (REQ-004). Re-observe by 2026-11-25.
- `mcp server geospatial` — the discovery path to `@honua/mcp-server` for an agent developer. Re-observe by 2026-11-25.

## Tracked targets

- `maplibre arcgis migration` → `@honua/sdk-js` on page 1: **not met** — page 5 (rank 86) as observed 2026-08-25.

A target that is not met is reported here rather than removed. These are tracked,
non-gating metrics on [#499](https://github.com/honua-io/honua-sdk-js/issues/499): CI fails
when this page drifts from its records, never because a rank is disappointing — the SDK does
not own npm's ranking function.

## What this page does not claim

- **Not a download count.** Rank is not adoption; the download baseline is tracked separately on #499.
- **Not a competitor comparison.** Which packages outrank Honua for a term is not a product claim; that comparison lives in [`docs/comparison.md`](../comparison.md) under its own evidence contract.
- **Not stable.** Nothing here is a guarantee about the next query you run; rerun the observe command.

The declared keywords and descriptions these queries test are gated separately by
`npm run verify:discoverability`, which covers every package this repository publishes.

Ecosystem directory entries and the external submission ledger live in
[`maplibre-plugin-directory.md`](./maplibre-plugin-directory.md).
