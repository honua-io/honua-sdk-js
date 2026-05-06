# Honua Cloud Spatial Analytics Workbench

Fixture-backed sample for issue #58 and the #66 indexed aggregation follow-up. It exercises AOI selection, process metadata discovery, async job state, materialized outputs, linked map/table/chart/filter state, workspace export, cache policy, and SDK-shaped indexed aggregation cells with category, histogram, stat, and grouped widgets.

The indexed aggregation lane intentionally uses a fixture response rather than decoding H3 or Quadbin cell ids in the browser. Cell ids stay opaque, widget rows come from `SpatialAggregationResult.metadata.widgets`, and viewport-specific cell results are treated as ad hoc spatial output rather than reusable metadata cache.

Run locally:

```sh
npm run demo:spatial-analytics
```
