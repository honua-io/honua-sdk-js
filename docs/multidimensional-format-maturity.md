# NetCDF and HDF5 maturity boundary

This page is internal architecture and curriculum guidance. It is not public
SDK documentation, a support claim, or a runnable workflow. The governed source
is `config/multidimensional-format-maturity.v1.json`; its server evidence is
pinned to commit `61b7038e1887c98131aa217b6f0ae7869356a1f3`.

## Reconciled server boundary

The server has authenticated admin registration CRUD at
`/api/v1/admin/multidim-coverages`, plus refresh and scan-status operations.
Registration records a layer, cloud object, declared format, and variable
selection. It does not prove that a client can inspect or read the object.

ADR-0039 selects a separately deployed native GDAL worker. A refresh can run
`gdalmdiminfo` and best-effort conversion to a derived Zarr store. The serving
process remains native-library-free, and the managed fallback reader advertises
no supported multidimensional formats. The Docker build explicitly checks the
netCDF and GRIB drivers, but not an HDF5 driver; none of those build checks is a
deployed server/worker compatibility receipt.

The current source therefore proves registration and a build-optional
conversion architecture. It does not prove a stable versioned HTTP operation
for variable/dimension inspection or bounded spatial, temporal, vertical, and
variable subsets. Unit and integration tests use in-memory job stores and fake
GDAL results rather than immutable live NetCDF4/HDF5 fixtures.

## Format boundaries

NetCDF-4 is scoped to CF-aware coverage variables, dimensions, coordinate axes,
attributes, grid mappings, calendars, chunks, scale/offset, and fill/no-data.

HDF5 is not inherently geospatial. A future adapter may cover only HDF5
datasets that map to a documented geospatial coverage model. Generic group
browsing is out of scope and must never be implied by NetCDF parity.

GRIB/GRIB2 is reference-only here. Server source contains a registration enum,
extension validation, worker-path test reference, and image-driver assertion,
but issue #1121 does not create a GRIB SDK or curriculum commitment.

## Release blockers

- `server-versioned-metadata-http`: versioned variable, dimension, coordinate,
  attribute, and convention inspection with generated protocol documentation.
- `server-bounded-subset-http`: bounded variable/time/vertical/spatial reads
  with explicit byte, cell, variable, timeout, and range limits.
- `worker-driver-image-matrix`: explicit NetCDF4 and HDF5 driver proof for every
  supported image, architecture, and deployed server/worker version pair.
- `pinned-live-format-fixtures`: immutable, license-safe NetCDF4 and geospatial
  HDF5 fixtures with known metadata and expected subset digests.
- `deployed-live-canary`: scheduled end-to-end receipts for auth, cancellation,
  errors, metadata, bounded results, conversion, and artifact provenance.
- `sdk-adapter-contract`: reviewed bounded client API with typed errors,
  cancellation, auth/interceptors, caching, and safe raster/columnar handoffs.

Until every blocker is evidenced, there is no public export, support or coverage
claim, runnable example, Studio action, CLI command, or implicit browser
full-file download.

## Curriculum after unblock

The first task inspects one variable and explains its dimensions, axes, units,
chunks, fill value, CRS, and server limits. The second requests one bounded
space/time/vertical slice and asserts a deterministic result. The third chooses
an admitted raster/coverage or columnar handoff without downloading the source
file. Only then may a gallery walkthrough use a pinned fixture, expected output,
troubleshooting, provenance, and a complete-project link.
