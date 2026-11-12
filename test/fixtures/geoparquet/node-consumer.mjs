import assert from "node:assert/strict";
import { PROTOCOL_DEFAULT_CAPABILITIES } from "@honua/sdk-js/contract";
import { envelope } from "@honua/sdk-js";
import { GeoparquetRuntime, geoparquetSource } from "@honua/sdk-js/geoparquet";
import { createNodeDuckDbDriver } from "@honua/sdk-js/geoparquet/node";

const runtime = new GeoparquetRuntime({ driverFactory: createNodeDuckDbDriver });
try {
  const source = geoparquetSource({
    id: "places", protocol: "geoparquet", locator: { url: process.argv[2] },
    capabilities: PROTOCOL_DEFAULT_CAPABILITIES.geoparquet,
  }, { runtime });
  const all = await source.query({});
  assert.equal(all.features.length, 8);
  assert.ok(all.features.every((feature) => feature.geometry?.type === "Point"));
  const filtered = await source.query({ spatialFilter: envelope(-157.86, 21.25, -157.8, 21.3) });
  assert.ok(filtered.features.length > 0 && filtered.features.length < 8);
  console.log(JSON.stringify({ rows: all.features.length, geometry: "Point", spatialRows: filtered.features.length }));
} finally {
  await runtime.dispose();
}
