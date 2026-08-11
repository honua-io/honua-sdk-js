# Unified raster capability matrix

The `@honua/sdk-js/raster` facade records client, server, and end-to-end status
separately. `supported` is not inferred from a filename, endpoint family, or
injected adapter.

| Source | Client | Server | End to end | Executable operations |
| --- | --- | --- | --- | --- |
| Direct COG | Experimental | Unavailable | Experimental | Structural inspect, bounded pixel window, bands, no-data statistics, histogram, value inspect, MapLibre mount |
| ImageServer | Supported | Supported | Supported | Metadata, bounded bbox render, bands, rendering rule, identify, MapLibre/deck.gl image handoff |
| OGC API Coverages | Experimental | Experimental | Experimental | Collection/domain/range metadata, bounded bbox retrieval, named range fields, MapLibre/deck.gl image handoff |
| WCS | Experimental | Experimental | Experimental | DescribeCoverage, bounded bbox retrieval, named range fields, advertised-axis scaling, MapLibre/deck.gl image handoff |
| Zarr | Unavailable | Varies | Unavailable | No executable adapter in this issue |
| NetCDF | Unavailable | Varies | Unavailable | No executable adapter in this issue |

`UNIFIED_RASTER_CAPABILITY_MATRIX` and `RASTER_FORMAT_MATURITY` use the canonical
`CloudNativeMaturity` vocabulary. Coverage/WCS operations reuse the bounded
clients from `@honua/sdk-js/coverages`; unsupported facade fields fail closed.
