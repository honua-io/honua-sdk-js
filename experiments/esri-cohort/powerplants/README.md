# Global power plants conversion

Exploratory application for [SDK #1705](https://github.com/honua-io/honua-sdk-js/issues/1705).
This is a standalone installed-package conversion with incomplete onboarding
qualification. The canonical acceptance criteria remain in Specifica.

## Run

Use Node >=20.19, `npm ci`, `npm run check`, and `npm run build`. The lock pins
published SDK 0.1.9-beta.0, MapLibre 6.9.0 and Vega dependencies. No workspace aliases
or ArcGIS JavaScript runtime are used.

Bind `VITE_POWERPLANTS_URL` explicitly before starting or building. For a local
import, use `/rest/services/<service>/FeatureServer/<layer-id>` from the import
receipt, set `HONUA_ALLOWED_SERVICES` to that service name and supply
`HONUA_LOCAL_API_KEY` from the ignored environment. The development/preview proxy
targets localhost:18615; the administrator credential stays server-side. This
proxy is for the disposable experiment, not deployment authentication.

`npm run dev` serves localhost:18620. Optional `VITE_LIGHT_BASEMAP_STYLE` and
`VITE_DARK_BASEMAP_STYLE` select MapLibre styles. The explicit source-service
preview uses OpenFreeMap liberty/dark, preserving its attribution. Without these
bindings the basemap is empty. There is no automatic Esri operational fallback.

## Workflow and observed differences

The SDK connects to and inspects the source, queries independent counts grouped
by fuel, then streams 1,000-row pages ordered by feature identity. Every loaded
row must reconcile to the independent fuel counts. Duplicate IDs, invalid point
coordinates, degraded results and counts over the reviewed 35,000-row budget
produce a visible failure. Requests share a three-minute cancellation budget.

All/Solar/Oil controls change headline metrics; the map and charts retain the full
dataset, matching the original interaction scope. Sidebar, about panel, map
legend, light/dark modes, map popups and independent pie/box-plot toggles are
implemented. Chart settings translate the source's count-by-fuel pie with groups
under 4%, and capacity-by-fuel box plots with outliers. Vega quartiles and pointer
interactions still need independent comparison with the original chart.

The original's unpaged headline query displays 12,000 plants (72% renewable),
although the service contains 28,664. Its Solar metric displays 1,849. The
conversion deliberately corrects this truncation: 28,664 total (67% renewable),
5,427 Solar (100% renewable), and 2,925 Oil (0% renewable), observed in the browser
against the original source. Its pie includes three records with null fuel as
Other; the original pie omits them. Null plus named Other reconcile to 39 records.
These corrections must remain explicit in parity reports.

Source preview checks observed both charts, solar/oil metrics and dark-mode state
without an application alert. Rendering a chart initially created duplicate Vega
action menus under React StrictMode; an owned per-effect host now prevents that.
An invalid Vega box-plot option and fuel-group normalization also failed during
conversion and were corrected. All attempt receipts are retained locally.

## Provenance and remaining evidence

Workflow source: Esri/jsapi-resources commit
`e9d4aa0d42c1f84ba29d6780188bb94a8a34bc0c`, `layouts/dashboard-sample`, Apache-2.0.
Chart semantics came from its referenced item
`6fea417194a0475d8306e24c14220081`. This app is newly authored; original source,
service records and embedded Esri imagery are not copied into this project.
Service data attribution and redistribution terms must be reviewed independently
of the sample-code license before publishing data or captures.

The first local service import failed with PostgreSQL lock exhaustion before
publishing rows; [server #4820](https://github.com/honua-io/honua-server/issues/4820)
tracks the savepoint-lifetime defect. A working source preview is not import proof.
Remaining: successful backend import and independent reconciliation, target-only
production browser replay, complete popup/chart interactions, measured network
and response budgets, fresh conversion repeats and qualified snapshot restore.
