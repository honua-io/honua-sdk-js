---
type: guide
title: Catalog dataset picker
description: Search approved OGC Records catalogs and share one selected source with the map, table, and charts.
---

# Catalog dataset picker

> **Native application path:** [gRPC for live data and edits; PMTiles, GeoParquet and COG through the CDN](native-data-paths.md). Start there for browser gRPC-Web setup, signed private URLs and regeneration after changes. OGC API and GeoServices REST examples below are compatibility workflows.

`@honua/app-platform/controls` exports `HonuaCatalogPicker`,
`createCatalogSelectionResolver`, `HonuaCatalogPickerElement`, and
`defineHonuaCatalogPicker`. Register `honua-catalog-picker` explicitly, or use
`registerComponent("controls.catalog-picker")`. Imports are safe in Node and
SSR; discovery and map adapters are supplied by the application.

```ts doc-test=skip reason="application supplies its authenticated client, map, and approved connection options"
import {
  HonuaCatalogPicker, defineHonuaCatalogPicker, createCatalogSelectionResolver,
} from "@honua/app-platform/controls";

const picker = new HonuaCatalogPicker({
  client,
  collectionId: "datasets",
  resolve: createCatalogSelectionResolver({
    connect, mountSource, map,
    // Map approved record IDs to connection options in application code.
    // Return undefined for records the workspace cannot open.
    optionsFor: record => approvedConnections.get(String(record.id)),
  }),
});
defineHonuaCatalogPicker();
const control = document.createElement("honua-catalog-picker");
control.picker = picker;
control.addEventListener("honua-catalog-select", event => {
  const { source, dataset, layer } = event.detail;
  analysisTable.source = source;
  analysisChart.source = source;
  // layer.sourceId/layer.layerIds identify the mounted map representation.
});
document.querySelector("#catalog").append(control);
```

Pass the existing `connect` discovery function and `mountSource` map bridge from
your application's data integration. The resolver returns the connection's
`dataset` and the exact `Source` passed to `mountSource`, so consumers share the
same analysis identity. Connection options and authorization stay in application
code. Catalog links are never automatically followed as connection endpoints.

Search is explicit and requests at most 25 records. Queries are trimmed and
limited to 256 characters; newer searches cancel stale requests. The native
search form and result buttons support keyboard use, with live loading, empty,
error, unsupported and selected messages. Record titles and descriptions render
as text. Errors display fixed messages rather than upstream connection details.

The picker owns the layer returned by its resolver. It retains the existing
selection during searches and failed or unsupported replacement attempts. A
successful replacement removes the preceding layer; cancelled late resolutions
are removed immediately. A custom resolver must return a layer handle whose
`remove()` releases only its own resources. Use unique map IDs when mounting
concurrent selections. Call `picker.dispose()` when the workspace closes; it
aborts pending work and removes the selected layer exactly once. Disconnecting
the view only unsubscribes it, allowing the application to retain the model.

The selection event bubbles across the shadow boundary and contains live source
and layer objects for in-process consumers. Do not serialize the event as an
export or log connection objects. `state`, `subscribe`, `search`, and `select`
are also available without the custom element. CSS parts are `root`, `search`,
`status`, and `results`; typography and color inherit from the host application.
