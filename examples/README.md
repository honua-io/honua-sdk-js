# Examples

> **Native application path:** [gRPC for live data and edits; PMTiles, GeoParquet and COG through the CDN](../docs/native-data-paths.md). Start there for browser gRPC-Web setup, signed private URLs and regeneration after changes. OGC API and GeoServices REST examples below are compatibility workflows.

Each example here is the runnable demonstration of one SDK capability. Every example runs on committed
fixtures by default; "Fixture or live" means it can also point at a live server you configure. Each example's
README has its run, build and test commands.

Use-case demos built on the SDK (property and planning, 311, emergency preparedness, public works, analysis
workbench) are at [samples.honua.io](https://samples.honua.io). Track, support tier, lifecycle and evidence for
every example are in the generated [sample catalog](../docs/generated/sample-catalog.md).

## Start with the native path

Follow the [native data guide](../docs/native-data-paths.md) before selecting
a sample: it covers live gRPC queries, current edit support, browser setup,
public CDN files and private snapshot refresh. The protocol-specific examples
below preserve compatibility and coexistence coverage.

For public data, run [PMTiles](pmtiles-static/README.md),
[GeoParquet](overture-geoparquet/README.md), or
[COG imagery](imagery-cog-quickstart/README.md) first.

## Get started

| Example | What it shows | Data |
| --- | --- | --- |
| [maplibre-quickstart](./maplibre-quickstart/README.md) | First Map: connect to a layer, inspect the accepted query plan and mount it on MapLibre. | Fixture or live |
| [react-quickstart](./react-quickstart/README.md) | React provider, hooks and map components. | Fixture or live |
| [node-backend-quickstart](./node-backend-quickstart/README.md) | The protocol-neutral client in a Node service, with no browser dependencies. | Fixture or live |
| [oauth-signin](./oauth-signin/README.md) | Browser OAuth sign-in with PKCE and session lifecycle. | Fixture (mock identity provider) |

## Connect, inspect and migrate

| Example | What it shows | Data |
| --- | --- | --- |
| [service-explorer](./service-explorer/README.md) | Turns a service URL into inspected protocol capabilities, a bounded query and copyable map code. | Fixture or live |
| [migration-workbench](./migration-workbench/README.md) | Scans and rewrites ArcGIS JavaScript application source with auditable compatibility results. | Fixture |
| [geoservices-source-app](./geoservices-source-app/README.md) | The ArcGIS JavaScript source application the migration end-to-end tests run against; a test input, not a demo. | Fixture |

## Query and analyze data

| Example | What it shows | Data |
| --- | --- | --- |
| [columnar-query-quickstart](./columnar-query-quickstart/README.md) | Bounded Arrow (GeoArrow) query, decoding and cancellation, handed to MapLibre. | Fixture |
| [overture-geoparquet](./overture-geoparquet/README.md) | Bounded GeoParquet queries over Overture data with worker, range, memory and pruning evidence. | Fixture or live |
| [spatial-analytics-workbench](./spatial-analytics-workbench/README.md) | Indexed spatial aggregation with linked map, table and chart, and the Kepler workspace handoff. | Fixture or live |
| [geocoding-quickstart](./geocoding-quickstart/README.md) | Forward geocoding to a synchronized map pin with score and provenance. | Fixture |

## Maps and rendering

| Example | What it shows | Data |
| --- | --- | --- |
| [pmtiles-static](./pmtiles-static/README.md) | A static PMTiles archive with no Honua server. | Fixture |
| [temporal-playback](./temporal-playback/README.md) | Time playback with a class-breaks renderer and the legend it derives. | Fixture |

## Imagery and coverages

| Example | What it shows | Data |
| --- | --- | --- |
| [imagery-cog-quickstart](./imagery-cog-quickstart/README.md) | STAC search, direct COG rendering, imagery comparison, Terrain-RGB and elevation profiles. | Fixture or live |
| [stac-imagery-browser](./stac-imagery-browser/README.md) | STAC search by bounds and time with preview and a signed PMTiles handoff. | Fixture |
| [coverages-wcs-basic](./coverages-wcs-basic/README.md) | OGC API Coverages and WCS subsets rendered on MapLibre. | Fixture |

## Editing

| Example | What it shows | Data |
| --- | --- | --- |
| [sketch-editing](./sketch-editing/README.md) | terra-draw sketching with snapping, undo and edit submission. | Fixture |

## Realtime

| Example | What it shows | Data |
| --- | --- | --- |
| [realtime-incident-dashboard](./realtime-incident-dashboard/README.md) | Feature-stream subscriptions with reconciliation, degradation and a guarded edit lab. | Fixture or live |

## AI and agents

| Example | What it shows | Data |
| --- | --- | --- |
| [ai-spatial-app-builder](./ai-spatial-app-builder/README.md) | Typed agent proposals with policy validation, single-use approval and execution receipts. | Fixture or live |
| [nl-map-control](./nl-map-control/README.md) | Natural-language map control: reviewed queries executed on the map and in a table. | Fixture |

## Reference walkthroughs

Smaller references live under [docs/examples](../docs/examples): automatic source-to-map strategy selection,
offline regions, PMTiles publishing, and shared MapLibre and Cesium state.

`_kit/` holds the shared sample runner configuration and design tokens; `shared/` holds MapLibre helpers the
examples import.
