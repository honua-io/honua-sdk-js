# WFS 2.0 adapter

`@honua/sdk-js` ships a first-party WFS 2.0 client that conforms to the
shared JS client contract from
[`docs/shared-client-contract.md`](./shared-client-contract.md). A WFS
source registered through `createDataset({ sources })` produces the same
canonical `Source<T>` / `Query<T>` / `Result<T>` / `EditEnvelope<T>` /
`EditResult` shapes as the GeoServices and OGC Features adapters, so
mixed-source operator apps do not have to learn WFS / XML specifics.

```ts
import { createDataset, PROTOCOL_DEFAULT_CAPABILITIES } from "@honua/sdk-js/contract";
import { HonuaClient } from "@honua/sdk-js";

const client = new HonuaClient({ baseUrl: "https://server.honua.io" });
const dataset = createDataset({
  id: "parcels",
  client,
  sources: [
    {
      id: "parcels-wfs",
      protocol: "wfs",
      locator: { url: "https://server.honua.io/wfs", typeName: "parcels:lot" },
      capabilities: PROTOCOL_DEFAULT_CAPABILITIES.wfs,
    },
  ],
});

const source = dataset.source("parcels-wfs")!;
const result = await source.query({ where: "STATE = 'CA' AND ACRES > 10" });
```

## Capabilities

The default capability set
(`PROTOCOL_DEFAULT_CAPABILITIES.wfs`) is `query`, `queryExtent`,
`queryObjectIds`, `applyEdits`, `stream`. The capability matrix in
[`protocol-capability-matrix.md`](./protocol-capability-matrix.md)
covers each row's degraded fallbacks (none here — WFS is either
supported or it isn't).

`queryAggregate`, `queryRelated`, `attachments` throw
`HonuaCapabilityNotSupportedError` because WFS 2.0 does not expose
server-side aggregation, related-records, or feature attachments.

## Locator

```ts
{
  url: string;                 // Fully qualified WFS endpoint (e.g. https://server/wfs)
  typeName: string;            // Namespace-qualified feature-type name (e.g. parcels:lot)
  featureNamespace?: string;   // URI bound to the typeName prefix (required for prefixed applyEdits)
}
```

The endpoint URL must share an origin with the `HonuaClient`'s `baseUrl`;
cross-origin WFS sources require constructing a separate `HonuaClient`.

`featureNamespace` is the namespace URI the server advertises for the
`typeName` prefix (typically declared as `xmlns:<prefix>="…"` on the
`<wfs:WFS_Capabilities>` root). The canonical adapter binds it on the
`<wfs:Transaction>` root so per-handle feature elements
(`<parcels:lot>…</parcels:lot>`) and prefixed `typeName="…"` attribute
references on `<wfs:Update>` / `<wfs:Delete>` resolve. When the locator
omits `featureNamespace` and the type name carries a prefix, the
adapter falls back to a synthetic URN
(`urn:honua:wfs:feature-namespace:<prefix>`) so the document is
well-formed XML; strict servers will reject the synthetic URI with an
`<ows:ExceptionReport>` whose locator names the prefix, telling
callers which descriptor field to set. Unprefixed `typeName` values
do not need `featureNamespace`.

## Capability negotiation

`HonuaWfs.capabilities()` issues a single `GetCapabilities` request the
first time `query`, `queryAll`, `queryObjectIds`, `stream`, or
`queryExtent` runs (the no-network `queryExtent` shortcut also reads
the cached snapshot to find the per-feature-type
`ows:WGS84BoundingBox`). The parsed snapshot is cached per `HonuaWfs`
instance — subsequent calls reuse it. Use `wfs.refresh()` to drop the
cache. `applyEdits` does not pre-fetch capabilities because the
canonical transaction body never needs the output-format negotiation;
servers that do not advertise `Transaction` surface that as a
server-side `OperationProcessingFailed` `<ows:ExceptionReport>` on the
first transaction request, projected onto `HonuaWfsExceptionError`
(carrying `exceptionCode` and `locator`).

The descriptor's `capabilities` set is the SDK's promise of what the
adapter can fulfil; the constructor does not currently widen or narrow
it from `GetCapabilities`. Callers that need a downgraded set per
source (for example, dropping `applyEdits` for a server that publishes
WFS read-only) intersect the default themselves and pass the result
on `SourceDescriptor.capabilities`.

## Content-type negotiation

The adapter treats the server as advertising JSON when
`OperationsMetadata.GetFeature` lists any of
`application/geo+json`, `application/json`,
`application/vnd.geo+json`, `json`, or `geojson` and prefers the
GeoJSON encoding over GML. If only GML is advertised, the canonical
`Source.query()` throws `HonuaCapabilityNotSupportedError("query")`
rather than ship raw XML through `Result.features`. Callers can still
reach the GML payload through
`Source.protocol("wfs").getFeature(...)` (see "Protocol escape hatch"
below).

GML decoding is intentionally out of scope. A future ticket may add an
opt-in GML decoder; for now the canonical surface is GeoJSON-only.

## Filter encoding (FES 2.0)

`Query.where` compiles to FES 2.0 OGC Filter Encoding. The supported
subset is:

- comparison operators: `=`, `<>`, `!=`, `<`, `<=`, `>`, `>=`
- `IN (a, b, …)` / `NOT IN (…)`
- `BETWEEN x AND y` / `NOT BETWEEN`
- `LIKE 'pattern%'` / `NOT LIKE`
- `IS NULL` / `IS NOT NULL`
- boolean combinators `AND`, `OR`, `NOT`
- parenthesization
- string literals (single-quoted, `''` escapes), numeric literals,
  property identifiers (dotted path supported)

Anything richer — function calls, subqueries, vendor extensions — yields
`HonuaCapabilityNotSupportedError("query")` rather than emitting a
silent partial filter. Callers that need the full FES vocabulary
reach the wire through
`Source.protocol("wfs").getFeature({ filter: rawFesXml })`.

`Query.spatialFilter` compiles to FES `<fes:BBOX>` (envelope geometry
with `spatialRel` undefined / `esriSpatialRelIntersects` /
`esriSpatialRelEnvelopeIntersects`) or the corresponding spatial
predicate (`<fes:Intersects>`, `<fes:Within>`, `<fes:Contains>`,
`<fes:Crosses>`, `<fes:Overlaps>`, `<fes:Touches>`). For envelope
geometry with a non-intersects relation (`Contains`, `Within`,
`Crosses`, `Overlaps`, `Touches`), the adapter lowers the envelope to
a GML 3.2 polygon and emits the requested predicate so the server
honors the relation rather than silently widening to bbox semantics.
Geometry serialization is GML 3.2 simple (point / line / polygon);
curves and surfaces throw and require the escape hatch.

The geometry property name defaults to `the_geom`. Servers using a
different name (`geometry`, `shape`, …) can supply a per-source filter
through the protocol escape hatch.

## GET vs. POST routing

Filters whose encoded length exceeds `~7000` characters are routed
through POST GetFeature with a `<wfs:GetFeature>` body containing a
`<wfs:Query typeNames="…" srsName="…">`, optional
`<wfs:PropertyName>` projections, the same `<fes:Filter>` tree, and an
optional `<fes:SortBy>` block. `Query.outFields`, `Query.orderBy`, and
`Query.outSr` survive the GET → POST switch — the only transport
difference is the body encoding. The 7000-character threshold is a
single constant we revise after telemetry lands.

`Query.outSr` accepts either a string CRS URI / EPSG token (passed
through verbatim) or a numeric WKID. Numeric WKIDs are translated to
the OGC URN form `urn:ogc:def:crs:EPSG::<wkid>` so the wire shape
matches what `OperationsMetadata` and `Filter_Capabilities` advertise.

## Pagination

`Query.pagination.offset` maps to `startIndex`; `Query.pagination.limit`
maps to `count`. `queryAll` requests `limit + 1` rows so the adapter
can stamp `Result.exceededTransferLimit: true` when more records exist.
`stream` paginates internally with a 2000-row default page size or
the caller's `pagination.limit` when supplied.

`Result.totalCount` populates from the GeoJSON `numberMatched` field;
`exceededTransferLimit` flips when `numberMatched > features.length`.

## queryExtent

Unfiltered `queryExtent()` (no `where`, no `spatialFilter`, no
`outSr`) reads the per-feature-type `ows:WGS84BoundingBox` from
`GetCapabilities` and returns the cached envelope without any extra
HTTP traffic. Filtered or `outSr`-bearing requests drain every page of
the matching set (2000 features per page) and compute the bbox
client-side, so the returned extent always covers the full filtered
set rather than just the first server page. Caller pagination
(`Query.pagination.offset` / `.limit`) is intentionally ignored on
this path — `queryExtent` answers "what bbox holds the matching
records" rather than "what bbox holds the first page". `queryExtent`
returns `{ extent, count? }` and does not carry a `degraded[]` array;
the OGC Features adapter is the only one that flags this fallback
today.

## Edits (`applyEdits`)

`applyEdits` builds a single `<wfs:Transaction>` POST body with
`<wfs:Insert>`, `<wfs:Update>`, and `<wfs:Delete>` blocks. Geometry
payloads come from `CanonicalFeature.geometry` (GeoJSON →
GML 3.2). The transaction's `releaseAction` follows
`EditEnvelope.rollbackOnFailure`:

| `rollbackOnFailure` | `releaseAction` |
| --- | --- |
| `true`              | `ALL`           |
| `false` / omitted   | `SOME`          |

Per-handle `<wfs:InsertResults>` `<fes:ResourceId rid="…"/>` IDs
populate `EditOutcome.id`. `OperationProcessingFailed` and other
`<ows:ExceptionReport>` responses surface as
`HonuaWfsExceptionError` with `.exceptionCode` / `.locator`
preserved.

## Stored queries

`ListStoredQueries` and `DescribeStoredQueries` are reachable through
the protocol escape hatch:

```ts
const wfs = source.protocol("wfs")!;     // HonuaWfsFeatureType
const ids = await wfs.root.storedQueries();
const sq = wfs.root.storedQuery("byKey");
const response = await sq.execute({ parameters: { id: 1 } });
```

A stored query whose output is JSON returns canonical features through
`response.kind === "json"`. Stored queries that advertise only GML
(today: Honua Server's
`urn:ogc:def:query:OGC-WFS::GetFeatureById`) cannot be projected onto
the canonical envelope — `Source.query()` does not carry stored-query
intent because that would re-introduce WFS-specific shapes at the top
level. The escape hatch above still returns the raw GML payload.

## Protocol escape hatch

`Source.protocol("wfs")` returns a bound `HonuaWfsFeatureType` whose
methods carry the raw WFS-shaped payloads:

```ts
const wfs = source.protocol("wfs")!;
// Raw XML capabilities payload (cached after the first call).
const snapshot = await wfs.capabilities();
// Custom FES filter (escape unsupported expressions).
await wfs.getFeature({ filter: customFesXml });
// GetPropertyValue (returns raw XML).
await wfs.getPropertyValue({ valueReference: "ACRES" });
// Custom Transaction body.
await wfs.transaction({ body: rawTransactionXml });
```

`HonuaWfs` (`wfs.root`) owns the capabilities cache and exposes
`capabilities()`, `refresh()`, `rawCapabilities()`, `storedQueries()`,
and `storedQuery(id)` so callers can drive WFS without going through
the canonical `Source` surface when they need full FES expressivity.

## Locking

WFS `LockFeature` / `GetFeatureWithLock` are not exposed in the
canonical contract. Callers that need locks reach the wire through
the protocol escape hatch — there is no top-level
`Source.lock()` concept.

## Defenses

- The capabilities XML walker refuses any document declaring
  `<!DOCTYPE>` or `<!ENTITY>`. This stops XXE-class attacks before any
  property is read. The same walker is reused for
  `<ows:ExceptionReport>` and `<wfs:TransactionResponse>` parsing, so
  every WFS XML payload entering the canonical surface is hardened.
- The WFS adapter never reaches `fetch` directly; all wire calls go
  through `HonuaClient.requestText`, so the existing interceptor / retry
  / timeout / abort signal pipeline applies.
- WFS responses with content-type `application/xml` containing
  `<ows:ExceptionReport>` are turned into typed
  `HonuaWfsExceptionError` instances (`exceptionCode`, `locator`, and
  the message as the parser saw it) so the canonical surface
  surfaces structured WFS errors instead of opaque HTTP failures.
  `HonuaWfsExceptionError` is also raised when an
  `<ows:ExceptionReport>` arrives wrapped inside a `HonuaHttpError`
  body (the body is sniffed for `ExceptionReport` and re-thrown as
  the typed error before the failure leaves the adapter).

## Server compatibility

The adapter targets WFS 2.0 servers. WFS 1.x is intentionally not
supported — Honua Server publishes WFS 2.0 only. Non-Honua servers
that advertise WFS 2.0 with at least GeoJSON output should work
out of the box; servers that only emit GML force the canonical
surface to throw and require the escape hatch.
