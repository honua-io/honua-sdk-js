---
type: guide
title: Filtered-row data export
description: Download filtered public attributes as credential-free CSV and GeoJSON.
---

# Filtered-row data export

`@honua/app-platform/controls` provides `HonuaDataExportElement` and the
SSR-safe `serializeHonuaDataExport` helper. The control creates CSV and GeoJSON
files from the rows your application supplies. It never runs a query or fetches
additional pages.

```ts
import { defineHonuaDataExport, HonuaDataExportElement } from "@honua/app-platform/controls";

defineHonuaDataExport();
const control = new HonuaDataExportElement();
control.fields = ["parcel_id", "address", "assessed_value"];
control.maxRows = 10_000;
document.querySelector("#export")!.append(control);

// Supply the same result snapshot used by the filtered table and map.
// Repeat this assignment after applying attribute, spatial or time filters.
control.rows = filteredResult.features;
```

Declare an explicit allowlist of public attribute names in `fields`; hidden
attributes are excluded. CSV follows that column order, quotes cells and prefixes
spreadsheet formula triggers with an apostrophe. GeoJSON retains feature IDs and
null geometry. Input geometry must already use WGS84; known projected spatial
references, unsupported geometry and coordinates outside longitude/latitude
bounds fail. Geometry conversion uses the SDK's existing GeoJSON projection.

The default limit is 10,000 rows, configurable from 1 to 100,000. Overflow fails
with no file rather than silently truncating. If the query result is paginated,
collect the desired filtered pages before assigning `rows`, and describe that
scope in your application. There is no implicit server-wide export.

Every artifact uses the shared credential scanner and rejects sensitive keys
(including nested keys), credential-bearing URLs and recognizable secret values.
Failures show a fixed message that excludes source data. Empty results disable
both native buttons; successful downloads and failures update a live status.
Keyboard users can activate either button with Enter or Space. CSS parts are
`root`, `button` and `status`.

For host-managed downloads, call `serializeHonuaDataExport({ rows, fields,
format: "csv" })` or `control.createArtifact("geojson")`. Both return `text`,
`mimeType`, `filename` and `rowCount`, and throw on unsafe input. Browser downloads
emit `honua-data-export` with that safe artifact, or `honua-data-export-error`
with a fixed `{ message }`. GeoPackage is deferred.
