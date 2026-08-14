/** Runtime configuration for the React quickstart, resolved from Vite env. */
export interface ReactQuickstartConfig {
  /** Honua server origin. Empty string targets the same origin (fixture lane). */
  baseUrl: string;
  serviceId: string;
  layerId: number;
  where: string;
}

function readOptional(env: Record<string, string | undefined>, key: string): string | undefined {
  const value = env[key]?.trim();
  return value && value.length > 0 ? value : undefined;
}

function normalizeBaseUrl(value: string): string {
  return value.replace(/\/+$/, "");
}

export function resolveReactQuickstartConfig(env: Record<string, string | undefined>): ReactQuickstartConfig {
  const layerRaw = readOptional(env, "VITE_HONUA_REACT_LAYER_ID") ?? "0";
  const layerId = Number(layerRaw);
  return {
    baseUrl: normalizeBaseUrl(readOptional(env, "VITE_HONUA_REACT_BASE_URL") ?? ""),
    serviceId: readOptional(env, "VITE_HONUA_REACT_SERVICE_ID") ?? "natural-earth",
    layerId: Number.isInteger(layerId) ? layerId : 0,
    where: readOptional(env, "VITE_HONUA_REACT_WHERE") ?? "1=1",
  };
}
