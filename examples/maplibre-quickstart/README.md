# First Map

This is the canonical five-minute browser journey for the Honua JavaScript SDK:

```text
connect → discover → explain → query → mount
```

Paste an anonymous GeoServices FeatureServer layer or OGC API Features endpoint, inspect the advertised source, see why
the SDK chose its bounded map strategy, filter the mounted data, and inspect a feature. Fixture and public-live modes use
the same published SDK workflow; only the endpoint and protocol hint change.

## Run the deterministic journey

Requirements: Node 20.19 and dependencies installed with `npm ci`.

```bash
npm run demo:quickstart:mock
```

Open the printed `quickstartMockUrl`. The fixture is same-origin, credential-free, and closed to external network access.
The page starts on GeoServices, and its paste-URL form also accepts the fixture OGC API Features endpoint. The versioned
fixture pack lives in [`samples/fixtures/first-map/v1`](../../samples/fixtures/first-map/v1).

The copyable workflow core is [`src/workflow.ts`](./src/workflow.ts). It stays within 120 non-comment lines and uses only
the public `@honua/sdk-js` and `@honua/sdk-js/map` entrypoints. The thin shell in
[`src/first-map-shell.ts`](./src/first-map-shell.ts) owns MapLibre, controls, evidence, and deterministic teardown.

## Paste a public endpoint

The form accepts absolute, anonymous HTTP(S) URLs without user info, query parameters, or fragments. Supported paths are:

- a GeoServices `FeatureServer/{layerId}` URL, using `auto` or the explicit GeoServices hint;
- an OGC API Features landing page, using the explicit OGC Features hint.

Discovery never selects the first source when an endpoint advertises multiple candidates. Choose the advertised source
and submit again. Capability misses, unsafe bounds, authentication responses, and query failures remain distinct visible
states; no error becomes an empty map.

To preconfigure a public run:

```bash
VITE_HONUA_FIRST_MAP_URL=https://public.example/rest/services/places/FeatureServer/0 \
VITE_HONUA_FIRST_MAP_MODE=public-live \
VITE_HONUA_FIRST_MAP_PROTOCOL=auto \
npm run demo:quickstart
```

Reviewed browser-public settings:

- `VITE_HONUA_FIRST_MAP_URL` — anonymous endpoint URL.
- `VITE_HONUA_FIRST_MAP_MODE` — `fixture` or `public-live`.
- `VITE_HONUA_FIRST_MAP_PROTOCOL` — `auto`, `geoservices-feature-service`, or `ogc-features`.
- `VITE_HONUA_FIRST_MAP_SOURCE_ID` — explicit advertised source identifier.
- `VITE_HONUA_FIRST_MAP_MAX_FEATURES` — positive materialization ceiling, at most 10,000.
- `VITE_HONUA_FIRST_MAP_FILTER` — optional source-native filter.
- `VITE_HONUA_FIRST_MAP_BASEMAP_STYLE` — credential-free HTTP(S) style URL without query or fragment data.

There are no browser API-key or bearer-token settings. Vite embeds browser variables in public JavaScript, so private
services require a host-mediated session or server-side proxy rather than a durable browser secret.

## Inspectable evidence and interactions

The page exposes:

- endpoint, protocol, source identity, attribution, observation time, and metadata-cache state;
- advertised capabilities, discovery diagnostics, strategy reasons, and the hard feature bound;
- current rendered and reported counts, geometry kinds, overflow disclosure, and first-map timing;
- a source-native filter, pointer popup from the map bridge, keyboard feature inspection, and copyable public-SDK code;
- accessible status/error regions, keyboard focus, reduced-motion behavior, and a single-column mobile layout.

The browser smoke uses these credential-free runtime hooks:

- `window.__HONUA_QUICKSTART_EVENTS__`
- `window.__HONUA_QUICKSTART_RUNTIME__`
- `window.__HONUA_QUICKSTART_DISPOSE__()`
- `CustomEvent("honua:quickstart")`

The disposer aborts in-flight discovery/query work and removes popups, bridge layers/listeners, MapLibre, the managed
kernel, form listeners, global hooks, and sample-kit presentation. It is idempotent.

## Budgets and qualification

[`budgets.v1.json`](./budgets.v1.json) pins the browser first-map ceiling at 5,000 ms and sets raw/gzip ceilings for the
complete application JavaScript, CSS, and output tree. `npm run demo:quickstart:build` fails if any bundle ceiling is
exceeded. The repository-wide clean-install-to-first-map gate separately keeps the complete `npm ci` → browser → usable
map path under 300 seconds.

The S3 portfolio slice will enroll this finished interaction shell in the shared source/packed and release-browser evidence
matrix. The S2 deterministic browser smoke is network-closed and already covers accessibility, responsive behavior,
console cleanliness, performance, and fixture cleanup.

## Validation

```bash
npm run demo:quickstart:typecheck
npm test -- test/first-map-workflow.test.ts test/quickstart-config.test.ts
npm run demo:quickstart:build
npm run test:playwright:quickstart
```

The browser test covers both fixture protocols, the plan, filter, popup, copied code, desktop/mobile layout, keyboard and
axe checks, zero page/console errors, no external fixture requests, and explicit cleanup.

S3 will reclassify the overlapping standalone, four-statement bridge, and React apps as focused recipes while preserving
their existing routes and commands. This sample owns the interaction design for the canonical First Map learning path.

See [`docs/quickstart.md`](../../docs/quickstart.md) for the learning path and
[`docs/quickstart-troubleshooting.md`](../../docs/quickstart-troubleshooting.md) for diagnostics.
