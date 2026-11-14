---
type: guide
title: "Start with gRPC and cloud-native files"
description: "Use gRPC for authenticated live data and edits, and PMTiles, GeoParquet and COG through the CDN for public and read-heavy data."
---
# Start with gRPC and cloud-native files

Build new Honua applications and finish customer migrations on the native path:
**gRPC for authenticated, live and edited data**, plus **cloud-native files for
public and read-heavy data**. The shared protobuf contract lives in
[geospatial-grpc](https://github.com/honua-io/geospatial-grpc).
This follows the founder direction recorded in [ADR-0087](https://github.com/honua-io/honua-server/pull/7555).

## Live queries and edits

Use `HonuaClient` with `transport: "grpc-web"` for native feature queries,
query streaming and `applyEdits()`. Edits use the unary `ApplyEdits` RPC;
transport or server errors propagate without a REST fallback. Per-row errors
remain in the result arrays. `rollbackOnFailure` defaults to `true`.

```ts doc-test=compile
import { HonuaClient } from "@honua/sdk-js/honua";

const client = new HonuaClient({
  baseUrl: "https://your-honua-server.example",
  transport: "grpc-web",
  bearerToken: "<short-lived-user-access-token>",
});
const edits = await client.applyEdits({
  serviceId: "parcels",
  layerId: 0,
  adds: [{ attributes: { name: "New parcel" }, geometry: { x: -122.4, y: 37.8 } }],
  rollbackOnFailure: true,
});
console.log(edits.addResults);
```

Supply coordinates in the layer's coordinate system and omit `spatialReference`; explicit edit reprojection is unavailable and rejected. Updates use the
`objectid` or `id` attribute (case insensitive); set `objectIdField` for another
primary-key name. Integer values must be safe JavaScript integers, or use
`bigint` for exact int64 attributes and decimal strings for large object IDs.
Large result IDs are returned as decimal strings. Attributes support scalar
values, `Date`, `Uint8Array` and explicit `null`; unsupported values fail before
sending a request. Writes are never automatically retried. For an explicit
retry, reuse an `idempotencyKey` only for the same logical edit.

Date-only, time-only, offset-timestamp and exact-decimal columns (geospatial-grpc
1.2) are read as exact strings: `"2026-11-14"`, `"08:30:00.5"`,
`"2026-11-14T08:30:00-08:00"` and `"12.10"`. Write them as the same strings. A
canonical gRPC `Source` reads the layer's offset-timestamp and decimal columns from
`DescribeLayer` once and sends those strings on their exact wire cases; date and
time strings travel as plain strings, which servers also accept. With
`HonuaClient.applyEdits`, declare columns in `attributeTypes` (for example
`{ signed_at: "timestamp-offset", fee: "decimal" }`); declare `date` or `time`
only for a geospatial-grpc 1.2 server, since older servers ignore those cases.

Set `useGlobalIds: true` to address updates and deletes by global ID; `deletes`
then lists UUIDs. On gRPC each update carries `globalId` (or the UUID in the
`globalIdField` attribute), adds may carry a client-generated `globalId`, and
queries accept `globalIds` instead of `objectIds`. Edit results report
`globalId` alongside `objectId` when known. On REST, global-ID deletes are
forwarded, updates keep the GlobalID in the server's own attribute, and
feature-level `globalId` and `globalIds` queries are refused rather than sent
unfiltered. A server older than geospatial-grpc 1.2 ignores these fields; the SDK
refuses such responses instead of reporting them as success.

## Browser setup: gRPC-Web

Browsers use gRPC-Web rather than a native HTTP/2 gRPC channel. The JavaScript
SDK uses the Connect libraries with the **gRPC-Web transport**; this does not
require or imply support for the separate Connect protocol.

```bash
npm install @honua/sdk-js @bufbuild/protobuf@^2 @connectrpc/connect@^2 @connectrpc/connect-web@^2
```

**Current browser packaging limitation:** the JS SDK loads its optional Connect
peers and internal gRPC modules dynamically with variable imports. Installing the
peers alone is insufficient in ordinary Vite browser bundles: those imports are
left for runtime resolution. The configuration below describes the client API,
not a verified drop-in Vite application. Before deploying, verify that your build
and module loader resolve those modules in the browser; otherwise use a backend
with the native SDK until browser packaging is supported.

Configure the deployment's HTTPS gRPC-Web endpoint and allow the application's
origin, authorization headers and gRPC-Web response headers in its CORS policy.
Use a short-lived user access token from your sign-in flow; never ship an admin
key in a browser bundle. Replace these deployment-specific values before running:

```ts doc-test=compile
import { HonuaClient } from "@honua/sdk-js/honua";

const client = new HonuaClient({
  baseUrl: "https://your-honua-server.example",
  transport: "grpc-web",
  bearerToken: "<short-lived-user-access-token>",
});
const page = await client.queryFeatures({
  serviceId: "parcels",
  layerId: 0,
  where: "1=1",
  outFields: ["*"],
  returnGeometry: true,
  resultRecordCount: 10,
});
console.log(page.features);
```

The endpoint must actually expose gRPC-Web; an ordinary REST endpoint or an
HTTP/2-only native gRPC listener is insufficient. Configure token renewal through
the SDK's auth provider for a long-running session. Setting `transport` explicitly
matters: the JavaScript client's default remains REST for existing applications.

## Public files and private snapshots

Ordinary gRPC calls are POST requests and are not CDN-cacheable. Publish public,
read-heavy data as versioned files, then use a format-aware reader that requests
only the needed byte ranges through the CDN:

| Data | Native file | Reader |
| --- | --- | --- |
| Map tiles | PMTiles | PMTiles-capable map renderer |
| Vector extracts and analytics | GeoParquet | GeoParquet / Arrow tooling |
| Raster imagery | Cloud Optimized GeoTIFF (COG) | COG-aware raster reader |

Configure object storage and the CDN to support HTTP range requests (including
`206 Partial Content` and `Content-Range`), preserve the file bytes, and allow
browser CORS access where needed. A plain full-file download is still possible;
partial reads depend on the reader and the file's layout.

For private files, authorize the user first and return a short-lived **signed
URL** scoped to the permitted object. The reader uses that URL for its range
requests. Keep private responses out of shared public caches unless the CDN
enforces the same authorization; configure signing, cache keys and expiry with
the deployment operator. Refresh the signed URL when it expires, including
during multi-request reads, and do not put it in logs or source control.

**Reader limitation:** the current JS SDK COG integration rejects URLs containing
query parameters, including typical presigned URLs. Its COG example therefore
cannot read those private objects directly. Choose a COG reader that supports
your signed URLs; do not remove their signatures or make private data public to
work around this restriction.

After edits, regenerate the affected files and publish a new immutable version
(for example a generation-specific object key). Update the application's catalog
or manifest only after publication succeeds; acquire a new signed URL for that
version. A signed URL controls access, not freshness. An old file does not change
when the live layer changes. Keep gRPC as the source for current authorized
reads and writes while a new snapshot is being built.

For working format-specific examples, start with [PMTiles](../examples/pmtiles-static/README.md),
[GeoParquet](../examples/overture-geoparquet/README.md) and
[COG imagery](../examples/imagery-cog-quickstart/README.md).
These optional format integrations retain their documented maturity and peer
requirements; the native direction does not promote an experimental API to stable.

## Compatibility during coexistence

OGC API and GeoServices REST clients remain supported for third-party tools and
existing Esri clients that cannot yet migrate. Their examples demonstrate
**compatibility**, not the target architecture for a new Honua application.
Keep them during coexistence, then move application data access to gRPC and
cloud-native files. Control-plane administration and capabilities outside the
feature data path retain their own documented contracts.

The native edit integration test is separately gated by
`HONUA_GRPC_EDIT_INTEGRATION=1`. Use a disposable writable point layer with a
`name` field and the standard integration service, layer and credential settings.
It adds, queries, updates and deletes its own fixture through gRPC-Web only.

For a call-by-call application migration, use the [native conversion guide](native-app-conversion.md), including identify, find and style legends.
