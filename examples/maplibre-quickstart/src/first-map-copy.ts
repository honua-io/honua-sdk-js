import type { Query } from "@honua/sdk-js";

import type { FirstMapConfig } from "./first-map-config.js";

export function firstMapCopyCode(
  config: FirstMapConfig<Record<string, unknown>>,
  basemapStyle: string,
  query: Readonly<Omit<Query<Record<string, unknown>>, "signal">> = config.query,
): string {
  const sourceSelection = config.sourceId
    ? `const sourceId = ${literal(config.sourceId)};`
    : `const sourceId = inspection.defaultSourceId;
if (!sourceId) throw new Error("Choose one advertised source before mounting.");`;
  return `import maplibregl from "maplibre-gl";
import { createHonua } from "@honua/sdk-js";
import { explainDataToMapStrategy, mountSource } from "@honua/sdk-js/map";

const honua = createHonua();
const connection = await honua.connect({
  url: ${literal(config.endpoint)},
  protocol: ${literal(config.protocol)},
});
const inspection = await connection.inspect();
${sourceSelection}
const source = connection.source(sourceId);
const query = ${json(query)};
const plan = await explainDataToMapStrategy(source, {
  query,
  maxGeoJsonFeatures: ${config.maxFeatures},
});

const map = new maplibregl.Map({
  container: "map",
  style: ${literal(basemapStyle)},
  center: [-157.86, 21.31],
  zoom: 10,
});
await map.once("load");
const mounted = await mountSource(map, source, {
  query,
  strategy: plan.strategy,
  maxGeoJsonFeatures: ${config.maxFeatures},
  fitBounds: true,
  hover: true,
  popup: { factory: () => new maplibregl.Popup() },
});

let disposal;
const dispose = () =>
  (disposal ??= (async () => {
    const failures = [];
    for (const cleanup of [() => mounted.dispose(), () => map.remove(), () => honua.dispose()]) {
      try {
        await cleanup();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, "First Map cleanup failed.");
  })());
window.addEventListener("pagehide", () => void dispose(), { once: true });`;
}

function literal(value: string): string {
  return JSON.stringify(value).replaceAll("<", "\\u003c");
}

function json(value: unknown): string {
  return JSON.stringify(value, null, 2).replaceAll("<", "\\u003c");
}
