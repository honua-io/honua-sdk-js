import { SOURCE_MANIFESTS } from "./source-manifests.js";
import type {
  Bbox,
  OvertureExecutionPolicy,
  OvertureQueryInput,
  OvertureQueryPlan,
  OvertureSourceManifest,
} from "./types.js";

export class OverturePlanRejectedError extends Error {
  readonly code: "invalid-aoi" | "aoi-budget" | "row-budget" | "projection-budget" | "no-object";

  constructor(code: OverturePlanRejectedError["code"], message: string) {
    super(message);
    this.name = "OverturePlanRejectedError";
    this.code = code;
  }
}

export function parseAoi(value: string): Bbox {
  const values = value.split(",").map((part) => Number.parseFloat(part.trim()));
  if (values.length !== 4 || values.some((number) => !Number.isFinite(number))) {
    throw new OverturePlanRejectedError("invalid-aoi", "AOI must contain four finite comma-separated numbers.");
  }
  const [xmin, ymin, xmax, ymax] = values as [number, number, number, number];
  if (xmin < -180 || xmax > 180 || ymin < -90 || ymax > 90 || xmin >= xmax || ymin >= ymax) {
    throw new OverturePlanRejectedError("invalid-aoi", "AOI must be an ordered CRS84 envelope within world bounds.");
  }
  return [xmin, ymin, xmax, ymax];
}

export function planOvertureQuery(
  input: OvertureQueryInput,
  policy: OvertureExecutionPolicy,
  manifest: OvertureSourceManifest = SOURCE_MANIFESTS[input.lane],
): OvertureQueryPlan {
  const [xmin, ymin, xmax, ymax] = input.aoi;
  const aoiSquareDegrees = (xmax - xmin) * (ymax - ymin);
  if (aoiSquareDegrees > policy.maxAoiSquareDegrees) {
    throw new OverturePlanRejectedError(
      "aoi-budget",
      `AOI ${aoiSquareDegrees.toFixed(3)} deg² exceeds the ${policy.maxAoiSquareDegrees} deg² safety budget.`,
    );
  }
  if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > policy.maxRows) {
    throw new OverturePlanRejectedError("row-budget", `Row limit must be between 1 and ${policy.maxRows}.`);
  }
  const projection =
    input.lane === "live"
      ? ["id", "names", "categories", "confidence", "bbox"]
      : ["id", "name", "category", "confidence", "bbox"];
  if (projection.length > policy.maxProjectedColumns) {
    throw new OverturePlanRejectedError("projection-budget", "Projected columns exceed the execution policy.");
  }
  const selectedObjects = manifest.objects.filter((object) => intersects(input.aoi, object.bbox));
  if (selectedObjects.length === 0) {
    throw new OverturePlanRejectedError("no-object", "The pinned STAC manifest has no object intersecting this AOI.");
  }
  const cacheKey = JSON.stringify({
    release: manifest.release,
    schemaVersion: manifest.schemaVersion,
    objects: selectedObjects.map((object) => ({
      objectKey: object.objectKey,
      etag: object.etag,
      bytes: object.bytes,
    })),
    aoi: input.aoi,
    crs: manifest.crs,
    projection,
    category: input.category,
    limit: input.limit,
    memoryLimitMiB: policy.memoryLimitMiB,
    maxResultBytes: policy.maxResultBytes,
    maxEngineMs: policy.maxEngineMs,
    maxSourceProbeMs: policy.maxSourceProbeMs,
    allowFullHttpReads: policy.allowFullHttpReads,
  });
  return {
    lane: input.lane,
    aoi: input.aoi,
    aoiSquareDegrees,
    category: input.category,
    limit: input.limit,
    projection,
    selectedObjects,
    filesSelected: selectedObjects.length,
    filesAvailable: manifest.totalFiles,
    selectedObjectRows: selectedObjects.reduce((total, object) => total + object.rows, 0),
    selectedObjectRowGroups: selectedObjects.reduce((total, object) => total + object.rowGroups, 0),
    filePruning: input.lane === "live" ? "pinned-stac-manifest-bbox" : "fixture-manifest-bbox",
    rowGroupPruning: "bbox-predicate-planned-unverified",
    rangeReadPlan: input.lane === "live" ? "aws-fail-closed-range-io" : "local-buffer",
    cacheKey,
    memoryLimitMiB: policy.memoryLimitMiB,
    maxResultBytes: policy.maxResultBytes,
    maxEngineMs: policy.maxEngineMs,
    maxSourceProbeMs: policy.maxSourceProbeMs,
    allowFullHttpReads: policy.allowFullHttpReads,
    warning:
      input.lane === "live"
        ? "The pinned 16-item STAC manifest proves file selection and the query pushes a bbox predicate. Scheduled evidence observes browser range traffic; DuckDB-WASM does not expose rows scanned or row groups pruned, so those engine metrics remain unverified."
        : "The tiny committed file is intentionally buffered in full; the same AOI, projection, bbox predicate, limit, and result contract are used as the live lane.",
  };
}

function intersects(left: Bbox, right: Bbox): boolean {
  return left[0] <= right[2] && left[2] >= right[0] && left[1] <= right[3] && left[3] >= right[1];
}
