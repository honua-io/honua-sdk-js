# LA venue finder conversion

Exploratory implementation for [SDK #1704](https://github.com/honua-io/honua-sdk-js/issues/1704).
This is a standalone installed-package app, not yet an admitted gallery sample or
a completed backend migration. The canonical requirements remain in Specifica.

## Run

Use Node >=20.19. Install with `npm ci`, then `npm run check` and `npm run build`.
The lockfile pins the published SDK 0.1.9-beta.0 and MapLibre 6.9.0, including
registry integrity. No workspace aliases or ArcGIS JS runtime are used.

Before `npm run dev` or a production build, explicitly bind all three layer URLs:

```powershell
$env:VITE_VENUES_URL = '/rest/services/<venue-service>/FeatureServer/<layer-id>'
$env:VITE_BUFFER2_URL = '/rest/services/<two-mile-service>/FeatureServer/<layer-id>'
$env:VITE_BUFFER5_URL = '/rest/services/<five-mile-service>/FeatureServer/<layer-id>'
$env:HONUA_ALLOWED_SERVICES = '<venue-service>,<two-mile-service>,<five-mile-service>'
# Supply HONUA_LOCAL_API_KEY from the ignored local environment, never a VITE_* variable.
npm run dev
```

Derive each binding from that run's import receipt; do not assume source and target
layer IDs match. The optional development proxy targets only localhost:18615 and
the explicitly listed services. Keep it local; deployment needs normal scoped
customer authentication. The browser gets no administrator credential.

The default basemap is empty, so the app does not silently depend on a licensed
Esri basemap. The source-service preview explicitly sets `VITE_BASEMAP_STYLE` to
`https://tiles.openfreemap.org/styles/liberty`, following the
[OpenFreeMap quick start](https://openfreemap.org/quick_start/), with the style's
OpenFreeMap/OpenMapTiles/OpenStreetMap attribution retained. This is a declared
visual substitution, not pixel parity with Esri's topographic map. A customer can
bind their own MapLibre style instead.

For **client-only diagnosis**, all three URLs can explicitly point at the original
public service. Record this as a source-service preview. It does not establish
service import, reconciliation, absence of Esri operational reads, or onboarding
completion. There is no automatic operational-service fallback.

## Workflow and translation

The app uses the SDK's `createHonua → connect → inspect → query` primitives, requests
WGS84 geometry, normalizes imported attribute names at the app boundary, and uses
the SDK's geometry converter to render all three layers through MapLibre.
The worker follows the supported Vite scaffold (`?worker&url`).

Search, alphabetical sorting, multiple category filters, list selection, map
selection, detail/back navigation, popups, category colors, dim/grayscale effects,
selection glow and a buffer legend are implemented. The glow is a MapLibre circle
approximation of Esri bloom; inspect it as a visual variation. Search affects the
list, while category and selection affect map emphasis, matching the original
finder behavior. WGS84 detail coordinates intentionally correct the source app's
mislabelled projected `Latitude`/`Longitude` attributes.

Queries fail visibly on truncation, degraded results, missing geometry and invalid
venue longitude/latitude. The 100-row budget covers this frozen small sample only;
it is not a general paging claim. React StrictMode cancellation and retry rebuild
the owned map lifecycle. Browser Performance entries named `finder-load-N` measure
the successful data-and-map load; command receipts are recorded separately.

## Provenance and remaining validation

Workflow reference: Esri/jsapi-resources commit
`e9d4aa0d42c1f84ba29d6780188bb94a8a34bc0c`, `layouts/finder-sample`, Apache-2.0.
This app is newly authored; no original source files, sample data, symbols or fonts
are copied into this directory. Code licensing does not establish permission to
redistribute service data. Baselines, locks and local data captures remain outside
this tracked app.

Current evidence: original installed/built and displayed 26 venues; original
Santa Monica search, details/back, empty search and Coastal filtering observed.
The standalone conversion installed and built, and displayed 26 venues with
colored markers on the explicitly configured source-service preview. Both buffer
dependencies are queried before the ready state. All failures remain in run-003
receipts in the migration experiment's ignored local directory.

Remaining: complete browser checklist and network/interaction measurements;
qualified import of all three layers into the patched local server; actual target
coordinate/extent parity; target-only production browser replay; independent
fresh conversions; snapshot capture/restore qualification. Do not infer those
outcomes from a successful build or a source-service browser run.
