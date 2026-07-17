import type { CogDecoderFactory } from "@honua/sdk-js/cog";

/** Load the optional GeoTIFF.js adapter only for an explicitly opened COG. */
export function loadGeoTiffCogDecoderFactory(): Promise<CogDecoderFactory>;
