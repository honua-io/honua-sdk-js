# Five-minute quickstart: endpoint to linked MapLibre map

The canonical server-connected browser workflow is the tested app in
[`examples/maplibre-quickstart`](../examples/maplibre-quickstart/README.md). It makes the SDK's five-stage journey
visible instead of hiding network and fallback decisions:

```text
connect → discover → explain → query → mount
```

If you do not need a Honua server, start with the
[`standalone quickstart`](./standalone-quickstart.md). It connects directly to a public GeoServices endpoint. This page
covers the protocol-neutral Honua lane with compatibility, discovery, planning, evidence, and linked views.

## Run the deterministic lane

```bash
npm ci
npm run demo:quickstart:mock
```

Open the printed `quickstartMockUrl`. No account, credential, or network-hosted basemap is required. The app:

1. checks SDK/server compatibility;
2. discovers layer metadata and constructs the protocol capability contract;
3. explains a deterministic query plan before fetching rows;
4. executes that accepted plan through `Dataset → Source → Query → Result`;
5. mounts the result in MapLibre and links map, table, filter, detail, and popup state.

The page also exposes provenance, capture/observation time, auth mode, SDK/server/data versions, metadata cache state,
plan fingerprint, pushdown, fidelity, and degradation. Fixture replay is labeled explicitly and never presented as live
data.

### What the five-minute claim measures

Required CI sets up the pinned Node runtime, then starts a monotonic clock before `npm ci`, provisions Chromium, builds
this fixture app, and stops only after all five stages complete with renderable features and a mounted MapLibre canvas.
The 300-second ceiling is enforced by:

```bash
npm run docs:quickstart:time-to-map
```

CI uploads `quickstart-time-to-map.json` on success or failure. It records the actual elapsed duration, fixture mode,
completed stages, renderable feature count, package version, and revision; it never substitutes a configured or
estimated duration. A local invocation measures script-to-map because dependencies and the browser are already
installed. Only CI evidence with `cleanInstallIncluded: true` covers runtime setup and a clean install.

This automated gate proves the documented path is reproducible within the budget on a fresh runner. It is not evidence
of a first-time human usability study; that separate observation remains required before claiming the broader learning
architecture acceptance criterion is complete.

## Use an anonymous live endpoint

Copy [`.env.example`](../examples/maplibre-quickstart/.env.example), point it at a public CORS-enabled Honua layer, then
run the same app:

```bash
cp examples/maplibre-quickstart/.env.example examples/maplibre-quickstart/.env
npm run demo:quickstart
```

The required live values are:

- `VITE_HONUA_QUICKSTART_BASE_URL`
- `VITE_HONUA_QUICKSTART_SERVICE_ID`
- `VITE_HONUA_QUICKSTART_LAYER_ID`
- `VITE_HONUA_QUICKSTART_DATA_VERSION`

The filter, bounded record count, basemap style, and optional snapshot timestamp are documented in the
[sample README](../examples/maplibre-quickstart/README.md#secret-free-live-run).

The browser quickstart rejects API keys and bearer tokens because Vite embeds environment values in public JavaScript.
Use an anonymous endpoint or a server-side proxy/session. Protected server-only staging validation remains separate.

## The SDK shape

The sample uses stable subpath imports and the explicitly experimental planner:

```ts doc-test=compile
import { PROTOCOL_DEFAULT_CAPABILITIES, createDataset } from "@honua/sdk-js/contract";
import { HonuaClient } from "@honua/sdk-js/honua";
import { executeQueryPlan, explainQuery } from "@honua/sdk-js/query-planner";

const client = new HonuaClient({ baseUrl: "https://your-public-honua.example" });
const metadata = await client.getLayerMetadata("public-service", 0);
const descriptor = {
  id: "public-features",
  protocol: "geoservices-feature-service" as const,
  locator: { url: "https://your-public-honua.example", serviceId: "public-service", layerId: 0 },
  capabilities: PROTOCOL_DEFAULT_CAPABILITIES["geoservices-feature-service"],
  schema: { fields: metadata.fields },
};
const dataset = createDataset({ id: "public-map", client, sources: [descriptor] });
const source = dataset.source("public-features");
if (!source) throw new Error("Source resolution failed");

const query = { where: "1=1", outFields: ["*"], returnGeometry: true, pagination: { limit: 25 } };
const plan = explainQuery({ descriptor, query, sourceVersion: "public-service-2026-07" });
const execution = await executeQueryPlan(plan, source, { sourceVersion: "public-service-2026-07" });
console.log(execution.result.features);
```

Planning is synchronous and side-effect free. Execution validates plan integrity and source context before invoking the
accepted step. Capability gaps and unsafe fallback bounds throw structured errors; they do not become silent empty maps.

## Requests and validation

A healthy startup performs three Honua requests before the basemap's own assets:

1. `GET /api/v1/admin/capabilities`
2. `GET /rest/services/{serviceId}/FeatureServer/{layerId}?f=json`
3. `GET /rest/services/{serviceId}/FeatureServer/{layerId}/query?...`

The required CI lane is fixture-only:

```bash
npm run demo:quickstart:typecheck
npx vitest run test/quickstart-config.test.ts test/quickstart-data.test.ts test/quickstart-linked-exploration.test.ts
npm run demo:quickstart:build
npm run test:playwright:quickstart
```

See [`quickstart-troubleshooting.md`](./quickstart-troubleshooting.md) for compatibility, discovery, configuration,
geometry, plan, CORS, and staging diagnostics.
