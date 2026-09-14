# Hazards Editor conversion experiment

Owner: [SDK #1707](https://github.com/honua-io/honua-sdk-js/issues/1707).
Original: [Esri Editor component sample](https://developers.arcgis.com/javascript/latest/sample-code/editor-basic/),
WebMap `4793230052ed498ebf1c7bed9966bd35`. The captured HTML used ArcGIS 5.1;
it is a dated published-page baseline rather than a pinned GitHub application.

This newly authored conversion composes the published SDK's
`createFeatureEditorWorkflow`, `<honua-feature-editor>`, subtype/domain projection,
attachment operations, and `createTerraDrawEditorSketch`. MapLibre renders the
three imported layers. Query rows are mapped to edit-session features using the
discovered primary key. The geometry converter supplies explicit EPSG:4326.

## Run against disposable imports

Import Hazards_Uptown_Charlotte/0, Road_Closure/0, and Hazard_Areas/0 through the
Honua server importer. Reconcile fields, subtypes, feature IDs, geometry and
attachments before enabling the app. Bind the actual service/layer identities
from the receipts; never assume IDs survive a fresh run.

```powershell
npm ci
$env:VITE_HAZARDS_URL = '/rest/services/onboarding-editor-hazards-003/FeatureServer/RECEIPT_LAYER_ID'
$env:VITE_ROADS_URL = '/rest/services/onboarding-editor-roads-003/FeatureServer/RECEIPT_LAYER_ID'
$env:VITE_AREAS_URL = '/rest/services/onboarding-editor-areas-003/FeatureServer/RECEIPT_LAYER_ID'
$env:HONUA_ALLOWED_SERVICES = 'onboarding-editor-hazards-003,onboarding-editor-roads-003,onboarding-editor-areas-003'
# Supply HONUA_LOCAL_API_KEY from the private local environment, never a VITE_* variable.
npm run dev
```

The loopback Vite proxy targets port 18615. Writable URLs must be same-origin,
under `/rest/services/onboarding-editor-*/FeatureServer/<numeric id>`. There is
no original Esri service fallback. Imported metadata must advertise EPSG:4326
and subtype definitions. Missing dependencies stop startup with a visible error.

## Evidence and remaining work

The original browser exposed eight hazard, two road-closure and two area
templates; choosing Flooding opened a point-drawing draft. No original-service
mutation was submitted. The initial converted build failed because query results
do not expose the edit session's top-level `id`; the explicit key mapping fixed
it. The next build passed in 6.377 seconds. Install took 39.308 seconds.

All three backend plans were applied: hazards 4,246 rows (layer 6), roads 35
(layer 7), areas 49 (layer 8). All terminate NeedsReview. Target metadata omits
feature types and templates and advertises Query only; hazards and areas lose
attachment capability, and hazards loses the GlobalID binding. Reconciliation
also needs source-aware geometry diagnosis: roads have seven null geometries on
both source and target. These gaps are tracked in server #4824, #4825 and #4826.
CRUD persistence, geometry
reshape, cancel/undo, invalid domains, attachments, keyboard interaction and
browser behavior are **unverified**. The UI supports one selected feature at a
time; the original's multi-selection tools remain a parity gap. Original symbol
assets are not redistributed. The replacement uses simple native map styles.

The initial bundle emitted a 570.86 kB gzip main chunk, a 506.72 kB worker
(uncompressed), and lazy drawing/runtime chunks. These are build observations,
not a controlled performance comparison. Offline editing, source data reuse
rights, immutable snapshot restore and repeated fresh conversions are not
qualified by this attempt.
