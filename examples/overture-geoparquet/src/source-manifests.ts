import type { OvertureExecutionPolicy, OvertureSourceManifest } from "./types.js";

export const OVERTURE_POLICY: OvertureExecutionPolicy = {
  maxRows: 200,
  maxProjectedColumns: 5,
  maxAoiSquareDegrees: 1,
  memoryLimitMiB: 256,
  renderBatchSize: 25,
  maxEngineMs: 30_000,
};

export const FIXTURE_MANIFEST: OvertureSourceManifest = {
  lane: "fixture",
  release: "fixture-places-v1",
  schemaVersion: "fixture-v1",
  stacUrl: null,
  totalFiles: 1,
  totalRows: 8,
  objects: [
    {
      id: "fixture",
      url: "overture-places.parquet",
      objectKey: "public/overture-places.parquet",
      bbox: [-158.6, 21, -157.5, 21.7],
      bytes: 1939,
      rows: 8,
      rowGroups: 1,
      etag: "sha256:611e669a2955069fe1aa838f33eb667c09b9d60f034df4c357349d91d58ef74c",
      lastModified: "fixture-commit",
    },
  ],
  attribution: "Synthetic Overture-shaped fixture; GERS-style identifiers are preserved for deterministic testing.",
  crs: "OGC:CRS84",
};

export const LIVE_MANIFEST: OvertureSourceManifest = {
  lane: "live",
  release: "2026-06-17.0",
  schemaVersion: "v1.17.0",
  stacUrl: "https://stac.overturemaps.org/2026-06-17.0/places/place/00000/00000.json",
  totalFiles: 16,
  totalRows: 75_642_289,
  objects: [
    {
      id: "00000",
      url: "https://overturemaps-us-west-2.s3.us-west-2.amazonaws.com/release/2026-06-17.0/theme=places/type=place/part-00000-6c973aba-862d-590f-a178-70bcd31cde1c-c000.zstd.parquet",
      objectKey:
        "release/2026-06-17.0/theme=places/type=place/part-00000-6c973aba-862d-590f-a178-70bcd31cde1c-c000.zstd.parquet",
      bbox: [-179.99806213378906, -84.83818054199219, -76.6320571899414, 28.47271728515625],
      bytes: 656_568_610,
      rows: 4_717_270,
      rowGroups: 256,
      etag: "14bf817df11b311fd2e9183c0ca8a8ec-10",
      lastModified: "2026-06-17T17:24:54.000Z",
    },
  ],
  attribution:
    "Overture Maps Foundation Open Map Data; source attribution remains available in each feature's sources column.",
  crs: "OGC:CRS84",
};

export const SOURCE_MANIFESTS = {
  fixture: FIXTURE_MANIFEST,
  live: LIVE_MANIFEST,
} as const;
