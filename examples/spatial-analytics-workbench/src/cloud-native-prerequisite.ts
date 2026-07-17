import {
  type ColumnarBatchMetrics,
  type ColumnarBatchV1,
  createColumnarBatch,
  inspectColumnarBatch,
} from "@honua/sdk-js/query-planner";

export const CLOUD_NATIVE_ANALYSIS_FIXTURE_PATH = "/fixtures/cloud-native-analysis-columnar.v1.json";
export const CLOUD_NATIVE_ANALYSIS_FIXTURE_SHA256 = "a9fdb37c01437fa92c6d74bb0b799eb12a5d42f115e9375b5e3b453ad2ffffbe";

export const CLOUD_NATIVE_ANALYSIS_PREREQUISITE_POLICY = Object.freeze({
  maxFixtureBytes: 8_192,
  maxFixtureRows: 64,
  maxRowGroups: 8,
  maxResultRows: 16,
  maxResultBytes: 16_384,
  maxColumnarBackingBytes: 4_096,
  maxObjectFallbackRows: 4,
});

export type CloudNativeAnalysisPrerequisiteErrorCode =
  | "aborted"
  | "cross-origin-fixture"
  | "fixture-fetch-failed"
  | "fixture-integrity"
  | "invalid-fixture"
  | "invalid-query"
  | "unsafe-materialization";

export class CloudNativeAnalysisPrerequisiteError extends Error {
  public constructor(
    public readonly code: CloudNativeAnalysisPrerequisiteErrorCode,
    message: string,
    options: { readonly cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "CloudNativeAnalysisPrerequisiteError";
  }
}

export type CloudNativeAnalysisBbox = readonly [number, number, number, number];

export interface CloudNativeAnalysisPrerequisiteQuery {
  readonly aoi: CloudNativeAnalysisBbox;
  readonly risks?: readonly ("critical" | "high" | "moderate" | "low")[];
  readonly limit?: number;
}

export interface CloudNativeAnalysisFixtureRow {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly risk: "critical" | "high" | "moderate" | "low";
  readonly score: number;
  readonly incidentCount: number;
}

export interface CloudNativeAnalysisPrerequisitePolicy {
  readonly maxFixtureBytes: number;
  readonly maxFixtureRows: number;
  readonly maxRowGroups: number;
  readonly maxResultRows: number;
  readonly maxResultBytes: number;
  readonly maxColumnarBackingBytes: number;
  readonly maxObjectFallbackRows: number;
}

export interface PrepareCloudNativeAnalysisPrerequisiteOptions {
  readonly origin: string | URL;
  readonly query: CloudNativeAnalysisPrerequisiteQuery;
  /** Whether the next workflow stage can consume the public Honua columnar batch contract. */
  readonly acceptsColumnar: boolean;
  readonly fixturePath?: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly signal?: AbortSignal;
  readonly policy?: Partial<CloudNativeAnalysisPrerequisitePolicy>;
}

export type CloudNativeAnalysisPreparedArtifact =
  | {
      readonly kind: "columnar-batch";
      readonly batch: ColumnarBatchV1;
      readonly metrics: ColumnarBatchMetrics;
    }
  | {
      readonly kind: "bounded-object-fallback";
      readonly rows: readonly CloudNativeAnalysisFixtureRow[];
    };

export interface CloudNativeAnalysisPrerequisiteTruth {
  readonly schemaVersion: "honua.sample.cloud-native-analysis-prerequisite-truth.v1";
  readonly workflow: "bounded-columnar-analysis-prerequisite";
  readonly qualification: "fixture-prerequisite-only";
  readonly source: {
    readonly mode: "fixture";
    readonly url: string;
    readonly sameOrigin: true;
    readonly fixtureId: string;
    readonly declaredSourceVersion: string;
    readonly objectVersion: `sha256:${string}`;
    readonly byteLength: number;
    readonly crs: "OGC:CRS84";
    readonly attribution: string;
  };
  readonly query: {
    readonly aoi: CloudNativeAnalysisBbox;
    readonly risks: readonly string[];
    readonly limit: number;
    readonly selectedRowGroupIds: readonly string[];
    readonly availableRowGroups: number;
  };
  readonly artifact: {
    readonly kind: CloudNativeAnalysisPreparedArtifact["kind"];
    readonly rows: number;
    readonly resultBytes: number;
    readonly backingBytes: number | null;
    readonly artifactFidelity: "fixture-exact";
  };
  readonly fallback: {
    readonly selected: "none" | "bounded-object";
    readonly maxRows: number;
    readonly reason: string;
  };
  readonly cacheIdentity: `sha256:${string}`;
  readonly claims: {
    readonly sameOriginFetch: { readonly state: "observed"; readonly basis: string };
    readonly partitionSelection: { readonly state: "fixture-evaluated"; readonly basis: string };
    readonly rowGroupPruning: { readonly state: "fixture-modeled"; readonly limitation: string };
    readonly rangeAccess: { readonly state: "unobserved"; readonly limitation: string };
    readonly workerExecution: { readonly state: "unobserved"; readonly limitation: string };
    readonly peakMemory: { readonly state: "unobserved"; readonly limitation: string };
  };
  readonly degradations: readonly {
    readonly code:
      | "columnar-consumer-unavailable"
      | "peak-memory-unobserved"
      | "range-access-unobserved"
      | "worker-execution-unobserved";
    readonly reason: string;
  }[];
}

export interface PreparedCloudNativeAnalysisPrerequisite {
  readonly artifact: CloudNativeAnalysisPreparedArtifact;
  readonly truth: CloudNativeAnalysisPrerequisiteTruth;
}

interface FixtureRowGroup {
  readonly id: string;
  readonly rowOffset: number;
  readonly rowCount: number;
  readonly bbox: CloudNativeAnalysisBbox;
}

interface CloudNativeAnalysisFixture {
  readonly schemaVersion: "honua.sample.cloud-native-analysis-columnar-fixture.v1";
  readonly fixtureId: string;
  readonly sourceVersion: string;
  readonly generatedAt: string;
  readonly crs: "OGC:CRS84";
  readonly attribution: string;
  readonly risks: readonly CloudNativeAnalysisFixtureRow["risk"][];
  readonly rowGroups: readonly FixtureRowGroup[];
  readonly rows: readonly CloudNativeAnalysisFixtureRow[];
}

/**
 * Prepare the S1 fixture artifact without claiming worker, range, row-group, or
 * peak-memory observations. All SDK behavior comes from published entrypoints;
 * this sample module does not import repository internals.
 */
export async function prepareCloudNativeAnalysisPrerequisite(
  options: PrepareCloudNativeAnalysisPrerequisiteOptions,
): Promise<PreparedCloudNativeAnalysisPrerequisite> {
  const policy = normalizePolicy(options.policy);
  const fixtureUrl = resolveSameOriginFixture(
    options.origin,
    options.fixturePath ?? CLOUD_NATIVE_ANALYSIS_FIXTURE_PATH,
  );
  const bytes = await fetchFixtureBytes(fixtureUrl, options, policy);
  const digest = await sha256(bytes);
  if (digest !== CLOUD_NATIVE_ANALYSIS_FIXTURE_SHA256) {
    throw new CloudNativeAnalysisPrerequisiteError(
      "fixture-integrity",
      `Columnar fixture digest sha256:${digest} does not match the committed object version.`,
    );
  }
  throwIfAborted(options.signal);
  const fixture = parseFixture(bytes, policy);
  const query = normalizeQuery(options.query, fixture, policy);
  const selectedGroups = fixture.rowGroups.filter((group) => intersects(query.aoi, group.bbox));
  const candidateRows = selectedGroups.flatMap((group) =>
    fixture.rows.slice(group.rowOffset, group.rowOffset + group.rowCount),
  );
  const selectedRows = candidateRows
    .filter((row) => pointInBbox(row, query.aoi) && query.risks.includes(row.risk))
    .slice(0, query.limit);
  const resultBytes = byteLength(JSON.stringify(selectedRows));
  if (selectedRows.length > policy.maxResultRows || resultBytes > policy.maxResultBytes) {
    throw new CloudNativeAnalysisPrerequisiteError(
      "unsafe-materialization",
      `Prepared result exceeds the ${policy.maxResultRows}-row or ${policy.maxResultBytes}-byte ceiling.`,
    );
  }

  let artifact: CloudNativeAnalysisPreparedArtifact;
  if (options.acceptsColumnar) {
    const batch = createFixtureBatch(fixture, selectedRows, policy);
    artifact = {
      kind: "columnar-batch",
      batch,
      metrics: inspectColumnarBatch(batch, {
        maxRows: policy.maxResultRows,
        maxBackingBytes: policy.maxColumnarBackingBytes,
      }),
    };
  } else {
    if (selectedRows.length > policy.maxObjectFallbackRows) {
      throw new CloudNativeAnalysisPrerequisiteError(
        "unsafe-materialization",
        `Columnar consumption is unavailable and ${selectedRows.length} rows exceed the bounded object fallback ceiling of ${policy.maxObjectFallbackRows}.`,
      );
    }
    artifact = { kind: "bounded-object-fallback", rows: Object.freeze([...selectedRows]) };
  }

  const selectedRowGroupIds = Object.freeze(selectedGroups.map((group) => group.id));
  const cacheIdentity = await sha256Text(
    JSON.stringify({
      objectVersion: digest,
      aoi: query.aoi,
      risks: query.risks,
      limit: query.limit,
      artifact: artifact.kind,
      policy,
    }),
  );
  const fallbackSelected = artifact.kind === "bounded-object-fallback";
  const degradations: CloudNativeAnalysisPrerequisiteTruth["degradations"] = Object.freeze([
    ...(fallbackSelected
      ? [
          {
            code: "columnar-consumer-unavailable" as const,
            reason: `The consumer cannot accept a columnar batch; object conversion is capped at ${policy.maxObjectFallbackRows} rows.`,
          },
        ]
      : []),
    {
      code: "range-access-unobserved" as const,
      reason: "This small JSON fixture is fetched as one object; it is not evidence of HTTP range access.",
    },
    {
      code: "worker-execution-unobserved" as const,
      reason: "This prerequisite prepares an SDK batch but does not start or qualify a worker execution.",
    },
    {
      code: "peak-memory-unobserved" as const,
      reason: "Only fixture, result, and columnar backing bytes are bounded; runtime peak memory is not observed.",
    },
  ]);

  return Object.freeze({
    artifact,
    truth: Object.freeze({
      schemaVersion: "honua.sample.cloud-native-analysis-prerequisite-truth.v1",
      workflow: "bounded-columnar-analysis-prerequisite",
      qualification: "fixture-prerequisite-only",
      source: Object.freeze({
        mode: "fixture",
        url: fixtureUrl.href,
        sameOrigin: true,
        fixtureId: fixture.fixtureId,
        declaredSourceVersion: fixture.sourceVersion,
        objectVersion: `sha256:${digest}` as const,
        byteLength: bytes.byteLength,
        crs: fixture.crs,
        attribution: fixture.attribution,
      }),
      query: Object.freeze({
        aoi: query.aoi,
        risks: query.risks,
        limit: query.limit,
        selectedRowGroupIds,
        availableRowGroups: fixture.rowGroups.length,
      }),
      artifact: Object.freeze({
        kind: artifact.kind,
        rows: selectedRows.length,
        resultBytes,
        backingBytes: artifact.kind === "columnar-batch" ? artifact.metrics.backingBytes : null,
        artifactFidelity: "fixture-exact",
      }),
      fallback: Object.freeze({
        selected: fallbackSelected ? "bounded-object" : "none",
        maxRows: policy.maxObjectFallbackRows,
        reason: fallbackSelected
          ? "Columnar consumption was unavailable and the selected result fit the explicit object ceiling."
          : "The consumer accepted the public Honua columnar batch contract; no object fallback was used.",
      }),
      cacheIdentity: `sha256:${cacheIdentity}` as const,
      claims: Object.freeze({
        sameOriginFetch: Object.freeze({
          state: "observed",
          basis: `Fetched ${bytes.byteLength} digest-verified bytes from ${fixtureUrl.pathname} on the application origin.`,
        }),
        partitionSelection: Object.freeze({
          state: "fixture-evaluated",
          basis: `Selected ${selectedGroups.length} of ${fixture.rowGroups.length} committed fixture partitions by AOI envelope.`,
        }),
        rowGroupPruning: Object.freeze({
          state: "fixture-modeled",
          limitation: "The JSON partition envelopes model row-group selection; no Parquet engine counter was observed.",
        }),
        rangeAccess: Object.freeze({
          state: "unobserved",
          limitation: "The committed prerequisite fixture is intentionally fetched as one bounded same-origin object.",
        }),
        workerExecution: Object.freeze({
          state: "unobserved",
          limitation:
            "Worker execution, cancellation, and cleanup remain an S1 integration step after this prerequisite.",
        }),
        peakMemory: Object.freeze({
          state: "unobserved",
          limitation: "The public SDK exposes exact batch backing bytes here, not browser process peak memory.",
        }),
      }),
      degradations,
    }),
  });
}

function normalizePolicy(
  overrides: Partial<CloudNativeAnalysisPrerequisitePolicy> | undefined,
): CloudNativeAnalysisPrerequisitePolicy {
  const policy = { ...CLOUD_NATIVE_ANALYSIS_PREREQUISITE_POLICY, ...overrides };
  for (const [name, value] of Object.entries(policy)) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new CloudNativeAnalysisPrerequisiteError("invalid-query", `${name} must be a positive safe integer.`);
    }
  }
  if (policy.maxObjectFallbackRows > policy.maxResultRows) {
    throw new CloudNativeAnalysisPrerequisiteError(
      "invalid-query",
      "maxObjectFallbackRows cannot exceed maxResultRows.",
    );
  }
  return Object.freeze(policy);
}

function resolveSameOriginFixture(originValue: string | URL, fixturePath: string): URL {
  let origin: URL;
  let fixtureUrl: URL;
  try {
    origin = new URL(originValue);
    fixtureUrl = new URL(fixturePath, origin);
  } catch (cause) {
    throw new CloudNativeAnalysisPrerequisiteError("cross-origin-fixture", "Fixture origin or path is invalid.", {
      cause,
    });
  }
  if ((origin.protocol !== "http:" && origin.protocol !== "https:") || fixtureUrl.origin !== origin.origin) {
    throw new CloudNativeAnalysisPrerequisiteError(
      "cross-origin-fixture",
      "The cloud-native analysis prerequisite accepts only an HTTP(S) fixture on the application origin.",
    );
  }
  return fixtureUrl;
}

async function fetchFixtureBytes(
  fixtureUrl: URL,
  options: PrepareCloudNativeAnalysisPrerequisiteOptions,
  policy: CloudNativeAnalysisPrerequisitePolicy,
): Promise<ArrayBuffer> {
  const fetcher = options.fetch ?? globalThis.fetch;
  if (typeof fetcher !== "function") {
    throw new CloudNativeAnalysisPrerequisiteError("fixture-fetch-failed", "No fetch implementation is available.");
  }
  throwIfAborted(options.signal);
  let response: Response;
  try {
    response = await fetcher(fixtureUrl, {
      cache: "no-store",
      credentials: "same-origin",
      redirect: "error",
      ...(options.signal ? { signal: options.signal } : {}),
    });
  } catch (cause) {
    if (options.signal?.aborted || isAbortError(cause)) {
      throw new CloudNativeAnalysisPrerequisiteError("aborted", "Columnar fixture fetch was cancelled.", { cause });
    }
    throw new CloudNativeAnalysisPrerequisiteError("fixture-fetch-failed", "Columnar fixture fetch failed.", {
      cause,
    });
  }
  if (!response.ok) {
    throw new CloudNativeAnalysisPrerequisiteError(
      "fixture-fetch-failed",
      `Columnar fixture fetch returned HTTP ${response.status}.`,
    );
  }
  if (response.url) {
    const finalUrl = new URL(response.url);
    if (finalUrl.origin !== fixtureUrl.origin) {
      throw new CloudNativeAnalysisPrerequisiteError(
        "cross-origin-fixture",
        "The fixture response resolved outside the application origin.",
      );
    }
  }
  const declaredBytes = response.headers.get("content-length");
  let parsedDeclaredBytes: number | undefined;
  if (declaredBytes !== null) {
    const parsed = Number(declaredBytes);
    if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > policy.maxFixtureBytes) {
      throw new CloudNativeAnalysisPrerequisiteError(
        "unsafe-materialization",
        `Fixture Content-Length exceeds the ${policy.maxFixtureBytes}-byte ceiling.`,
      );
    }
    parsedDeclaredBytes = parsed;
  }
  let bytes: ArrayBuffer;
  try {
    bytes = await readBoundedBody(response, policy.maxFixtureBytes, options.signal);
  } catch (cause) {
    if (cause instanceof CloudNativeAnalysisPrerequisiteError) throw cause;
    if (options.signal?.aborted || isAbortError(cause)) {
      throw new CloudNativeAnalysisPrerequisiteError("aborted", "Columnar fixture body read was cancelled.", {
        cause,
      });
    }
    throw new CloudNativeAnalysisPrerequisiteError("fixture-fetch-failed", "Columnar fixture body read failed.", {
      cause,
    });
  }
  if (parsedDeclaredBytes !== undefined && parsedDeclaredBytes !== bytes.byteLength) {
    throw new CloudNativeAnalysisPrerequisiteError(
      "fixture-integrity",
      "Fixture Content-Length does not match the observed bounded body.",
    );
  }
  return bytes;
}

async function readBoundedBody(
  response: Response,
  maxBytes: number,
  signal: AbortSignal | undefined,
): Promise<ArrayBuffer> {
  if (!response.body) {
    throw new CloudNativeAnalysisPrerequisiteError(
      "fixture-fetch-failed",
      "Fixture response has no readable body for bounded consumption.",
    );
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let observedBytes = 0;
  const abort = () => {
    void reader.cancel(signal?.reason ?? new DOMException("cancelled", "AbortError")).catch(() => undefined);
  };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    while (true) {
      throwIfAborted(signal);
      const { done, value } = await reader.read();
      throwIfAborted(signal);
      if (done) break;
      if (value.byteLength > maxBytes - observedBytes) {
        await reader.cancel("Fixture byte ceiling exceeded.").catch(() => undefined);
        throw new CloudNativeAnalysisPrerequisiteError(
          "unsafe-materialization",
          `Fixture body exceeds the ${maxBytes}-byte ceiling.`,
        );
      }
      chunks.push(value);
      observedBytes += value.byteLength;
    }
  } finally {
    signal?.removeEventListener("abort", abort);
    reader.releaseLock();
  }
  const bytes = new ArrayBuffer(observedBytes);
  const target = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    target.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function parseFixture(bytes: ArrayBuffer, policy: CloudNativeAnalysisPrerequisitePolicy): CloudNativeAnalysisFixture {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (cause) {
    throw new CloudNativeAnalysisPrerequisiteError("invalid-fixture", "Fixture is not valid UTF-8 JSON.", { cause });
  }
  const root = record(value, "fixture");
  if (root.schemaVersion !== "honua.sample.cloud-native-analysis-columnar-fixture.v1") {
    throw new CloudNativeAnalysisPrerequisiteError("invalid-fixture", "Fixture schemaVersion is unsupported.");
  }
  const fixtureId = text(root.fixtureId, "fixtureId");
  const sourceVersion = text(root.sourceVersion, "sourceVersion");
  const generatedAt = text(root.generatedAt, "generatedAt");
  if (!Number.isFinite(Date.parse(generatedAt))) {
    throw new CloudNativeAnalysisPrerequisiteError("invalid-fixture", "generatedAt must be an ISO timestamp.");
  }
  if (root.crs !== "OGC:CRS84") {
    throw new CloudNativeAnalysisPrerequisiteError("invalid-fixture", "Fixture CRS must be OGC:CRS84.");
  }
  const attribution = text(root.attribution, "attribution");
  const dictionary = record(root.dictionary, "dictionary");
  const risks = stringArray(dictionary.risk, "dictionary.risk") as CloudNativeAnalysisFixtureRow["risk"][];
  if (
    risks.length !== 4 ||
    risks.some((risk) => !["critical", "high", "moderate", "low"].includes(risk)) ||
    new Set(risks).size !== risks.length
  ) {
    throw new CloudNativeAnalysisPrerequisiteError("invalid-fixture", "Risk dictionary is invalid.");
  }
  const columns = record(root.columns, "columns");
  const ids = stringArray(columns.id, "columns.id");
  const x = numberArray(columns.x, "columns.x");
  const y = numberArray(columns.y, "columns.y");
  const riskCodes = numberArray(columns.riskCode, "columns.riskCode");
  const scores = numberArray(columns.score, "columns.score");
  const incidentCounts = numberArray(columns.incidentCount, "columns.incidentCount");
  const rowCount = ids.length;
  if (
    rowCount > policy.maxFixtureRows ||
    [x, y, riskCodes, scores, incidentCounts].some((column) => column.length !== rowCount) ||
    new Set(ids).size !== rowCount
  ) {
    throw new CloudNativeAnalysisPrerequisiteError(
      "invalid-fixture",
      "Fixture columns violate row or identity bounds.",
    );
  }
  const rows = Object.freeze(
    ids.map((id, index): CloudNativeAnalysisFixtureRow => {
      const riskCode = riskCodes[index];
      const incidentCount = incidentCounts[index];
      if (!Number.isSafeInteger(riskCode) || riskCode < 0 || riskCode >= risks.length) {
        throw new CloudNativeAnalysisPrerequisiteError("invalid-fixture", `Row ${index} has an invalid risk code.`);
      }
      if (!Number.isSafeInteger(incidentCount) || incidentCount < 0) {
        throw new CloudNativeAnalysisPrerequisiteError(
          "invalid-fixture",
          `Row ${index} has an invalid incident count.`,
        );
      }
      const rowX = x[index] as number;
      const rowY = y[index] as number;
      if (rowX < -180 || rowX > 180 || rowY < -90 || rowY > 90) {
        throw new CloudNativeAnalysisPrerequisiteError("invalid-fixture", `Row ${index} is outside CRS84 bounds.`);
      }
      return Object.freeze({
        id,
        x: rowX,
        y: rowY,
        risk: risks[riskCode] as CloudNativeAnalysisFixtureRow["risk"],
        score: scores[index] as number,
        incidentCount,
      });
    }),
  );
  const groupsValue = array(root.rowGroups, "rowGroups");
  if (groupsValue.length > policy.maxRowGroups) {
    throw new CloudNativeAnalysisPrerequisiteError("invalid-fixture", "Fixture exceeds the row-group ceiling.");
  }
  let expectedOffset = 0;
  const rowGroups = Object.freeze(
    groupsValue.map((entry, index): FixtureRowGroup => {
      const group = record(entry, `rowGroups[${index}]`);
      const rowOffset = integer(group.rowOffset, `rowGroups[${index}].rowOffset`);
      const groupRowCount = integer(group.rowCount, `rowGroups[${index}].rowCount`);
      const bbox = bboxValue(group.bbox, `rowGroups[${index}].bbox`);
      if (rowOffset !== expectedOffset || groupRowCount < 1 || rowOffset + groupRowCount > rows.length) {
        throw new CloudNativeAnalysisPrerequisiteError(
          "invalid-fixture",
          "Fixture row groups must cover ordered, non-overlapping bounded row spans.",
        );
      }
      for (const row of rows.slice(rowOffset, rowOffset + groupRowCount)) {
        if (!pointInBbox(row, bbox)) {
          throw new CloudNativeAnalysisPrerequisiteError(
            "invalid-fixture",
            `Row group ${String(group.id)} does not enclose all declared rows.`,
          );
        }
      }
      expectedOffset += groupRowCount;
      return Object.freeze({ id: text(group.id, `rowGroups[${index}].id`), rowOffset, rowCount: groupRowCount, bbox });
    }),
  );
  if (expectedOffset !== rows.length) {
    throw new CloudNativeAnalysisPrerequisiteError("invalid-fixture", "Fixture row groups do not cover every row.");
  }
  return Object.freeze({
    schemaVersion: "honua.sample.cloud-native-analysis-columnar-fixture.v1",
    fixtureId,
    sourceVersion,
    generatedAt,
    crs: "OGC:CRS84",
    attribution,
    risks: Object.freeze(risks),
    rowGroups,
    rows,
  });
}

function normalizeQuery(
  input: CloudNativeAnalysisPrerequisiteQuery,
  fixture: CloudNativeAnalysisFixture,
  policy: CloudNativeAnalysisPrerequisitePolicy,
) {
  if (typeof input !== "object" || input === null) {
    throw new CloudNativeAnalysisPrerequisiteError("invalid-query", "Query is required.");
  }
  const aoi = bboxValue(input.aoi, "query.aoi");
  const risks = Object.freeze(input.risks === undefined ? [...fixture.risks] : [...input.risks]);
  if (risks.length < 1 || risks.some((risk) => !fixture.risks.includes(risk))) {
    throw new CloudNativeAnalysisPrerequisiteError("invalid-query", "Query risks must use the fixture dictionary.");
  }
  const limit = input.limit ?? policy.maxResultRows;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > policy.maxResultRows) {
    throw new CloudNativeAnalysisPrerequisiteError(
      "invalid-query",
      `Query limit must be from 1 through ${policy.maxResultRows}.`,
    );
  }
  return Object.freeze({ aoi, risks, limit });
}

function createFixtureBatch(
  fixture: CloudNativeAnalysisFixture,
  rows: readonly CloudNativeAnalysisFixtureRow[],
  policy: CloudNativeAnalysisPrerequisitePolicy,
): ColumnarBatchV1 {
  const idCodes = uint32Buffer(rows.map((_row, index) => index));
  const x = float64Buffer(rows.map((row) => row.x));
  const y = float64Buffer(rows.map((row) => row.y));
  const riskCodes = uint32Buffer(rows.map((row) => fixture.risks.indexOf(row.risk)));
  const scores = float64Buffer(rows.map((row) => row.score));
  const incidentCounts = uint32Buffer(rows.map((row) => row.incidentCount));
  const buffers = [
    buffer("id-code-values", "idCode", idCodes),
    buffer("x-values", "x", x),
    buffer("y-values", "y", y),
    buffer("risk-code-values", "riskCode", riskCodes),
    buffer("score-values", "score", scores),
    buffer("incident-count-values", "incidentCount", incidentCounts),
  ];
  return createColumnarBatch(
    {
      id: `${fixture.fixtureId}:prepared`,
      schema: {
        id: `${fixture.fixtureId}:${fixture.sourceVersion}:columnar-v1`,
        fields: [
          { name: "idCode", type: { name: "uint32" }, nullable: false },
          { name: "x", type: { name: "float64" }, nullable: false },
          { name: "y", type: { name: "float64" }, nullable: false },
          { name: "riskCode", type: { name: "uint32" }, nullable: false },
          { name: "score", type: { name: "float64" }, nullable: false },
          { name: "incidentCount", type: { name: "uint32" }, nullable: false },
        ],
        metadata: {
          "honua.fixture.ids": JSON.stringify(rows.map((row) => row.id)),
          "honua.fixture.riskDictionary": JSON.stringify(fixture.risks),
          "honua.fixture.crs": fixture.crs,
          "honua.fixture.layout": "sample-column-buffers-v1",
        },
      },
      rowCount: rows.length,
      sequence: 0,
      buffers,
    },
    { maxRows: policy.maxResultRows, maxBackingBytes: policy.maxColumnarBackingBytes },
  );
}

function buffer(id: string, field: string, data: ArrayBuffer) {
  return { id, field, role: "values" as const, data, byteOffset: 0, byteLength: data.byteLength };
}

function uint32Buffer(values: readonly number[]): ArrayBuffer {
  const data = new ArrayBuffer(values.length * Uint32Array.BYTES_PER_ELEMENT);
  new Uint32Array(data).set(values);
  return data;
}

function float64Buffer(values: readonly number[]): ArrayBuffer {
  const data = new ArrayBuffer(values.length * Float64Array.BYTES_PER_ELEMENT);
  new Float64Array(data).set(values);
  return data;
}

function bboxValue(value: unknown, name: string): CloudNativeAnalysisBbox {
  const values = numberArray(value, name);
  if (values.length !== 4) {
    throw new CloudNativeAnalysisPrerequisiteError("invalid-query", `${name} must contain four numbers.`);
  }
  const [xmin, ymin, xmax, ymax] = values as [number, number, number, number];
  if (xmin < -180 || xmax > 180 || ymin < -90 || ymax > 90 || xmin >= xmax || ymin >= ymax) {
    throw new CloudNativeAnalysisPrerequisiteError("invalid-query", `${name} must be an ordered CRS84 envelope.`);
  }
  return Object.freeze([xmin, ymin, xmax, ymax]);
}

function intersects(left: CloudNativeAnalysisBbox, right: CloudNativeAnalysisBbox): boolean {
  return left[0] <= right[2] && left[2] >= right[0] && left[1] <= right[3] && left[3] >= right[1];
}

function pointInBbox(row: Pick<CloudNativeAnalysisFixtureRow, "x" | "y">, bbox: CloudNativeAnalysisBbox): boolean {
  return row.x >= bbox[0] && row.x <= bbox[2] && row.y >= bbox[1] && row.y <= bbox[3];
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new CloudNativeAnalysisPrerequisiteError("invalid-fixture", `${name} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function array(value: unknown, name: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new CloudNativeAnalysisPrerequisiteError("invalid-fixture", `${name} must be an array.`);
  }
  return value;
}

function stringArray(value: unknown, name: string): string[] {
  return array(value, name).map((entry, index) => text(entry, `${name}[${index}]`));
}

function numberArray(value: unknown, name: string): number[] {
  return array(value, name).map((entry, index) => {
    if (typeof entry !== "number" || !Number.isFinite(entry)) {
      throw new CloudNativeAnalysisPrerequisiteError("invalid-fixture", `${name}[${index}] must be finite.`);
    }
    return entry;
  });
}

function text(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim() !== value || value.length < 1 || value.length > 2_048) {
    throw new CloudNativeAnalysisPrerequisiteError("invalid-fixture", `${name} must be bounded non-empty text.`);
  }
  return value;
}

function integer(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new CloudNativeAnalysisPrerequisiteError("invalid-fixture", `${name} must be a non-negative integer.`);
  }
  return value as number;
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

async function sha256Text(value: string): Promise<string> {
  const encoded = new TextEncoder().encode(value);
  const bytes = new ArrayBuffer(encoded.byteLength);
  new Uint8Array(bytes).set(encoded);
  return sha256(bytes);
}

async function sha256(bytes: ArrayBuffer): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new CloudNativeAnalysisPrerequisiteError("aborted", "Columnar fixture preparation was cancelled.", {
      cause: signal.reason,
    });
  }
}

function isAbortError(value: unknown): boolean {
  return value instanceof DOMException && value.name === "AbortError";
}
