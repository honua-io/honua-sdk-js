# Five-minute quickstart: endpoint to linked MapLibre map

The canonical public-endpoint browser workflow is the tested app in
[`examples/maplibre-quickstart`](../examples/maplibre-quickstart/README.md). It makes the SDK's five-stage journey
visible instead of hiding network and fallback decisions:

```text
connect → discover → explain → query → mount
```

This slice keeps the overlapping standalone and endpoint-to-map routes intact for the later portfolio-convergence
work. New users should start here because this one workflow accepts both public GeoServices layers and OGC API
Features landing pages.

## Run the deterministic lane

```bash
npm ci
npm run demo:quickstart:mock
```

Open the printed `quickstartMockUrl`. No account, credential, or network-hosted basemap is required. The app:

1. connects and negotiates the configured protocol;
2. inspects advertised sources and capabilities;
3. explains a deterministic bounded query plan before fetching rows;
4. executes that accepted plan through the kernel connection;
5. passes the same plan to the SDK's MapLibre renderer.

The thin shell adds only endpoint input, table/filter state over the bounded result, popup selection, plan disclosure,
copyable code, and managed cleanup. It exposes source identity and attribution, observation time, auth mode, SDK/plan
versions, metadata cache state, plan fingerprint, pushdown, fidelity, and degradation. Fixture replay is labeled
explicitly and never presented as live data.

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

Paste a public CORS-enabled GeoServices FeatureServer layer or OGC API Features landing-page URL into the visible form.
The same endpoint can be preconfigured by copying [`.env.example`](../examples/maplibre-quickstart/.env.example):

```bash
cp examples/maplibre-quickstart/.env.example examples/maplibre-quickstart/.env
npm run demo:quickstart
```

Use either the direct endpoint variables:

- `VITE_HONUA_QUICKSTART_ENDPOINT`
- `VITE_HONUA_QUICKSTART_PROTOCOL` (`auto`, `geoservices-feature-service`, or `ogc-features`)

or the retained GeoServices base/service/layer variables. Their retirement is intentionally deferred to the route
convergence slice.

The optional source-native filter, bounded record count, and basemap style are documented in the
[sample README](../examples/maplibre-quickstart/README.md#secret-free-live-run).

The browser quickstart rejects API keys and bearer tokens because Vite embeds environment values in public JavaScript.
Use an anonymous endpoint or a server-side proxy/session. Protected server-only staging validation remains separate.

## The SDK shape

The copyable core is [`src/workflow.ts`](../examples/maplibre-quickstart/src/workflow.ts). It imports only the reviewed
`@honua/sdk-js` root and `@honua/sdk-js/runtime`, then calls `createHonua()`, `connect`, `inspect`, `explain`, `query`,
and `mount`. It is the source of truth for both fixture protocols, the source bundle, and the packed SDK build. The page
shows a copy button for the configured call site; presentation code never creates a second dataset or private plan.

Planning remains side-effect free. Execution validates plan integrity and source context before invoking the accepted
step. Capability gaps, ambiguous sources, authentication, overflow, and unsafe fallback bounds remain explicit states;
they do not become silent empty maps.

## Requests and validation

Request shape follows the negotiated protocol. Both lanes inspect metadata before executing a bounded plan; the mount
executes that accepted plan again for the SDK-owned renderer projection. The deterministic browser smoke blocks any
origin outside its fixture server.

The required CI lane is fixture-only:

```bash
npm run demo:quickstart:typecheck
npm run demo:quickstart:test
npm run demo:quickstart:parity
npm run demo:quickstart:build
npm run test:playwright:quickstart
```

See [`quickstart-troubleshooting.md`](./quickstart-troubleshooting.md) for compatibility, discovery, configuration,
geometry, plan, CORS, and staging diagnostics.
