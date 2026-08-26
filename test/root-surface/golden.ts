/** Compile-only proof of the final root connect -> query -> explain -> mount workflow. */
import { type Query, createHonua, envelope } from "@honua/sdk-js";
import { maplibreRenderer } from "@honua/sdk-js/runtime";
import * as maplibregl from "maplibre-gl";

declare const map: maplibregl.Map;

const honua = createHonua();
const connection = await honua.connect({
  url: "https://example.test/ogc",
  protocol: "ogc-features",
});
await connection.inspect();
const query: Query<{ status: string }> = {
  where: "status = 'open'",
  spatialFilter: envelope(-158.5, 21.2, -157.6, 21.7),
  pagination: { limit: 100 },
};

const plan = await connection.explain(query);
const result = await connection.query(plan);
result.execution.terminal.state satisfies "completed";
const mounted = await connection.mount(map, { renderer: maplibreRenderer(maplibregl), query: plan });
await mounted.dispose();
await honua.dispose();

// Headless callers stop at connection.query(plan). Mounting an accepted plan is
// the renderer-oriented alternative terminal path shown here for surface proof.
