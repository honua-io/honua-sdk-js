# Honua × MapLibre flagship workflow

This is the canonical five-minute browser journey for the Honua JavaScript SDK:

```text
connect → discover → explain → query → mount
```

It composes the accepted north-star journey from the SDK's public, protocol-neutral `Dataset → Source → Query → Result`
contract, the experimental deterministic query planner, and a small MapLibre mounting function. The future application
kernel facade remains design-stage; this sample does not pretend that facade has shipped.

The result is more than a map. The page makes endpoint provenance, snapshot/live freshness, authorization mode,
capabilities, SDK/server/data versions, query fingerprint, pushdown, fidelity, cache behavior, and degradation visible.
The map, table, attribute filter, detail panel, and popup share one linked exploration context.

## Five-minute fixture run

Requirements: Node 20.19 and the repository dependencies installed with `npm ci`.

```bash
npm run demo:quickstart:mock
```

Open the printed `quickstartMockUrl`. The fixture lane is deterministic and self-contained:

1. `connect` checks the SDK/server compatibility contract.
2. `discover` reads committed layer metadata and reports metadata-cache state.
3. `explain` creates a deterministic query IR, plan, and SHA-256 fingerprint without fetching rows.
4. `query` executes that accepted plan through a protocol-neutral `Source`.
5. `mount` converts the result geometry and links MapLibre to the exploration context.

The fixture is clearly labeled **Fixture replay**, uses no authentication, reports its committed data version and capture
time, and does not make external network requests. Fixture responses live in
[`test/fixtures/honua-quickstart-demo`](../../test/fixtures/honua-quickstart-demo).

Required CI measures the path from Node setup and `npm ci` through the first usable fixture map and enforces a
300-second ceiling. See the [quickstart timing contract](../../docs/quickstart.md#what-the-five-minute-claim-measures).
The resulting machine evidence demonstrates clean-runner reproducibility, not an observed first-time human session.

## Secret-free live run

The same code path can use any CORS-enabled Honua FeatureServer layer that allows anonymous reads:

```bash
VITE_HONUA_QUICKSTART_BASE_URL=https://your-public-honua.example \
VITE_HONUA_QUICKSTART_SERVICE_ID=public-service \
VITE_HONUA_QUICKSTART_LAYER_ID=0 \
VITE_HONUA_QUICKSTART_DATA_VERSION=public-service-2026-07 \
npm run demo:quickstart
```

Optional browser settings:

- `VITE_HONUA_QUICKSTART_WHERE` — source-native filter, default `1=1`.
- `VITE_HONUA_QUICKSTART_RESULT_RECORD_COUNT` — positive bounded row limit, default `25`.
- `VITE_HONUA_QUICKSTART_BASEMAP_STYLE` — MapLibre style URL.
- `VITE_HONUA_QUICKSTART_CAPTURED_AT` — ISO timestamp when the configured dataset is a published snapshot.

Browser API keys and bearer tokens are intentionally rejected. Do not put durable credentials in Vite environment
variables: Vite embeds them in public JavaScript. Use an anonymous demo endpoint or a server-side proxy/session flow.
Server-only staging validation may still use `HONUA_STAGING_API_KEY` or `HONUA_STAGING_BEARER_TOKEN`; those values never
enter the browser bundle or runtime evidence.

## Runtime contract

The workflow uses only stable subpath imports plus the explicitly experimental planner subpath:

- `@honua/sdk-js/honua` for `HonuaClient` and GeoServices geometry conversion.
- `@honua/sdk-js/contract` for `createDataset`, `SourceDescriptor`, `Query`, and `Result`.
- `@honua/sdk-js/query-planner` for `explainQuery()` and `executeQueryPlan()`.
- `@honua/sdk-js/exploration` and `@honua/sdk-js/interactions` for linked views.

It does not use the deprecated package-root convenience surface.

For a GeoServices layer, the initial workflow performs:

- `GET /api/v1/admin/capabilities`
- `GET /rest/services/{serviceId}/FeatureServer/{layerId}?f=json`
- `GET /rest/services/{serviceId}/FeatureServer/{layerId}/query?...`

Planning is synchronous and side-effect free. Execution validates that the plan fingerprint and source context still
match, then invokes the accepted remote step. Unsupported capability or unsafe fallback paths fail visibly; they do not
produce silent empty results.

## Evidence and teardown

The page exposes test-friendly runtime state without credentials or full query-bearing endpoint URLs:

- `window.__HONUA_QUICKSTART_EVENTS__`
- `window.__HONUA_QUICKSTART_RUNTIME__`
- `window.__HONUA_QUICKSTART_DISPOSE__()`
- `CustomEvent("honua:quickstart")`

The browser smoke calls the disposer and verifies the map, linked bindings, popup, and exploration context are released.

## Validation

Required fixture validation is independent of a live environment:

```bash
npm run demo:quickstart:typecheck
npx vitest run test/quickstart-config.test.ts test/quickstart-data.test.ts test/quickstart-linked-exploration.test.ts
npm run demo:quickstart:build
npm run test:playwright:quickstart
```

The Playwright lane verifies all five stages, evidence and plan fields, table/filter/popup linkage, keyboard selection,
mobile layout, zero page/console errors, and explicit cleanup. Live validation remains separate:

```bash
npm run test:quickstart:staging
npm run bench:live
```

The catalog publishes the latest validated per-sample live envelope at
[`evidence/live.v1.json`](./evidence/live.v1.json). The envelope records the
anonymous source version, semantic outcome, item count, assertions, and timing;
the live lane never substitutes fixture data.

See [`docs/quickstart-troubleshooting.md`](../../docs/quickstart-troubleshooting.md) for compatibility and staging
diagnostics.
