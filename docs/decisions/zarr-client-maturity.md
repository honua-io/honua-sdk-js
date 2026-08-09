# Zarr Client Maturity Boundary

Status: blocked, maturity-only. Issue: [#1120](https://github.com/honua-io/honua-sdk-js/issues/1120).

The JavaScript SDK does not currently expose a Zarr client. This page records
the server evidence and the gates that must pass before an API or sample can be
published. The governed source is
[`zarr-client-maturity.v1.json`](../data/zarr-client-maturity.v1.json).

## Current Maturity

| Layer | Status | Meaning |
| --- | --- | --- |
| Honua Server | `implementation-evidenced` | Registration, bounded reads, CoverageJSON, WCS fixture paths, and datacube tile components exist. A positive public live Zarr canary is not recorded. |
| JavaScript SDK | `unavailable` | There is no Zarr export, connector, metadata reader, slice reader, or tile client. |
| Developer sample | `withheld` | A runnable sample would imply an executable client and stable public service that do not yet exist. |

No code should import `@honua/sdk-js/zarr`; that path is a design candidate,
not a package export.

## Reconciled Server Evidence

The server reference audited by the descriptor is pinned so later changes do
not silently upgrade these claims.

| Surface | What exists | Evidence boundary |
| --- | --- | --- |
| Registration | Versioned admin CRUD and refresh routes are composed into the server; an HTTP lifecycle test covers register/list/get/delete. | The test does not read a public object-store fixture or prove a successful metadata refresh. |
| OGC API Coverages | `ZarrCoverageService` maps a registered store to collection/schema documents and a bounded CoverageJSON subset. Core tests prove chunk-aware reads. | No Zarr-specific positive OGC API Coverages HTTP round trip or public live response was found in the audited proof. |
| Datacube tiles | The public route maps a registered Zarr slice to a bounded PNG tile. Planner and renderer components are tested. | The checked-in endpoint test proves only the no-registration 404 path; there is no positive route or public live tile proof. |
| WCS 2.0.1 | HTTP fixture tests return native-CRS PNG slices for registered Zarr data and exercise explicit failures. | TIFF and range-subset composition remain unsupported on this path. |

This reconciles two easy-to-confuse statements in the server repository:

- `docs/reference/protocols/cloud-native-formats.md` labels registration and
  serving as live because the server paths are implemented.
- `docs/cng-status.md` correctly says Zarr is read/transcode only; Honua does
  not claim Zarr authoring in the cloud-native artifact conformance lane.

Neither statement proves a public end-to-end deployment. For SDK maturity,
"live" requires the explicit fixture and live-service gates below.

## Server Contract Bounds

### Versions and metadata

- Zarr v2 reads `.zgroup`, `.zattrs`, and `.zarray`. Grouped discovery depends
  on an optional `variables` attribute rather than unrestricted store listing.
- Zarr v3 reads root and child `zarr.json` nodes. Grouped discovery depends on
  the root `attributes.variables` list; it is not general Zarr v3 enumeration.
- The implementation is bounded to 64 metadata variables and 64 KiB per
  metadata document.

### Codecs and layout

- Tested reads cover v2 uncompressed/zlib and v3 uncompressed/gzip chunks.
- The supported layout is C order with regular chunks. V3 default `c/` chunk
  keys and v2-style dotted keys are recognized.
- V3 `zstd`, `blosc`, `sharding_indexed`, `crc32c`, and unknown codecs fail
  explicitly. Filters, Fortran order, big-endian values, and unsupported data
  types also fail explicitly.
- A request is capped at 4096 chunks and 256 MiB of decoded subset data. The
  CoverageJSON path is capped at 16 MiB and a datacube tile slice at 4 MiB.

### Coordinates and CRS

- The current georeferencing path reads Honua `crs_wkid` and extent
  attributes. It does not promise unrestricted CF/Zarr coordinate inference.
- Datacube tiles require the tile matrix set SRID to match the storage SRID.
- Cross-CRS reprojection of a Zarr tile window is not implemented.

## Why This Stays Internal

The published canonical keys `raster.multidim-coverage`,
`serve.ogc-api-coverages`, and `serve.wcs` describe server capabilities. The
SDK coverage schema only permits `covered` and `partial`, and each entry must
carry an executable entrypoint and evidence. It cannot truthfully express an
unavailable client or a withheld sample.

Therefore this descriptor is intentionally absent from the support manifest,
SDK coverage crosswalk, public capability projection, package exports, and
sample catalog. Adding a `partial` entry now would confuse server availability
with client implementation.

## Required Evidence Gates

### Public fixture

1. Publish immutable, redistributable v2 and v3 fixtures with a license,
   SHA-256 digests, expected metadata, and expected subset/tile digests.
2. Cover supported codec, CRS, spatial, temporal, vertical, and named-dimension
   behavior.
3. Record deterministic byte-range traces that prove chunk-bounded access and
   rejection at the declared limits.

### Live service

1. Pin the deployed server commit and capability manifest.
2. Verify a bounded Zarr-backed OGC API Coverage response, including media
   type, byte limit, axes, shape, and digest.
3. Verify a positive datacube PNG tile response, including media type,
   dimensions, byte limit, and digest.

### SDK and sample

1. Stabilize the versioned server contract for metadata, subset, tile, codec,
   coordinates, CRS, and errors.
2. Implement typed, bounded operations with cancellation, auth, request hooks,
   and explicit unsupported-format errors.
3. Pass deterministic fixture contracts and scheduled live evidence.
4. Only then publish a minimal sample with inline editable code.

## Future API Shape, Not An API

The future surface has three conceptual responsibilities:

| Responsibility | Contract boundary |
| --- | --- |
| Metadata | Describe groups, arrays, dimensions, chunks, data types, codecs, fill values, coordinates, CRS, and consolidated-metadata availability without fetching array payloads. |
| Slice | Read an explicitly bounded spatial, temporal, vertical, or named-dimension slice through chunk-aware requests. |
| Tile | Request a bounded server datacube tile or adapt an explicitly supported 2D slice without hiding CRS or resampling limits. |

Direct object-store access and Honua server operations must remain distinct
execution modes. Both must use observable budgets, shared cancellation/auth
plumbing, and typed failures. These responsibilities are architecture only;
they do not reserve final TypeScript names.

## Governance

`test/zarr-maturity-descriptor.test.ts` validates the descriptor schema, pins
the unavailable/withheld states, requires the three evidence tracks, and
guards against accidentally exposing a Zarr package or sample before the gates
are intentionally replaced by executable evidence.
