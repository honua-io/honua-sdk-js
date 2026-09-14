# NYC helicopter noise conversion

Exploratory Honua/MapLibre conversion of Esri's
[NYC helicopter noise explorer](https://github.com/Esri/nyc-heli-noise-explorer),
reviewed at source commit `c162bc12b34a6ef3f91dcc7e4d54790a504a9c27` (Apache-2.0, Esri 2026).
This implementation is not yet browser-qualified or a completed parity claim.

The application uses installed `@honua/sdk-js` sources for discovery, typed
filters, server aggregation and bounded feature paging. `@honua/geometry`
constructs half-mile search polygons; operational queries run against local
Honua imports. No Esri operational-service fallback is configured.

## Local bindings

Use `npm install` to establish this new application's lockfile, then `npm ci`
for repeat runs. `npm run dev` listens on `http://127.0.0.1:18626`.
Bind these four spatial resources to the corresponding import receipt:

- `VITE_FLIGHTS_URL`: flight tracks (the current disposable import covers January 11, 2025 only).
- `VITE_COMPLAINTS_URL`: individual NYC 311 noise complaints.
- `VITE_CENSUS_URL`: census population/income polygons.
- `VITE_SUMMARY_URL`: complaint-summary census tract polygons.

Bindings must be same-origin `/rest/services/onboarding-heli-*/FeatureServer/<id>`
paths. Set `HONUA_ALLOWED_SERVICES` to their comma-separated service names,
`HONUA_LOCAL_PORT` to the disposable Honua port, and `HONUA_LOCAL_API_KEY` in
the server process environment. Never put credentials in `VITE_*` variables.
The Vite proxy forwards only the explicitly configured service prefixes.
`VITE_BASEMAP_STYLE` overrides the default OpenFreeMap Positron style.

## Workflows written; validation pending

- Available-day calendar populated by source-side flight counts, with UTC date semantics.
- Day-specific map tracks and aircraft grouping by registration, description and aircraft type.
- Aircraft and multiple-track selection, with selected paths highlighted and other tracks dimmed.
- Complaint table constrained by day, optional current extent, and half-mile selected-flight corridor.
- Flight, complaint and census boundary toggles with a visible legend.
- Click-based half-mile neighborhood lens, using whole-intersecting-tract population sums and income averages.
- Query cancellation, count/paging reconciliation and explicit incomplete-query errors.

## Remaining fidelity work

Full date-range backend import and the related nonspatial complaint table remain
unqualified. The latter currently fails service import (server #4834); its
relationship is not fabricated here. The calendar only lists dates actually
present in the imported flight population. Missing source dates are not shown
as zero-flight days.

The original pointer-following lens, proportional timeline chart/selection-time
complaint effect, thematic summary renderer, and chart/webmap metadata adoption
still require conversion and verification. Current track selection applies a
spatial complaint filter for the selected day; it does not yet reproduce the
source's start-time selection effect. Unit/build/browser evidence and repeat-run
timings are still pending. Keep these gaps open when reporting cohort completion.
