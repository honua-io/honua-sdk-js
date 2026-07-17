# First Map: the five-minute Honua SDK path

The canonical first experience is the runnable [`maplibre-quickstart`](../examples/maplibre-quickstart/README.md):

```text
public endpoint → connect → discover → explain → bounded query → MapLibre mount
```

It requires no Honua account, browser credential, private server, or internal import. Start with the deterministic lane:

```bash
npm ci
npm run demo:quickstart:mock
```

Open the printed URL. The page explains the selected source and map strategy before it executes the query. You can apply
a source-native filter, inspect a popup with the keyboard, and copy the same published-SDK path used by the running app.

## The copyable core

The complete protocol-neutral workflow is in
[`examples/maplibre-quickstart/src/workflow.ts`](../examples/maplibre-quickstart/src/workflow.ts). It is held to 120
non-comment lines and uses `createHonua()`, `connect()`, `inspect()`, `explainDataToMapStrategy()`, and `mountSource()`.
Discovery ambiguity requires an explicit source; unsupported capability and overflow states stay visible.

The deterministic fixture covers both a GeoServices FeatureServer layer and an OGC API Features landing page. Public
mode accepts the same two endpoint families through the same workflow.

## Public endpoint mode

Run the Vite app, paste an anonymous URL, and choose its protocol hint. Endpoint URLs must use HTTP(S) and cannot include
userinfo, query parameters, or fragments. Basemap style URLs follow the same credential-free rule.

For a preconfigured run:

```bash
VITE_HONUA_FIRST_MAP_URL=https://public.example/rest/services/places/FeatureServer/0 \
VITE_HONUA_FIRST_MAP_MODE=public-live \
VITE_HONUA_FIRST_MAP_PROTOCOL=auto \
npm run demo:quickstart
```

Use `ogc-features` for an OGC API Features landing page. If it advertises multiple collections, choose one in the source
picker; the SDK does not silently pick the first.

## What the five-minute claim measures

CI starts a monotonic 300-second clock before `npm ci`, provisions Chromium, builds the fixture app, starts the closed
fixture harness, and waits for all five stages plus a mounted MapLibre canvas. Failure evidence records the exact stage.
That is a clean-runner reproducibility bound, not a claim about how quickly every person reads the explanation.

The app also has a tighter 5,000 ms browser-runtime qualification budget after submission. Its build enforces raw and
gzip ceilings from [`budgets.v1.json`](../examples/maplibre-quickstart/budgets.v1.json). Controlled fixture and evidence
runs fail the runtime gate. A successful arbitrary public service that takes longer remains mounted and usable with an
explicit exceeded-budget warning, so a performance miss does not erase the user's successful map.

## Evidence matrix

```bash
npm run demo:quickstart:typecheck
npm test -- test/first-map-workflow.test.ts test/quickstart-config.test.ts
npm run demo:quickstart:build
npm run test:playwright:quickstart
npm run samples:run -- verify --sample maplibre-quickstart --sdk-mode source
npm run samples:run -- verify --sample maplibre-quickstart --sdk-mode packed
```

The sample-kit declaration binds Chromium, Firefox, and WebKit release evidence, accessibility, responsive, console,
screenshot, performance, fixture, packed-build, and live gates to this exact sample and test identity. PR validation is
deterministic and network-closed. `npm run bench:live` and `npm run test:quickstart:staging` are separate scheduled,
anonymous-live checks.

## Where the other quickstarts fit

- [`standalone-quickstart`](../examples/standalone-quickstart/README.md) is the focused Esri compatibility/migration recipe.
- [`endpoint-to-map`](../examples/endpoint-to-map/README.md) is the minimal four-statement `mountSource()` recipe.
- [`react-quickstart`](../examples/react-quickstart/README.md) is the focused React provider/hooks recipe.

Their existing commands and site routes remain valid, but new users should begin with First Map so discovery, capability
truth, bounds, provenance, and cleanup are learned once.

See [`quickstart-troubleshooting.md`](./quickstart-troubleshooting.md) for endpoint, CORS, capability, geometry, and browser
diagnostics.
