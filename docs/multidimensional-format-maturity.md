# Zarr, NetCDF, and HDF5 maturity boundary

This page is internal architecture and curriculum guidance. It is not public
SDK documentation, a support claim, or a runnable workflow. The sole governed
source is `config/multidimensional-format-maturity.v1.json`. NetCDF/HDF5 evidence
is pinned to server commit `61b7038e1887c98131aa217b6f0ae7869356a1f3`, while
Zarr evidence is pinned to its separately audited commit
`639d37449fb8da5e9df4b12b7641ba4c6c5ac581`.

## Explicit maturity states

| Format | Client | Server | End to end | Meaning |
| --- | --- | --- | --- | --- |
| Zarr v2/v3 | `unavailable` | `experimental` | `unavailable` | Registration, bounded-read internals, CoverageJSON, WCS fixtures, and datacube components exist, but no public canary or JavaScript adapter closes the path. |
| NetCDF-4 | `unavailable` | `metadata-only` | `unavailable` | Registration and build-optional metadata/conversion exist without a stable variable or subset read contract. |
| Geospatial HDF5 | `unavailable` | `metadata-only` | `unavailable` | Registration and conversion architecture exist, but explicit driver and bounded-read proof are missing. |

These states describe delivery layers separately. Server implementation evidence
must never be promoted into a client or end-to-end claim.

## Reconciled Zarr server evidence

The server maps versioned admin registration routes, binds registered stores to
OGC API Coverages, exposes a datacube tile route, and exercises registered Zarr
PNG slices through WCS fixtures. Chunk-aware bounded readers and renderer
components are tested. This is truthful `experimental` server evidence, not a
positive public live Zarr canary.

The registration lifecycle test does not prove a readable cloud-hosted store.
The OGC API Coverage path lacks a Zarr-specific positive public HTTP receipt.
The checked-in datacube endpoint test proves only the no-registration negative
path. WCS supports bounded native-CRS PNG fixtures, while TIFF and range-subset
composition remain unsupported.

## Zarr contract bounds

### Versions and metadata

- Zarr v2 reads `.zgroup`, `.zattrs`, and `.zarray`. Group discovery depends
  on an optional variables attribute rather than unrestricted store listing.
- Zarr v3 reads root and child `zarr.json` nodes. Group discovery depends on
  `attributes.variables` and is not general v3 enumeration.
- Metadata documents are capped at 64 KiB and discovery at 64 variables.

### Codecs and layout

- Tested reads cover v2 uncompressed/zlib and v3 uncompressed/gzip chunks.
- V3 `zstd`, `blosc`, `sharding_indexed`, `crc32c`, and unknown
  codecs fail explicitly. Filters, Fortran order, big-endian values, and
  unsupported non-numeric types also fail explicitly.
- C-order regular chunks, v3 `c/` keys, and v2-style dotted keys are admitted.
- A subset is capped at 4096 chunks and 256 MiB decoded data. CoverageJSON is
  capped at 16 MiB and a datacube tile slice at 4 MiB.

### Coordinates and CRS

- Georeferencing uses Honua variable, dimension, `crs_wkid`, and extent
  attributes rather than unrestricted CF/Zarr inference.
- A datacube tile matrix SRID must equal the storage SRID.
- Cross-CRS reprojection of a Zarr tile window is not implemented.

## NetCDF and HDF5 server boundary

The server has authenticated admin registration CRUD at
`/api/v1/admin/multidim-coverages`, plus refresh and scan-status operations.
Registration records a layer, cloud object, declared format, and variable
selection. It does not prove that a client can inspect or read the object.

ADR-0039 selects a separately deployed native GDAL worker. A refresh can run
`gdalmdiminfo` and best-effort conversion to a derived Zarr store. The serving
process remains native-library-free, and the managed fallback reader advertises
no supported multidimensional formats. The Docker build explicitly checks the
netCDF and GRIB drivers, but not an HDF5 driver; none of those checks is a
deployed server/worker compatibility receipt.

The current source proves registration and a build-optional conversion
architecture. It does not prove a stable versioned HTTP operation for variable
or dimension inspection or bounded spatial, temporal, vertical, and variable
subsets. Tests use in-memory job stores and fake GDAL results rather than
immutable live NetCDF4/HDF5 fixtures.

## Format boundaries

NetCDF-4 is scoped to CF-aware coverage variables, dimensions, coordinate axes,
attributes, grid mappings, calendars, chunks, scale/offset, and fill/no-data.

HDF5 is not inherently geospatial. A future adapter may cover only datasets
that map to a documented geospatial coverage model. Generic group browsing is
out of scope and must never be implied by NetCDF parity.

GRIB/GRIB2 is reference-only here. Server source contains a registration enum,
extension validation, worker-path test reference, and image-driver assertion,
but issue #1121 does not create a GRIB SDK or curriculum commitment.

## Release blockers

NetCDF/HDF5 blockers remain unchanged:

- `server-versioned-metadata-http`
- `server-bounded-subset-http`
- `worker-driver-image-matrix`
- `pinned-live-format-fixtures`
- `deployed-live-canary`
- `sdk-adapter-contract`

Zarr adds format-specific gates without implying public support:

- `zarr-immutable-fixture-and-version-matrix`
- `zarr-positive-server-routes`
- `zarr-stable-version-codec-contract`
- `zarr-bounded-sdk-client`
- `zarr-sample-publication`

Until every applicable blocker is evidenced, there is no public export, support
or coverage claim, runnable example, Studio action, CLI command, or implicit
browser full-file download.

## Maturity-only architecture guidance

A future Zarr surface has three conceptual responsibilities, not reserved API
names: inspect bounded metadata, read a chunk-aware bounded slice, and request a
server tile or adapt an admitted two-dimensional slice. Direct object-range and
Honua server execution remain distinct. Both require observable byte, chunk,
dimension, and decoded-output budgets; shared cancellation/auth/interceptors;
and typed failures for versions, codecs, coordinates, and CRS.

For NetCDF/HDF5, the first task inspects one variable and explains dimensions,
axes, units, chunks, fill value, CRS, and server limits. The second requests one
bounded space/time/vertical slice. The third chooses an admitted raster,
coverage, or columnar handoff without downloading the source file. Only after
the corresponding SDK and live gates pass may a pinned gallery walkthrough be
published.
