/**
 * Remote tile / imagery source projection (REQ-002, REQ-006).
 *
 * A supported remote source is handed to Kepler as a reference, never
 * materialized through the SDK: raster tiles and styles become a Kepler custom
 * basemap entry, vector tiles become a Kepler tileset dataset descriptor.
 * Because those descriptors are serialized into saved maps, the projection is
 * fail-closed on credentials: a signed URL, a `?key=`/`?access_token=` style
 * parameter, or userinfo credentials are rejected outright with
 * `credential-leak` and must be applied by a host transport interceptor
 * instead.
 *
 * @experimental
 * @module
 */

import { keplerDatasetMetadata, keplerIngestionDiagnostic, normalizeKeplerProvenance } from "./ingest.js";
import { assertCredentialFreeUrl } from "./redaction.js";
import type { KeplerFidelityLoss, KeplerRemoteSourceProjection, KeplerRemoteSourceProjectionRequest } from "./types.js";
import { HonuaKeplerBridgeError } from "./types.js";

function requireZoom(value: number | undefined, label: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || value < 0 || value > 30) {
    throw new HonuaKeplerBridgeError("invalid-request", `${label} must be an integer zoom level between 0 and 30.`, {
      label,
      value,
    });
  }
  return value;
}

/**
 * Project a supported remote tile/imagery source into Kepler's configuration
 * model. Returns either a `mapStyles` entry (raster tiles / style documents) or
 * a tileset dataset descriptor (vector tiles).
 */
export function projectRemoteSourceToKepler(
  request: KeplerRemoteSourceProjectionRequest,
): KeplerRemoteSourceProjection {
  if (typeof request.datasetId !== "string" || request.datasetId.trim().length === 0) {
    throw new HonuaKeplerBridgeError(
      "invalid-request",
      "A Kepler remote-source projection requires a non-empty datasetId.",
    );
  }
  const provenance = normalizeKeplerProvenance(request.provenance);
  const source = request.source;
  if (typeof source !== "object" || source === null) {
    throw new HonuaKeplerBridgeError(
      "invalid-request",
      "A Kepler remote-source projection requires a source descriptor.",
    );
  }
  const minZoom = requireZoom(source.minZoom, "source.minZoom");
  const maxZoom = requireZoom(source.maxZoom, "source.maxZoom");
  const losses: KeplerFidelityLoss[] = [];
  const label = request.label ?? request.datasetId;

  if (source.kind === "raster-tiles" || source.kind === "style") {
    const url = source.kind === "style" ? source.url : source.tiles?.[0];
    if (typeof url !== "string" || url.length === 0) {
      throw new HonuaKeplerBridgeError(
        "invalid-request",
        source.kind === "style"
          ? "A style source requires source.url."
          : "A raster-tiles source requires at least one source.tiles template.",
      );
    }
    assertCredentialFreeUrl(url, `source.${source.kind === "style" ? "url" : "tiles[0]"}`);
    if (source.kind === "raster-tiles" && (source.tiles?.length ?? 0) > 1) {
      for (const template of source.tiles ?? []) assertCredentialFreeUrl(template, "source.tiles[]");
      losses.push({
        kind: "unsupported-column-layout",
        detail: "Kepler custom basemaps accept a single style/tile URL; additional tile templates were not projected.",
      });
    }
    if (source.tileSize !== undefined && source.tileSize !== 512) {
      losses.push({
        kind: "unsupported-column-layout",
        detail: `Kepler custom basemaps do not carry a tileSize override; the declared ${source.tileSize}px hint was dropped.`,
      });
    }
    const diagnostic = keplerIngestionDiagnostic({
      strategy: "remote-basemap-style",
      rows: 0,
      fields: 0,
      geoJsonBytes: 0,
      losses,
    });
    return Object.freeze({
      target: "map-style",
      mapStyle: Object.freeze({
        id: request.datasetId,
        label,
        url,
        custom: true,
        ...(minZoom === undefined ? {} : { minZoom }),
        ...(maxZoom === undefined ? {} : { maxZoom }),
      }),
      diagnostic,
    });
  }

  if (source.kind === "vector-tiles") {
    const metadataUrl = source.url;
    const dataUrl = source.tiles?.[0];
    if (typeof metadataUrl !== "string" && typeof dataUrl !== "string") {
      throw new HonuaKeplerBridgeError(
        "invalid-request",
        "A vector-tiles source requires source.url (tileset metadata) or source.tiles[0] (tile template).",
      );
    }
    if (typeof metadataUrl === "string") assertCredentialFreeUrl(metadataUrl, "source.url");
    if (typeof dataUrl === "string") assertCredentialFreeUrl(dataUrl, "source.tiles[0]");
    const diagnostic = keplerIngestionDiagnostic({
      strategy: "remote-vector-tileset",
      rows: 0,
      fields: 0,
      geoJsonBytes: 0,
      losses,
    });
    return Object.freeze({
      target: "tileset",
      tileset: Object.freeze({
        info: Object.freeze({ id: request.datasetId, label, type: "vectorTile" as const }),
        metadata: Object.freeze({
          ...keplerDatasetMetadata({
            provenance,
            crs: Object.freeze({
              requested: "EPSG:3857",
              applied: "EPSG:3857",
              reprojected: false,
              reason: "Kepler renders remote vector tiles in the tileset's own Web Mercator tiling scheme.",
            }),
            ingestion: diagnostic,
            fields: [],
          }),
          ...(typeof metadataUrl === "string" ? { tilesetMetadataUrl: metadataUrl } : {}),
          ...(typeof dataUrl === "string" ? { tilesetDataUrl: dataUrl } : {}),
        }),
      }),
      diagnostic,
    });
  }

  throw new HonuaKeplerBridgeError("invalid-request", `Unsupported remote source kind "${String(source.kind)}".`, {
    kind: source.kind,
  });
}
