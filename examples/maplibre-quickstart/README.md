# First Map: endpoint to inspected MapLibre map

This is the canonical five-minute browser journey for the Honua JavaScript SDK:

```text
connect → discover → explain → query → mount
```

It composes the accepted north-star journey from the SDK's public, protocol-neutral `Dataset → Source → Query → Result`
contract and managed application kernel.

The copyable S1 workflow core lives in [`src/workflow.ts`](./src/workflow.ts). In at most 120 non-comment lines it uses
only published `@honua/sdk-js` and `@honua/sdk-js/runtime` entrypoints to connect, inspect, explain, execute a bounded
query, and call `connection.mount()` with the accepted plan. GeoServices and OGC API Features use the same semantic
workflow; the bounded map query requests WGS84 output for MapLibre. Ambiguous source selection, unsupported
capability, authentication, overflow, and unexpected errors remain
explicit states; truncated data is never mounted.

The thin presentation shell runs that workflow directly. It accepts an anonymous GeoServices FeatureServer layer
or OGC API Features URL, mounts the accepted plan through MapLibre, and adds only presentation concerns: a linked
table/filter, accessible popup, plan disclosure, copyable call site, runtime budgets, and deterministic teardown. It
does not adapt source behavior or add a private fallback. The former `standalone-quickstart` and `endpoint-to-map`
executables now redirect here rather than maintaining duplicate implementations.

The result is more than a map. The page makes endpoint provenance, source identity and attribution, observation time,
authorization mode, capabilities, SDK/plan versions, accepted feature count, query fingerprint, pushdown, fidelity,
cache behavior, and degradation visible. The map, table, mounted-result filter, detail panel, and popup share one
presentation state without changing the accepted query plan.

## Five-minute fixture run

Requirements: Node 20.19 and the repository dependencies installed with `npm ci`.

```bash
npm run demo:quickstart:mock
```

Open the printed `quickstartMockUrl`. The fixture lane is deterministic and self-contained:

1. `connect` negotiates the configured public protocol.
2. `discover` inspects advertised sources and reports metadata-cache state.
3. `explain` creates a bounded query plan and SHA-256 fingerprint without fetching rows.
4. `query` executes that accepted plan through a protocol-neutral source.
5. `mount` gives the same accepted plan to the SDK's MapLibre renderer.

The fixture is clearly labeled **Fixture replay**, uses no authentication, reports committed source provenance, and
does not make external network requests. The versioned fixture pack lives in
[`samples/fixtures/first-map/v2`](../../samples/fixtures/first-map/v2). It contains all 48 Maui County 2025 census
tracts derived without simplification from the exact SHA-256-pinned Census TIGER/Line archive. The harness binds the
query limit and initial selected record to the governed fixture manifest rather than duplicating those values in UI code.

Required CI measures the path from a clean `npm ci` through the first usable fixture map and enforces a 300-second
ceiling. The browser shell also reports narrower monotonic budgets: 10,000 ms to its first usable fixture frame, 100 ms
for a synchronous filter/selection update, and 1,000 ms for managed cleanup. See the
[quickstart timing contract](../../docs/quickstart.md#what-the-five-minute-claim-measures). These are machine budgets,
not claims about a first-time human session or public-network latency.

## Secret-free live run

`npm run demo:quickstart` now opens on the anonymous Maui parcels layer advertised by the
`demo.honua.io` service directory:

`https://demo.honua.io/rest/services/maui-parcels/FeatureServer/1`

That public-live canary is a separate source and is not represented as Census-governed. Its endpoint-advertised
attribution and observation time remain visible in the same evidence drawer.

Paste any other anonymous, CORS-enabled GeoServices FeatureServer layer or OGC API Features landing-page URL into the
form. The same path can also be preconfigured for development:

```bash
VITE_HONUA_QUICKSTART_ENDPOINT=https://your-public-data.example/ogc/features \
VITE_HONUA_QUICKSTART_PROTOCOL=ogc-features \
npm run demo:quickstart
```

`VITE_HONUA_QUICKSTART_PROTOCOL` accepts `auto`, `geoservices-feature-service`, or `ogc-features`. The retired
base/service/layer composition variables are intentionally not browser inputs; paste the final public endpoint.

Optional browser settings:

- `VITE_HONUA_QUICKSTART_WHERE` — source-native filter; the built-in Maui endpoint defaults to `id <= 25`.
- `VITE_HONUA_QUICKSTART_RESULT_RECORD_COUNT` — positive bounded row limit, default `25`.
- `VITE_HONUA_QUICKSTART_SELECTED_RECORD_ID` — optional initial record ID; the v2 fixture harness injects its
  manifest-bound selection automatically.
- `VITE_HONUA_QUICKSTART_BASEMAP_STYLE` — MapLibre style URL.

Browser API keys and bearer tokens are intentionally rejected. Do not put durable credentials in Vite environment
variables: Vite embeds them in public JavaScript. Use an anonymous demo endpoint or a server-side proxy/session flow.
Server-only staging validation may still use `HONUA_STAGING_API_KEY` or `HONUA_STAGING_BEARER_TOKEN`; those values never
enter the browser bundle or runtime evidence.

## Runtime contract

The copyable core imports only the reviewed `@honua/sdk-js` root and `@honua/sdk-js/runtime`. It calls `createHonua()`,
then `connect`, `inspect`, `explain`, `query`, and `mount`; the accepted plan is passed to both query and mount. The
shell imports MapLibre and reads the returned features only to render its table, popup, and mounted-result filter. It
does not construct a second dataset/source, plan queries privately, or convert data for the SDK renderer. Unsupported
capability, authentication, ambiguous source, bounded overflow, and unexpected failures remain explicit states.

## Evidence and teardown

The page exposes test-friendly runtime state without credentials or full query-bearing endpoint URLs:

- `window.__HONUA_QUICKSTART_EVENTS__`
- `window.__HONUA_QUICKSTART_RUNTIME__`
- `window.__HONUA_QUICKSTART_DISPOSE__()`
- `CustomEvent("honua:quickstart")`

The browser smoke calls the asynchronous disposer and verifies the SDK mount, event bindings, popup, and borrowed
MapLibre host are released. Repeated disposal is safe.

## Validation

Required fixture validation is independent of a live environment:

```bash
npm run demo:quickstart:typecheck
npm run demo:quickstart:test
npm run demo:quickstart:parity
npm run demo:quickstart:copyability
npm run demo:quickstart:build
npm run test:playwright:quickstart
```

The Playwright lane verifies all five stages, evidence and plan fields, table/filter/popup linkage, keyboard selection,
mobile layout, Axe accessibility, zero external fixture requests, zero page/console errors, and explicit cleanup.
The release smoke repeats the same focused test across Chromium, Firefox, and WebKit. Live validation remains
scheduled and explicitly network-gated:

```bash
HONUA_FIRST_MAP_LIVE_ENABLED=true npm run evidence:first-map:live
```

The scheduled workflow writes `examples/maplibre-quickstart/evidence/live.v1.json`
into its retained `honua-sdk-first-map-live-evidence` artifact. The catalog stays
planned until that envelope and the exact-tree gate receipts are admitted. The
envelope records the anonymous source version, semantic outcome, item count,
assertions, and timing; the live lane never substitutes fixture data.

See [`docs/quickstart-troubleshooting.md`](../../docs/quickstart-troubleshooting.md) for compatibility and staging
diagnostics.
