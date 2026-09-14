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

Use `npm ci` with the committed lockfile for repeat runs.
`npm run dev` listens on `http://127.0.0.1:18626`.
Bind these four spatial resources to the corresponding import receipt:

- `VITE_FLIGHTS_URL`: flight tracks (the current disposable import covers January 11, 2026 only).
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
- Complaint table constrained by day and optional current extent; aircraft selection independently highlights map complaints within a half-mile corridor.
- Selected track start times constrain the complaint highlight time range, without changing the table's filters.
- Six-minute flight-count chart using the source chart's first-timestamp alignment, zero-count empty intervals and incomplete-interval trimming; chart points select their underlying tracks.
- Flight, complaint and census boundary toggles with a visible legend.
- Pointer-following half-mile neighborhood lens with debounced queries, using whole-intersecting-tract population sums and income averages; clicking also positions the lens.
- Query cancellation, count/paging reconciliation and explicit incomplete-query errors.

## Remaining fidelity work

Full date-range backend import and the related nonspatial complaint table remain
unqualified. The latter currently fails service import (server #4834); its
relationship is not fabricated here. The calendar only lists dates actually
present in the imported flight population. Missing source dates are not shown
as zero-flight days.

The thematic summary renderer, map navigation constraints, chart selection
gestures and remaining webmap metadata still require conversion and verification.
The chart configuration was captured from flight item
`1b496d1b79fd4344ab548a1f2399c5fa`, chart `1771976572578`; its implementation still
needs complete interaction comparison against the source chart in the browser.
The source N945RF chart on January 11, 2026 displays counts
`177, 160, 13, 0, 0, 0, 125, 211`; local binning matches these values and trims
48 of its 734 records from the trailing interval. Its count aggregation displays
zeroes despite the saved `nullPolicy: "null"`, so the conversion follows the
observed count chart. `npm test` checks binning boundaries and identity accounting.
App formatting, all four chart tests and the TypeScript/Vite production build
pass. Browser interaction qualification and repeat-run timings remain pending.
Keep these gaps open when reporting cohort completion.

The first local browser run reached the free basemap and imported services but
stopped at calendar initialization: the backend's grouped date query returned
`1/11/2026`, while ordinary feature queries returned `2026-01-11`. The app rejects
this ambiguous date instead of guessing a locale. The statistics-reader fix is
being validated with server PR #4839; the live backend has not yet received it.
