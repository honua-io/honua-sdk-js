/**
 * Shared resolvers that turn a `HonuaWmsSourceSpecification` /
 * `HonuaWmtsSourceSpecification` into a runtime SDK handle. Used by both
 * `src/style/factory.ts` (`createSources`) and `src/map/honua-map.ts`
 * (`HonuaMap.getSource`) so the URL-parsing and handle-selection rules
 * stay identical between the two surfaces.
 *
 * @module
 */

import type { HonuaClient } from "../core/client.js";
import { HonuaWms, HonuaWmsLayer } from "../core/wms.js";
import { HonuaWmts, HonuaWmtsTileset } from "../core/wmts.js";
import type { HonuaWmsSourceSpecification, HonuaWmtsSourceSpecification } from "./specification.js";

/**
 * Match the canonical Esri MapServer WMS/WMTS endpoint shape
 * (`/rest/services/<name>/MapServer/{WMS|WMTS}`) and the OGC web-map
 * shape (`/ogc/services/<name>/{wms|wmts}`) so we can lift the service
 * id out of the URL when the spec did not carry it explicitly.
 */
const HONUA_WMS_WMTS_URL_RE =
  /\/(?:rest\/services\/([^/?#]+)\/MapServer\/(?:WMS|WMTS)|ogc\/services\/([^/?#]+)\/(?:wms|wmts))/i;

/**
 * Extract the service id from a WMS/WMTS endpoint URL. Returns
 * `undefined` if the URL does not match a known service shape so the
 * caller can fall back to the spec's explicit `serviceId` (or surface a
 * typed error).
 */
export function parseWmsServiceIdFromUrl(url: string): string | undefined {
  const match = HONUA_WMS_WMTS_URL_RE.exec(url);
  if (!match) return undefined;
  const id = match[1] ?? match[2];
  if (!id) return undefined;
  try {
    return decodeURIComponent(id);
  } catch {
    return id;
  }
}

/**
 * Resolve a `honua-wms` source spec to a runtime handle. Returns the
 * layer-bound `HonuaWmsLayer` when the spec pins a single LAYER (and
 * optional STYLE); otherwise returns the service-level `HonuaWms`
 * handle for multi-layer composites.
 */
export function resolveWmsSpec(client: HonuaClient, spec: HonuaWmsSourceSpecification): HonuaWms | HonuaWmsLayer {
  const serviceId = spec.serviceId ?? parseWmsServiceIdFromUrl(spec.url);
  if (!serviceId) {
    throw new Error("honua-wms source requires either serviceId or a URL containing the service id");
  }
  const root = new HonuaWms({ client, serviceId });
  if (typeof spec.layers === "string" && spec.layers.length > 0) {
    const opts: { client: HonuaClient; serviceId: string; layerName: string; defaultStyleId?: string } = {
      client,
      serviceId,
      layerName: spec.layers,
    };
    if (typeof spec.styles === "string" && spec.styles.length > 0) {
      opts.defaultStyleId = spec.styles;
    }
    return new HonuaWmsLayer(opts);
  }
  return root;
}

/**
 * Resolve a `honua-wmts` source spec to a runtime handle. Returns the
 * (layer × style × TileMatrixSet) `HonuaWmtsTileset` when the spec
 * pins a single layer; otherwise returns the service-level `HonuaWmts`
 * handle.
 */
export function resolveWmtsSpec(client: HonuaClient, spec: HonuaWmtsSourceSpecification): HonuaWmts | HonuaWmtsTileset {
  const serviceId = spec.serviceId ?? parseWmsServiceIdFromUrl(spec.url);
  if (!serviceId) {
    throw new Error("honua-wmts source requires either serviceId or a URL containing the service id");
  }
  const root = new HonuaWmts({ client, serviceId });
  if (typeof spec.layer === "string" && spec.layer.length > 0) {
    const style = spec.style ?? "default";
    const tms = spec.tileMatrixSet ?? "WebMercatorQuad";
    return new HonuaWmtsTileset({
      client,
      serviceId,
      layerName: spec.layer,
      styleId: style,
      tileMatrixSetId: tms,
    });
  }
  return root;
}
