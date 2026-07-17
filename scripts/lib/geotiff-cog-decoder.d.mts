import type { CogDecoderFactory } from "@honua/sdk-js/cog";

/** Resolve a GeoTIFF resolution unit from authoritative GeoKey unit codes. */
export function geoTiffResolutionUnit(keys: Readonly<Record<string, unknown>>): string | undefined;

/** Load the optional GeoTIFF.js adapter only for an explicitly opened COG. */
export function loadGeoTiffCogDecoderFactory(): Promise<CogDecoderFactory>;
