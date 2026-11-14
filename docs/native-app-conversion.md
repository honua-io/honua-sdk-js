---
type: guide
title: "Convert an application to the native data path"
description: "Replace GeoServices calls with canonical Sources, gRPC-Web and cloud-native files."
---
# Convert an application to the native data path

Use gRPC for authenticated live reads and editing, and versioned PMTiles,
GeoParquet and COG files for rendering and bulk reads. Render with MapLibre styles.
Application code uses `Dataset` and `Source`; it does not need a FeatureServer URL
builder or a GeoServices-shaped facade over gRPC. See [native setup and file
delivery](native-data-paths.md) for transport peers, browser packaging limitations,
CORS, signed URLs and snapshot freshness.

## Bind a source

This example supplies a known source explicitly. It does not perform metadata
discovery or prove that the deployment permits editing. Use [native discovery](grpc-discovery.md) to observe descriptors and caller
capabilities when the deployment supports DescribeService and DescribeLayer.
Protocol defaults describe the SDK surface.

```ts doc-test=compile
import { HonuaClient } from "@honua/sdk-js/honua";
import { createDataset, PROTOCOL_DEFAULT_CAPABILITIES, queryFilter } from "@honua/sdk-js/contract";

const baseUrl = "https://your-honua-server.example";
const client = new HonuaClient({
  baseUrl,
  transport: "grpc-web",
  bearerToken: "<short-lived-user-access-token>",
});
const dataset = createDataset({
  id: "inspection-app",
  client,
  capabilityPolicy: "strict",
  sources: [{
    id: "inspections",
    protocol: "grpc",
    locator: { url: baseUrl, serviceId: "inspections", layerId: 0 },
    capabilities: PROTOCOL_DEFAULT_CAPABILITIES.grpc,
  }],
});
const inspections = dataset.source("inspections")!;
const page = await inspections.query({
  filter: queryFilter.eq("status", "open"),
  outFields: ["objectid", "status"],
  pagination: { limit: 100 },
});
console.log(page.features, page.exceededTransferLimit);
```

Use the refreshable `auth` provider for a long-running signed-in application.
Credentials travel in authorization headers, never `token=` query parameters.
Browsers support unary and server-streaming gRPC-Web calls, not client or
bidirectional streams.

## Replace each call

The readiness column describes this SDK implementation, not every server's
enabled capabilities. An API method can exist while its gRPC transport is pending.
Check the deployment and the linked work before removing a compatibility path.

| Existing call or behavior | Native application replacement | Current boundary |
| --- | --- | --- |
| MapServer tiles or export | PMTiles source and MapLibre style | No gRPC needed; port export options into the style/camera. |
| FeatureLayer renderer and labels | Style JSON; PMTiles for public data, `Source.stream()` into a GeoJSON source for live data | Use style expressions; streams yield pages of canonical features. |
| Service/layer metadata | Descriptor discovered with `DescribeService` / `DescribeLayer` | SDK discovery and the typed native handle use descriptor RPCs without REST metadata; deploy a server implementing the additive 1.1.0 contract. See [native discovery](grpc-discovery.md). |
| Query by attributes/geometry/fields/output CRS/sort/page | `source.query({ filter, spatialFilter, outFields, outSr, orderBy, pagination })` | gRPC reads available. Prefer typed filters; `where` is source-native migration text. |
| Count, IDs or extent only | `source.queryExtent()` and its optional `count`; `source.queryObjectIds()` | gRPC available; exact count may require additional reads. Do not interpret an absent count as zero. |
| Distinct values | Explicit bounded query and client deduplication, or a published analytical file | Canonical `Query` has no `distinct` property. Do not deduplicate one page and claim a complete distinct set. |
| Large reads/export | `for await (const page of source.stream(query))` or GeoParquet | Stream has no reconnect cursor. Bound memory; choose a snapshot for reproducible exports. |
| Statistics/grouping | `source.queryAggregate({ aggregation: { groupBy, metrics } })` | gRPC strict policy rejects unsupported server aggregation; degrade policy may materialize client-side. Inspect `Result.degraded`. |
| Time slider | `source.query({ temporalFilter })` | Native server time filtering remains pending; do not silently drop the constraint. |
| Top features per group | Explicit analytical query/file | No canonical `top` parameter yet. |
| Identify | `identifySources(selectedSources, options)` | Queries each selected source; coordinate-space envelope tolerance, one bounded page per source. |
| Find | `findSources([{ source, fields }], options)` | Typed equality or explicit LIKE pattern over chosen fields; no service-wide discovery. |
| Legend | `legendFromStyle(style, options)` | Style-derived colors plus the full symbol definition; complex expressions need a renderer. No server legend call. |
| Add/update/delete/applyEdits | `source.applyEdits({ adds, updates, deletes, rollbackOnFailure })` | Uses unary gRPC-Web `ApplyEdits` with no REST fallback when configured for gRPC-Web. Per-row errors remain in the result; whole-call failures reject. Set the source schema primary key for custom object IDs. |
| Edits keyed by global ID | `source.applyEdits({ useGlobalIds: true, updates: [{ globalId, attributes }], deletes: [globalId] })` | Outcomes carry `globalId` with `id`. On gRPC this requires a geospatial-grpc 1.2 server and a declared global-ID field; on REST only global-ID deletes are forwarded. Adds may supply client-generated global IDs. |
| Parent and child transaction | `client.applyServiceEdits({ serviceId, edits: [{ layerId, adds, ... }, ...], rollbackOnFailure })` | One gRPC `ApplyServiceEdits` call (or REST service-level applyEdits); with rollback, all layers commit or none. Key children to parents with client-generated global IDs. A canonical multi-source edit session over it is pending. |
| Query attachment metadata | `source.attachments.list(id)` / `.query()` | Canonical API exists; native attachment transport is pending. |
| Add/update/delete attachment | `source.attachments.add/update/delete` | Native small unary and large chunked-session upload support is pending. Browser client streaming is unsuitable. |
| Attachment popup URL | Short-lived signed download URL | Native signed-URL support is pending. Refresh after expiry; do not persist/log signed URLs. |
| Related records | `source.queryRelated({ relationshipId, sourceIds })` | Uses gRPC `QueryRelatedRecords` on gRPC-Web, following page tokens; no REST fallback. Relationship IDs come from the layer descriptor. |
| Domains/subtypes/templates | Native layer descriptor | Use `source.protocol("grpc").describe()` for complete metadata; source schema projects field defaults and domains. Server descriptor support is required. Store domain codes, display labels. |
| Replicas/extractChanges | GeoParquet snapshot, change-feed cursor, idempotent edits | Full native sync lifecycle is pending; a query stream is not a durable change feed. |
| generateToken / token parameter | `auth`, `bearerToken` or `apiKey` client options | Supported; use user-scoped credentials in browsers. |
| REST error numbers | `HonuaGrpcError` and gRPC status | Handle authentication, permission, precondition, quota and retry status explicitly; see [errors](errors.md). |

## Identify and find

Pass only sources visible and queryable in the application. Convert a pixel click
tolerance to the input CRS before calling identify; the helper uses a square
envelope, not a geodesic radius or a screen-space hit test. Preserve source identity
when displaying results. Each result retains `exceededTransferLimit`, field and
degradation information; there may be more matches than this page contains.

```ts doc-test=skip reason="uses inspections from the source binding above and an application click"
import { identifySources, findSources } from "@honua/sdk-js/contract";

const controller = new AbortController();
const hits = await identifySources([inspections], {
  x: clickX, y: clickY, tolerance: toleranceInCrsUnits,
  spatialReference: { wkid: 3857 },
  limit: 25,
  query: { outFields: ["objectid", "status"], signal: controller.signal },
});
const matches = await findSources([{ source: inspections, fields: ["name", "owner"] }], {
  search: { text: "O'Brien%" }, // literal equality; % is not a wildcard here
  limit: 50,
});
const prefixes = await findSources([{ source: inspections, fields: ["name"] }], {
  search: { pattern: "Main%", caseSensitive: false }, // explicit SQL LIKE pattern
});
```

Find combines its field matches with an optional `query.filter` using AND. Fields
within a target are ORed. Unsupported comparisons and source failures propagate;
the helpers never turn them into empty successful searches. Cancel through
`query.signal`. In a fan-out, a failing source rejects the operation; other calls
may already be in flight, so abort the shared signal when abandoning them.

## Render a legend from the style

```ts doc-test=compile
import { legendFromStyle } from "@honua/sdk-js/style";

const legend = legendFromStyle({ layers: [{
  id: "inspection-status", type: "circle", source: "inspections",
  paint: { "circle-color": ["match", ["get", "status"], "open", "orange", "gray"] },
}] }, { zoom: 12 });
console.log(legend);
```

The helper reads static colors and `match`/`step` color expressions. Step labels
use inclusive lower and exclusive upper bounds. It omits hidden layers and applies
the supplied layer selection and zoom. The returned layer is a copy preserving
filters, opacity, sprite references and other symbol properties; color chips alone
do not reproduce the complete symbol. `unresolvedReason` marks styles requiring
custom rendering, such as interpolation or sprite-only symbols. Use explicit
renderer `legendItems` when you already have domain labels or curated classes.

## Preserve editing semantics

Keep omitted values separate from explicit nulls. Check exact 64-bit IDs before
converting them to JavaScript numbers. Preserve stable global IDs independently of
server-assigned object IDs. Store coded domain values rather than their labels,
and apply subtype-specific defaults and templates from the descriptor.

Keep dates, date-only, time-only and offset timestamps distinct. Carry Z and M
ordinates separately; an M-only tuple must not become Z. Current curve support
uses densification; do not claim lossless curves or vertical datum transformation.
Use deterministic ID ordering for paging, while recognizing concurrent edits can
still change offset pages. Use idempotency keys where the native edit API supports
them; after an uncertain transport outcome, reconcile before retrying a write.
Inspect per-row outcomes as well as the call status, and request rollback explicitly
when the operation requires all-or-nothing behavior.
