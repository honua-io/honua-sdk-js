import { HonuaHttpError } from "../core/errors.js";
import { HonuaZarrError, HonuaZarrServiceError } from "./errors.js";
import type {
  RegisterZarrStoreRequest,
  ZarrClientOptions,
  ZarrHonuaClient,
  ZarrMaturityAssessment,
  ZarrMaturityFailure,
  ZarrReadinessOptions,
  ZarrStoreRegistration,
  ZarrTileRequest,
  ZarrTileResult,
  ZarrVariableMetadata,
} from "./types.js";

const DEFAULT_METADATA_BYTES = 2 * 1024 * 1024;
const DEFAULT_TILE_BYTES = 2 * 1024 * 1024;
const SUPPORTED_CODECS = new Set(["gzip", "zlib"]);
const SUPPORTED_PROVIDERS = new Set(["AwsS3", "AzureBlob", "Local"]);

/** Experimental client for Honua Server's versioned Zarr registration and tile contract. */
export class HonuaZarrClient {
  private readonly adminBasePath: string;
  private readonly datacubeBasePath: string;
  private readonly maxMetadataResponseBytes: number;
  private readonly maxTileResponseBytes: number;

  public constructor(
    private readonly client: ZarrHonuaClient,
    options: ZarrClientOptions = {},
  ) {
    this.adminBasePath = versionedPath(options.adminBasePath ?? "/api/v1/admin/zarr-stores", "adminBasePath");
    this.datacubeBasePath = versionedPath(options.datacubeBasePath ?? "/api/v1/datacubes", "datacubeBasePath");
    this.maxMetadataResponseBytes = positiveByteLimit(options.maxMetadataResponseBytes ?? DEFAULT_METADATA_BYTES);
    this.maxTileResponseBytes = positiveByteLimit(options.maxTileResponseBytes ?? DEFAULT_TILE_BYTES);
  }

  public async register(request: RegisterZarrStoreRequest, signal?: AbortSignal): Promise<ZarrStoreRegistration> {
    validateRegistrationRequest(request);
    return this.registrationJson("POST", this.adminBasePath, request, signal);
  }

  public async list(layerId: number, signal?: AbortSignal): Promise<readonly ZarrStoreRegistration[]> {
    const id = nonNegativeInteger(layerId, "layerId");
    const value = await this.json("GET", `${this.adminBasePath}?layerId=${id}`, undefined, signal);
    if (!Array.isArray(value)) invalidResponse("Zarr list response must be an array.");
    return Object.freeze(value.map((entry) => normalizeRegistration(entry)));
  }

  public async get(id: number, signal?: AbortSignal): Promise<ZarrStoreRegistration> {
    return this.registrationJson("GET", `${this.adminBasePath}/${positiveInteger(id, "id")}`, undefined, signal);
  }

  public async refresh(id: number, signal?: AbortSignal): Promise<ZarrStoreRegistration> {
    return this.registrationJson(
      "POST",
      `${this.adminBasePath}/${positiveInteger(id, "id")}/refresh`,
      undefined,
      signal,
    );
  }

  public async unregister(id: number, signal?: AbortSignal): Promise<void> {
    try {
      await boundedFetch(
        this.client,
        "DELETE",
        `${this.adminBasePath}/${positiveInteger(id, "id")}`,
        undefined,
        "application/json",
        this.maxMetadataResponseBytes,
        signal,
      );
    } catch (error) {
      throw translateError(error);
    }
  }

  /**
   * Reports whether scanned metadata can be handed to Honua Server's bounded tile operation.
   * It does not claim that this SDK can decode chunks directly from object storage.
   */
  public assess(registration: ZarrStoreRegistration, options: ZarrReadinessOptions): ZarrMaturityAssessment {
    const failures: ZarrMaturityFailure[] = [];
    if (registration.variables === null || registration.zarrFormat === null) {
      failures.push({ code: "metadata-pending", message: "Refresh the registration before requesting a tile." });
    } else {
      if (registration.zarrFormat !== 2 && registration.zarrFormat !== 3) {
        failures.push({
          code: "unsupported-version",
          message: `Zarr v${String(registration.zarrFormat)} is outside the versioned server contract.`,
        });
      }
      if (registration.srid === null || registration.srid <= 0) {
        failures.push({
          code: "missing-spatial-reference",
          message: "Tile rendering requires a positive storage SRID that can match the requested tile matrix set.",
        });
      } else if (!Number.isSafeInteger(options?.tileMatrixSrid) || options.tileMatrixSrid <= 0) {
        failures.push({
          code: "missing-spatial-reference",
          message: "Tile readiness requires the positive SRID of the requested tile matrix set.",
        });
      } else if (registration.srid !== options.tileMatrixSrid) {
        failures.push({
          code: "spatial-reference-mismatch",
          message: `Coverage EPSG:${registration.srid} cannot be handed to tile matrix EPSG:${options.tileMatrixSrid} without reprojection.`,
        });
      }
      if (!isUsableSpatialExtent(options?.storageExtent)) {
        failures.push({
          code: "missing-spatial-extent",
          message:
            "Tile readiness requires a finite, non-degenerate storage extent from advertised or scanned metadata.",
        });
      }
      const variable = selectTileVariable(registration, options?.variable);
      if (!variable) {
        failures.push({
          code: "no-tileable-variable",
          message:
            options?.variable === undefined
              ? "The completed Zarr metadata scan did not discover a primary variable for the tile operation."
              : `The completed Zarr metadata scan did not discover variable "${options.variable}" for the tile operation.`,
        });
      } else {
        assessVariable(variable, failures);
      }
    }
    return Object.freeze({
      maturity: "experimental" as const,
      metadata: failures.some((failure) => failure.code === "metadata-pending") ? "pending" : "ready",
      serverTileHandoff: failures.length === 0 ? "ready" : "unavailable",
      directObjectStoreRead: "unavailable" as const,
      failures: Object.freeze(failures),
    });
  }

  /** Fail with a stable code when scanned metadata is not ready for the server tile operation. */
  public assertTileReady(registration: ZarrStoreRegistration, options: ZarrReadinessOptions): void {
    const failure = this.assess(registration, options).failures[0];
    if (failure) {
      throw new HonuaZarrError(failure.code, failure.message, {
        ...(failure.variable ? { variable: failure.variable } : {}),
      });
    }
  }

  /** Fetch one bounded PNG tile through the server; direct chunk reads are not performed. */
  public async tile(request: ZarrTileRequest): Promise<ZarrTileResult> {
    const path = this.tilePath(request);
    const maxBytes = positiveByteLimit(request.maxResponseBytes ?? this.maxTileResponseBytes);
    try {
      const response = await boundedFetch(this.client, "GET", path, undefined, "image/png", maxBytes, request.signal);
      if (response.status === 204) {
        return {
          bytes: new Uint8Array(),
          contentType: null,
          status: 204,
          requestUrl: resolveUrl(this.client.serverBaseUrl, path),
        };
      }
      if (response.status !== 200) {
        throw new HonuaZarrError("invalid-response", "Zarr tile endpoint returned an unexpected success status.", {
          status: response.status,
        });
      }
      const contentType = response.headers.get("Content-Type")?.split(";", 1)[0]?.trim().toLowerCase();
      if (contentType !== "image/png") {
        throw new HonuaZarrError("invalid-response", "Zarr tile endpoint did not return image/png.", {
          contentType: contentType ?? null,
        });
      }
      return {
        bytes: new Uint8Array(await response.arrayBuffer()),
        contentType: "image/png",
        status: 200,
        requestUrl: resolveUrl(this.client.serverBaseUrl, path),
      };
    } catch (error) {
      throw translateError(error);
    }
  }

  /** Build the same bounded server tile handoff URL without issuing a request. */
  public tileUrl(request: Omit<ZarrTileRequest, "maxResponseBytes" | "signal">): string {
    return resolveUrl(this.client.serverBaseUrl, this.tilePath(request));
  }

  private tilePath(request: Omit<ZarrTileRequest, "maxResponseBytes" | "signal">): string {
    const layerId = nonNegativeInteger(request.layerId, "layerId");
    const matrix = requiredText(request.tileMatrixSetId, "tileMatrixSetId");
    const z = nonNegativeInteger(request.z, "z");
    const x = nonNegativeInteger(request.x, "x");
    const y = nonNegativeInteger(request.y, "y");
    const params = new URLSearchParams();
    append(params, "variable", request.variable);
    append(params, "datetime", request.datetime);
    if (request.elevation !== undefined)
      params.set("elevation", String(nonNegativeInteger(request.elevation, "elevation")));
    const query = params.size === 0 ? "" : `?${params.toString()}`;
    return `${this.datacubeBasePath}/${layerId}/tiles/${encodeURIComponent(matrix)}/${z}/${x}/${y}${query}`;
  }

  private async registrationJson(
    method: "GET" | "POST",
    path: string,
    body: RegisterZarrStoreRequest | undefined,
    signal?: AbortSignal,
  ): Promise<ZarrStoreRegistration> {
    return normalizeRegistration(await this.json(method, path, body, signal));
  }

  private async json(
    method: "GET" | "POST",
    path: string,
    body: RegisterZarrStoreRequest | undefined,
    signal?: AbortSignal,
  ): Promise<unknown> {
    try {
      const response = await boundedFetch(
        this.client,
        method,
        path,
        body,
        "application/json",
        this.maxMetadataResponseBytes,
        signal,
      );
      try {
        return JSON.parse(new TextDecoder().decode(await response.arrayBuffer())) as unknown;
      } catch (error) {
        throw new HonuaZarrError(
          "invalid-response",
          "Zarr endpoint returned invalid JSON.",
          { path },
          { cause: error },
        );
      }
    } catch (error) {
      throw translateError(error);
    }
  }
}

export function createZarrClient(client: ZarrHonuaClient, options: ZarrClientOptions = {}): HonuaZarrClient {
  return new HonuaZarrClient(client, options);
}

function assessVariable(variable: ZarrVariableMetadata, failures: ZarrMaturityFailure[]): void {
  const spatialAxes = variable.dimensionNames.map((name) => name.toLowerCase());
  const xIndex = spatialAxes.findIndex((name) => name === "x" || name === "lon" || name === "longitude");
  const yIndex = spatialAxes.findIndex((name) => name === "y" || name === "lat" || name === "latitude");
  if (
    xIndex < 0 ||
    yIndex < 0 ||
    xIndex >= variable.shape.length ||
    yIndex >= variable.shape.length ||
    variable.shape[xIndex] === 0 ||
    variable.shape[yIndex] === 0
  ) {
    failures.push({
      code: "no-tileable-variable",
      variable: variable.name,
      message: `Variable "${variable.name}" does not expose non-empty X and Y axes for tile rendering.`,
    });
  }
  const codec = variable.compressor?.toLowerCase() ?? null;
  if (codec !== null && !SUPPORTED_CODECS.has(codec)) {
    failures.push({
      code: "unsupported-codec",
      variable: variable.name,
      message: `Variable "${variable.name}" uses unsupported codec "${variable.compressor}"; the server contract permits uncompressed, gzip, or zlib chunks.`,
    });
  }
  if (!isTileDtype(variable.dataType)) {
    failures.push({
      code: "unsupported-dtype",
      variable: variable.name,
      message: `Variable "${variable.name}" uses unsupported dtype "${variable.dataType}"; use a little-endian numeric or boolean dtype.`,
    });
  }
  if (
    variable.shape.length === 0 ||
    variable.shape.length !== variable.chunks.length ||
    variable.dimensionNames.length !== variable.shape.length
  ) {
    failures.push({
      code: "ambiguous-dimensions",
      variable: variable.name,
      message: `Variable "${variable.name}" does not expose one named dimension and chunk extent per shape axis.`,
    });
  }
}

function selectTileVariable(
  registration: ZarrStoreRegistration,
  variableName: string | undefined,
): ZarrVariableMetadata | undefined {
  const variables = registration.variables ?? [];
  const selected = variableName ?? registration.primaryVariable ?? variables[0]?.name;
  return selected === undefined ? undefined : variables.find((variable) => variable.name === selected);
}

function isTileDtype(dataType: string): boolean {
  const match = /^([<|=])([fiub])(1|2|4|8)$/.exec(dataType);
  if (!match) return false;
  const [, byteOrder, kind, width] = match;
  if (byteOrder === "|" && width !== "1") return false;
  if (kind === "f") return width === "4" || width === "8";
  if (kind === "b") return width === "1";
  return true;
}

function isUsableSpatialExtent(value: unknown): value is readonly [number, number, number, number] {
  if (!Array.isArray(value) || value.length !== 4 || value.some((coordinate) => !Number.isFinite(coordinate))) {
    return false;
  }
  const [minX, minY, maxX, maxY] = value as [number, number, number, number];
  return maxX > minX && maxY > minY;
}

async function boundedFetch(
  client: ZarrHonuaClient,
  method: "GET" | "POST" | "DELETE",
  path: string,
  body: RegisterZarrStoreRequest | undefined,
  accept: string,
  maxResponseBytes: number,
  signal?: AbortSignal,
): Promise<Response> {
  return client.pipelineFetch(
    method,
    path,
    {
      headers: { Accept: accept, ...(body ? { "Content-Type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    },
    signal,
    {
      errorBody: async (response, deadlineSignal) =>
        parseErrorBody(await readBounded(response, maxResponseBytes, deadlineSignal)),
      prepareResponse: async (response, deadlineSignal) => {
        const bytes = await readBounded(response, maxResponseBytes, deadlineSignal);
        return new Response(response.status === 204 ? null : bytes.slice().buffer, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        });
      },
    },
  );
}

async function readBounded(response: Response, limit: number, signal?: AbortSignal): Promise<Uint8Array> {
  const declared = response.headers.get("Content-Length");
  if (declared !== null) {
    const parsed = Number(declared);
    if (!Number.isSafeInteger(parsed) || parsed < 0) invalidResponse("Zarr response has an invalid Content-Length.");
    if (parsed > limit) {
      void response.body?.cancel().catch(() => undefined);
      throw responseTooLarge(limit, parsed);
    }
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  try {
    while (true) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > limit) {
        await reader.cancel();
        throw responseTooLarge(limit, received);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const result = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function normalizeRegistration(value: unknown): ZarrStoreRegistration {
  if (!isRecord(value)) invalidResponse("Zarr registration response must be an object.");
  const variables = value.variables;
  if (variables !== null && !Array.isArray(variables)) invalidResponse("Zarr variables must be an array or null.");
  const format = nullableInteger(value.zarrFormat, "zarrFormat");
  if (format !== null && format !== 2 && format !== 3) {
    throw new HonuaZarrError(
      "unsupported-version",
      `Zarr v${String(format)} is outside the versioned server contract.`,
      { zarrFormat: format },
    );
  }
  return Object.freeze({
    id: responsePositiveInteger(value.id, "id"),
    layerId: responseNonNegativeInteger(value.layerId, "layerId"),
    name: responseText(value.name, "name"),
    description: nullableText(value.description, "description"),
    provider: responseProvider(value.provider),
    bucket: responseText(value.bucket, "bucket"),
    rootPath: responseText(value.rootPath, "rootPath"),
    zarrFormat: format,
    srid: nullableInteger(value.srid, "srid"),
    variableCount: nullableNonNegativeInteger(value.variableCount, "variableCount"),
    primaryVariable: nullableText(value.primaryVariable, "primaryVariable"),
    variables: variables === null ? null : Object.freeze(variables.map(normalizeVariable)),
    metadataScannedAt: nullableText(value.metadataScannedAt, "metadataScannedAt"),
    createdAt: responseText(value.createdAt, "createdAt"),
  });
}

function normalizeVariable(value: unknown): ZarrVariableMetadata {
  if (!isRecord(value)) invalidResponse("Zarr variable entry must be an object.");
  return Object.freeze({
    name: responseText(value.name, "variable.name"),
    shape: nonNegativeIntegerArray(value.shape, "variable.shape"),
    chunks: integerArray(value.chunks, "variable.chunks"),
    dataType: responseText(value.dataType, "variable.dataType"),
    compressor: nullableText(value.compressor, "variable.compressor"),
    dimensionNames: textArray(value.dimensionNames, "variable.dimensionNames"),
  });
}

function validateRegistrationRequest(request: RegisterZarrStoreRequest): void {
  nonNegativeInteger(request.layerId, "layerId");
  requiredText(request.name, "name");
  requiredText(request.bucket, "bucket");
  const rootPath = requiredText(request.rootPath, "rootPath");
  if (rootPath.startsWith("/") || rootPath.includes("\\") || rootPath.includes("..")) {
    invalidRequest("rootPath must be a relative object key without traversal sequences.", { rootPath });
  }
  requestProvider(request.provider);
}

function versionedPath(value: string, field: string): string {
  const path = requiredText(value, field);
  if (!path.startsWith("/api/v1/")) invalidRequest(`${field} must use the versioned /api/v1 contract.`, { path });
  if (/^[a-z][a-z\d+.-]*:/i.test(path) || path.startsWith("//"))
    invalidRequest(`${field} must be a relative same-origin path.`, { path });
  let end = path.length;
  while (end > 0 && path.charCodeAt(end - 1) === 47) end--;
  return path.slice(0, end);
}

function resolveUrl(baseUrl: string, path: string): string {
  return `${baseUrl}${path}`;
}

function translateError(error: unknown): unknown {
  if (error instanceof HonuaZarrError) return error;
  if (error instanceof HonuaHttpError) {
    return new HonuaZarrServiceError(error.statusCode, error.message, error.body, { cause: error });
  }
  return error;
}

function parseErrorBody(bytes: Uint8Array): unknown {
  const text = new TextDecoder().decode(bytes);
  if (!text) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { raw: text };
  }
}

function responseTooLarge(limit: number, received: number): HonuaZarrError {
  return new HonuaZarrError("response-too-large", `Zarr response exceeded the ${limit}-byte ceiling.`, {
    limit,
    received,
  });
}

function invalidRequest(message: string, detail?: Readonly<Record<string, unknown>>): never {
  throw new HonuaZarrError("invalid-request", message, detail);
}

function invalidResponse(message: string): never {
  throw new HonuaZarrError("invalid-response", message);
}

function positiveByteLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0)
    invalidRequest("Response byte limits must be positive safe integers.");
  return value;
}

function positiveInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) invalidRequest(`${field} must be a positive integer.`);
  return value as number;
}

function responsePositiveInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) invalidResponse(`${field} must be a positive integer.`);
  return value as number;
}

function responseNonNegativeInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0)
    invalidResponse(`${field} must be a non-negative integer.`);
  return value as number;
}

function nonNegativeInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) invalidRequest(`${field} must be a non-negative integer.`);
  return value as number;
}

function nullableInteger(value: unknown, field: string): number | null {
  if (value === null) return null;
  if (!Number.isSafeInteger(value)) invalidResponse(`${field} must be an integer or null.`);
  return value as number;
}

function nullableNonNegativeInteger(value: unknown, field: string): number | null {
  const parsed = nullableInteger(value, field);
  if (parsed !== null && parsed < 0) invalidResponse(`${field} must be non-negative or null.`);
  return parsed;
}

function requiredText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") invalidRequest(`${field} must be a non-empty string.`);
  return (value as string).trim();
}

function responseText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") invalidResponse(`${field} must be a non-empty string.`);
  return (value as string).trim();
}

function nullableText(value: unknown, field: string): string | null {
  if (value === null) return null;
  if (typeof value !== "string") invalidResponse(`${field} must be a string or null.`);
  return value as string;
}

function integerArray(value: unknown, field: string): readonly number[] {
  if (!Array.isArray(value) || value.some((entry) => !Number.isSafeInteger(entry) || entry <= 0)) {
    invalidResponse(`${field} must be an array of positive integers.`);
  }
  return Object.freeze([...(value as number[])]);
}

function nonNegativeIntegerArray(value: unknown, field: string): readonly number[] {
  if (!Array.isArray(value) || value.some((entry) => !Number.isSafeInteger(entry) || entry < 0)) {
    invalidResponse(`${field} must be an array of non-negative integers.`);
  }
  return Object.freeze([...(value as number[])]);
}

function textArray(value: unknown, field: string): readonly string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || entry.trim() === "")) {
    invalidResponse(`${field} must be an array of non-empty strings.`);
  }
  return Object.freeze([...(value as string[])]);
}

function requestProvider(value: unknown): RegisterZarrStoreRequest["provider"] {
  if (typeof value !== "string" || !SUPPORTED_PROVIDERS.has(value)) {
    invalidRequest("provider must be AwsS3, AzureBlob, or Local.");
  }
  return value as RegisterZarrStoreRequest["provider"];
}

function responseProvider(value: unknown): RegisterZarrStoreRequest["provider"] {
  if (typeof value !== "string" || !SUPPORTED_PROVIDERS.has(value)) {
    invalidResponse("provider must be AwsS3, AzureBlob, or Local.");
  }
  return value as RegisterZarrStoreRequest["provider"];
}

function append(params: URLSearchParams, key: string, value: string | undefined): void {
  if (value !== undefined) params.set(key, requiredText(value, key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
