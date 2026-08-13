# Zarr client

`@honua/sdk-js/zarr` is an experimental client for Honua Server's versioned
Zarr registration and tile-serving contract. It reuses an existing
`HonuaClient`, so API keys, bearer tokens, cancellation, retry policy, timeout,
and request interceptors remain active.

```ts
import { HonuaClient } from "@honua/sdk-js/honua";
import { createZarrClient } from "@honua/sdk-js/zarr";

const client = new HonuaClient({
  baseUrl: "https://your-honua-server.example",
  apiKey: process.env.HONUA_API_KEY,
});
const zarr = createZarrClient(client);

const registered = await zarr.register({
  layerId: 7,
  name: "Daily temperature",
  provider: "AwsS3",
  bucket: "coverage-data",
  rootPath: "temperature/daily.zarr",
});

const scanned = await zarr.refresh(registered.id);
const status = zarr.assess(scanned);
if (status.serverTileHandoff !== "ready") {
  throw new Error(status.failures.map((failure) => failure.message).join("; "));
}

const tile = await zarr.tile({
  layerId: scanned.layerId,
  tileMatrixSetId: "WorldCRS84Quad",
  z: 3,
  x: 2,
  y: 4,
  variable: scanned.primaryVariable ?? undefined,
  datetime: "2026-08-13T00:00:00Z",
  maxResponseBytes: 2 * 1024 * 1024,
});
```

## Contract and limits

- The client calls only `/api/v1/admin/zarr-stores` and
  `/api/v1/datacubes/{layerId}/tiles/...`. Alternate unversioned base paths are
  rejected.
- Registration and metadata responses default to a 2 MiB ceiling. Tile
  responses also default to 2 MiB and can be reduced per request.
- Tile coordinates and optional elevation are non-negative integers. The
  server converts the advertised tile window into a bounded, chunk-aware read.
- `AbortSignal` is forwarded to the shared request pipeline.
- `assess()` recognizes Zarr v2/v3, little-endian numeric or boolean dtypes,
  and uncompressed, gzip, or zlib chunks. Blosc, Zstandard, big-endian dtypes,
  and ambiguous dimension metadata fail explicitly.
- Metadata must be refreshed before the tile handoff is considered ready.

This slice does not fetch chunks directly from S3, Azure Blob Storage, or the
local filesystem. `directObjectStoreRead` therefore remains `"unavailable"`.
Use the server tile operation or the existing OGC API Coverages/WCS client for
bounded subsets. The API remains experimental until cross-deployment evidence
is stable.
