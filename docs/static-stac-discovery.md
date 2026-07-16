# Static STAC discovery

`@honua/sdk-js/stac-discovery` is an experimental, opt-in pre-connect lane for
static [STAC 1.0 and 1.1](https://github.com/radiantearth/stac-spec/tree/v1.1.0)
Catalog, Collection, and Item documents. It walks a bounded static graph,
normalizes the metadata a user needs to decide what to use, and emits existing
SDK locator coordinates only when the asset evidence is safe and actionable.

It does not query, render, or silently choose an asset. The intended workflow
stays explicit:

1. discover the static catalog;
2. inspect classifications, diagnostics, legal metadata, and provenance;
3. accept one candidate and hand its locator to an existing SDK adapter;
4. query or map through that adapter's normal capability surface.

The module is subpath-only. Importing the stable package root does not retain
the traversal or probe runtime.

## Discover and inspect

```ts doc-test=compile
import { discoverStaticStac } from "@honua/sdk-js/stac-discovery";

const discovery = await discoverStaticStac({
  endpoint: "https://example.com/stac/catalog.json",
  authorizationScopeFingerprint: "public",
});

for (const asset of discovery.assets) {
  if (asset.classification.state !== "classified") {
    console.warn(asset.id, asset.classification.reason, asset.classification.evidence);
    continue;
  }

  console.log({
    id: asset.id,
    format: asset.classification.format,
    source: asset.source,
    crs: asset.crs,
    extent: asset.extent,
    time: asset.temporalExtent,
    license: asset.license,
    attribution: asset.attribution,
    provenance: asset.provenance,
  });
}
```

Check both `classification.state === "classified"` and `asset.source`. A COG
can be classified safely without having a direct COG execution adapter, and a
signed asset is returned as `access: "resolver-required"` without a reusable
locator. `ambiguous` and `unsupported` candidates are never promoted to a
source locator.

## Adapter handoff

`asset.source` uses existing protocol and `SourceLocator` coordinates:

| Discovered format | Locator protocol | Next step |
| --- | --- | --- |
| GeoParquet | `geoparquet` | Run explicit GeoParquet `connect()` with a profiler and `geoparquetResolver()`, then inspect the connection before querying. |
| PMTiles | `pmtiles` | Create a tiles-only descriptor, inspect the archive through `source.protocol("pmtiles")`, then mount it through the map/runtime lane. |
| TileJSON or tile template | `maplibre-vector` or `maplibre-raster` | Create a renderer-native descriptor and mount it with the existing data-to-map bridge. |
| COG | none yet | Keep the classified candidate and metadata; do not invent a query or render adapter. |
| Metadata | none | Treat it as metadata, not spatial data. |

GeoParquet deliberately goes through the existing profiler again. The bounded
discovery probe proves that the asset is plausibly GeoParquet; the profiler
produces the complete schema required for query admission.

```ts doc-test=skip reason="requires the optional DuckDB-WASM runtime and an application map host"
import { connect } from "@honua/sdk-js";
import { geoparquetResolver, GeoparquetRuntime } from "@honua/sdk-js/geoparquet";
import { discoverStaticStac } from "@honua/sdk-js/stac-discovery";

const discovered = await discoverStaticStac({ endpoint: catalogUrl });
const candidate = discovered.assets.find(
  (asset) => asset.classification.format === "geoparquet" && asset.source?.protocol === "geoparquet",
);
if (!candidate?.source) throw new Error("No reviewed GeoParquet asset");

const runtime = new GeoparquetRuntime();
const connection = await connect({
  endpoint: candidate.source.locator.url,
  protocol: "geoparquet",
  authorizationScopeFingerprint: "public",
  geoparquet: { profiler: runtime },
  resolveSource: geoparquetResolver({ runtime }),
});

console.table(connection.inspection.sources);
const result = await connection.source().query({ pagination: { limit: 500 } });
await runtime.dispose();
```

For tile candidates, use the same accepted descriptor with the
[`mountSource`](./data-to-map-bridge.md) workflow. PMTiles remains tiles-only;
calling its query family correctly throws `HonuaCapabilityNotSupportedError`.

## Classification evidence

Classification never uses a file-name extension. A URL ending in `.pmtiles`,
`.parquet`, or `.tif` is not evidence by itself.

| Format | Evidence used | Fail-closed behavior |
| --- | --- | --- |
| COG | Explicit Cloud Optimized GeoTIFF media profile, roles/extensions, and a bounded TIFF signature probe | A TIFF signature validates a declared COG but cannot prove cloud optimization. Generic GeoTIFF remains ambiguous. |
| GeoParquet | Parquet media/roles/extensions plus an honored suffix range, a structurally decoded Compact Protocol footer, required primary-column `encoding` and `geometry_types` metadata, and `PAR1` prefix/footer framing | A generic or malformed Parquet file, a merely present `geo` object, an incomplete footer, and a server that ignores or misstates the suffix range are not promoted. |
| PMTiles | PMTiles media/roles/extensions plus the `PMTiles` magic and v3 byte | Conflicting magic produces an ambiguous candidate. |
| Tiles | Explicit vector/raster tile media, a `{z}/{x}/{y}` template, or a bounded TileJSON object | Unknown tile content stays unknown and cannot become a renderer locator. |
| Metadata | An explicit metadata role paired with an absent or metadata-compatible JSON/XML/text media type | Metadata is never treated as queryable spatial data. |

Evidence follows the published format contracts: [OGC COG
1.0](https://docs.ogc.org/is/21-026/21-026.html), [GeoParquet
1.1](https://geoparquet.org/releases/v1.1.0/), [PMTiles
v3](https://github.com/protomaps/PMTiles/blob/main/spec/v3/spec.md), and
[TileJSON 3.0](https://github.com/mapbox/tilejson-spec/tree/master/3.0.0).

## Traversal and transport policy

Traversal is deterministic breadth-first over sorted `child` and `item` links.
Repeated targets and loops are reported and ignored. Relative links resolve
against the document that contains them. Catalog/Collection/Item identity,
collection inheritance, CRS, spatial and temporal extent, license,
attribution, providers, validators, and observation provenance are preserved.

The defaults are deliberately finite:

| Limit | Default | SDK ceiling |
| --- | ---: | ---: |
| Documents | 128 | 1,024 |
| Link depth | 12 | 32 |
| Relevant links per document | 512 | 2,048 |
| Assets | 1,000 | 10,000 |
| JSON document | 1 MiB | 8 MiB |
| One asset probe | 64 KiB | 256 KiB |
| Request deadline | 10 seconds | 60 seconds |
| Redirects per request | 5 | 10 |

Additional protections are always on:

- only HTTP(S) URLs are accepted;
- traversal is root-origin-only unless `allowedOrigins` explicitly expands it;
- asset probes are root-origin-only unless `probeOrigins` explicitly expands them;
- redirects are revalidated, cross-origin policy is enforced, and HTTPS
  downgrades are refused;
- caller headers go only to the root origin; cross-origin requests start with
  no caller headers and fetch credentials are omitted;
- discovery identity, diagnostics, results, and provenance never retain URL
  credentials or recognized signed-query material;
- streamed bodies stop at their configured byte limit;
- `AbortSignal` cancellation and per-request deadlines cover metadata and
  probes;
- asset probes request bounded byte ranges; responses from servers that ignore
  `Range` are truncated at the same byte limit.

GeoParquet suffix evidence is interpreted only from a non-truncated `206`
response whose terminal `Content-Range` exactly matches the returned bytes.
An ignored or malformed range remains nonconclusive rather than being mistaken
for footer evidence.

`allowedOrigins` authorizes STAC metadata traversal, not credential replay.
`probeOrigins` authorizes bounded anonymous probes, not full asset download.
Signed/query-bearing asset URLs are normalized for display and returned as
`resolver-required`; the caller must resolve fresh access at execution time.

The authorization-scope default is deliberately narrow. `public` is inferred
only when discovery uses `globalThis.fetch`, sends no caller headers, and stays
on the root origin. Supplying a custom `fetchFn`, any non-empty caller headers,
or an expanded traversal/probe origin policy requires an explicit, non-public
`authorizationScopeFingerprint`. Use a stable ACL/audience label—not a token or
credential—so authenticated or transport-dependent results cannot collide in a
public discovery cache partition.

## Diagnostics

Diagnostics are safe coordinates rather than network traces. They identify a
document id, asset key, or link relation but do not include request URLs or
credential values. Expected recoverable conditions include loops,
cross-origin links, non-JSON links, traversal limits, unreadable child
documents, skipped probes, ambiguous evidence, and unsupported assets.

Root-document transport or validation failure rejects discovery. Failures on a
linked child are diagnostic and traversal continues within the configured
budgets. Cancellation always rejects immediately.
