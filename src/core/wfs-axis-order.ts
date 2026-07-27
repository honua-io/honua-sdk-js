/**
 * Authority-axis resolution for WFS 2.0 / GML 3.2 coordinates.
 *
 * WFS 2.0 uses the axis order defined by the referenced CRS. That order is a
 * property of the authority definition, not of the identifier spelling:
 * `EPSG:4326`, its OGC URN, and its OGC HTTP URI therefore resolve identically.
 *
 * The registry is intentionally closed. Shipping an unknown authority code in
 * canonical x/y order can query or edit the wrong area, so callers must fail
 * before emitting wire coordinates when no reviewed definition is available.
 */

import { HonuaWfsProtocolError } from "./wfs-protocol-error.js";

export type WfsAxisOrder = "xy" | "yx";

interface AuthorityAxisDefinition {
  readonly authority: "EPSG" | "OGC";
  readonly code: string;
  readonly order: WfsAxisOrder;
  readonly axes: readonly [string, string];
}

/**
 * Reviewed definitions from the EPSG Geodetic Parameter Dataset and the OGC
 * CRS registry. Entries carry both axis names so this remains a CRS registry,
 * rather than a protocol-specific list of codes to swap.
 */
const AUTHORITY_AXIS_DEFINITIONS: readonly AuthorityAxisDefinition[] = [
  { authority: "OGC", code: "CRS84", order: "xy", axes: ["longitude", "latitude"] },

  { authority: "EPSG", code: "4019", order: "yx", axes: ["geodetic latitude", "geodetic longitude"] },
  { authority: "EPSG", code: "4152", order: "yx", axes: ["geodetic latitude", "geodetic longitude"] },
  { authority: "EPSG", code: "4167", order: "yx", axes: ["geodetic latitude", "geodetic longitude"] },
  { authority: "EPSG", code: "4203", order: "yx", axes: ["geodetic latitude", "geodetic longitude"] },
  { authority: "EPSG", code: "4214", order: "yx", axes: ["geodetic latitude", "geodetic longitude"] },
  { authority: "EPSG", code: "4258", order: "yx", axes: ["geodetic latitude", "geodetic longitude"] },
  { authority: "EPSG", code: "4267", order: "yx", axes: ["geodetic latitude", "geodetic longitude"] },
  { authority: "EPSG", code: "4269", order: "yx", axes: ["geodetic latitude", "geodetic longitude"] },
  { authority: "EPSG", code: "4277", order: "yx", axes: ["geodetic latitude", "geodetic longitude"] },
  { authority: "EPSG", code: "4283", order: "yx", axes: ["geodetic latitude", "geodetic longitude"] },
  { authority: "EPSG", code: "4326", order: "yx", axes: ["geodetic latitude", "geodetic longitude"] },
  { authority: "EPSG", code: "4490", order: "yx", axes: ["geodetic latitude", "geodetic longitude"] },
  { authority: "EPSG", code: "4612", order: "yx", axes: ["geodetic latitude", "geodetic longitude"] },
  { authority: "EPSG", code: "4617", order: "yx", axes: ["geodetic latitude", "geodetic longitude"] },
  { authority: "EPSG", code: "4618", order: "yx", axes: ["geodetic latitude", "geodetic longitude"] },
  { authority: "EPSG", code: "4674", order: "yx", axes: ["geodetic latitude", "geodetic longitude"] },
  { authority: "EPSG", code: "4759", order: "yx", axes: ["geodetic latitude", "geodetic longitude"] },
  { authority: "EPSG", code: "4979", order: "yx", axes: ["geodetic latitude", "geodetic longitude"] },
  { authority: "EPSG", code: "6668", order: "yx", axes: ["geodetic latitude", "geodetic longitude"] },
  { authority: "EPSG", code: "7844", order: "yx", axes: ["geodetic latitude", "geodetic longitude"] },

  { authority: "EPSG", code: "2193", order: "yx", axes: ["northing", "easting"] },
  { authority: "EPSG", code: "3035", order: "yx", axes: ["northing", "easting"] },
  { authority: "EPSG", code: "3413", order: "xy", axes: ["easting", "northing"] },
  { authority: "EPSG", code: "3857", order: "xy", axes: ["easting", "northing"] },
  { authority: "EPSG", code: "27700", order: "xy", axes: ["easting", "northing"] },
  { authority: "EPSG", code: "28992", order: "xy", axes: ["easting", "northing"] },
];

const AUTHORITY_AXIS_REGISTRY: ReadonlyMap<string, AuthorityAxisDefinition> = new Map(
  AUTHORITY_AXIS_DEFINITIONS.map((definition) => [`${definition.authority}:${definition.code}`, definition] as const),
);

// Reviewed EPSG projected-CRS series whose definitions all use easting,
// northing. Keeping series here avoids hundreds of repetitive registry rows
// while retaining a closed set of authority definitions.
const EPSG_EASTING_NORTHING_SERIES: readonly [number, number][] = [
  [25828, 25838], // ETRS89 / UTM zones 28N-38N
  [26901, 26923], // NAD83 / UTM zones 1N-23N
  [28348, 28358], // GDA94 / MGA zones 48-58
  [32601, 32660], // WGS 84 / UTM zones 1N-60N
  [32701, 32760], // WGS 84 / UTM zones 1S-60S
];

interface AuthorityIdentity {
  authority: string;
  code: string;
}

function parseAuthorityIdentity(srsName: string): AuthorityIdentity | undefined {
  const value = srsName.trim();

  if (/^CRS:?84$/i.test(value) || /^OGC:CRS:?84$/i.test(value)) {
    return { authority: "OGC", code: "CRS84" };
  }

  const urn = value.match(/^urn:(?:ogc|x-ogc):def:crs:([^:]+):[^:]*:([^:\s]+)$/i);
  if (urn) {
    return { authority: urn[1].toUpperCase(), code: normalizeAuthorityCode(urn[2]) };
  }

  const http = value.match(/^https?:\/\/www\.opengis\.net\/def\/crs\/([^/]+)\/[^/]+\/([^/?#]+)\/?$/i);
  if (http) {
    return { authority: http[1].toUpperCase(), code: normalizeAuthorityCode(http[2]) };
  }

  const legacyEpsgHttp = value.match(/^https?:\/\/www\.opengis\.net\/gml\/srs\/epsg\.xml#(\d+)$/i);
  if (legacyEpsgHttp) {
    return { authority: "EPSG", code: legacyEpsgHttp[1] };
  }

  const shorthand = value.match(/^([A-Z][A-Z0-9_-]*):([^:/\s]+)$/i);
  if (shorthand) {
    return { authority: shorthand[1].toUpperCase(), code: normalizeAuthorityCode(shorthand[2]) };
  }

  return undefined;
}

function normalizeAuthorityCode(code: string): string {
  return /^CRS:?84$/i.test(code) ? "CRS84" : code.toUpperCase();
}

function resolveRegisteredAxisOrder(identity: AuthorityIdentity): WfsAxisOrder | undefined {
  const registered = AUTHORITY_AXIS_REGISTRY.get(`${identity.authority}:${identity.code}`);
  if (registered) return registered.order;

  if (identity.authority !== "EPSG" || !/^\d+$/.test(identity.code)) return undefined;
  const code = Number(identity.code);
  if (EPSG_EASTING_NORTHING_SERIES.some(([first, last]) => code >= first && code <= last)) {
    return "xy";
  }
  return undefined;
}

/**
 * Resolve a WFS/GML wire axis order. An omitted CRS retains canonical x/y;
 * every explicit CRS must resolve through the closed authority registry.
 */
export function requireWfsAxisOrder(srsName: string | undefined): WfsAxisOrder {
  if (srsName === undefined) return "xy";
  const identity = parseAuthorityIdentity(srsName);
  const order = identity ? resolveRegisteredAxisOrder(identity) : undefined;
  if (order) return order;
  throw new HonuaWfsProtocolError("unknown-axis-order", "WFS axis order cannot be determined for the requested CRS");
}
