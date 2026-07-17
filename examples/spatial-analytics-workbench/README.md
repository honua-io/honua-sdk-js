# Linked Spatial Analysis Workbench

Flagship explain → accept → execute journey for issue #407. One immutable
query-plan fingerprint carries the selected AOI, risk filter, map, feature
table, risk chart, execution evidence, workspace export, and reusable output
artifact. Changing the AOI, filter, or policy produces a new estimate and
invalidates the prior acceptance.

## What the modes mean

| UI state | What happened |
| --- | --- |
| Estimate | `explainQuery()` compiled a plan from committed metadata. No result rows were read. |
| Fixture replay | The GeoServices `queryAggregate` request was compiled and executed against a committed response fixture. It is never labeled live. |
| Remote executed | A configured public GeoServices FeatureServer handled the accepted aggregate plan. The observation time and source/schema versions are recorded. |
| Bounded local | A GeoServices feature query fetched at most 65 rows (`maxRows=64` plus an overflow sentinel), checked a 256 KB ceiling, then ran metrics/groupBy locally. |
| Rejected | A deliberately unsafe two-row fallback was refused during planning; no partial aggregate was reported. |
| Skipped | Live configuration was absent or an OGC lane was selected. The reason is structured and no fixture result is substituted. |

Feature/query caching is bypassed. The generated output artifact is explicit
materialization with input/output attribution, plan fingerprint, source/schema
versions, observation time, and cache provenance.

The advanced indexed-response panel remains a clearly labeled fixture for the
existing `SpatialAggregationResult` widgets. It does **not** claim that #389
already compiles OGC/CQL2, DuckDB, H3, or Quadbin execution.

## Cloud-native S1 prerequisite and S2 linked workflow

`public/fixtures/cloud-native-analysis-columnar.v1.json` is a small,
digest-pinned columnar analysis fixture served from the application origin.
`src/cloud-native-prerequisite.ts` prepares it through the published
`@honua/sdk-js/query-planner` columnar contract with fixture, result, backing
buffer, and object-fallback ceilings. If a consumer cannot accept a columnar
batch, conversion is allowed only for four rows and otherwise fails closed.

This prerequisite is deliberately truth-limited: committed partition envelopes
model row-group selection, but HTTP range access, Parquet row-group counters,
worker execution/cleanup, and browser peak memory remain explicitly unobserved.
It is fixture preparation, not live or golden qualification.

The S2 control consumes that accepted prerequisite through either the public
columnar envelope or an explicit four-row object fallback. Both paths publish
the same feature objects into one public SDK exploration context, so AOI,
filter, map, table, chart, and detail selection remain linked. The UI reports
combined prerequisite time, SDK adaptation time, and browser render-commit
time separately; source-only and engine timing stay marked unobserved because
S1 does not expose those boundaries. The accessible DOM map is an explicit
fallback—not a claim of MapLibre, deck.gl/GeoArrow, or Kepler execution.

The sample is registered with the shared sample kit. Source and extracted
packed-package modes resolve only declared public SDK entrypoints and emit
`honua-sample-sdk-resolution.json` for browser verification.

## Run the deterministic lane

```sh
npm run demo:spatial-analytics
npm run demo:spatial-analytics:typecheck
npm run demo:spatial-analytics:build
npm run demo:spatial-analytics:evidence
npm run test:playwright:spatial-analytics
```

The fixture and structured live-skip envelopes live in `evidence/`; the
versioned presentation projection is `presentation.v1.json`. All use the #411
sample publication/evidence contract.

## Configured live GeoServices lane

Browser mode accepts public endpoint configuration through build-time variables
or equivalent query parameters (`mode=live`, `baseUrl`, `serviceId`, `layerId`).
Never put credentials or signed URLs in either location.

```sh
VITE_HONUA_SPATIAL_ANALYTICS_BASE_URL=https://demo.honua.io \
VITE_HONUA_SPATIAL_ANALYTICS_SERVICE_ID=incidents \
VITE_HONUA_SPATIAL_ANALYTICS_LAYER_ID=0 \
npm run demo:spatial-analytics
```

The headless evidence lane uses the corresponding `HONUA_*` variables and
writes `test-results/spatial-analytics-live-evidence.json`:

```sh
HONUA_SPATIAL_ANALYTICS_BASE_URL=https://demo.honua.io \
HONUA_SPATIAL_ANALYTICS_SERVICE_ID=incidents \
HONUA_SPATIAL_ANALYTICS_LAYER_ID=0 \
npm run demo:spatial-analytics:live-evidence
```

Without configuration it succeeds only by emitting a structured `skipped`
envelope. Setting `HONUA_SPATIAL_ANALYTICS_PROTOCOL=ogc-features` also emits a
structured compiler-unavailable skip until the CQL2/OGC compiler slice of #389
lands. It never simulates OGC or DuckDB execution.
