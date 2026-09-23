import registryJson from "../../config/raster-source-registry.v1.json" with { type: "json" };

export type RasterRegistryMaturity = "supported" | "experimental" | "metadata-only" | "unavailable";
export type RasterRegistryServerStatus = RasterRegistryMaturity | "not-applicable";
export type RasterRegistrySessionKind = "cog" | "image-server" | "ogc-coverage" | "wcs";
export type RasterRegistryDiscoveryKind = "cog" | "ogc-coverages" | "wcs" | "zarr" | "netcdf";
export type RasterSourceIdentity =
  | "client-only-asset"
  | "honua-service"
  | "third-party-service"
  | "server-backed-api"
  | "server-backed-asset";

export interface RasterSourceRegistryEntry {
  readonly id: string;
  readonly sessionKind?: RasterRegistrySessionKind;
  readonly discoveryKind?: RasterRegistryDiscoveryKind;
  readonly deployment?: "honua" | "arcgis";
  readonly identity: RasterSourceIdentity;
  readonly client: RasterRegistryMaturity;
  readonly server: RasterRegistryServerStatus;
  readonly endToEnd: RasterRegistryMaturity;
  readonly operations: readonly string[];
  readonly discoveryOperations: readonly string[];
  readonly note: string;
}

export const RASTER_SOURCE_REGISTRY = Object.freeze(
  registryJson.sources.map((entry) =>
    Object.freeze({
      ...entry,
      operations: Object.freeze([...entry.operations]),
      discoveryOperations: Object.freeze([...entry.discoveryOperations]),
    }),
  ) as readonly RasterSourceRegistryEntry[],
);

export function rasterRegistryEntry(id: string): RasterSourceRegistryEntry {
  const entry = RASTER_SOURCE_REGISTRY.find((candidate) => candidate.id === id);
  if (!entry) throw new Error(`Unknown canonical raster source identity: ${id}`);
  return entry;
}

export function rasterSessionRegistryEntry(
  kind: RasterRegistrySessionKind,
  deployment?: "honua" | "arcgis",
): RasterSourceRegistryEntry {
  const matches = RASTER_SOURCE_REGISTRY.filter((entry) => entry.sessionKind === kind);
  const entry = deployment
    ? matches.find((candidate) => candidate.deployment === deployment)
    : matches.length === 1
      ? matches[0]
      : undefined;
  if (!entry) throw new Error(`Raster source ${kind} requires an explicit canonical deployment identity`);
  return entry;
}

export function rasterDiscoveryRegistryEntry(kind: RasterRegistryDiscoveryKind): RasterSourceRegistryEntry {
  const entry = RASTER_SOURCE_REGISTRY.find((candidate) => candidate.discoveryKind === kind);
  if (!entry) throw new Error(`Unknown canonical raster discovery kind: ${kind}`);
  return entry;
}
