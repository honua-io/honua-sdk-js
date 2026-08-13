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
const readiness = { tileMatrixSrid: 4326, variable: scanned.primaryVariable ?? undefined };
const status = zarr.assess(scanned, readiness);
if (status.serverTileHandoff !== "ready") {
  throw new Error(status.failures.map((failure) => failure.message).join("; "));
}

const tile = await zarr.tile({
  layerId: scanned.layerId,
  tileMatrixSetId: "WorldCRS84Quad",
  z: 3,
  x: 2,
  y: 4,
  variable: readiness.variable,
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
- A tile outside the coverage extent is returned as `{ status: 204, bytes:
  Uint8Array(0), contentType: null }`; an intersecting tile is a `200` PNG.
- `AbortSignal` is forwarded to the shared request pipeline.
- `assess()` recognizes Zarr v2/v3, little-endian numeric or boolean dtypes,
  and uncompressed, gzip, or zlib chunks. Blosc, Zstandard, big-endian dtypes,
  and ambiguous dimension metadata fail explicitly.
- `assess()` mirrors the server's primary-or-first variable selection. Its
  readiness options require the requested tile matrix SRID and accept an
  optional variable; unrelated auxiliary variables do not block a valid
  raster. Tileable variables require non-empty `x`/`lon` and `y`/`lat` axes.
- Metadata must be refreshed and expose at least one variable before the tile
  handoff is considered ready.
- A positive storage SRID is required because the current tile handoff cannot
  reproject between the coverage and tile matrix set.

This slice does not fetch chunks directly from S3, Azure Blob Storage, or the
local filesystem. `directObjectStoreRead` therefore remains `"unavailable"`.
Use the server tile operation or the existing OGC API Coverages/WCS client for
bounded subsets. The API remains experimental until cross-deployment evidence
is stable.
