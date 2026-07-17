# Universal GIS Service Explorer

This maintained sample is the URL-to-working-map golden journey for the public
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
4. The accepted query executes unchanged through `executeQueryPlan()`. Its
   bounded result is projected to MapLibre with
   `projectSourceToMapLibre()` and rendered as safe DOM text in the table.
5. The copy panel regenerates equivalent TypeScript from the accepted endpoint,
   source, query, and planner path. Credentials are neither accepted as URL
   identity nor retained in renderer state.

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
New inspections supersede and dispose stale connections; manual cancellation,
the ten-second browser deadline, and demo disposal abort in-flight work.

The focused fixture matrix feeds bounded raw JSON or XML metadata through a
real, default `createHonua()` kernel for GeoServices Feature/Map, OGC API
Features/Tiles/Maps, WFS, WMS, WMTS, STAC, and OData. Every row exercises the
public `connect()`, `inspect()`, and `source()` surfaces; it does not inject a
descriptor or capability profile. If an installed public adapter cannot
connect to a supplied protocol, the model returns a structured unsupported
state rather than simulating discovery.

| Raw profile | Schema reported by root discovery | Minimum observed capabilities | Honest degradation |
| --- | --- | --- | --- |
| GeoServices FeatureServer | available | query, IDs, edits, stream | render unavailable |
| GeoServices MapServer | available | query, IDs, render, tiles, stream | edits unavailable |
| OGC API Features | unavailable | query, IDs, edits | render unavailable |
| OGC API Tiles | unavailable | render, tiles | query unavailable |
| OGC API Maps | unavailable | render | query and tiles unavailable |
| WFS 2.0 | unavailable | query, edits, stream | render unavailable |
| WMS 1.3 | unavailable | render, tiles | partial: raw `GetFeatureInfo` is not bound to canonical query |
| WMTS 1.0 | unavailable | render, tiles | query unavailable |
| STAC API | unavailable | query, IDs, stream | render unavailable |
| OData v4 | available | query, IDs, edits, stream | render unavailable |

“Unavailable” means the service-root metadata did not advertise a field
inventory. The Explorer does not turn a collection or feature-type name into a
schema. Claimed/observed/effective capability profiles and pagination
constraints likewise remain `not reported` until a public projection supplies
them.

## Local golden path

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
npm run test:playwright:service-explorer
```

The model tests cover the ten-protocol raw metadata matrix through the real
public kernel, the shared endpoint boundary, validated multi-source selection,
opaque authorization fingerprints, collection budgets, supersession,
cancellation, and disposal. Synthetic kernels are reserved for hostile,
failure, race, and lifecycle boundaries. Operation tests prove that claims
alone do not enable work and that accepted query/render plans remain
protocol-neutral.

The Playwright journey uses the real OGC fixture and public SDK implementation.
It verifies inspection evidence, structured unsupported actions, strict plan
facts, query execution, map/table projection, hostile URL redaction, timeout
cancellation, responsive layout, axe accessibility, and teardown. The fixture
runner also proves loopback readiness and complete server shutdown.

The shared maintained-sample runner exercises the same workflow against both
the source checkout and the packed public package:

```sh
npm run samples:run -- verify --sample service-explorer --sdk-mode source
npm run samples:run -- verify --sample service-explorer --sdk-mode packed
```

The fixture evidence lane probes the OGC landing page, conformance declaration,
collection metadata, and bounded item response. It also proves that a hostile
slow endpoint is cancelled by a deadline before the server shuts down. A
scheduled, non-PR workflow runs `demo:service-explorer:live-evidence` against a
public Esri GeoServices layer and a public pygeoapi OGC Features collection.
Every live request is anonymous, URL-validated, and capped at 20 seconds.

## Hosted control-plane handoff

The URL explorer deliberately does not need a Honua account. A server-side host
that wants to turn an inspected public source into managed connections, maps,
or workspaces can hand off to the separate control-plane client without placing
credentials in this browser sample:

```ts
import { createHonuaControlPlane } from "@honua/sdk-js/control-plane";

const controlPlane = createHonuaControlPlane({
  baseUrl: process.env.HONUA_CONTROL_PLANE_URL,
  getAccessToken: () => loadAccessTokenFromServerSession(),
});
```

That host-only client is an optional follow-on; it is not part of discovery,
planner truth, or the fixture/live evidence claims made by this sample.

## Caching and realtime

- Cache landing pages, conformance, catalog, schema/domain, CRS/extent, and
  style metadata by endpoint and authorization-scope identity.
- Treat ad hoc feature queries and explicit refreshes as fresh requests unless
  a materialized result exposes visible version/provenance evidence.
- This discovery sample is not realtime. A selected source must advertise a
  stream capability before a host may present live state as authoritative.
