# Discover cloud-native sources

Use `@honua/sdk-js/cloud-native-discovery` when an application needs to answer
"what can this deployment or object actually do?" before choosing a protocol
adapter. The result is a stable, data-only document, so the same contract works
in a source picker, server-rendered configuration, diagnostics, and tests.

## Walkthrough: inspect a Honua deployment

### 1. Discover from one base URL

```ts
import {
  assertCloudNativeOperation,
  discoverCloudNativeSources,
} from "@honua/sdk-js/cloud-native-discovery";

const discovery = await discoverCloudNativeSources("https://demo.honua.io", {
  signal: AbortSignal.timeout(5_000),
  interceptors: [
    {
      after({ request, durationMs }) {
        console.log(`discovered ${request.url} in ${durationMs} ms`);
      },
    },
  ],
});

console.table(
  discovery.capabilities.map(({ kind, status, advertised }) => ({
    kind,
    client: status.client,
    server: status.server,
    endToEnd: status.endToEnd,
    advertised,
  })),
);

const stac = discovery.sources.find((source) => source.kind === "stac");
if (stac) assertCloudNativeOperation(stac, "search");
```

Expected output: one request to
`https://demo.honua.io/demo-services.v1.json`, followed by capability rows for
COG, STAC, PMTiles, GeoParquet, GeoArrow, OGC API Coverages, WCS, Zarr, and
NetCDF. Only sources carrying explicit manifest links are returned. The helper
does not probe a guessed `/search`, `/collections`, tile, or asset route.

### 2. Normalize a direct object

```ts
const direct = await discoverCloudNativeSources(
  "https://objects.example.com/basemaps/world.pmtiles",
);

const [archive] = direct.sources;
if (archive) assertCloudNativeOperation(archive, "read-ranges");
```

No request is made during direct URL normalization. The PMTiles connector still
performs its own structural range validation when the application opens the
archive. For a URL with an ambiguous suffix, declare the candidate explicitly:

```ts
const parquet = await discoverCloudNativeSources({
  type: "direct-asset",
  url: "https://objects.example.com/releases/places.parquet",
  format: "geoparquet",
});

const [source] = parquet.sources;
if (source) {
  assertCloudNativeOperation(source, "query", { allowExperimental: true });
}
```

GeoParquet remains experimental. GeoArrow is metadata-only in this discovery
contract. Zarr and NetCDF are maturity markers only; this API does not claim a
reader or query implementation for either format.

## Auth, cancellation, and request policy

`discoverCloudNativeSources` accepts the same auth-provider and request-
interceptor contracts as `HonuaClient`, plus `apiKey`, `bearerToken`, `fetchFn`,
and `AbortSignal` options. Credentials and hooks apply to the deployment
manifest request. Direct asset normalization does not send credentials or make
a network request.

## Troubleshooting

| Symptom | Meaning | Next action |
| --- | --- | --- |
| `invalid-cloud-native-input` | The URL is invalid or a direct format is ambiguous. | Pass an absolute HTTP(S) URL and set `format` for an ambiguous object. |
| `invalid-cloud-native-manifest` | The manifest is not JSON or lacks its version/services envelope. | Check the configured `manifestUrl` and deployed manifest version. |
| `cloud-native-operation-unavailable` | The format, advertised link, or maturity does not permit the operation. | Branch on `status` or explicitly opt into an experimental operation. |
| `HonuaAbortError` | The caller cancelled discovery. | Treat it as cancellation, not a failed capability probe. |
| `HonuaHttpError` | The manifest request was rejected. | Supply an auth provider or inspect the HTTP status. |

For a production-shaped application that turns discovered STAC links into an
imagery workflow, see
[`examples/stac-imagery-browser`](../examples/stac-imagery-browser/README.md).
