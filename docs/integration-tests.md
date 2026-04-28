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
- **Public API only.** Tests call methods on `HonuaClient` and its
  factory-returned helpers (`featureLayer`, `mapService`,
  `ogcFeatures`, `ogcTiles`, `ogcMaps`, `ogcProcesses`, `wms`, `wmts`).
  Private HTTP helpers from `honua-server/tests/` are not used.
- **One file per protocol surface.** `test/integration/surfaces/`
  contains one `*.integration.ts` per surface; each file calls
  `integrationSuite("<friendly>", "<surface-tag>", () => …)` so the
  metadata reporter can attach the surface to every CI run.

## Running locally

```bash
# 1. Start a Honua Server (Docker Compose listens on :8080 by default;
#    js_test_server.py listens on :5555 with seeded test data).
cd /path/to/honua-server
docker compose up -d
# or, for the JS-targeted seeded fixture:
python -m tests.python.shared.js_test_server  # prints {"base_url": ...}

# 2. Run the integration lane against it.
cd /path/to/honua-sdk-js
HONUA_INTEGRATION_BASE_URL=http://localhost:8080 npm run test:integration
```

## Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `HONUA_INTEGRATION_BASE_URL` | _(required)_ | Server URL the lane connects to. Suite skips when absent. |
| `HONUA_INTEGRATION_SERVICE_ID` | `test_service_gw0` | GeoServices service ID (FeatureServer / MapServer / WMS / WMTS). |
| `HONUA_INTEGRATION_LAYER_ID` | `1000` | FeatureServer / MapServer layer ID. |
| `HONUA_INTEGRATION_COLLECTION_ID` | `places` | OGC API Features / Maps / Tiles collection ID. |
| `HONUA_INTEGRATION_TILE_MATRIX_SET` | `WebMercatorQuad` | OGC Tiles tile-matrix-set ID. |
| `HONUA_INTEGRATION_SEED_PROFILE` | `places-roads-v1` | Free-form label for the seed configuration; recorded into the metadata file but not sent on the wire. |
| `HONUA_INTEGRATION_API_KEY` | _(unset)_ | Optional `X-API-Key` header. |
| `HONUA_INTEGRATION_BEARER_TOKEN` | _(unset)_ | Optional `Authorization: Bearer …` header. |
| `HONUA_INTEGRATION_TIMEOUT_MS` | `30000` | Per-request timeout used by the harness `HonuaClient`. |
| `HONUA_INTEGRATION_SERVER_IMAGE` | _(unset)_ | Recorded into `integration-meta.json` (CI uses the resolved image digest). |
| `HONUA_INTEGRATION_SERVER_COMMIT` | _(unset)_ | Recorded into `integration-meta.json` (CI uses `${{ github.sha }}`). |

## Surface coverage

The lane exercises the following surfaces against the seed profile.

| Surface | Status | Notes |
| --- | --- | --- |
| FeatureServer | Exercised | metadata, queryFeatures, queryFeatureCount, queryObjectIds |
| MapServer | Exercised | metadata, mapLayer.queryFeatures, queryFeatureCount, exportMap |
| OGC API Features | Exercised | landing, conformance, collections, items, item |
| OGC API Tiles | Exercised | landing, conformance, tileMatrixSets, tilesets, tile |
| OGC API Maps | Exercised | landing, conformance, map render |
| OGC API Processes | Exercised | landing, conformance, list, describe (when registered) |
| WMS | Exercised | capabilities, GetMap |
| WMTS | Exercised | capabilities, GetTile |
| ImageServer | Skipped | No first-party `client.imageService(...)` entry yet (tracked by honua-sdk-js#39). |
| GPServer | Skipped | No first-party `client.geoprocessing(...)` entry yet (tracked by honua-sdk-js#39). |

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
`release/**` pushes and on manual dispatch. The job:

1. Spins up `postgis/postgis:17-3.5-alpine` and the configured
   `ghcr.io/honua-io/honua-server` image as service containers.
2. Polls `/healthz/live` until the server reports healthy.
3. Runs `npm run test:integration` with `HONUA_INTEGRATION_BASE_URL`
   pinned to the in-job server.
4. Uploads `test-results/integration-meta.json` as the
   `integration-meta` artifact (always, including on failure).
5. Renders a summary table into `$GITHUB_STEP_SUMMARY` listing every
   surface and its status.

### Metadata artifact

`integration-meta.json` records the run context:

```json
{
  "sdkPackage": "@honua/sdk-js",
  "sdkVersion": "0.0.3-alpha.0",
  "serverVersion": "1.x.y",
  "serverReleaseChannel": "preview",
  "serverImage": "ghcr.io/honua-io/honua-server@sha256:…",
  "serverCommit": "<github.sha>",
  "baseUrl": "http://localhost:8080",
  "seedProfile": "ogc",
  "serviceId": "test_service_gw0",
  "layerId": 1000,
  "collectionId": "places",
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
