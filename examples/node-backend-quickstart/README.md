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

## Control-Plane Pattern

Backend processes can use `@honua/sdk-js/control-plane` for hosted product administration while keeping runtime data operations on the regular SDK client:

```ts
import { HonuaClient } from "@honua/sdk-js";
import { createHonuaControlPlane } from "@honua/sdk-js/control-plane";

const client = new HonuaClient({
  baseUrl: process.env.HONUA_BASE_URL ?? "https://cloud.honua.io",
  apiKey: process.env.HONUA_API_KEY,
});
const controlPlane = createHonuaControlPlane({ client });

const maps = await controlPlane.hostedMaps.list({ workspaceId: process.env.HONUA_WORKSPACE_ID, limit: 20 });
if (!maps.supported) {
  // Deployment does not expose this admin capability.
  console.warn({ capability: maps.capability, reason: maps.reason });
} else {
  console.log(maps.value.items.map((map) => ({ id: map.id, title: map.title, packageId: map.packageId })));
}
```

Token and connection responses redact secret-bearing fields after creation unless a deployment explicitly returns a one-time reveal field. Do not log raw request bodies that contain upstream credentials.

## Backend Patterns

| Route | SDK surface | Honua endpoint | Notes |
| --- | --- | --- | --- |
| `GET /api/services` | `HonuaClient.listServices()` | `/rest/services` | Service discovery through the backend. |
| `GET /api/features` | `HonuaClient.queryFeatures()` | `/rest/services/{service}/FeatureServer/{layer}/query` | Supports `where`, `limit`, `outFields`, and `returnGeometry` query params. |
| `GET /api/ogc/items` | `HonuaClient.listOgcItems()` | `/ogc/features/collections/{collection}/items` | Supports `collection`, `limit`, `bbox`, and `filter` query params. |
| control-plane handoff | `createHonuaControlPlane()` | `/api/v1/admin/*` | Lists hosted maps/packages and returns typed unsupported results on deployments without admin APIs. |

The sample uses a server-side SDK auth provider, in-memory credential caching, request timeouts, SDK retries for transient upstream statuses, JSON problem responses, and structured JSON logs. It does not use `window`, `localStorage`, cookies, or browser OAuth redirects.

## Validation

```bash
npm run demo:node-backend:typecheck
npm test -- test/node-backend-quickstart.test.ts
npm run demo:node-backend:smoke
```

Node compatibility gaps found in this slice: none. The sample runs on Node's built-in `http` server and `fetch`.
