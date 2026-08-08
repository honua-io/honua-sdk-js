# Unified raster capability matrix

The `@honua/sdk-js/raster` facade records client, server, and end-to-end status
separately. `supported` is not inferred from a filename, endpoint family, or
injected adapter.

| Source | Client | Server | End to end | Executable operations |
| --- | --- | --- | --- | --- |
| Direct COG | Experimental | Unavailable | Experimental | Structural inspect, bounded pixel window, bands, no-data statistics, histogram, value inspect, MapLibre mount |
| ImageServer | Supported | Supported | Supported | Metadata, bounded bbox render, bands, rendering rule, identify, MapLibre/deck.gl image handoff |
| OGC API Coverages | Metadata only | Experimental | Unavailable | Descriptor/plan; execution requires an advertised-link executor |
| WCS | Metadata only | Experimental | Unavailable | Descriptor/plan; execution requires a capabilities-derived executor |
| Zarr | Metadata only | Varies | Unavailable | No executable adapter in this issue |
| NetCDF | Metadata only | Varies | Unavailable | No executable adapter in this issue |

`UNIFIED_RASTER_CAPABILITY_MATRIX` and `RASTER_FORMAT_MATURITY` are the public,
machine-readable forms of this table. Application-supplied coverage adapters do
not mutate the built-in support claim.

