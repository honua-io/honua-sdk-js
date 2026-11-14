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
| Edits keyed by global ID | Global-ID-aware canonical edit API | Additive scalar/identity contract and transport support are pending. Preserve global IDs when copying data. |
| Parent and child transaction | Service edit session | Multi-layer native transaction support is pending; independent calls are not atomic. |
| Query attachment metadata | `source.attachments.list(parentId)` or `.query({ parentIds })` | Unary `ListAttachments` with attachment page tokens; explicit parent IDs, no filter text. Low level: `client.attachments.list`. |
| Add/update/delete attachment | `source.attachments.add/update/delete` with a `Blob` or `File` | The SDK picks unary upload or a chunked upload session from the layer's advertised limits. Retry a failed upload with the same `idempotencyKey` to resume its session; deletes return one outcome per row. Requires a server implementing the additive 1.3.0 contract. |
| Attachment popup URL | `source.attachments.downloadUrl(parentId, attachmentId)` | Short-lived signed URL for `<img src>`; descriptors contain no URLs. Refresh after `expiresAt`; do not persist or log signed URLs. |
| Related records | `source.queryRelated({ relationshipId, sourceIds })` | Canonical API exists; native relationship transport is pending. |
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


## Attachments over browser gRPC-Web

Use the native attachment resource on the same authenticated client. It accepts
canonical protobuf request objects and preserves bigint IDs, sizes and offsets.
It never converts them through JavaScript numbers or sends a FeatureServer
request. The deployment must implement the additive 1.3.0 attachment contract;
older servers reject the calls. Most applications should call
`source.attachments` (end of this section); `client.attachments` is the low-level
resource for custom chunking and incremental hashing.

```ts doc-test=compile
import { HonuaClient } from "@honua/sdk-js/honua";

const client = new HonuaClient({
  baseUrl: "https://your-honua-server.example",
  transport: "grpc-web",
  bearerToken: "<short-lived-user-access-token>",
});
const parent = {
  serviceId: "inspections", layerId: 0,
  identity: { case: "objectId" as const, value: 9007199254740993n },
};
const page = await client.attachments.list({ parent, pageSize: 50 });
const attachment = page.attachments[0];
if (attachment) {
  const grant = await client.attachments.downloadUrl({ parent, attachmentId: attachment.attachmentId });
  // Pass grant.url directly to the display element; do not log or persist it.
  if (BigInt(Date.now()) >= grant.expiresAtUtcMs) throw new Error("Download grant expired");
}
```

A global-ID selector uses `identity: { case: "globalId", value: uuid }` instead.
The server resolves the public selector to the authorized physical feature; the
application must not substitute a storage layer or internal row ID.

For a small upload, provide the complete SHA-256 digest and exact byte length.
With the low-level resource the caller selects unary versus chunked upload; it
does not buffer a large File or choose a mode for you (`source.attachments`,
below, does). Read the deployment's advertised attachment
limits before selecting a mode. New uploads and deletes use an explicit idempotency key; chunk, commit and abort calls use the bound session ID.
Use a new key for different content, metadata, parent or operation.

```ts doc-test=skip reason="uses the authenticated client and parent above and an application File within the advertised unary limit"
const content = new Uint8Array(await file.arrayBuffer());
const sha256 = new Uint8Array(await crypto.subtle.digest("SHA-256", content));
const upload = {
  parent, name: file.name, contentType: file.type || "application/octet-stream",
  keywords: ["inspection"], sizeBytes: BigInt(content.byteLength), sha256,
  idempotencyKey: crypto.randomUUID(),
};
const committed = await client.attachments.upload({ upload, content });
// To replace an attachment atomically, set upload.replaceAttachmentId to its bigint ID.
```

For a large file, calculate its complete SHA-256 with a bounded incremental hasher
or trusted precomputed digest. Web Crypto's digest method alone requires the
complete input buffer; hashing each chunk separately does not produce the file
digest. Begin with the same metadata as a small upload, then send bounded chunks:

```ts doc-test=skip reason="uses file, upload with an independently computed whole-file digest, and the authenticated client above"
let { session } = await client.attachments.beginUpload({ upload });
if (!session) throw new Error("Missing upload session");
while (session.nextOffsetBytes < upload.sizeBytes) {
  const offset = session.nextOffsetBytes;
  // File slicing uses numbers; this conversion is safe only within the exact range.
  if (!Number.isSafeInteger(file.size)) throw new Error("File size exceeds browser precision");
  if (offset < 0n || offset > BigInt(file.size)) throw new Error("Invalid upload offset");
  const length = Number(session.maxChunkBytes > 1048576n ? 1048576n : session.maxChunkBytes);
  if (length <= 0) throw new Error("Invalid upload chunk limit");
  const content = new Uint8Array(await file.slice(Number(offset), Math.min(file.size, Number(offset) + length)).arrayBuffer());
  if (content.length === 0) throw new Error("File changed or upload metadata is inconsistent");
  const sha256 = new Uint8Array(await crypto.subtle.digest("SHA-256", content));
  const next = await client.attachments.uploadChunk({ sessionId: session.sessionId, offsetBytes: offset, content, sha256 });
  if (!next.session || next.session.nextOffsetBytes <= offset) throw new Error("Upload did not advance");
  session = next.session;
}
const committed = await client.attachments.commitUpload({ sessionId: session.sessionId });
```

After an uncertain begin response, repeat begin with the identical upload and key
to recover the accepted offset. After an uncertain chunk response, replay the
identical offset, bytes and digest, or repeat begin to observe progress. A gap or
conflicting replay fails without changing content. Commit publishes verified
content atomically and returns the same receipt on a retry within the session
lifetime. Expiry requires a new session; its old ID never grants authorization.
Use `.abortUpload({ sessionId })` to discard staging; abort does not remove a
committed attachment. Cancellation through the optional second argument
`{ signal }` cancels the request; with the low-level resource it does not abort the
session (`source.attachments` aborts it when you cancel).

Delete with `.delete({ parent, attachmentId, idempotencyKey })`. Check gRPC status
for permission, precondition, quota and expiry failures; a rejected call is not a
successful empty result. Download URLs are bearer credentials: request one close
to display time, keep it out of logs and persistent caches, and request a new
grant after expiry. Never construct a storage URL from attachment IDs or names.

`Source.attachments` uses these native calls when the client uses `grpc-web`.
`list` follows attachment page tokens independently of feature pages, and `add`
and `update` accept a `Blob` or `File`. Uploads use the layer's advertised unary
limit, then durable chunk sessions for larger content. Pass `idempotencyKey` again
when retrying the same add, update or delete. Attachment IDs remain decimal
strings when returned through the canonical source interface. Native `query`
requires explicit `parentIds`; filter text and string upload bodies are rejected.
The adapter hashes the complete Blob in memory, so applications handling very
large files should use `client.attachments` directly with their own incremental
hashing and chunk lifecycle. A transient chunk failure leaves the session open:
retry the same call with the same `idempotencyKey` and the upload resumes at the
server's committed offset. Cancelling through `signal`, including `AbortSignal.timeout`, aborts the session, so
retry a cancelled upload with a new key. The adapter never aborts after commit is
sent, because the commit may have landed; list the parent to check. A zero
advertised unary limit sends every upload through a session, and a zero file
limit leaves the size check to the server. `delete` returns one outcome per
attachment with `success` and the gRPC status `code`, as the REST adapter does.
Signed downloads use `source.attachments.downloadUrl(parentId, attachmentId)`,
which returns `url`, `expiresAt` and the attachment descriptor. Parent IDs are
object IDs or global ID UUIDs, with or without braces.
