/**
 * `honua query <service>/<layer>` — the workhorse verb.
 *
 * Pretty table by default; `--format geojson` (or `--json`) for machine output;
 * `--count` for a fast feature count. Spatial filtering via `--bbox`.
 *
 * @packageDocumentation
 */

import type { HonuaFeatureLayerQueryRequest } from "../../core/surfaces.js";
import type { HonuaTypedFeature } from "../../core/types.js";
import type { ParsedArgs } from "../args.js";
import { ArgError, getArray, getBoolean, getNumber, getString, parseBbox, parseServiceLayer } from "../args.js";
import { createClient } from "../client.js";
import type { CommandContext } from "../command.js";
import { printLine, renderJson, renderTable } from "../output.js";

const DEFAULT_LIMIT = 25;

function bboxToEnvelope(bbox: [number, number, number, number]): {
  geometry: Record<string, unknown>;
  geometryType: "esriGeometryEnvelope";
  spatialRel: "esriSpatialRelIntersects";
} {
  const [xmin, ymin, xmax, ymax] = bbox;
  return {
    geometry: { xmin, ymin, xmax, ymax, spatialReference: { wkid: 4326 } },
    geometryType: "esriGeometryEnvelope",
    spatialRel: "esriSpatialRelIntersects",
  };
}

/** Convert an Esri-style typed feature into a GeoJSON Feature. */
function toGeoJsonFeature(feature: HonuaTypedFeature<Record<string, unknown>>): Record<string, unknown> {
  const geom = feature.geometry as Record<string, unknown> | null | undefined;
  let geometry: Record<string, unknown> | null = null;
  if (geom) {
    if (typeof geom.x === "number" && typeof geom.y === "number") {
      geometry = { type: "Point", coordinates: [geom.x, geom.y] };
    } else if (Array.isArray(geom.rings)) {
      geometry = { type: "Polygon", coordinates: geom.rings };
    } else if (Array.isArray(geom.paths)) {
      geometry = { type: "MultiLineString", coordinates: geom.paths };
    } else if (Array.isArray(geom.points)) {
      geometry = { type: "MultiPoint", coordinates: geom.points };
    }
  }
  return { type: "Feature", geometry, properties: feature.attributes };
}

export async function queryCommand(parsed: ParsedArgs, ctx: CommandContext): Promise<void> {
  const ref = parsed.positionals[0];
  if (!ref) {
    throw new ArgError("Usage: honua query <service>/<layer> [--where ... --bbox ... --count]");
  }
  const { service, layer } = parseServiceLayer(ref);
  const client = createClient({ baseUrl: ctx.baseUrl, apiKey: ctx.apiKey });
  const featureLayer = client.featureLayer(service, layer);

  const where = getString(parsed, "where");
  const bboxRaw = getString(parsed, "bbox");
  const format = (getString(parsed, "format") ?? "table").toLowerCase();
  const asJson = getBoolean(parsed, "json") || format === "json";
  const asGeoJson = format === "geojson";

  // --count: short-circuit to a fast count. We issue the query directly with
  // `returnCountOnly` (rather than the SDK's `queryFeatureCount`, which pins
  // `outFields=OBJECTID` and 400s on servers whose OID field is named otherwise)
  // and read the `count` envelope.
  if (getBoolean(parsed, "count")) {
    const countResponse = (await featureLayer.queryFeatures({
      where: where ?? "1=1",
      outFields: "*",
      returnGeometry: false,
      extraParams: { returnCountOnly: true },
    })) as { count?: number; features?: unknown[] };
    const count = typeof countResponse.count === "number" ? countResponse.count : (countResponse.features?.length ?? 0);
    if (asJson) {
      printLine(renderJson({ service, layer, where: where ?? "1=1", count }));
    } else {
      printLine(`${count}`);
    }
    return;
  }

  const limit = getNumber(parsed, "limit") ?? DEFAULT_LIMIT;
  const outFields = getArray(parsed, "fields");

  const request: HonuaFeatureLayerQueryRequest = {
    where: where ?? "1=1",
    outFields: outFields.length > 0 ? outFields : "*",
    returnGeometry: asGeoJson,
    resultRecordCount: limit,
  };
  if (bboxRaw) {
    const env = bboxToEnvelope(parseBbox(bboxRaw));
    request.geometry = env.geometry;
    request.geometryType = env.geometryType;
    request.spatialRel = env.spatialRel;
    request.returnGeometry = asGeoJson;
  }

  const response = await featureLayer.queryFeatures(request);
  const features = (response.features ?? []) as HonuaTypedFeature<Record<string, unknown>>[];

  if (asGeoJson) {
    const collection = {
      type: "FeatureCollection",
      features: features.map(toGeoJsonFeature),
    };
    printLine(renderJson(collection));
    return;
  }

  if (asJson) {
    printLine(renderJson(response));
    return;
  }

  // Pretty table columns: honor an explicit --fields list, else the server's
  // declared field order, else the first row's attribute keys.
  const fieldNames =
    outFields.length > 0
      ? outFields
      : response.fields && response.fields.length > 0
        ? response.fields.map((f) => f.name)
        : features.length > 0
          ? Object.keys(features[0].attributes ?? {})
          : [];

  const rows = features.map((f) => {
    const attrs = (f.attributes ?? {}) as Record<string, unknown>;
    const row: Record<string, string | number | boolean | null> = {};
    for (const name of fieldNames) {
      const v = attrs[name];
      row[name] = v === null || v === undefined ? null : (v as string | number | boolean);
    }
    return row;
  });

  printLine(
    renderTable(
      rows,
      fieldNames.map((name) => ({ key: name, header: name })),
      { title: `${service}/${layer} — ${where ?? "1=1"}`, emptyText: "(no features matched)" },
    ),
  );
  if (rows.length > 0) {
    const more = response.exceededTransferLimit ? " (more available; raise --limit)" : "";
    printLine(`\n${rows.length} feature(s)${more}.`);
  }
}
