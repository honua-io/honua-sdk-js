import type { Plugin } from "vite";
import type { DuckDbExtensionProvenance } from "../overture-geoparquet/extension-cache.mjs";
export const SPATIAL_EXTENSION: DuckDbExtensionProvenance;
export function queryEngineAssets(): Promise<Plugin>;
