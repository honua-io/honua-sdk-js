# Node.js Backend Quickstart

Minimal Node HTTP service that uses the Honua JavaScript SDK from a backend process. It exposes fixture-safe spatial API routes without Express or browser-only dependencies.

## Run

Fixture-safe lane:

```bash
npm run demo:node-backend:mock
```

In another terminal:

```bash
npm run demo:node-backend
curl http://127.0.0.1:8787/api/services
curl "http://127.0.0.1:8787/api/features?where=priority%20%3D%20'high'&limit=1"
curl "http://127.0.0.1:8787/api/ogc/items?limit=2"
```

Live Honua lane:

```bash
cp examples/node-backend-quickstart/.env.example examples/node-backend-quickstart/.env
set -a
source examples/node-backend-quickstart/.env
set +a
npm run demo:node-backend
```

Set `HONUA_BASE_URL`, `HONUA_SERVICE_ID`, `HONUA_LAYER_ID`, and `HONUA_OGC_COLLECTION_ID` for your deployment. Use `HONUA_API_KEY` or `HONUA_SERVICE_ACCOUNT_TOKEN` for backend-only credentials.

To exercise auth against the local fixture, start the mock with an expected key and pass the same key to the backend:

```bash
HONUA_MOCK_EXPECT_API_KEY=dev-fixture-key npm run demo:node-backend:mock
HONUA_API_KEY=dev-fixture-key npm run demo:node-backend
```

## Backend Patterns

| Route | SDK surface | Honua endpoint | Notes |
| --- | --- | --- | --- |
| `GET /api/services` | `HonuaClient.listServices()` | `/rest/services` | Service discovery through the backend. |
| `GET /api/features` | `HonuaClient.queryFeatures()` | `/rest/services/{service}/FeatureServer/{layer}/query` | Supports `where`, `limit`, `outFields`, and `returnGeometry` query params. |
| `GET /api/ogc/items` | `HonuaClient.listOgcItems()` | `/ogc/features/collections/{collection}/items` | Supports `collection`, `limit`, `bbox`, and `filter` query params. |

The sample uses a server-side SDK auth provider, in-memory credential caching, request timeouts, SDK retries for transient upstream statuses, JSON problem responses, and structured JSON logs. It does not use `window`, `localStorage`, cookies, or browser OAuth redirects.

## Validation

```bash
npm run demo:node-backend:typecheck
npm test -- test/node-backend-quickstart.test.ts
npm run demo:node-backend:smoke
```

Node compatibility gaps found in this slice: none. The sample runs on Node's built-in `http` server and `fetch`.
