import { HonuaHttpError } from "../core/errors.js";
import { HonuaCoverageError, HonuaCoverageServiceError, HonuaWcsExceptionError } from "./errors.js";
import type {
  CoverageAxis,
  CoverageAxisSubset,
  CoverageClientOptions,
  CoverageCollection,
  CoverageCollections,
  CoverageConformance,
  CoverageDomainSet,
  CoverageFormat,
  CoverageHonuaClient,
  CoverageLandingPage,
  CoverageRangeField,
  CoverageRangeType,
  CoverageRequest,
  CoverageResult,
  CoverageServiceDescription,
  CoverageSource,
  WcsCapabilities,
  WcsCapabilitiesRequest,
  WcsClientOptions,
  WcsCoverageDescription,
  WcsGetCoverageRequest,
} from "./types.js";

const DEFAULT_COVERAGE_BYTES = 32 * 1024 * 1024;
const DEFAULT_METADATA_BYTES = 2 * 1024 * 1024;

export class HonuaCoverageClient {
  private readonly basePath: string;
  private readonly maxResponseBytes: number;
  private readonly maxMetadataResponseBytes: number;

  public constructor(
    private readonly client: CoverageHonuaClient,
    options: CoverageClientOptions = {},
  ) {
    this.basePath = normalizeSameOriginPath(client.serverBaseUrl, options.basePath ?? "/ogc/coverages");
    this.maxResponseBytes = positiveByteLimit(options.maxResponseBytes ?? DEFAULT_COVERAGE_BYTES);
    this.maxMetadataResponseBytes = positiveByteLimit(options.maxMetadataResponseBytes ?? DEFAULT_METADATA_BYTES);
  }

  public async landing(options: { readonly signal?: AbortSignal } = {}): Promise<CoverageLandingPage> {
    return this.json<CoverageLandingPage>(this.basePath, options.signal);
  }

  public async conformance(options: { readonly signal?: AbortSignal } = {}): Promise<CoverageConformance> {
    return this.json<CoverageConformance>(`${this.basePath}/conformance`, options.signal);
  }

  public async collections(options: { readonly signal?: AbortSignal } = {}): Promise<CoverageCollections> {
    const result = await this.json<CoverageCollections>(`${this.basePath}/collections`, options.signal);
    if (!Array.isArray(result.collections)) {
      throw new HonuaCoverageError("invalid-response", "Coverage collections response has no collections array.");
    }
    return result;
  }

  public async discover(options: { readonly signal?: AbortSignal } = {}): Promise<CoverageServiceDescription> {
    const landing = await this.landing(options);
    const [conformance, collections] = await Promise.all([this.conformance(options), this.collections(options)]);
    return { landing, conformance, collections: collections.collections };
  }

  public async collection(
    collectionId: string,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<CoverageCollection> {
    const id = requiredIdentifier(collectionId, "collectionId");
    return this.json<CoverageCollection>(`${this.basePath}/collections/${encodeURIComponent(id)}`, options.signal);
  }

  public async domainSet(
    collectionId: string,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<CoverageDomainSet> {
    return normalizeDomain(await this.collection(collectionId, options));
  }

  public async rangeType(
    collectionId: string,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<CoverageRangeType> {
    const id = requiredIdentifier(collectionId, "collectionId");
    const schema = await this.json<Readonly<Record<string, unknown>>>(
      `${this.basePath}/collections/${encodeURIComponent(id)}/schema`,
      options.signal,
    );
    return normalizeRange(id, schema);
  }

  public source(collectionId: string): CoverageSource {
    const id = requiredIdentifier(collectionId, "collectionId");
    return {
      id,
      collection: (options) => this.collection(id, options),
      domainSet: (options) => this.domainSet(id, options),
      rangeType: (options) => this.rangeType(id, options),
      coverage: (request) => this.getCoverage(id, request),
    };
  }

  public async getCoverage(collectionId: string, request: CoverageRequest): Promise<CoverageResult> {
    const id = requiredIdentifier(collectionId, "collectionId");
    assertBoundedCoverageRequest(request);
    const params = new URLSearchParams();
    appendBbox(params, request.bbox);
    append(params, "bbox-crs", request.bboxCrs);
    append(params, "crs", request.outputCrs);
    for (const subset of request.subsets ?? []) params.append("subset", serializeSubset(subset));
    append(params, "datetime", request.datetime);
    if (request.properties?.length) params.set("properties", request.properties.map(requiredProperty).join(","));
    appendOgcScaling(params, request);
    const format = request.format ?? "image/tiff";
    params.set("f", ogcFormatToken(format));
    const path = withQuery(`${this.basePath}/collections/${encodeURIComponent(id)}/coverage`, params);
    return this.binary(
      path,
      format,
      request.maxResponseBytes ?? this.maxResponseBytes,
      request.signal,
      "ogc-coverages",
    );
  }

  public wcs(options: WcsClientOptions): HonuaWcsClient {
    return new HonuaWcsClient(this.client, options);
  }

  private async json<T>(path: string, signal?: AbortSignal): Promise<T> {
    try {
      const response = await boundedFetch(this.client, path, "application/json", this.maxMetadataResponseBytes, signal);
      try {
        return JSON.parse(new TextDecoder().decode(await response.arrayBuffer())) as T;
      } catch (error) {
        throw new HonuaCoverageError(
          "invalid-response",
          "Coverage service returned invalid JSON.",
          { path },
          { cause: error },
        );
      }
    } catch (error) {
      throw translateServiceError(error, "ogc-coverages");
    }
  }

  private async binary(
    path: string,
    accept: string,
    maxResponseBytes: number,
    signal: AbortSignal | undefined,
    protocol: "ogc-coverages" | "wcs",
  ): Promise<CoverageResult> {
    try {
      const response = await boundedFetch(this.client, path, accept, positiveByteLimit(maxResponseBytes), signal);
      const contentType = response.headers.get("Content-Type")?.split(";", 1)[0]?.trim().toLowerCase() || accept;
      if (contentType.includes("xml")) {
        const xml = new TextDecoder().decode(await response.arrayBuffer());
        const exception = parseWcsException(xml);
        if (exception)
          throw new HonuaWcsExceptionError(exception.code, exception.locator, exception.message, response.status);
        throw new HonuaCoverageError("invalid-response", `${protocol} returned XML instead of a coverage body.`, {
          path,
        });
      }
      return {
        bytes: new Uint8Array(await response.arrayBuffer()),
        contentType,
        ...(response.headers.get("Content-Disposition")
          ? { contentDisposition: response.headers.get("Content-Disposition") ?? undefined }
          : {}),
        requestUrl: new URL(path, `${this.client.serverBaseUrl}/`).toString(),
      };
    } catch (error) {
      throw translateServiceError(error, protocol);
    }
  }
}

export class HonuaWcsClient {
  private readonly basePath: string;
  private readonly version: "2.0.1";
  private readonly maxResponseBytes: number;
  private readonly maxMetadataResponseBytes: number;

  public constructor(
    private readonly client: CoverageHonuaClient,
    options: WcsClientOptions,
  ) {
    this.basePath = normalizeSameOriginPath(client.serverBaseUrl, options.basePath);
    this.version = options.version ?? "2.0.1";
    this.maxResponseBytes = positiveByteLimit(options.maxResponseBytes ?? DEFAULT_COVERAGE_BYTES);
    this.maxMetadataResponseBytes = positiveByteLimit(options.maxMetadataResponseBytes ?? DEFAULT_METADATA_BYTES);
  }

  public async capabilities(request: WcsCapabilitiesRequest = {}): Promise<WcsCapabilities> {
    const params = this.operation("GetCapabilities");
    if (request.acceptVersions?.length) params.set("ACCEPTVERSIONS", request.acceptVersions.join(","));
    if (request.sections?.length) params.set("SECTIONS", request.sections.join(","));
    if (request.acceptFormats?.length) params.set("ACCEPTFORMATS", request.acceptFormats.join(","));
    const xml = await this.xml(withQuery(this.basePath, params), request.signal);
    return parseWcsCapabilities(xml);
  }

  public async describeCoverage(
    coverageIds: readonly string[],
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<readonly WcsCoverageDescription[]> {
    if (coverageIds.length === 0) {
      throw new HonuaCoverageError("invalid-request", "DescribeCoverage requires at least one coverage ID.");
    }
    const params = this.operation("DescribeCoverage");
    params.set("COVERAGEID", coverageIds.map((id) => requiredIdentifier(id, "coverageId")).join(","));
    return parseWcsCoverageDescriptions(await this.xml(withQuery(this.basePath, params), options.signal));
  }

  public async getCoverage(coverageId: string, request: WcsGetCoverageRequest): Promise<CoverageResult> {
    assertBoundedCoverageRequest(request);
    if (request.bbox && request.subsets?.length) {
      throw new HonuaCoverageError("invalid-request", "WCS BBOX and SUBSET are mutually exclusive.");
    }
    if (request.bboxCrs && request.subsettingCrs && request.bboxCrs !== request.subsettingCrs) {
      throw new HonuaCoverageError(
        "invalid-request",
        "WCS BBOXCRS and SUBSETTINGCRS must match when both are supplied.",
      );
    }
    const params = this.operation("GetCoverage");
    params.set("COVERAGEID", requiredIdentifier(coverageId, "coverageId"));
    appendBbox(params, request.bbox, "BBOX");
    append(params, "BBOXCRS", request.bboxCrs);
    for (const subset of request.subsets ?? []) params.append("SUBSET", serializeSubset(subset));
    append(params, "SUBSETTINGCRS", request.subsettingCrs);
    append(params, "OUTPUTCRS", request.outputCrs);
    if (request.rangeSubset?.length) params.set("RANGESUBSET", request.rangeSubset.map(requiredProperty).join(","));
    appendWcsScaling(params, request);
    append(params, "INTERPOLATION", request.interpolation);
    append(params, "DATETIME", request.datetime);
    const format = request.format ?? "image/tiff";
    params.set("FORMAT", format);
    return this.binary(
      withQuery(this.basePath, params),
      format,
      request.maxResponseBytes ?? this.maxResponseBytes,
      request.signal,
    );
  }

  private operation(request: string): URLSearchParams {
    return new URLSearchParams({ SERVICE: "WCS", VERSION: this.version, REQUEST: request });
  }

  private async xml(path: string, signal?: AbortSignal): Promise<string> {
    try {
      const response = await boundedFetch(
        this.client,
        path,
        "application/xml,text/xml;q=0.9",
        this.maxMetadataResponseBytes,
        signal,
      );
      const xml = new TextDecoder().decode(await response.arrayBuffer());
      const exception = parseWcsException(xml);
      if (exception)
        throw new HonuaWcsExceptionError(exception.code, exception.locator, exception.message, response.status);
      return xml;
    } catch (error) {
      throw translateServiceError(error, "wcs");
    }
  }

  private async binary(
    path: string,
    accept: string,
    maxResponseBytes: number,
    signal?: AbortSignal,
  ): Promise<CoverageResult> {
    try {
      const response = await boundedFetch(this.client, path, accept, positiveByteLimit(maxResponseBytes), signal);
      const contentType = response.headers.get("Content-Type")?.split(";", 1)[0]?.trim().toLowerCase() || accept;
      if (contentType.includes("xml")) {
        const xml = new TextDecoder().decode(await response.arrayBuffer());
        const exception = parseWcsException(xml);
        if (exception)
          throw new HonuaWcsExceptionError(exception.code, exception.locator, exception.message, response.status);
        throw new HonuaCoverageError("invalid-response", "WCS returned XML instead of a coverage body.", { path });
      }
      return {
        bytes: new Uint8Array(await response.arrayBuffer()),
        contentType,
        ...(response.headers.get("Content-Disposition")
          ? { contentDisposition: response.headers.get("Content-Disposition") ?? undefined }
          : {}),
        requestUrl: new URL(path, `${this.client.serverBaseUrl}/`).toString(),
      };
    } catch (error) {
      throw translateServiceError(error, "wcs");
    }
  }
}

export function createCoverageClient(
  client: CoverageHonuaClient,
  options: CoverageClientOptions = {},
): HonuaCoverageClient {
  return new HonuaCoverageClient(client, options);
}

export function createWcsClient(client: CoverageHonuaClient, options: WcsClientOptions): HonuaWcsClient {
  return new HonuaWcsClient(client, options);
}

async function boundedFetch(
  client: CoverageHonuaClient,
  path: string,
  accept: string,
  maxResponseBytes: number,
  signal?: AbortSignal,
): Promise<Response> {
  return client.pipelineFetch("GET", path, { headers: { Accept: accept } }, signal, {
    prepareResponse: async (response, deadlineSignal) => {
      const bytes = await readBoundedBytes(response, maxResponseBytes, deadlineSignal);
      return new Response(ownedArrayBuffer(bytes), {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    },
  });
}

async function readBoundedBytes(
  response: Response,
  maxResponseBytes: number,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  const declared = response.headers.get("Content-Length");
  if (declared !== null) {
    const parsed = Number(declared);
    if (!Number.isSafeInteger(parsed) || parsed < 0) {
      throw new HonuaCoverageError("invalid-response", "Coverage response has an invalid Content-Length.", {
        declared,
      });
    }
    if (parsed > maxResponseBytes) {
      void response.body?.cancel().catch(() => undefined);
      throw tooLarge(maxResponseBytes, parsed);
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
      if (received > maxResponseBytes) {
        await reader.cancel();
        throw tooLarge(maxResponseBytes, received);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function tooLarge(limit: number, received: number): HonuaCoverageError {
  return new HonuaCoverageError("response-too-large", `Coverage response exceeds the ${limit}-byte limit.`, {
    maxResponseBytes: limit,
    receivedBytes: received,
  });
}

function translateServiceError(error: unknown, protocol: "ogc-coverages" | "wcs"): unknown {
  if (error instanceof HonuaCoverageError) return error;
  if (!(error instanceof HonuaHttpError)) return error;
  const rawBody =
    typeof error.body === "string"
      ? error.body
      : isRecord(error.body) && typeof error.body.raw === "string"
        ? error.body.raw
        : undefined;
  if (protocol === "wcs" && rawBody) {
    const exception = parseWcsException(rawBody);
    if (exception) {
      return new HonuaWcsExceptionError(exception.code, exception.locator, exception.message, error.statusCode, {
        cause: error,
      });
    }
  }
  return new HonuaCoverageServiceError(error.statusCode, error.message, error.body, { cause: error });
}

function normalizeDomain(collection: CoverageCollection): CoverageDomainSet {
  const raw = isRecord(collection.domain) ? collection.domain : {};
  const grid = isRecord(collection.grid) ? collection.grid : undefined;
  const axes: CoverageAxis[] = [];
  const rawAxes = isRecord(raw.axes) ? raw.axes : undefined;
  if (rawAxes) {
    for (const [name, value] of Object.entries(rawAxes)) axes.push(normalizeAxis(name, value));
  } else if (grid && Array.isArray(grid.axisLabels)) {
    for (const name of grid.axisLabels) if (typeof name === "string") axes.push({ name });
  }
  const spatial = isRecord(collection.extent?.spatial) ? collection.extent.spatial : undefined;
  const bboxValue = Array.isArray(spatial?.bbox) ? spatial.bbox[0] : undefined;
  const bbox =
    Array.isArray(bboxValue) && bboxValue.every((value) => typeof value === "number") ? bboxValue : undefined;
  return {
    collectionId: collection.id,
    ...(collection.storageCrs ? { crs: collection.storageCrs } : {}),
    ...(bbox ? { bbox } : {}),
    axes,
    ...(grid ? { grid } : {}),
    raw,
  };
}

function normalizeAxis(name: string, value: unknown): CoverageAxis {
  if (!isRecord(value)) return { name, raw: value };
  const values = Array.isArray(value.values) ? value.values.filter(isCoverageScalar) : undefined;
  return {
    name,
    ...(isCoverageScalar(value.lower) ? { lower: value.lower } : {}),
    ...(isCoverageScalar(value.upper) ? { upper: value.upper } : {}),
    ...(values?.length ? { values } : {}),
    ...(typeof value.resolution === "number" ? { resolution: value.resolution } : {}),
    raw: value,
  };
}

function normalizeRange(collectionId: string, schema: Readonly<Record<string, unknown>>): CoverageRangeType {
  const properties = isRecord(schema.properties) ? schema.properties : {};
  const fields = Object.entries(properties).map(([name, value]) => normalizeRangeField(name, value));
  return { collectionId, fields, raw: schema };
}

function normalizeRangeField(name: string, value: unknown): CoverageRangeField {
  const raw = isRecord(value) ? value : {};
  const noDataCandidate = raw.noData ?? raw.nodata ?? raw["x-ogc-nodata"] ?? raw.nilValues;
  const noData = Array.isArray(noDataCandidate)
    ? noDataCandidate.filter(isCoverageScalar)
    : isCoverageScalar(noDataCandidate)
      ? [noDataCandidate]
      : undefined;
  return {
    name,
    ...(typeof raw.title === "string" ? { title: raw.title } : {}),
    ...(typeof raw.description === "string" ? { description: raw.description } : {}),
    ...(typeof raw.type === "string"
      ? { dataType: raw.type }
      : typeof raw.dataType === "string"
        ? { dataType: raw.dataType }
        : {}),
    ...(noData?.length ? { noData } : {}),
    raw,
  };
}

function appendOgcScaling(params: URLSearchParams, request: CoverageRequest): void {
  const supplied = [
    request.resolution !== undefined,
    request.scaleFactor !== undefined,
    request.scaleSize !== undefined,
  ].filter(Boolean).length;
  if (supplied > 1) throw new HonuaCoverageError("invalid-request", "Choose only one coverage scaling method.");
  if (request.resolution !== undefined) {
    const values = typeof request.resolution === "number" ? [request.resolution] : request.resolution;
    params.set("resolution", values.map(positiveNumber).join(","));
  }
  if (request.scaleFactor !== undefined) params.set("scale-factor", String(positiveNumber(request.scaleFactor)));
  if (request.scaleSize) {
    params.set(
      "scale-size",
      `x(${positiveInteger(request.scaleSize.width)}),y(${positiveInteger(request.scaleSize.height)})`,
    );
  }
}

function appendWcsScaling(params: URLSearchParams, request: WcsGetCoverageRequest): void {
  const supplied = [
    request.scaleSize !== undefined,
    request.scaleFactor !== undefined,
    request.scaleAxes !== undefined,
    request.scaleExtent !== undefined,
  ].filter(Boolean).length;
  if (supplied > 1) throw new HonuaCoverageError("invalid-request", "Choose only one WCS scaling method.");
  if (request.scaleSize) params.set("SCALESIZE", serializeAxisMap(request.scaleSize, positiveInteger));
  if (request.scaleFactor !== undefined) params.set("SCALEFACTOR", String(positiveNumber(request.scaleFactor)));
  if (request.scaleAxes) params.set("SCALEAXES", serializeAxisMap(request.scaleAxes, positiveNumber));
  if (request.scaleExtent?.length) params.set("SCALEEXTENT", request.scaleExtent.map(serializeSubset).join(","));
}

function serializeAxisMap(values: Readonly<Record<string, number>>, validate: (value: number) => number): string {
  const entries = Object.entries(values);
  if (entries.length === 0) throw new HonuaCoverageError("invalid-request", "A WCS axis scale cannot be empty.");
  return entries.map(([axis, value]) => `${requiredAxis(axis)}(${validate(value)})`).join(",");
}

function assertBoundedCoverageRequest(request: {
  readonly bbox?: readonly number[];
  readonly subsets?: readonly CoverageAxisSubset[];
  readonly scaleSize?: unknown;
  readonly scaleFactor?: number;
  readonly allowFullCoverage?: boolean;
}): void {
  if (
    request.allowFullCoverage !== true &&
    !request.bbox &&
    !request.subsets?.length &&
    request.scaleSize === undefined &&
    request.scaleFactor === undefined
  ) {
    throw new HonuaCoverageError(
      "invalid-request",
      "Coverage downloads require bbox, subset, or scaling bounds. Set allowFullCoverage only for an intentional full download.",
    );
  }
}

function appendBbox(
  params: URLSearchParams,
  bbox: readonly [number, number, number, number] | undefined,
  key = "bbox",
): void {
  if (!bbox) return;
  if (bbox.length !== 4 || bbox.some((value) => !Number.isFinite(value))) {
    throw new HonuaCoverageError("invalid-request", `${key} must contain four finite numbers.`);
  }
  params.set(key, bbox.join(","));
}

function serializeSubset(subset: CoverageAxisSubset): string {
  const axis = requiredAxis(subset.axis);
  const low = serializeScalar(subset.low);
  return subset.high === undefined ? `${axis}(${low})` : `${axis}(${low},${serializeScalar(subset.high)})`;
}

function serializeScalar(value: string | number): string {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new HonuaCoverageError("invalid-request", "Axis bounds must be finite.");
    return String(value);
  }
  if (!value.trim()) throw new HonuaCoverageError("invalid-request", "Axis bounds cannot be empty.");
  return JSON.stringify(value);
}

function requiredAxis(value: string): string {
  const axis = requiredIdentifier(value, "axis");
  if (!/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(axis)) {
    throw new HonuaCoverageError("invalid-request", `Invalid coverage axis name: ${axis}`);
  }
  return axis;
}

function requiredProperty(value: string): string {
  return requiredIdentifier(value, "property");
}

function requiredIdentifier(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new HonuaCoverageError("invalid-request", `${label} cannot be empty.`);
  return normalized;
}

function positiveNumber(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new HonuaCoverageError("invalid-request", "Scale and resolution values must be positive finite numbers.");
  }
  return value;
}

function positiveInteger(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 8192) {
    throw new HonuaCoverageError("invalid-request", "Scale sizes must be integers from 1 through 8192.");
  }
  return value;
}

function positiveByteLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new HonuaCoverageError("invalid-request", "maxResponseBytes must be a positive safe integer.");
  }
  return value;
}

function ogcFormatToken(format: CoverageFormat): string {
  if (format === "image/tiff") return "geotiff";
  if (format === "image/png") return "png";
  throw new HonuaCoverageError("unsupported-format", `Unsupported OGC coverage format: ${String(format)}`);
}

function append(params: URLSearchParams, key: string, value: string | undefined): void {
  if (value !== undefined) params.set(key, value);
}

function withQuery(path: string, params: URLSearchParams): string {
  const query = params.toString();
  return query ? `${path}?${query}` : path;
}

function normalizeSameOriginPath(serverBaseUrl: string, value: string): string {
  const server = new URL(`${serverBaseUrl.replace(/\/$/, "")}/`);
  const endpoint = new URL(value, server);
  if (endpoint.origin !== server.origin) {
    throw new HonuaCoverageError(
      "invalid-request",
      "Coverage endpoints must share the HonuaClient origin so auth and request hooks remain active.",
      { endpoint: endpoint.toString(), serverOrigin: server.origin },
    );
  }
  return `${endpoint.pathname.replace(/\/$/, "")}${endpoint.search}`;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCoverageScalar(value: unknown): value is string | number {
  return typeof value === "string" || (typeof value === "number" && Number.isFinite(value));
}

function parseWcsCapabilities(xml: string): WcsCapabilities {
  const root = xml.match(/<(?:[\w.-]+:)?Capabilities\b[^>]*\bversion=["']([^"']+)["']/i);
  return {
    version: root?.[1] ?? "2.0.1",
    ...(firstElement(xml, "Title") ? { title: firstElement(xml, "Title") } : {}),
    operations: unique(attributeValues(xml, "Operation", "name")),
    coverageIds: unique(elementValues(xml, "CoverageId")),
    formats: unique([...elementValues(xml, "formatSupported"), ...elementValues(xml, "FormatSupported")]),
    crs: unique([...elementValues(xml, "crsSupported"), ...elementValues(xml, "CrsSupported")]),
    rawXml: xml,
  };
}

function parseWcsCoverageDescriptions(xml: string): readonly WcsCoverageDescription[] {
  const blocks = xml.match(/<(?:[\w.-]+:)?CoverageDescription\b[\s\S]*?<\/(?:[\w.-]+:)?CoverageDescription>/gi) ?? [];
  return blocks.map((block) => {
    const coverageId = firstElement(block, "CoverageId");
    if (!coverageId) throw new HonuaCoverageError("invalid-response", "WCS DescribeCoverage omitted CoverageId.");
    const envelope = block.match(/<(?:[\w.-]+:)?Envelope\b([^>]*)>/i);
    const axisLabels =
      attributeValue(envelope?.[1] ?? "", "axisLabels")
        ?.split(/\s+/)
        .filter(Boolean) ?? [];
    const lowerCorner = firstElement(block, "lowerCorner")?.split(/\s+/).map(parseScalar);
    const upperCorner = firstElement(block, "upperCorner")?.split(/\s+/).map(parseScalar);
    const fieldMatches = [
      ...block.matchAll(/<(?:[\w.-]+:)?field\b[^>]*\bname=["']([^"']+)["'][^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?field>/gi),
    ];
    const fields = fieldMatches.map((match) => {
      const rawXml = match[2] ?? "";
      const noData = elementValues(rawXml, "nilValue").map(parseScalar);
      return {
        name: decodeXml(match[1] ?? ""),
        ...(firstElement(rawXml, "label") ? { title: firstElement(rawXml, "label") } : {}),
        ...(noData.length ? { noData } : {}),
        raw: { xml: rawXml },
      } satisfies CoverageRangeField;
    });
    const noData = unique(elementValues(block, "nilValue")).map(parseScalar);
    return {
      coverageId,
      ...(attributeValue(envelope?.[1] ?? "", "srsName")
        ? { crs: attributeValue(envelope?.[1] ?? "", "srsName") }
        : {}),
      axisLabels,
      ...(lowerCorner ? { lowerCorner } : {}),
      ...(upperCorner ? { upperCorner } : {}),
      fields,
      noData,
      rawXml: block,
    };
  });
}

function parseWcsException(xml: string): { code: string; locator?: string; message: string } | undefined {
  const exception = xml.match(/<(?:[\w.-]+:)?Exception\b([^>]*)>/i);
  if (!exception) return undefined;
  const attributes = exception[1] ?? "";
  const code = attributeValue(attributes, "exceptionCode") ?? "NoApplicableCode";
  const locator = attributeValue(attributes, "locator");
  const message = firstElement(xml, "ExceptionText") ?? `WCS request failed with ${code}.`;
  return { code, ...(locator ? { locator } : {}), message };
}

function elementValues(xml: string, localName: string): string[] {
  const expression = new RegExp(
    `<(?:[\\w.-]+:)?${localName}\\b[^>]*>([\\s\\S]*?)<\\/(?:[\\w.-]+:)?${localName}>`,
    "gi",
  );
  return [...xml.matchAll(expression)].map((match) => decodeXml(stripTags(match[1] ?? "").trim()));
}

function firstElement(xml: string, localName: string): string | undefined {
  return elementValues(xml, localName)[0];
}

function attributeValues(xml: string, localName: string, attribute: string): string[] {
  const expression = new RegExp(`<(?:[\\w.-]+:)?${localName}\\b([^>]*)>`, "gi");
  return [...xml.matchAll(expression)]
    .map((match) => attributeValue(match[1] ?? "", attribute))
    .filter((value): value is string => value !== undefined);
}

function attributeValue(attributes: string, name: string): string | undefined {
  const match = attributes.match(new RegExp(`\\b${name}=["']([^"']*)["']`, "i"));
  return match?.[1] === undefined ? undefined : decodeXml(match[1]);
}

function stripTags(value: string): string {
  const text: string[] = [];
  let insideTag = false;
  for (const character of value) {
    if (character === "<") {
      insideTag = true;
    } else if (character === ">") {
      insideTag = false;
    } else if (!insideTag) {
      text.push(character);
    }
  }
  return text.join("");
}

function decodeXml(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function parseScalar(value: string): string | number {
  const number = Number(value);
  return value.trim() !== "" && Number.isFinite(number) ? number : value;
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function ownedArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}
