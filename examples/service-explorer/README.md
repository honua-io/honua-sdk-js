# Universal GIS Service Explorer

This maintained sample is the URL-to-working-map journey for the public
Honua kernel. Paste an HTTP(S) service root, select an explicit protocol hint
when needed, inspect immutable discovery evidence, and execute only operations
accepted by both endpoint evidence and the SDK planner.

The browser shell imports only public `@honua/sdk-js`,
`@honua/sdk-js/contract`, and `@honua/sdk-js/map` entrypoints. It does not use
the deprecated app shell, app-workspace, exploration, or Esri compatibility
surfaces.

## Workflow

1. `createServiceExplorerTruthModel()` validates the endpoint using the same
   identity boundary as `createHonua().connect()`. Absolute HTTP(S) URLs are
   required. User-info, fragments, and identity-bearing queries are rejected;
   only an all-`f`/`format=json|pjson` discovery query may be removed.
2. The managed connection exposes protocol, source, schema, CRS, provenance,
   cache, authorization-scope label, and capability decisions. The view shows
   `not-reported` instead of manufacturing detector confidence or schema truth.
3. `projectServiceExplorerOperations()` intersects inspected effective
   capabilities with `explainQuery(..., capabilityPolicy: "strict")` and
   `explainAutomaticSourceToMapLibre()`. A disabled action retains its
   structured code and reason.
4. The accepted query executes unchanged through `executeQueryPlan()` with an
   explicit cancel path and a ten-second operation deadline. Its bounded result
   is projected to MapLibre with `projectSourceToMapLibre()` and rendered as safe
   DOM text in the table.
5. The copy panel regenerates equivalent TypeScript from the accepted endpoint,
   source, query, planner path, deadline, and cleanup lifecycle. Credentials are
   neither accepted as URL identity nor retained in renderer state.

The UI exposes claimed/observed/effective profile values when the kernel
reports them and explicitly says `not reported` otherwise. It also shows
conformance provenance, schema identity, CRS, pagination and authorization
constraints, metadata cache state, pushdown, client residual work, fidelity,
and plan cache semantics.

## Truth and safety boundaries

`src/truth-model.ts` owns one public kernel (or borrows an injected one) and
publishes explicit `loading`, `ready`, `partial`, `ambiguous`, `auth`,
`unsupported`, `cancelled`, and `error` states. Renderer projections are deeply
frozen and bounded across sources, fields, CRSs, extents, capability evidence,
profiles, provenance, and diagnostics. Metadata is cached separately from
feature data.

Opaque authorization fingerprints stay transport-only. The view receives only
an exact SHA-256 scope identity, a separately validated structural label, or
`[configured]`. Credential-shaped diagnostic and locator values are redacted.
New inspections supersede and dispose stale connections, clear prior endpoint
results, and prevent superseded operations from mutating the map. Manual
cancellation, bounded inspection and operation deadlines, and demo disposal
abort in-flight work.

The focused fixture matrix covers GeoServices Feature/Map, OGC API
Features/Tiles/Maps, WFS, WMS, WMTS, STAC, and OData truth projections. If an
installed public adapter cannot connect to a supplied protocol, the model
returns a structured unsupported state rather than simulating discovery.

## Local maintained path

The fixture server exposes a small same-origin OGC API Features service at
`/fixtures/ogc`. It advertises core conformance, one `places` collection, CRS
and extent metadata, and three deterministic GeoJSON point features. The app
opens this endpoint by default so the entire inspect → plan → query → table →
map path is runnable without credentials.

```sh
npm run demo:service-explorer
```

For any other endpoint, paste its service root, choose a protocol hint or
`auto`, and optionally provide a source ID. Authentication is configured at the
kernel transport boundary by an application host; this browser sample has no
API-key or bearer-token field.

## Validation

```sh
npm run demo:service-explorer:typecheck
npm run demo:service-explorer:build
npm test -- test/service-explorer-truth-model.test.ts test/service-explorer-operation-model.test.ts
npx vitest run test/service-explorer-live-evidence.test.ts
npm run test:playwright:service-explorer
```

The model tests cover the ten-protocol fixture matrix, the real public-kernel
endpoint boundary, opaque authorization fingerprints, selection integrity,
collection budgets, supersession, cancellation, and disposal. Operation tests
prove that claims alone do not enable work, accepted query/render plans remain
protocol-neutral, and generated code carries bounded execution and cleanup.

The Playwright journey uses the real OGC fixture and public SDK implementation.
It verifies inspection evidence, nested source selection, structured
unsupported actions, strict plan facts, query execution, map/table projection,
stale-result clearing, hostile URL redaction, timeout cancellation, responsive
layout, axe accessibility, and teardown. The fixture runner also proves loopback
readiness and complete server shutdown.

The shared maintained-sample runner exercises the same source and genuinely
packed SDK paths:

```sh
npm run samples:run -- verify --sample service-explorer --sdk-mode source
npm run samples:run -- verify --sample service-explorer --sdk-mode packed
```

The maintained-sample enrollment retires the superseded legacy helper surface
and projects both the service-explorer and two-protocols site routes from this
sample.

## Scheduled public evidence

The reviewed producer uses fixed anonymous HTTPS targets: Esri SampleServer 6
Citizen Requests FeatureServer layer `0` and the pygeoapi demo `lakes`
collection. Each path must inspect as its declared protocol, accept a strict
query plan, and return exactly one item. Requests remain under the reviewed
origin and path, omit credentials, reject redirects and credential-shaped query
or header values, and enforce request, deadline, per-response, and total-byte
budgets.

The weekly/manual workflow is separate from required pull-request CI. Its
producer remains disabled unless the scheduled job explicitly sets the enable
flag:

```sh
HONUA_SERVICE_EXPLORER_LIVE_ENABLED=true npm run demo:service-explorer:live-evidence
```

Deterministic tests exercise the same producer with loopback GeoServices and OGC
substitutes and validate the resulting envelope in memory; they do not contact
the public targets or create evidence files. The catalog deliberately keeps the
live lane and journey `planned` until a reviewed scheduled execution, current
quality receipts, and qualification decision land.

## Caching and realtime

- Cache landing pages, conformance, catalog, schema/domain, CRS/extent, and
  style metadata by endpoint and authorization-scope identity.
- Treat ad hoc feature queries and explicit refreshes as fresh requests unless
  a materialized result exposes visible version/provenance evidence.
- This discovery sample is not realtime. A selected source must advertise a
  stream capability before a host may present live state as authoritative.
