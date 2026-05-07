# Honua Server Protocol Integration Lane

The integration lane in `test/integration/` exercises the public
`HonuaClient` and its sub-surfaces against a real seeded Honua Server.
It complements the mock-backed unit suites in `test/` (which prove SDK
behavior in isolation) by catching drift between the SDK and live
server routes, response shapes, errors, and capability negotiation.

## Lane shape

- **Connect-only.** The SDK does not own the server bootstrap. The
  integration lane reads `HONUA_INTEGRATION_BASE_URL` and skips the
  entire suite when that variable is unset, so a clean clone passes
  `npm run test:integration` even with no server running.
- **Caller owns auth + seeding.** The lane assumes the target server is
  already running, seeded with the configured service / layer /
  collection, and reachable. `getCompatibility()` (the global setup
  health probe) hits `/api/v1/admin/capabilities`, which is gated by
  the server's admin auth — the harness passes
  `HONUA_INTEGRATION_API_KEY` as the `X-API-Key` header, and that value
  must match the server's `HONUA_ADMIN_PASSWORD`.
- **Public API only.** Tests call methods on `HonuaClient`, its
  factory-returned helpers (`featureLayer`, `mapService`,
  `imageService`, `geometryService`, `geoprocessing`, `ogcFeatures`,
  `ogcTiles`, `ogcMaps`, `ogcProcesses`, `stac`, `wfs`, `wms`, `wmts`,
  `odata`), and standalone public clients such as
  `HonuaGeocodingClient`. Private HTTP helpers from
  `honua-server/tests/` are not used.
- **One file per protocol surface.** `test/integration/surfaces/`
  contains one `*.integration.ts` per surface; each file calls
  `integrationSuite("<friendly>", "<surface-tag>", () => …)` so the
  metadata reporter can attach the surface to every CI run.

## Running locally

The recommended local fixture is `tests/python/shared/js_test_server.py`
in `honua-server`, which spins up a seeded PostGIS, applies the test
catalog (service `test_service_gw0`, layer 1000 named "Test Layer", a
small set of point features), and runs Honua Server in dev-auth mode on
`:5555`:

```bash
# 1. Start the seeded JS test server (from the honua-server checkout).
cd /path/to/honua-server
python -m tests.python.shared.js_test_server  # prints {"base_url": "http://127.0.0.1:5555", ...}

# 2. Run the integration lane against it. The js_test_server fixture
#    runs the server in dev-auth mode, so HONUA_INTEGRATION_API_KEY can
#    be any non-empty string (the value is still forwarded as
#    X-API-Key but the server does not validate it in dev-auth mode).
cd /path/to/honua-sdk-js
HONUA_INTEGRATION_BASE_URL=http://localhost:5555 \
  HONUA_INTEGRATION_API_KEY=local-dev \
  npm run test:integration
```

If you point the lane at a Docker Compose-launched server (admin auth
on, default port `:8080`), pass the configured admin password as the
API key:

```bash
HONUA_INTEGRATION_BASE_URL=http://localhost:8080 \
  HONUA_INTEGRATION_API_KEY="$HONUA_ADMIN_PASSWORD" \
  HONUA_INTEGRATION_COLLECTION_ID=places \
  npm run test:integration
```

## Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `HONUA_INTEGRATION_BASE_URL` | _(required)_ | Server URL the lane connects to. Suite skips when absent. |
| `HONUA_INTEGRATION_SERVICE_ID` | `test_service_gw0` | GeoServices service ID (FeatureServer / MapServer / WMS / WMTS). |
| `HONUA_INTEGRATION_LAYER_ID` | `1000` | FeatureServer / MapServer layer ID. |
| `HONUA_INTEGRATION_COLLECTION_ID` | `1000` (numeric layer ID) | OGC API Features / Maps / Tiles collection ID. The default rides the server's layer-id-by-numeric resolution path so it works against the `js_test_server.py` seed; override with the layer name when the target seed exposes a friendlier collection identifier (`places`, `roads`, etc). |
| `HONUA_INTEGRATION_API_KEY` | _(required)_ | `X-API-Key` header sent on every SDK call, including the `getCompatibility()` health probe against `/api/v1/admin/capabilities`. Must match the server's `HONUA_ADMIN_PASSWORD`. |
| `HONUA_INTEGRATION_TILE_MATRIX_SET` | `WebMercatorQuad` | OGC Tiles tile-matrix-set ID. |
| `HONUA_INTEGRATION_SEED_PROFILE` | `places-roads-v1` | Free-form label for the seed configuration; recorded into the metadata file but not sent on the wire. |
| `HONUA_INTEGRATION_BEARER_TOKEN` | _(unset)_ | Optional `Authorization: Bearer …` header (use only against bearer-secured deployments — admin endpoints expect `X-API-Key`). |
| `HONUA_INTEGRATION_TIMEOUT_MS` | `30000` | Per-request timeout used by the harness `HonuaClient`. |
| `HONUA_INTEGRATION_SERVER_IMAGE` | _(unset)_ | Recorded into `integration-meta.json` (CI uses the resolved image digest). |
| `HONUA_INTEGRATION_SERVER_COMMIT` | _(unset)_ | Honua Server commit SHA, recorded into `integration-meta.json`. CI reads it from the workflow `server_commit` input or `vars.HONUA_INTEGRATION_SERVER_COMMIT`; it is never derived from `${{ github.sha }}` (which is the SDK repo commit). Leave blank when the server commit is unknown. |
| `HONUA_INTEGRATION_STAC_COLLECTION_ID` | `HONUA_INTEGRATION_COLLECTION_ID` | STAC collection ID used for optional collection/item probes. |
| `HONUA_INTEGRATION_ODATA_BASE_PATH` | `/odata` | OData service root path. |
| `HONUA_INTEGRATION_ODATA_ENTITY_SET` | `Layers(<layerId>)/Features` | OData entity set or navigation path for the configured layer. |
| `HONUA_INTEGRATION_IMAGE_SERVICE_ID` | _(unset)_ | Enables ImageServer live coverage against a seeded raster service. |
| `HONUA_INTEGRATION_GP_SERVICE_ID` | _(unset)_ | Enables GPServer live coverage against a seeded job service. |
| `HONUA_INTEGRATION_GP_TASK_NAME` | _(unset)_ | Optional GPServer task segment for task-scoped services. |
| `HONUA_INTEGRATION_GP_PARAMETERS_JSON` | `{}` | JSON object submitted to the configured GPServer task. |
| `HONUA_INTEGRATION_WFS_ENDPOINT_URL` | _(unset)_ | Enables WFS live coverage against a seeded WFS endpoint. |
| `HONUA_INTEGRATION_WFS_TYPE_NAME` | _(unset)_ | WFS feature type used by the live WFS probe. |
| `HONUA_INTEGRATION_GEOCODING_LOCATOR` | _(unset)_ | Enables GeocodeServer live coverage against a seeded locator. |
| `HONUA_INTEGRATION_GEOCODING_PROBE_TEXT` | `Honolulu` | Forward-geocode text used when geocoding coverage is enabled. |

## Surface coverage

The lane exercises the following surfaces against the seed profile.

| Surface | Status | Notes |
| --- | --- | --- |
| FeatureServer | Exercised | metadata, queryFeatures, queryFeatureCount, queryObjectIds |
| MapServer | Exercised | metadata, mapLayer.queryFeatures, queryFeatureCount, exportMap |
| ImageServer | Configured | `client.imageService().metadata` when `HONUA_INTEGRATION_IMAGE_SERVICE_ID` is set; otherwise recorded skipped because the default seed is vector-only |
| GeometryServer | Exercised | `client.geometryService().project`, `buffer` |
| GPServer | Configured | submitJob and jobStatus when `HONUA_INTEGRATION_GP_SERVICE_ID` is set; otherwise recorded skipped because the default seed has no runnable GP task |
| OGC API Features | Exercised | landing, conformance, collections, items, item |
| OGC API Tiles | Exercised | landing, conformance, tileMatrixSets (list + by id), tilesets, tile |
| OGC API Maps | Exercised | landing, conformance, map render |
| OGC API Processes | Exercised | landing, conformance, list, describe (when registered) |
| STAC | Exercised | landing, collections, search, collection when advertised |
| WFS | Configured | capabilities and bounded GetFeature when WFS endpoint/type env vars are set; otherwise recorded skipped |
| WMS | Exercised | capabilities, GetMap |
| WMTS | Exercised | capabilities, GetTile |
| OData | Exercised | metadata, bounded entity query |
| Geocoding | Configured | forwardGeocode when `HONUA_INTEGRATION_GEOCODING_LOCATOR` is set; otherwise recorded skipped |

Skipped surfaces are recorded in `test-results/integration-meta.json`
with a `reason` field so the gap is visible in CI artifacts; this keeps
unsupported surfaces from silently disappearing from coverage.

## Failure diagnostics

Each SDK call is wrapped in `runWithDiagnostics(...)`. When an
assertion or an SDK error fires, the test message is augmented with a
standard block:

```
[honua-integration]
  SDK method   : client.featureLayer().queryFeatures
  Request path : /rest/services/test_service_gw0/FeatureServer/1000/query
  HTTP method  : GET
  HTTP status  : 500
  Duration ms  : 142.3
  Body excerpt : { "error": { "code": 500, "message": "..." } }
```

The body excerpt is bounded to 500 characters; longer bodies are
truncated with a `[truncated, original N chars]` suffix.

## CI integration

`.github/workflows/integration.yml` runs the lane on `trunk` /
`release/**` pushes and on manual dispatch. It is **connect-only**
against an externally-managed seeded Honua Server — the SDK repo does
not own the server bootstrap or seed because there is no public
seed-on-start image or admin seed API in honua-server today (tracked
as a follow-on, see "Deferred infrastructure" below).

The job:

1. Reads `HONUA_INTEGRATION_BASE_URL` from the workflow input or repo
   variable. If neither is set, the workflow exits 0 with a notice in
   the step summary so trunk pushes do not fail before the staging
   environment is provisioned.
2. Verifies that `HONUA_INTEGRATION_API_KEY` (repo secret) is present;
   otherwise it fails fast with an explicit error. The value must
   match the target server's `HONUA_ADMIN_PASSWORD`.
3. Polls `${HONUA_INTEGRATION_BASE_URL}/healthz/live` until the server
   reports healthy.
4. Runs `npm run test:integration` with the resolved env.
5. Uploads `test-results/integration-meta.json` as the
   `integration-meta` artifact (always, including on failure).
6. Renders a summary table into `$GITHUB_STEP_SUMMARY` listing every
   surface and its status.

### Required repo configuration

| Scope | Name | Purpose |
| --- | --- | --- |
| Repository variable | `HONUA_INTEGRATION_BASE_URL` | URL of the staging Honua Server. When unset the workflow skips. |
| Repository secret | `HONUA_INTEGRATION_API_KEY` | `X-API-Key` (matches server `HONUA_ADMIN_PASSWORD`). Required when the base URL is set. |
| Repository variable (optional) | `HONUA_INTEGRATION_SERVICE_ID`, `HONUA_INTEGRATION_LAYER_ID`, `HONUA_INTEGRATION_COLLECTION_ID`, `HONUA_INTEGRATION_TILE_MATRIX_SET`, `HONUA_INTEGRATION_SEED_PROFILE`, `HONUA_INTEGRATION_SERVER_IMAGE`, `HONUA_INTEGRATION_SERVER_COMMIT` | Override the corresponding harness defaults to match the staging seed. `HONUA_INTEGRATION_SERVER_COMMIT` records the Honua Server commit (not the SDK commit) in `integration-meta.json`; leave unset when it is unknown. |

### Deferred infrastructure

- A `:nightly-seeded` (or equivalent) Honua Server image with the test
  catalog baked in does not yet exist. Until it does, the workflow
  cannot bootstrap its own server from inside CI.
- A public admin seed API (`POST /api/v1/admin/services` /
  `.../layers` / `.../features`) does not yet exist. Until it does,
  the SDK repo cannot seed a freshly-started server without sibling-
  checking out honua-server and reaching into its Python fixture.

These gaps are tracked as honua-server follow-ons and re-enable the
service-container path in this workflow once either lands.

### Metadata artifact

`integration-meta.json` records the run context:

```json
{
  "sdkPackage": "@honua/sdk-js",
  "sdkVersion": "0.0.3-alpha.0",
  "serverVersion": "1.x.y",
  "serverReleaseChannel": "preview",
  "serverImage": "ghcr.io/honua-io/honua-server@sha256:…",
  "serverCommit": "<honua-server commit SHA, or null when unknown>",
  "baseUrl": "http://localhost:5555",
  "seedProfile": "places-roads-v1",
  "serviceId": "test_service_gw0",
  "layerId": 1000,
  "collectionId": "1000",
  "tileMatrixSetId": "WebMercatorQuad",
  "startedAt": "2026-04-28T01:23:45Z",
  "surfaces": [
    { "surface": "feature-server", "status": "exercised", "recordedAt": "…" },
    { "surface": "image-server", "status": "skipped", "reason": "…", "recordedAt": "…" }
  ]
}
```

This is the lane's only persistent observable signal — the workflow
attaches it to every run so SDK / server drift is traceable from the
GitHub Actions UI without re-running the suite.
