import type { ColumnarBatchV1 } from "@honua/sdk-js/query-planner";

import {
  type CloudNativeAnalysisFixtureRow,
  type CloudNativeAnalysisPrerequisiteTruth,
  type PrepareCloudNativeAnalysisPrerequisiteOptions,
  type PreparedCloudNativeAnalysisPrerequisite,
  prepareCloudNativeAnalysisPrerequisite,
} from "./cloud-native-prerequisite.js";
import type { AnalyticsFeature } from "./types.js";

export type CloudNativeLinkedWorkflowErrorCode = "invalid-columnar-artifact";

export class CloudNativeLinkedWorkflowError extends Error {
  public constructor(
    public readonly code: CloudNativeLinkedWorkflowErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "CloudNativeLinkedWorkflowError";
  }
}

export interface CloudNativeLinkedTiming {
  /** S1 currently combines bounded fetch, fixture parsing, filtering, and batch preparation. */
  readonly prerequisiteMs: number;
  /** Decoding the public batch envelope and adapting rows to the shared SDK exploration model. */
  readonly sdkLinkMs: number;
  /** S1 does not expose a source-only timing boundary. */
  readonly sourceMs: null;
  /** No GeoParquet engine executes in this bounded fixture prerequisite. */
  readonly engineMs: null;
}

export interface CloudNativeLinkedResult {
  readonly artifactKind: PreparedCloudNativeAnalysisPrerequisite["artifact"]["kind"];
  readonly features: readonly AnalyticsFeature[];
  readonly truth: CloudNativeAnalysisPrerequisiteTruth;
  readonly timing: CloudNativeLinkedTiming;
}

export interface PrepareCloudNativeLinkedWorkflowOptions
  extends Pick<
    PrepareCloudNativeAnalysisPrerequisiteOptions,
    "acceptsColumnar" | "fetch" | "fixturePath" | "origin" | "policy" | "signal"
  > {
  readonly aoiId: string;
  readonly aoi: readonly [number, number, number, number];
  readonly resultSourceId: string;
  readonly risks?: PrepareCloudNativeAnalysisPrerequisiteOptions["query"]["risks"];
  readonly limit?: number;
  readonly now?: () => number;
}

const FEATURE_PRESENTATION: Readonly<
  Record<string, { readonly title: string; readonly category: string; readonly action: string }>
> = Object.freeze({
  "asset-001": {
    title: "Municipal power relay",
    category: "Critical asset",
    action: "Inspect backup-power readiness",
  },
  "parcel-002": {
    title: "Mixed-use parcel cluster",
    category: "Parcel",
    action: "Review evacuation access",
  },
  "facility-003": {
    title: "Emergency support facility",
    category: "Facility",
    action: "Confirm supply staging",
  },
  "incident-004": {
    title: "Open response incident",
    category: "Incident",
    action: "Coordinate field response",
  },
  "harbor-005": {
    title: "Harbor fuel terminal",
    category: "Critical asset",
    action: "Inspect containment plan",
  },
  "depot-006": {
    title: "Response supply depot",
    category: "Facility",
    action: "Confirm inventory",
  },
  "airport-007": {
    title: "Airport operations node",
    category: "Critical asset",
    action: "Review continuity plan",
  },
  "corridor-008": {
    title: "Airport access corridor",
    category: "Transport",
    action: "Inspect route constraints",
  },
});

/**
 * Continue the accepted S1 prerequisite into one linked result artifact. This
 * consumes only the published query-planner batch envelope; it does not imply
 * Arrow, GeoParquet, worker, range, or peak-memory observations.
 */
export async function prepareCloudNativeLinkedWorkflow(
  options: PrepareCloudNativeLinkedWorkflowOptions,
): Promise<CloudNativeLinkedResult> {
  const now = options.now ?? (() => performance.now());
  const prerequisiteStarted = now();
  const prepared = await prepareCloudNativeAnalysisPrerequisite({
    origin: options.origin,
    query: {
      aoi: options.aoi,
      ...(options.risks ? { risks: options.risks } : {}),
      ...(options.limit === undefined ? {} : { limit: options.limit }),
    },
    acceptsColumnar: options.acceptsColumnar,
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.fixturePath ? { fixturePath: options.fixturePath } : {}),
    ...(options.policy ? { policy: options.policy } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  });
  const prerequisiteMs = elapsed(prerequisiteStarted, now());
  const sdkStarted = now();
  const rows = rowsFromPreparedArtifact(prepared);
  const features = Object.freeze(
    rows.map((row) => cloudNativeRowToFeature(row, options.resultSourceId, options.aoiId)),
  );
  const sdkLinkMs = elapsed(sdkStarted, now());

  return Object.freeze({
    artifactKind: prepared.artifact.kind,
    features,
    truth: prepared.truth,
    timing: Object.freeze({ prerequisiteMs, sdkLinkMs, sourceMs: null, engineMs: null }),
  });
}

export function rowsFromPreparedArtifact(
  prepared: PreparedCloudNativeAnalysisPrerequisite,
): readonly CloudNativeAnalysisFixtureRow[] {
  if (prepared.artifact.kind === "bounded-object-fallback") {
    return Object.freeze([...prepared.artifact.rows]);
  }
  return rowsFromColumnarBatch(prepared.artifact.batch, prepared.truth.artifact.rows);
}

function rowsFromColumnarBatch(batch: ColumnarBatchV1, expectedRows: number): readonly CloudNativeAnalysisFixtureRow[] {
  if (
    batch.rowCount !== expectedRows ||
    batch.schema.metadata?.["honua.fixture.layout"] !== "sample-column-buffers-v1"
  ) {
    invalidColumnar("The prepared batch row count or sample layout metadata is inconsistent.");
  }
  const ids = stringArrayMetadata(batch, "honua.fixture.ids", batch.rowCount);
  const risks = stringArrayMetadata(batch, "honua.fixture.riskDictionary", 4);
  if (risks.length !== 4 || risks.some((risk) => !["critical", "high", "moderate", "low"].includes(risk))) {
    invalidColumnar("The prepared batch risk dictionary is invalid.");
  }
  const idCodes = typedColumn(batch, "idCode", Uint32Array);
  const x = typedColumn(batch, "x", Float64Array);
  const y = typedColumn(batch, "y", Float64Array);
  const riskCodes = typedColumn(batch, "riskCode", Uint32Array);
  const score = typedColumn(batch, "score", Float64Array);
  const incidentCount = typedColumn(batch, "incidentCount", Uint32Array);

  return Object.freeze(
    Array.from({ length: batch.rowCount }, (_, index): CloudNativeAnalysisFixtureRow => {
      const id = ids[idCodes[index] as number];
      const risk = risks[riskCodes[index] as number];
      const rowX = x[index];
      const rowY = y[index];
      const rowScore = score[index];
      const rowIncidentCount = incidentCount[index];
      if (
        id === undefined ||
        !isAnalyticsRisk(risk) ||
        !Number.isFinite(rowX) ||
        !Number.isFinite(rowY) ||
        !Number.isFinite(rowScore) ||
        rowIncidentCount === undefined
      ) {
        invalidColumnar(`The prepared batch contains an invalid value at row ${index}.`);
      }
      return Object.freeze({
        id,
        x: rowX,
        y: rowY,
        risk,
        score: rowScore,
        incidentCount: rowIncidentCount,
      });
    }),
  );
}

function stringArrayMetadata(batch: ColumnarBatchV1, key: string, maxEntries: number): readonly string[] {
  const raw = batch.schema.metadata?.[key];
  if (raw === undefined || raw.length > 4_096)
    invalidColumnar(`The prepared batch is missing bounded ${key} metadata.`);
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    invalidColumnar(`The prepared batch ${key} metadata is not JSON.`);
  }
  if (
    !Array.isArray(value) ||
    value.length > maxEntries ||
    value.some((entry) => typeof entry !== "string" || entry.length < 1 || entry.length > 256)
  ) {
    invalidColumnar(`The prepared batch ${key} metadata exceeds its bounds.`);
  }
  return Object.freeze(value as string[]);
}

type SupportedTypedArray = Uint32Array | Float64Array;
interface SupportedTypedArrayConstructor<T extends SupportedTypedArray> {
  readonly BYTES_PER_ELEMENT: number;
  new (buffer: ArrayBuffer, byteOffset: number, length: number): T;
}

function typedColumn<T extends SupportedTypedArray>(
  batch: ColumnarBatchV1,
  field: string,
  Constructor: SupportedTypedArrayConstructor<T>,
): T {
  const matches = batch.buffers.filter((buffer) => buffer.field === field && buffer.role === "values");
  const descriptor = matches[0];
  const expectedBytes = batch.rowCount * Constructor.BYTES_PER_ELEMENT;
  if (
    matches.length !== 1 ||
    descriptor === undefined ||
    descriptor.byteLength !== expectedBytes ||
    descriptor.byteOffset % Constructor.BYTES_PER_ELEMENT !== 0 ||
    descriptor.byteOffset + descriptor.byteLength > descriptor.data.byteLength
  ) {
    invalidColumnar(`The prepared batch ${field} buffer is missing or malformed.`);
  }
  return new Constructor(descriptor.data, descriptor.byteOffset, batch.rowCount);
}

function cloudNativeRowToFeature(
  row: CloudNativeAnalysisFixtureRow,
  resultSourceId: string,
  aoiId: string,
): AnalyticsFeature {
  const presentation = FEATURE_PRESENTATION[row.id] ?? {
    title: row.id,
    category: "Analysis result",
    action: "Review result",
  };
  return Object.freeze({
    id: row.id,
    sourceId: resultSourceId,
    title: presentation.title,
    category: presentation.category,
    risk: row.risk,
    zone: aoiId,
    score: row.score,
    distanceMeters: row.incidentCount * 125,
    incidentCount: row.incidentCount,
    x: row.x,
    y: row.y,
    aoiIds: Object.freeze([aoiId]),
    attributes: Object.freeze({
      action: presentation.action,
      fixtureId: row.id,
      incidentCount: row.incidentCount,
    }),
  });
}

function isAnalyticsRisk(value: string | undefined): value is CloudNativeAnalysisFixtureRow["risk"] {
  return value === "critical" || value === "high" || value === "moderate" || value === "low";
}

function elapsed(start: number, end: number): number {
  return Number(Math.max(0, end - start).toFixed(3));
}

function invalidColumnar(message: string): never {
  throw new CloudNativeLinkedWorkflowError("invalid-columnar-artifact", message);
}
