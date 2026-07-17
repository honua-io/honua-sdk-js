import { canonicalStringify, toJsonValue } from "@honua/sdk-js/query-planner";

import { SOURCE_MANIFESTS } from "./source-manifests.js";
import type {
  Bbox,
  OvertureExecutionPolicy,
  OvertureLane,
  OvertureObjectManifest,
  OvertureQueryInput,
  OvertureQueryPlan,
  OvertureSourceManifest,
} from "./types.js";

export const OVERTURE_HARD_LIMITS = {
  maxRows: 1_000,
  maxProjectedColumns: 16,
  maxAoiSquareDegrees: 4,
  memoryLimitMiB: 512,
  maxResultBytes: 16 * 1024 * 1024,
  renderBatchSize: 500,
  maxEngineMs: 120_000,
  maxSourceProbeMs: 30_000,
} as const;

const LIVE_HOST = "overturemaps-us-west-2.s3.us-west-2.amazonaws.com";
const CATEGORY_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const LIVE_ETAG_PATTERN = /^[0-9a-f]{32}(?:-[1-9][0-9]*)?$/;
const FIXTURE_ETAG_PATTERN = /^sha256:[0-9a-f]{64}$/;
const PROJECTIONS = {
  fixture: ["id", "name", "category", "confidence", "bbox"],
  live: ["id", "names", "categories", "confidence", "bbox"],
} as const;

export class OverturePlanRejectedError extends Error {
  readonly code:
    | "invalid-aoi"
    | "invalid-input"
    | "invalid-policy"
    | "invalid-manifest"
    | "invalid-plan"
    | "aoi-budget"
    | "row-budget"
    | "projection-budget"
    | "no-object"
    | "file-budget";

  constructor(code: OverturePlanRejectedError["code"], message: string) {
    super(message);
    this.name = "OverturePlanRejectedError";
    this.code = code;
  }
}

export function parseAoi(value: string): Bbox {
  const values = value.split(",").map((part) => (part.trim() === "" ? Number.NaN : Number(part.trim())));
  return validateBbox(values, "AOI");
}

export function planOvertureQuery(
  input: OvertureQueryInput,
  policy: OvertureExecutionPolicy,
  suppliedManifest?: OvertureSourceManifest,
): OvertureQueryPlan {
  assertPlainRecord(input, "Query input", "invalid-input");
  const lane = validateLane(input.lane);
  const aoi = validateBbox(input.aoi, "AOI");
  const category = validateCategory(input.category);
  const validatedPolicy = validateOverturePolicy(policy);
  const manifest = validateOvertureManifest(suppliedManifest ?? SOURCE_MANIFESTS[lane]);
  if (manifest.lane !== lane) {
    throw new OverturePlanRejectedError("invalid-manifest", "Source manifest lane must match the query lane.");
  }
  return buildPlan({ lane, aoi, category, limit: input.limit }, validatedPolicy, manifest);
}

/** Rebuild and compare every plan field before any exact evidence is emitted. */
export function validateOvertureQueryPlan(
  plan: OvertureQueryPlan,
  suppliedManifest: OvertureSourceManifest,
): OvertureQueryPlan {
  assertPlainRecord(plan, "Workflow plan", "invalid-plan");
  const manifest = validateOvertureManifest(suppliedManifest);
  const policy = validateOverturePolicy(plan.policy);
  let expected: OvertureQueryPlan;
  try {
    expected = planOvertureQuery(
      {
        lane: validateLane(plan.lane),
        aoi: validateBbox(plan.aoi, "Plan AOI"),
        category: validateCategory(plan.category),
        limit: plan.limit,
      },
      policy,
      manifest,
    );
  } catch (cause) {
    if (cause instanceof OverturePlanRejectedError) {
      throw new OverturePlanRejectedError("invalid-plan", `Workflow plan is invalid: ${cause.message}`);
    }
    throw cause;
  }
  try {
    if (canonicalStringify(toJsonValue(plan)) !== canonicalStringify(toJsonValue(expected))) {
      throw new OverturePlanRejectedError(
        "invalid-plan",
        "Workflow plan is internally inconsistent with its AOI, manifest, and policy snapshot.",
      );
    }
  } catch (cause) {
    if (cause instanceof OverturePlanRejectedError) throw cause;
    throw new OverturePlanRejectedError("invalid-plan", "Workflow plan must be a finite plain JSON value.");
  }
  return expected;
}

export function validateOverturePolicy(policy: OvertureExecutionPolicy): OvertureExecutionPolicy {
  assertPlainRecord(policy, "Execution policy", "invalid-policy");
  boundedInteger(policy.maxRows, "maxRows", OVERTURE_HARD_LIMITS.maxRows);
  boundedInteger(policy.maxProjectedColumns, "maxProjectedColumns", OVERTURE_HARD_LIMITS.maxProjectedColumns);
  boundedNumber(policy.maxAoiSquareDegrees, "maxAoiSquareDegrees", OVERTURE_HARD_LIMITS.maxAoiSquareDegrees);
  boundedInteger(policy.memoryLimitMiB, "memoryLimitMiB", OVERTURE_HARD_LIMITS.memoryLimitMiB);
  boundedInteger(policy.maxResultBytes, "maxResultBytes", OVERTURE_HARD_LIMITS.maxResultBytes);
  boundedInteger(policy.renderBatchSize, "renderBatchSize", OVERTURE_HARD_LIMITS.renderBatchSize);
  boundedInteger(policy.maxEngineMs, "maxEngineMs", OVERTURE_HARD_LIMITS.maxEngineMs);
  boundedInteger(policy.maxSourceProbeMs, "maxSourceProbeMs", OVERTURE_HARD_LIMITS.maxSourceProbeMs);
  if (policy.renderBatchSize > policy.maxRows) {
    throw new OverturePlanRejectedError("invalid-policy", "renderBatchSize cannot exceed maxRows.");
  }
  if (policy.maxResultBytes > policy.memoryLimitMiB * 1024 * 1024) {
    throw new OverturePlanRejectedError("invalid-policy", "maxResultBytes cannot exceed the worker memory ceiling.");
  }
  if (policy.allowFullHttpReads !== false) {
    throw new OverturePlanRejectedError("invalid-policy", "Full HTTP reads must remain disabled.");
  }
  return Object.freeze({
    maxRows: policy.maxRows,
    maxProjectedColumns: policy.maxProjectedColumns,
    maxAoiSquareDegrees: policy.maxAoiSquareDegrees,
    memoryLimitMiB: policy.memoryLimitMiB,
    maxResultBytes: policy.maxResultBytes,
    renderBatchSize: policy.renderBatchSize,
    maxEngineMs: policy.maxEngineMs,
    maxSourceProbeMs: policy.maxSourceProbeMs,
    allowFullHttpReads: false,
  });
}

export function validateOvertureManifest(manifest: OvertureSourceManifest): OvertureSourceManifest {
  assertPlainRecord(manifest, "Source manifest", "invalid-manifest");
  const lane = validateLane(manifest.lane, "invalid-manifest");
  nonEmptyString(manifest.release, "release", 64, "invalid-manifest");
  nonEmptyString(manifest.schemaVersion, "schemaVersion", 64, "invalid-manifest");
  nonEmptyString(manifest.attribution, "attribution", 1_024, "invalid-manifest");
  if (manifest.crs !== "OGC:CRS84") {
    throw new OverturePlanRejectedError("invalid-manifest", "Source manifest CRS must be OGC:CRS84.");
  }
  boundedInteger(manifest.totalFiles, "totalFiles", 10_000, "invalid-manifest");
  boundedInteger(manifest.totalRows, "totalRows", Number.MAX_SAFE_INTEGER, "invalid-manifest");
  boundedInteger(manifest.totalBytes, "totalBytes", Number.MAX_SAFE_INTEGER, "invalid-manifest");
  boundedInteger(manifest.totalRowGroups, "totalRowGroups", 1_000_000, "invalid-manifest");
  if (!Array.isArray(manifest.objects) || manifest.objects.length !== manifest.totalFiles) {
    throw new OverturePlanRejectedError("invalid-manifest", "Manifest totalFiles must equal its object count.");
  }
  if (lane === "fixture") {
    if (manifest.stacUrl !== null) {
      throw new OverturePlanRejectedError("invalid-manifest", "Fixture manifests cannot claim a STAC URL.");
    }
  } else {
    validateHttpsUrl(manifest.stacUrl, "STAC URL");
  }

  const identities = new Set<string>();
  const objects = manifest.objects.map((object, index) => {
    const validated = validateOvertureObjectManifest(object, lane, index);
    for (const identity of [validated.id, validated.objectKey, validated.url, validated.etag]) {
      if (identities.has(identity)) {
        throw new OverturePlanRejectedError("invalid-manifest", "Manifest object identities must be unique.");
      }
      identities.add(identity);
    }
    return validated;
  });
  const totalRows = exactSum(objects, "rows");
  const totalBytes = exactSum(objects, "bytes");
  const totalRowGroups = exactSum(objects, "rowGroups");
  if (
    totalRows !== manifest.totalRows ||
    totalBytes !== manifest.totalBytes ||
    totalRowGroups !== manifest.totalRowGroups
  ) {
    throw new OverturePlanRejectedError(
      "invalid-manifest",
      "Manifest row, byte, and row-group totals must exactly equal the object metadata sums.",
    );
  }
  return Object.freeze({
    lane,
    release: manifest.release,
    schemaVersion: manifest.schemaVersion,
    stacUrl: manifest.stacUrl,
    totalFiles: manifest.totalFiles,
    totalRows,
    totalBytes,
    totalRowGroups,
    objects: Object.freeze(objects),
    attribution: manifest.attribution,
    crs: "OGC:CRS84",
  });
}

export function validateOvertureObjectManifest(
  object: OvertureObjectManifest,
  lane: OvertureLane,
  index = 0,
): OvertureObjectManifest {
  assertPlainRecord(object, `Manifest object ${index}`, "invalid-manifest");
  nonEmptyString(object.id, `objects[${index}].id`, 128, "invalid-manifest");
  nonEmptyString(object.objectKey, `objects[${index}].objectKey`, 1_024, "invalid-manifest");
  nonEmptyString(object.url, `objects[${index}].url`, 2_048, "invalid-manifest");
  const bbox = validateBbox(object.bbox, `objects[${index}].bbox`, "invalid-manifest");
  boundedInteger(object.bytes, `objects[${index}].bytes`, 2 * 1024 * 1024 * 1024, "invalid-manifest");
  boundedInteger(object.rows, `objects[${index}].rows`, 100_000_000, "invalid-manifest");
  boundedInteger(object.rowGroups, `objects[${index}].rowGroups`, 4_096, "invalid-manifest");
  if (lane === "live") {
    const url = validateHttpsUrl(object.url, `objects[${index}].url`);
    if (url.hostname !== LIVE_HOST || url.pathname.slice(1) !== object.objectKey || url.search || url.hash) {
      throw new OverturePlanRejectedError(
        "invalid-manifest",
        `objects[${index}] must name the pinned public Overture object exactly.`,
      );
    }
    if (!LIVE_ETAG_PATTERN.test(object.etag)) {
      throw new OverturePlanRejectedError("invalid-manifest", `objects[${index}].etag is not a pinned S3 ETag.`);
    }
    validateIsoTimestamp(object.lastModified, `objects[${index}].lastModified`, "invalid-manifest");
  } else {
    if (
      !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(object.url) ||
      object.objectKey !== `public/${object.url}` ||
      !FIXTURE_ETAG_PATTERN.test(object.etag) ||
      object.lastModified !== "fixture-commit"
    ) {
      throw new OverturePlanRejectedError(
        "invalid-manifest",
        `objects[${index}] must use a pinned local fixture identity.`,
      );
    }
  }
  return Object.freeze({
    id: object.id,
    url: object.url,
    objectKey: object.objectKey,
    bbox: Object.freeze(bbox),
    bytes: object.bytes,
    rows: object.rows,
    rowGroups: object.rowGroups,
    etag: object.etag,
    lastModified: object.lastModified,
  });
}

export function validateIsoTimestamp(
  value: unknown,
  field: string,
  code: OverturePlanRejectedError["code"] = "invalid-input",
): string {
  if (typeof value !== "string") throw new OverturePlanRejectedError(code, `${field} must be an ISO timestamp.`);
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.valueOf()) || parsed.toISOString() !== value) {
    throw new OverturePlanRejectedError(code, `${field} must be a canonical ISO timestamp.`);
  }
  return value;
}

function buildPlan(
  input: OvertureQueryInput,
  policy: OvertureExecutionPolicy,
  manifest: OvertureSourceManifest,
): OvertureQueryPlan {
  const [xmin, ymin, xmax, ymax] = input.aoi;
  const aoiSquareDegrees = (xmax - xmin) * (ymax - ymin);
  if (!Number.isFinite(aoiSquareDegrees) || aoiSquareDegrees > policy.maxAoiSquareDegrees) {
    throw new OverturePlanRejectedError(
      "aoi-budget",
      `AOI ${aoiSquareDegrees.toFixed(3)} deg² exceeds the ${policy.maxAoiSquareDegrees} deg² safety budget.`,
    );
  }
  if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > policy.maxRows) {
    throw new OverturePlanRejectedError("row-budget", `Row limit must be between 1 and ${policy.maxRows}.`);
  }
  const projection = Object.freeze([...PROJECTIONS[input.lane]]);
  if (projection.length > policy.maxProjectedColumns) {
    throw new OverturePlanRejectedError("projection-budget", "Projected columns exceed the execution policy.");
  }
  const selectedObjects = Object.freeze(manifest.objects.filter((object) => intersects(input.aoi, object.bbox)));
  if (selectedObjects.length === 0) {
    throw new OverturePlanRejectedError("no-object", "The pinned STAC manifest has no object intersecting this AOI.");
  }
  if (selectedObjects.length !== 1) {
    throw new OverturePlanRejectedError(
      "file-budget",
      `AOI selects ${selectedObjects.length} objects; this bounded flagship requires exactly one object per query.`,
    );
  }
  const cacheKey = canonicalStringify(
    toJsonValue({
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
      policy,
    }),
  );
  const frozenAoi = Object.freeze([...input.aoi]) as Bbox;
  return Object.freeze({
    lane: input.lane,
    aoi: frozenAoi,
    aoiSquareDegrees,
    category: input.category,
    limit: input.limit,
    projection,
    selectedObjects,
    filesSelected: selectedObjects.length,
    filesAvailable: manifest.totalFiles,
    selectedObjectRows: exactSum(selectedObjects, "rows"),
    selectedObjectRowGroups: exactSum(selectedObjects, "rowGroups"),
    filePruning: input.lane === "live" ? "pinned-stac-manifest-bbox" : "fixture-manifest-bbox",
    rowGroupPruning: "bbox-predicate-planned-unverified",
    rangeReadPlan: input.lane === "live" ? "aws-fail-closed-range-io" : "local-buffer",
    cacheKey,
    policy,
    memoryLimitMiB: policy.memoryLimitMiB,
    maxResultBytes: policy.maxResultBytes,
    maxEngineMs: policy.maxEngineMs,
    maxSourceProbeMs: policy.maxSourceProbeMs,
    allowFullHttpReads: false,
    warning:
      input.lane === "live"
        ? "The pinned 16-item STAC manifest proves file selection and the query pushes a bbox predicate. Scheduled evidence observes browser range traffic; DuckDB-WASM does not expose rows scanned or row groups pruned, so those engine metrics remain unverified."
        : "The tiny committed file is intentionally buffered in full; the same AOI, projection, bbox predicate, limit, and result contract are used as the live lane.",
  });
}

function validateLane(value: unknown, code: OverturePlanRejectedError["code"] = "invalid-input"): OvertureLane {
  if (value !== "fixture" && value !== "live") {
    throw new OverturePlanRejectedError(code, "Lane must be fixture or live.");
  }
  return value;
}

function validateCategory(value: unknown): string {
  if (typeof value !== "string" || !CATEGORY_PATTERN.test(value)) {
    throw new OverturePlanRejectedError(
      "invalid-input",
      "Category must be a lowercase identifier containing at most 64 letters, digits, underscores, or hyphens.",
    );
  }
  return value;
}

function validateBbox(value: unknown, field: string, code: OverturePlanRejectedError["code"] = "invalid-aoi"): Bbox {
  if (!Array.isArray(value) || value.length !== 4 || value.some((coordinate) => !Number.isFinite(coordinate))) {
    throw new OverturePlanRejectedError(code, `${field} must contain exactly four finite numbers.`);
  }
  const [xmin, ymin, xmax, ymax] = value as number[];
  if (xmin! < -180 || xmax! > 180 || ymin! < -90 || ymax! > 90 || xmin! >= xmax! || ymin! >= ymax!) {
    throw new OverturePlanRejectedError(code, `${field} must be an ordered CRS84 envelope within world bounds.`);
  }
  return Object.freeze([xmin!, ymin!, xmax!, ymax!]);
}

function boundedInteger(
  value: unknown,
  field: string,
  maximum: number,
  code: OverturePlanRejectedError["code"] = "invalid-policy",
): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > maximum) {
    throw new OverturePlanRejectedError(code, `${field} must be a positive safe integer no greater than ${maximum}.`);
  }
}

function boundedNumber(value: unknown, field: string, maximum: number): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > maximum) {
    throw new OverturePlanRejectedError(
      "invalid-policy",
      `${field} must be finite, positive, and no greater than ${maximum}.`,
    );
  }
}

function nonEmptyString(
  value: unknown,
  field: string,
  maximumLength: number,
  code: OverturePlanRejectedError["code"],
): asserts value is string {
  if (typeof value !== "string" || value.length < 1 || value.length > maximumLength || value.trim() !== value) {
    throw new OverturePlanRejectedError(code, `${field} must be a non-empty bounded string without outer whitespace.`);
  }
}

function validateHttpsUrl(value: unknown, field: string): URL {
  if (typeof value !== "string") {
    throw new OverturePlanRejectedError("invalid-manifest", `${field} must be an HTTPS URL.`);
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new OverturePlanRejectedError("invalid-manifest", `${field} must be an absolute HTTPS URL.`);
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
    throw new OverturePlanRejectedError("invalid-manifest", `${field} must be a credential-free HTTPS URL.`);
  }
  return parsed;
}

function exactSum<T extends { readonly [K in P]: number }, P extends "rows" | "bytes" | "rowGroups">(
  values: readonly T[],
  property: P,
): number {
  const total = values.reduce((sum, value) => sum + value[property], 0);
  if (!Number.isSafeInteger(total)) {
    throw new OverturePlanRejectedError("invalid-manifest", `Manifest ${property} total must be a safe integer.`);
  }
  return total;
}

function assertPlainRecord(
  value: unknown,
  field: string,
  code: OverturePlanRejectedError["code"],
): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new OverturePlanRejectedError(code, `${field} must be a plain object.`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new OverturePlanRejectedError(code, `${field} must be a plain object.`);
  }
}

function intersects(left: Bbox, right: Bbox): boolean {
  return left[0] <= right[2] && left[2] >= right[0] && left[1] <= right[3] && left[3] >= right[1];
}
