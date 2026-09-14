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

- `VITE_FLIGHTS_URL`: flight tracks. The original UI binding covers January 11, 2026; the full cached import is now published separately as described below.
- `VITE_COMPLAINTS_URL`: individual NYC 311 noise complaints.
- `VITE_CENSUS_URL`: census population/income polygons.
- `VITE_SUMMARY_URL`: complaint-summary census tract polygons.

Bindings must be same-origin `/rest/services/onboarding-heli-*/FeatureServer/<id>`
paths. Set `HONUA_ALLOWED_SERVICES` to their comma-separated service names,
`HONUA_LOCAL_PORT` to the disposable Honua port, and `HONUA_LOCAL_API_KEY` in
the server process environment. Never put credentials in `VITE_*` variables.
The Vite proxy forwards only the explicitly configured service prefixes.
`VITE_BASEMAP_STYLE` overrides the default OpenFreeMap Positron style.

The full flight import is now available on the disposable candidate at
`/rest/services/onboarding-heli-flights-full-004/FeatureServer/12`, backend port
18631. Publication reused the retained 698,843-row table and completed in 305.2
seconds. Public readback matches the full count and the January 11 count of 1,963,
advertises Z coordinates and EPSG:4326, and returns three-coordinate vertices.
The captured service renderer was restored through the admin drawing-info API
and matches public metadata exactly. These checks establish publication recovery;
the existing UI has not yet been rebound or browser-qualified against the full
population. Keep the original binding available until that comparison is complete.

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

Full date-range backend publication remains unqualified. The related nonspatial
table now has an imported 877-row backend: installed SDK candidate `39ab91b8e`
against server `66a3217a2` passed count, four-page streaming, unique IDs and a typed
Join_ID filter, with all non-object-ID attributes matching the source. These
readbacks do not qualify the pending table-metadata changes or the relationship.
All 579 imported parent keys and 877 child keys match with no orphans, but the
target related-record endpoint still reports the missing relationship (server
#4834). That dependency and its UI use remain unfinished. The calendar only lists
dates actually present in the imported flight population; missing source dates
are not shown as zero-flight days.

The thematic summary renderer, scale-dependent symbol widths, map navigation constraints, chart selection
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

The first local browser run stopped at calendar initialization because grouped
dates returned `1/11/2026`. A separate candidate backend with the statistics-reader
fix from server PR #4839 now returns `2026-01-11`. On September 14, 2026 the browser
loaded 1,963 tracks across five aircraft and the N945RF chart displayed the eight
expected bins above. Server regression qualification remains pending: the first
test build encountered DLLs locked by the original demo server, so the retry
uses an isolated artifact directory.

Flight colors now reproduce the source `Speed` visual variable, including its
five stops and alpha. Source item JSON SHA-256:
`c9baf813cdd54a9aa5c3b4f887c120806cfacbb1f7e4bde681eb265ee3331ec3`.
The sample composes this ramp with SDK expressions and resolves the imported
field name from schema. Automatic WebMap visual-variable conversion remains
open in SDK #1723. The speed legend, colored tracks, red complaints and basemap
attribution were inspected in the browser; formatting and the production build
pass for this change (1.653 s and 11.288 s respectively).

Selecting a whole aircraft exposes another transport gap: the buffered corridor
is sent as a GET query and the local proxy returns HTTP 431. The chart and day
table still render, but aircraft-to-complaint highlighting is not qualified.
This must be fixed without dropping or simplifying the spatial constraint.
