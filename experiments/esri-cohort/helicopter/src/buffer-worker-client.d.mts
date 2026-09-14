import type { Geometry } from "geojson";

export function bufferInWorker(geometry: Geometry, signal: AbortSignal, makeWorker?: () => Worker): Promise<Geometry>;
