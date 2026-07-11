# WFS 2.0 adapter

`@honua/sdk-js` ships a first-party WFS 2.0 client that conforms to the
shared JS client contract from
[`docs/shared-client-contract.md`](./shared-client-contract.md). A WFS
source registered through `createDataset({ sources })` produces the same
canonical `Source<T>` / `Query<T>` / `Result<T>` / `EditEnvelope<T>` /
`EditResult` shapes as the GeoServices and OGC Features adapters, so
mixed-source operator apps do not have to learn WFS / XML specifics.

```ts doc-test=compile
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

```ts doc-test=compile
interface WfsLocator {
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

## Field projection (`outFields` and `returnGeometry`)

WFS `propertyName=` drops every property the caller does not list,
including the geometry column. The canonical `Query` contract treats
`outFields` and `returnGeometry` as independent controls (geometry is
included unless `returnGeometry === false`), so the adapter resolves
the two like this:

| `outFields` | `returnGeometry` | wire `propertyName=` |
| --- | --- | --- |
| _unset / empty_ | _unset_ / `true` | _omitted_ — server returns all fields + geometry |
| _set_ | _unset_ / `true` | `outFields,the_geom` (geometry property appended unless already listed) |
| _set_ | `false` | `outFields` only — geometry is intentionally dropped |
| _unset / empty_ | `false` | _refused_ — `HonuaCapabilityNotSupportedError("query")` |

The `returnGeometry === false` + no-`outFields` case throws because
WFS cannot suppress geometry without enumerating every non-geometry
property; silently widening to "geometry included" would break the
canonical contract. Callers that need geometry-less rows must list the
non-geometry fields they want, or reach the wire through
`Source.protocol("wfs")`.

`queryExtent` and `queryObjectIds` ignore both `outFields` and
`returnGeometry` on the drain path so caller intent on those fields
cannot break the drain. `queryExtent` always issues geometry-bearing
pages (it computes a bbox from each feature's geometry); a
`returnGeometry: false` paired with `queryExtent` does **not** throw,
the field is stripped before the drain. `queryObjectIds` reads each
feature's GeoJSON `id` directly, so neither knob affects the result —
both are stripped before the drain so the caller's `outFields` cannot
push the geometry property onto the wire and `returnGeometry: false`
cannot trip the propertyName-suppression guard.

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

`pagination.limit === 0` is treated as an explicit "zero records" cap
across `query`, `queryAll`, `stream`, and `queryObjectIds` — the
default page-size fallback only applies when `limit` is unset or
negative. `query` / `stream` / `queryObjectIds` short-circuit before
the wire call (returning an empty result, no yielded pages, or `[]`
respectively); `queryAll` still issues a single 1-row lookahead so
`exceededTransferLimit` can flip when more records exist.

`Result.totalCount` populates from the GeoJSON `numberMatched` field;
`exceededTransferLimit` flips when `numberMatched > features.length`.

## queryObjectIds

WFS 2.0 has no interoperable server-side ids-only mode, so
`queryObjectIds` drains the matching set across pages and projects the
GeoJSON `id` from each feature. The default page size is 2000; the
drain stops as soon as the server returns a short page.
`Query.pagination.offset` chooses where the drain starts (forwarded as
`startIndex` to `GetFeature`) and `Query.pagination.limit`, when set,
caps the global id count — not the per-page count — so callers can
stop the drain without learning the server's default page size. The
adapter shrinks each page to `min(2000, remaining)` so the final page
never overshoots the cap. A `pagination.limit` of `0` short-circuits
the drain and returns `[]` without a wire call.

`Query.outFields` and `Query.returnGeometry` are stripped before each
drained page is requested. The drain reads each feature's top-level
GeoJSON `id` (a sibling of `properties` and `geometry`), so neither
knob affects the result; stripping them keeps the wire request from
emitting an unnecessary `propertyName=` and prevents
`returnGeometry: false` from tripping the canonical "no `outFields`"
guard documented in [Field projection](#field-projection-outfields-and-returngeometry).

## queryExtent

Unfiltered `queryExtent()` (no `where`, no `spatialFilter`, no
`outSr`) reads the per-feature-type `ows:WGS84BoundingBox` from
`GetCapabilities` and returns the cached envelope without any extra
HTTP traffic. Filtered or `outSr`-bearing requests drain every page of
the matching set (2000 features per page) and compute the bbox
client-side, so the returned extent always covers the full filtered
set rather than just the first server page. Caller pagination
(`Query.pagination.offset` / `.limit`), `Query.outFields`, and
`Query.returnGeometry` are intentionally ignored on this path —
`queryExtent` answers "what bbox holds the matching records" rather
than "what bbox holds the first page", and the drain must always see
geometry on the wire to compute a bbox. A caller-supplied `outFields`
projection would emit `propertyName=...` and drop geometry from every
drained page; a caller-supplied `returnGeometry: false` would trip the
field-projection guard. The drain therefore strips all three fields
before issuing each `GetFeature` page so geometry is preserved
end-to-end and the call cannot be refused on a knob that does not
apply to extent computation. `queryExtent` returns
`{ extent, count? }` and does not carry a `degraded[]` array; the OGC
Features adapter is the only one that flags this fallback today.

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
populate `EditOutcome.id`. The adapter stamps each `<wfs:Insert>` with
a stable `handle="add-N"` (1-based, matching `envelope.adds` order)
and indexes the returned `<wfs:Feature handle="…">` buckets by handle
when mapping ResourceIds back onto `EditResult.added`, so a server
that reorders the buckets — or omits them under `releaseAction="SOME"`
when an insert fails — does not misassign IDs to the wrong
`envelope.adds[i]`. Inserts whose handle is missing from the response
surface as `{ success: false }` rather than silently inheriting the
neighbouring success. The handle attribute is informational in WFS 2.0,
so when no `<wfs:Feature>` carries one the adapter falls back to the
legacy positional pairing instead of dropping every id.
`OperationProcessingFailed` and other `<ows:ExceptionReport>`
responses surface as `HonuaWfsExceptionError` with `.exceptionCode` /
`.locator` preserved.

`CanonicalFeature.id` is required on every update because each
`<wfs:Update>` is filtered by `<fes:ResourceId>`; without an id the
block would mass-update every feature in the type. Updates whose `id`
is `undefined` / `null` are filtered out before the transaction body is
built and surface as deterministic per-item failures
(`{ success: false, error: { code: 400, description: "update.id is
required" } }`) on `EditResult.updated`. Valid updates in the same
envelope still travel as a single transaction. When every operation in
the envelope is absent or malformed the adapter skips the wire
round-trip entirely so the server never sees an unaddressed
transaction.

## Stored queries

`ListStoredQueries` and `DescribeStoredQueries` are reachable through
the protocol escape hatch:

```ts doc-test=skip reason="partial excerpt requires application host context"
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

```ts doc-test=skip reason="partial excerpt requires application host context"
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
