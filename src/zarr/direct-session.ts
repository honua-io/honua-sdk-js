import type { CogDataType, CogSampleArray } from "../cog/types.js";
import { HonuaAbortError } from "../core/errors.js";
import { type ParsedArray, type ParsedStore, axisRole, discoverZarrStore } from "./direct-metadata.js";
import { ZarrObjectTransport } from "./direct-transport.js";
import type {
  OpenDirectZarrStoreOptions,
  ZarrAxisRole,
  ZarrChunkCodec,
  ZarrDirectBand,
  ZarrDirectCapability,
  ZarrDirectDimension,
  ZarrDirectInspection,
  ZarrDirectLimitOptions,
  ZarrDirectLimits,
  ZarrDirectProgress,
  ZarrDirectSubsetRequest,
  ZarrDirectSubsetResult,
  ZarrDirectWindowRequest,
  ZarrDirectWindowResult,
  ZarrFidelity,
  ZarrMapLibreCoordinates,
  ZarrMapLibreHandoff,
  ZarrPixelWindow,
  ZarrProvenance,
} from "./direct-types.js";
import { HonuaZarrError } from "./errors.js";

const KIB = 1024;
const MIB = 1024 * KIB;

/** Hard ceilings from the reviewed multidimensional contract. Callers cannot raise them. */
export const ZARR_DIRECT_LIMIT_CEILINGS: ZarrDirectLimits = Object.freeze({
  maxMetadataRequests: 256,
  maxChunkRequests: 4096,
  maxRequests: 256 + 4096,
  maxMetadataBytes: 64 * KIB,
  maxRangeBytes: 16 * MIB,
  maxTotalBytes: 256 * MIB,
  maxDecodedBytes: 256 * MIB,
  maxPixels: 16_777_216,
  maxChunks: 4096,
});

/** Defaults sit inside the reviewed ceilings. */
export const ZARR_DIRECT_DEFAULT_LIMITS: ZarrDirectLimits = Object.freeze({
  maxMetadataRequests: 96,
  maxChunkRequests: 256,
  maxRequests: 96 + 256,
  maxMetadataBytes: 64 * KIB,
  maxRangeBytes: 8 * MIB,
  maxTotalBytes: 32 * MIB,
  maxDecodedBytes: 32 * MIB,
  maxPixels: 4_194_304,
  maxChunks: 256,
});

/**
 * Structural support is not a promise that every array in a store can be read.
 * Codec and layout refusals stay distinct from this matrix.
 * Server-facade planning and live execution are a separate contract.
 */
export const ZARR_DIRECT_CAPABILITY: ZarrDirectCapability = Object.freeze({
  versions: Object.freeze([2, 3] as const),
  layouts: Object.freeze([
    "v2-c-order-regular",
    "v3-regular-grid",
    "v3-default-chunk-keys",
    "v3-v2-chunk-keys",
    "v2-dotted-or-slash-keys",
  ]),
  codecs: Object.freeze(["uncompressed", "zlib", "gzip", "bytes-little-endian"]),
  refusedCodecs: Object.freeze(["blosc", "zstd", "sharding_indexed", "crc32c"]),
  refusedLayouts: Object.freeze([
    "fortran-order",
    "v2-filters",
    "non-regular-grid",
    "big-endian",
    "unknown-chunk-key-encoding",
  ]),
  serverExecution: "separately-owned" as const,
});

const BUILTIN_V2 = new Set(["zlib"]);

interface AxisPlan {
  readonly array: ParsedArray;
  readonly roles: readonly ZarrAxisRole[];
  readonly start: readonly number[];
  readonly stop: readonly number[];
  readonly pixel: ZarrPixelWindow;
  readonly chunks: readonly { readonly index: readonly number[]; readonly key: string }[];
}

/** Open a reviewed Zarr store on static HTTP or object storage. No Honua Server is contacted. */
export function openDirectZarrStore(options: OpenDirectZarrStoreOptions): DirectZarrSession {
  return new DirectZarrSession(options);
}

export class DirectZarrSession {
  private readonly transport: ZarrObjectTransport;
  private readonly codecs: ReadonlyMap<string, ZarrChunkCodec>;
  private readonly variableName: string | undefined;
  private readonly cacheKey: string | undefined;
  private readonly sessionSignal: AbortSignal | undefined;
  private readonly onProgress: ((event: ZarrDirectProgress) => void) | undefined;
  private inspection: Promise<ZarrDirectInspection> | undefined;
  private store: ParsedStore | undefined;
  private identity: string | undefined;
  private disposed = false;

  /** @internal Use openDirectZarrStore so URL and budget checks happen before discovery. */
  public constructor(options: OpenDirectZarrStoreOptions) {
    const limits = normalizeZarrDirectLimits(options.limits);
    const fetchFn = options.fetchFn ?? globalThis.fetch.bind(globalThis);
    this.transport = new ZarrObjectTransport(options.url, fetchFn, limits);
    this.codecs = codecMap(options.codecs);
    this.variableName = options.variable;
    this.cacheKey = options.cacheKey;
    this.sessionSignal = options.signal;
    this.onProgress = options.onProgress;
  }

  /** Discover reviewed metadata. Unsupported selected arrays fail here, before any chunk request. */
  async inspect(options: { readonly signal?: AbortSignal } = {}): Promise<ZarrDirectInspection> {
    this.assertOpen();
    const signal = linkSignals(this.sessionSignal, options.signal);
    if (signal.aborted) {
      this.emit("aborted", 0, 0);
      throw new HonuaAbortError("Direct Zarr read was cancelled.");
    }
    if (!this.inspection) {
      this.inspection = this.loadInspection(signal).catch((error: unknown) => {
        this.inspection = undefined;
        throw error;
      });
    }
    return this.inspection;
  }

  /**
   * Read one geographic or index window into native little-endian samples.
   * Omitted spatial bounds are refused. int64 and uint64 stay on readSubset.
   */
  async readWindow(
    request: ZarrDirectWindowRequest,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<ZarrDirectWindowResult> {
    this.assertOpen();
    const signal = linkSignals(this.sessionSignal, options.signal);
    throwIfAborted(signal);
    const inspection = await this.inspect({ signal });
    const plans = this.planWindow(inspection, request);
    for (const plan of plans) {
      if (!rasterDtype(plan.array.dtype)) {
        this.refuse(0);
        throw new HonuaZarrError(
          "unsupported-dtype",
          `Zarr variable "${plan.array.name}" cannot be returned as a raster sample array.`,
          refusalDetail(plan.array, "unsupported-dtype", "unsupported"),
        );
      }
    }
    const [firstPlan, ...restPlans] = plans;
    if (!firstPlan) throw new HonuaZarrError("invalid-request", "The Zarr window does not select a variable.");
    if (
      restPlans.some(
        (plan) => plan.pixel.width !== firstPlan.pixel.width || plan.pixel.height !== firstPlan.pixel.height,
      )
    ) {
      throw new HonuaZarrError("invalid-request", "Stacked Zarr variables must share the requested width and height.");
    }
    const decoded = await this.readPlans(plans, signal);
    const bands = plans.map((plan, index) => ({
      band: bandNumber(inspection, request, plan, index),
      values: extractPlane(decoded[index] ?? new Uint8Array(), plan),
    }));
    const first = firstPlan;
    const provenance = this.provenance(
      first.array,
      plans.flatMap((plan) => plan.chunks.map((chunk) => chunk.key)),
    );
    return {
      request,
      variable: first.array.name,
      width: first.pixel.width,
      height: first.pixel.height,
      dtype: first.array.dtype,
      nodata: first.array.fillValue,
      bands,
      pixel: first.pixel,
      fidelity: fidelityFor(first.array, inspection),
      provenance,
      transfer: this.transport.snapshot(),
      cacheIdentity: this.requireIdentity(),
    };
  }

  /** Read an explicit index hyper-rectangle. The result is native C-order bytes, including int64. */
  async readSubset(
    request: ZarrDirectSubsetRequest,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<ZarrDirectSubsetResult> {
    this.assertOpen();
    const signal = linkSignals(this.sessionSignal, options.signal);
    throwIfAborted(signal);
    const inspection = await this.inspect({ signal });
    const array = selectArray(this.requireStore(), request.variable ?? this.variableName);
    assertReadable(array, this.codecs);
    const start = [...request.start];
    const stop = [...request.stop];
    assertIndexWindow(array, start, stop);
    const roles = rolesFor(array, this.requireStore());
    const y = roles.indexOf("y");
    const x = roles.indexOf("x");
    const pixel: ZarrPixelWindow = {
      x: x >= 0 ? (start[x] ?? 0) : 0,
      y: y >= 0 ? (start[y] ?? 0) : 0,
      width: x >= 0 ? (stop[x] ?? 0) - (start[x] ?? 0) : 1,
      height: y >= 0 ? (stop[y] ?? 0) - (start[y] ?? 0) : 1,
    };
    const chunks = enumerateChunks(array, start, stop);
    const [bytes] = await this.readPlans([{ array, roles, start, stop, pixel, chunks }], signal);
    const provenance = this.provenance(
      array,
      chunks.map((chunk) => chunk.key),
    );
    return {
      variable: array.name,
      shape: stop.map((value, index) => value - (start[index] ?? 0)),
      dtype: array.dtype,
      nodata: array.fillValue,
      bytes: bytes ?? new Uint8Array(),
      chunks: chunks.map((chunk) => chunk.key),
      fidelity: fidelityFor(array, inspection),
      provenance,
      transfer: this.transport.snapshot(),
      cacheIdentity: this.requireIdentity(),
    };
  }

  /** Lossy uint8 PNG for EPSG:4326 or CRS84. Native samples stay on the window result. */
  async toMapLibreHandoff(result: ZarrDirectWindowResult): Promise<ZarrMapLibreHandoff> {
    this.assertOpen();
    const inspection = await this.inspect();
    if (!inspection.extent) {
      throw new HonuaZarrError("missing-spatial-extent", "The Zarr store has no usable spatial extent.", {
        refusal: "missing-spatial-extent",
      });
    }
    if (!mapLibreCrs(inspection.crs?.code ?? null)) {
      throw new HonuaZarrError(
        "missing-spatial-reference",
        "MapLibre coordinates are produced only for EPSG:4326 and CRS84.",
        { refusal: "missing-spatial-reference", crs: inspection.crs?.code ?? null },
      );
    }
    const box = geographicBox(inspection, result.pixel);
    const url = await pngDataUrl(
      result.bands.map((band) => band.values),
      result.width,
      result.height,
      result.dtype,
      result.nodata,
    );
    return {
      type: "image",
      url,
      coordinates: box,
      fidelity: result.fidelity,
      provenance: result.provenance,
    };
  }

  transfer() {
    return this.transport.snapshot();
  }

  cacheIdentity(): string | undefined {
    return this.identity;
  }

  dispose(): void {
    this.disposed = true;
  }

  private async loadInspection(signal: AbortSignal): Promise<ZarrDirectInspection> {
    this.emit("metadata", 0, 0);
    try {
      const store = await discoverZarrStore(this.transport, signal);
      this.store = store;
      this.identity = cacheIdentity(this.transport, store, this.cacheKey);
      const selected = selectArray(store, this.variableName);
      const readable = codecState(selected, this.codecs);
      const needsRefusal =
        selected.layout === "unsupported" ||
        (readable !== "supported" && readable !== "injected") ||
        !endianSupported(selected);
      if (needsRefusal) {
        this.refuse(0);
        assertReadable(selected, this.codecs);
      }
      const roles = rolesFor(selected, store);
      assertUniqueRoles(roles, selected.name);
      const inspection = this.describe(store, selected, roles);
      this.emit("metadata", 0, 0);
      return inspection;
    } catch (error) {
      if (signal.aborted || error instanceof HonuaAbortError) {
        this.emit("aborted", 0, 0);
        throw error instanceof HonuaAbortError ? error : new HonuaAbortError("Direct Zarr read was cancelled.");
      }
      throw error;
    }
  }

  private describe(store: ParsedStore, selected: ParsedArray, roles: readonly ZarrAxisRole[]): ZarrDirectInspection {
    const bandAxis = roles.indexOf("band");
    const timeAxis = roles.indexOf("time");
    const bands = bandAxis >= 0 ? bandsFromAxis(selected, bandAxis) : bandsFromVariables(store);
    const temporal =
      timeAxis >= 0 && store.temporalStart
        ? {
            dimension: selected.dimensionNames[timeAxis] ?? "time",
            start: store.temporalStart,
            end: store.temporalEnd,
            stepSeconds: store.temporalStep ?? 0,
            size: selected.shape[timeAxis] ?? 0,
          }
        : null;
    return {
      format: store.format,
      url: this.transport.redactedUrl,
      cacheIdentity: this.requireIdentity(),
      crs: inspectionCrs(store),
      extent: store.extent,
      primaryVariable: selected.name,
      variables: store.arrays.map((array) => ({
        name: array.name,
        dtype: array.dtype,
        shape: array.shape,
        chunks: array.chunks,
        dimensions: array.dimensionNames,
        compressor: array.compressor,
        nodata: array.fillValue,
        codec: codecState(array, this.codecs),
        layout: array.layout,
      })),
      dimensions: selected.dimensionNames.map((name, index) => dimensionRecord(store, selected, roles, name, index)),
      bands,
      temporal,
      transfer: this.transport.snapshot(),
      capability: {
        ...ZARR_DIRECT_CAPABILITY,
        selected: {
          variable: selected.name,
          structural: "supported",
          layout: selected.layout,
          codec: codecState(selected, this.codecs),
        },
      },
    };
  }

  private planWindow(inspection: ZarrDirectInspection, request: ZarrDirectWindowRequest): AxisPlan[] {
    const store = this.requireStore();
    if (request.pixel && (request.bbox || request.index)) {
      throw new HonuaZarrError("invalid-request", "A Zarr window uses one of pixel, bbox, or index bounds.");
    }
    if (request.bbox && request.index) {
      throw new HonuaZarrError("invalid-request", "A Zarr window uses one of pixel, bbox, or index bounds.");
    }
    const selected = selectArray(store, request.variable ?? this.variableName ?? inspection.primaryVariable);
    const roles = rolesFor(selected, store);
    assertUniqueRoles(roles, selected.name);
    if (roles.includes("band")) {
      assertReadable(selected, this.codecs);
      const indexes = bandIndexes(request.bands, selected.shape[roles.indexOf("band")] ?? 0);
      return indexes.map((band) => this.planArray(selected, roles, request, band));
    }
    const variables = variableSelection(store, selected, request);
    for (const array of variables) assertReadable(array, this.codecs);
    return variables.map((array) => this.planArray(array, rolesFor(array, store), request, undefined));
  }

  private planArray(
    array: ParsedArray,
    roles: readonly ZarrAxisRole[],
    request: ZarrDirectWindowRequest,
    bandIndex: number | undefined,
  ): AxisPlan {
    assertUniqueRoles(roles, array.name);
    const x = roles.indexOf("x");
    const y = roles.indexOf("y");
    if (x < 0 || y < 0) {
      throw new HonuaZarrError("no-tileable-variable", `Zarr variable "${array.name}" has no x and y axes.`, {
        variable: array.name,
      });
    }
    const start = array.shape.map(() => 0);
    const stop = array.shape.map((_size, axis) => (axis === x || axis === y ? (array.shape[axis] ?? 0) : 1));
    if (request.index) {
      const indexStart = [...request.index.start];
      const indexStop = [...request.index.stop];
      assertIndexWindow(array, indexStart, indexStop);
      for (let axis = 0; axis < roles.length; axis += 1) {
        if (axis === x || axis === y || roles[axis] === "band") continue;
        if ((indexStop[axis] ?? 0) - (indexStart[axis] ?? 0) !== 1) {
          throw new HonuaZarrError("invalid-request", "A raster window keeps every non-spatial axis at one index.", {
            variable: array.name,
          });
        }
      }
      const pixel = {
        x: indexStart[x] ?? 0,
        y: indexStart[y] ?? 0,
        width: (indexStop[x] ?? 0) - (indexStart[x] ?? 0),
        height: (indexStop[y] ?? 0) - (indexStart[y] ?? 0),
      };
      return {
        array,
        roles,
        start: indexStart,
        stop: indexStop,
        pixel,
        chunks: enumerateChunks(array, indexStart, indexStop),
      };
    }
    const store = this.requireStore();
    if (request.pixel) {
      assignPixel(array, x, y, request.pixel, start, stop);
    } else if (request.bbox) {
      if (!store.extent) {
        throw new HonuaZarrError("missing-spatial-extent", "A bbox window requires the store extent.", {
          refusal: "missing-spatial-extent",
        });
      }
      const mapped = mapBbox(store.extent, array.shape[x] ?? 0, array.shape[y] ?? 0, request.bbox);
      start[x] = mapped.x0;
      stop[x] = mapped.x1;
      start[y] = mapped.y0;
      stop[y] = mapped.y1;
    } else {
      throw new HonuaZarrError(
        "invalid-request",
        "A Zarr raster window needs an explicit pixel, bbox, or index bound.",
      );
    }
    const timeAxis = roles.indexOf("time");
    if (timeAxis >= 0) {
      const [timeStart, timeStop] = resolveTime(store, array.shape[timeAxis] ?? 0, request.time);
      if (timeStop - timeStart !== 1) {
        throw new HonuaZarrError("invalid-request", "A raster window reads one time index.", { variable: array.name });
      }
      start[timeAxis] = timeStart;
      stop[timeAxis] = timeStop;
    }
    const bandAxis = roles.indexOf("band");
    if (bandAxis >= 0 && bandIndex !== undefined) {
      start[bandAxis] = bandIndex;
      stop[bandAxis] = bandIndex + 1;
    }
    const pixel = {
      x: start[x] ?? 0,
      y: start[y] ?? 0,
      width: (stop[x] ?? 0) - (start[x] ?? 0),
      height: (stop[y] ?? 0) - (start[y] ?? 0),
    };
    return { array, roles, start, stop, pixel, chunks: enumerateChunks(array, start, stop) };
  }

  private async readPlans(plans: readonly AxisPlan[], signal: AbortSignal): Promise<Uint8Array[]> {
    const chunks = plans.reduce((total, plan) => total + plan.chunks.length, 0);
    const pixels = plans.reduce((total, plan) => total + plan.pixel.width * plan.pixel.height, 0);
    let decodedBytes = 0;
    for (const plan of plans) {
      const chunkBytes = byteProduct(plan.array.chunks, elementSize(plan.array.dtype));
      if (isUncompressed(plan.array) && chunkBytes > this.transport.limits.maxRangeBytes) {
        this.refuse(chunks);
        throw budgetError("A Zarr chunk exceeds the range budget.", this.transport.limits.maxRangeBytes);
      }
      decodedBytes += chunkBytes * plan.chunks.length;
      const outputBytes = byteProduct(
        plan.stop.map((value, index) => value - (plan.start[index] ?? 0)),
        elementSize(plan.array.dtype),
      );
      if (outputBytes > this.transport.limits.maxDecodedBytes) {
        this.refuse(chunks);
        throw budgetError("The Zarr window exceeds the decoded byte budget.", this.transport.limits.maxDecodedBytes);
      }
    }
    const ledger = this.transport.snapshot();
    if (chunks > this.transport.limits.maxChunks || chunks > this.transport.limits.maxChunkRequests) {
      this.refuse(chunks);
      throw budgetError("The Zarr window exceeds the chunk budget.", this.transport.limits.maxChunks);
    }
    if (ledger.chunkRequests + chunks > this.transport.limits.maxChunkRequests) {
      this.refuse(chunks);
      throw budgetError("The Zarr window exceeds the chunk request budget.", this.transport.limits.maxChunkRequests);
    }
    if (ledger.requests + chunks > this.transport.limits.maxRequests) {
      this.refuse(chunks);
      throw budgetError("The Zarr window exceeds the request budget.", this.transport.limits.maxRequests);
    }
    if (pixels > this.transport.limits.maxPixels || decodedBytes > this.transport.limits.maxDecodedBytes) {
      this.refuse(chunks);
      throw budgetError(
        "The Zarr window exceeds the pixel or decoded byte budget.",
        pixels > this.transport.limits.maxPixels
          ? this.transport.limits.maxPixels
          : this.transport.limits.maxDecodedBytes,
      );
    }
    this.emit("planned", chunks, 0);
    const outputs: Uint8Array[] = [];
    let fetched = 0;
    for (const plan of plans) {
      throwIfAborted(signal);
      const element = elementSize(plan.array.dtype);
      const subsetShape = plan.stop.map((value, index) => value - (plan.start[index] ?? 0));
      const output = new Uint8Array(byteProduct(subsetShape, element));
      fillBuffer(output, plan.array.dtype, plan.array.fillValue);
      const chunkBytes = byteProduct(plan.array.chunks, element);
      for (const chunk of plan.chunks) {
        throwIfAborted(signal);
        this.emit("chunk", chunks, fetched);
        const object = await this.transport.read(chunk.key, "chunk", this.transport.limits.maxRangeBytes, signal);
        fetched += 1;
        if (!object) continue;
        const decoded = await decodeChunk(plan.array, object.bytes, this.codecs, chunkBytes, signal);
        copyChunk(decoded, output, plan.array, chunk.index, plan.start, plan.stop, subsetShape);
      }
      outputs.push(output);
    }
    this.emit("completed", chunks, fetched);
    return outputs;
  }

  private provenance(array: ParsedArray, chunks: readonly string[]): ZarrProvenance {
    const ledger = this.transport.snapshot();
    return {
      storeUrl: this.transport.redactedUrl,
      cacheIdentity: this.requireIdentity(),
      variable: array.name,
      zarrFormat: array.format,
      chunks,
      bytesFetched: ledger.bytesFetched,
      requests: ledger.requests,
    };
  }

  private requireStore(): ParsedStore {
    if (!this.store) throw new HonuaZarrError("metadata-pending", "Zarr metadata has not been inspected.");
    return this.store;
  }

  private requireIdentity(): string {
    if (!this.identity) throw new HonuaZarrError("metadata-pending", "Zarr metadata has not been inspected.");
    return this.identity;
  }

  private assertOpen(): void {
    if (this.disposed) throw new HonuaZarrError("invalid-request", "The direct Zarr session is closed.");
  }

  private refuse(chunksPlanned: number): void {
    this.emit("refused", chunksPlanned, 0);
  }

  private emit(phase: ZarrDirectProgress["phase"], chunksPlanned: number, chunksFetched: number): void {
    const ledger = this.transport.snapshot();
    this.onProgress?.({
      phase,
      requests: ledger.requests,
      bytesFetched: ledger.bytesFetched,
      chunksPlanned,
      chunksFetched,
    });
  }
}

export function normalizeZarrDirectLimits(options: ZarrDirectLimitOptions | undefined): ZarrDirectLimits {
  const limits = { ...ZARR_DIRECT_DEFAULT_LIMITS };
  if (!options) return limits;
  for (const key of Object.keys(ZARR_DIRECT_DEFAULT_LIMITS) as (keyof ZarrDirectLimits)[]) {
    const value = options[key];
    if (value === undefined) continue;
    const ceiling = ZARR_DIRECT_LIMIT_CEILINGS[key];
    if (!Number.isSafeInteger(value) || value < 1 || value > ceiling) {
      throw new HonuaZarrError("invalid-request", `Zarr limit ${key} must be an integer from 1 through ${ceiling}.`, {
        limit: key,
        ceiling,
      });
    }
    limits[key] = value;
  }
  return limits;
}

function codecMap(codecs: readonly ZarrChunkCodec[] | undefined): ReadonlyMap<string, ZarrChunkCodec> {
  const map = new Map<string, ZarrChunkCodec>();
  for (const codec of codecs ?? []) {
    if (!codec.id || codec.id.trim() === "") {
      throw new HonuaZarrError("invalid-request", "An injected Zarr codec needs an id.");
    }
    map.set(codec.id.toLowerCase(), codec);
  }
  return map;
}

function cacheIdentity(transport: ZarrObjectTransport, store: ParsedStore, cacheKey: string | undefined): string {
  const variables = store.arrays.map((array) => array.name).join(",");
  return [
    "zarr-direct",
    "v1",
    String(store.format),
    transport.redactedUrl,
    transport.validator() ?? "none",
    variables,
    cacheKey ?? "",
  ].join("|");
}

function selectArray(store: ParsedStore, name: string | undefined): ParsedArray {
  const selected = name ?? store.primary;
  const array = store.arrays.find((candidate) => candidate.name === selected);
  if (!array) {
    throw new HonuaZarrError("invalid-request", `Zarr variable "${selected}" is not in the variables manifest.`, {
      variable: selected,
    });
  }
  return array;
}

function rolesFor(array: ParsedArray, store: ParsedStore): ZarrAxisRole[] {
  return array.dimensionNames.map((name) => axisRole(name, store));
}

function assertUniqueRoles(roles: readonly ZarrAxisRole[], variable: string): void {
  for (const role of ["x", "y", "time", "band"] as const) {
    if (roles.filter((candidate) => candidate === role).length > 1) {
      throw new HonuaZarrError("ambiguous-dimensions", `Zarr variable "${variable}" has more than one ${role} axis.`, {
        variable,
        role,
      });
    }
  }
}

function codecState(
  array: ParsedArray,
  codecs: ReadonlyMap<string, ZarrChunkCodec>,
): "supported" | "injected" | "unsupported" {
  if (builtinPipeline(array)) return "supported";
  const foreign = foreignCodecId(array);
  if (foreign && codecs.has(foreign.toLowerCase())) return "injected";
  return "unsupported";
}

function foreignStages(array: ParsedArray): string[] {
  if (array.format === 2) {
    const stages = [...array.filters];
    if (array.compressor && !BUILTIN_V2.has(array.compressor)) stages.push(array.compressor);
    else if (array.filters.length > 0 && array.compressor === "zlib") stages.push(array.compressor);
    return stages;
  }
  return array.codecs
    .filter((codec) => codec.name !== "bytes" && !(codec.name === "gzip" && array.codecs.length === 2))
    .map((codec) => codec.name);
}

function foreignCodecId(array: ParsedArray): string | undefined {
  const stages = foreignStages(array);
  return stages.length === 1 ? stages[0] : undefined;
}

function builtinPipeline(array: ParsedArray): boolean {
  if (!endianSupported(array)) return false;
  if (array.format === 2) {
    return array.filters.length === 0 && (array.compressor === null || array.compressor === "zlib");
  }
  if (array.codecs.length === 1 && array.codecs[0]?.name === "bytes") return true;
  return (
    array.codecs.length === 2 &&
    array.codecs[0]?.name === "bytes" &&
    array.codecs[0]?.endian !== "big" &&
    array.codecs[1]?.name === "gzip"
  );
}

function endianSupported(array: ParsedArray): boolean {
  if (array.dtype.startsWith(">")) return false;
  const bytes = array.codecs.find((codec) => codec.name === "bytes");
  if (bytes?.endian === "big") return false;
  return reviewedDtype(array.dtype);
}

function reviewedDtype(dtype: string): boolean {
  if (dtype === "|b1" || dtype === "|i1" || dtype === "|u1") return true;
  return /^<(?:[iu][248]|f[48])$/u.test(dtype);
}

function assertReadable(array: ParsedArray, codecs: ReadonlyMap<string, ZarrChunkCodec>): void {
  if (array.layout !== "supported") {
    throw new HonuaZarrError("invalid-request", array.layoutReason ?? "The Zarr array layout is not reviewed.", {
      ...refusalDetail(array, "unsupported-layout", codecState(array, codecs)),
    });
  }
  if (!endianSupported(array)) {
    throw new HonuaZarrError("unsupported-dtype", `Zarr variable "${array.name}" uses an unreviewed dtype or endian.`, {
      ...refusalDetail(array, "unsupported-dtype", "unsupported"),
      dtype: array.dtype,
    });
  }
  const codec = codecState(array, codecs);
  if (codec === "unsupported") {
    const id =
      array.compressor ?? array.filters[0] ?? array.codecs.find((entry) => entry.name !== "bytes")?.name ?? null;
    throw new HonuaZarrError("unsupported-codec", `Zarr variable "${array.name}" uses an unreviewed codec.`, {
      ...refusalDetail(array, "unsupported-codec", "unsupported"),
      codecId: id,
    });
  }
}

function refusalDetail(
  array: ParsedArray,
  refusal: string,
  codec: "supported" | "injected" | "unsupported",
): Record<string, unknown> {
  return {
    refusal,
    structural: "supported",
    layout: array.layout,
    codec,
    variable: array.name,
  };
}

function rasterDtype(dtype: string): dtype is string {
  return cogDataType(dtype) !== undefined;
}

function cogDataType(dtype: string): CogDataType | undefined {
  switch (dtype) {
    case "|b1":
    case "|u1":
      return "uint8";
    case "|i1":
      return "int8";
    case "<u2":
      return "uint16";
    case "<i2":
      return "int16";
    case "<u4":
      return "uint32";
    case "<i4":
      return "int32";
    case "<f4":
      return "float32";
    case "<f8":
      return "float64";
    default:
      return undefined;
  }
}

export function zarrCogDataType(dtype: string): CogDataType | undefined {
  return cogDataType(dtype);
}

function bandIndexes(bands: readonly number[] | undefined, size: number): number[] {
  if (bands === undefined) {
    if (size === 1) return [0];
    throw new HonuaZarrError("invalid-request", "A multi-band Zarr window must name its bands.");
  }
  if (bands.length === 0 || bands.some((band) => !Number.isInteger(band) || band < 1 || band > size)) {
    throw new HonuaZarrError("invalid-request", "Zarr band indexes are one-based and must lie inside the band axis.");
  }
  if (new Set(bands).size !== bands.length) {
    throw new HonuaZarrError("invalid-request", "Zarr band indexes must be unique.");
  }
  return bands.map((band) => band - 1);
}

function variableSelection(store: ParsedStore, selected: ParsedArray, request: ZarrDirectWindowRequest): ParsedArray[] {
  if (request.variable) {
    if (request.bands !== undefined && (request.bands.length !== 1 || request.bands[0] !== 1)) {
      throw new HonuaZarrError("invalid-request", "An explicit Zarr variable is a single band.");
    }
    return [selected];
  }
  if (request.bands === undefined) return [selected];
  const indexes = bandIndexes(request.bands, store.arrays.length);
  return indexes.map((index) => {
    const array = store.arrays[index];
    if (!array) throw new HonuaZarrError("invalid-request", "The Zarr band index is outside the variables manifest.");
    return array;
  });
}

function bandNumber(
  inspection: ZarrDirectInspection,
  request: ZarrDirectWindowRequest,
  plan: AxisPlan,
  index: number,
): number {
  const bandAxis = plan.roles.indexOf("band");
  if (bandAxis >= 0) return (plan.start[bandAxis] ?? 0) + 1;
  if (request.bands) return request.bands[index] ?? index + 1;
  const found = inspection.bands.find((band) => band.variable === plan.array.name);
  return found?.index ?? index + 1;
}

function assignPixel(
  array: ParsedArray,
  x: number,
  y: number,
  pixel: ZarrPixelWindow,
  start: number[],
  stop: number[],
): void {
  const width = array.shape[x] ?? 0;
  const height = array.shape[y] ?? 0;
  if (
    !Number.isInteger(pixel.x) ||
    !Number.isInteger(pixel.y) ||
    !Number.isInteger(pixel.width) ||
    !Number.isInteger(pixel.height) ||
    pixel.x < 0 ||
    pixel.y < 0 ||
    pixel.width < 1 ||
    pixel.height < 1 ||
    pixel.x + pixel.width > width ||
    pixel.y + pixel.height > height
  ) {
    throw new HonuaZarrError("invalid-request", "The Zarr pixel window is outside the array.");
  }
  start[x] = pixel.x;
  stop[x] = pixel.x + pixel.width;
  start[y] = pixel.y;
  stop[y] = pixel.y + pixel.height;
}

function mapBbox(
  extent: readonly [number, number, number, number],
  xSize: number,
  ySize: number,
  bbox: readonly [number, number, number, number],
): { x0: number; x1: number; y0: number; y1: number } {
  const [minX, minY, maxX, maxY] = extent;
  const [west, south, east, north] = bbox;
  if (![west, south, east, north].every(Number.isFinite) || east <= west || north <= south) {
    throw new HonuaZarrError("invalid-request", "The Zarr bbox must be finite and ordered.");
  }
  const pixelX = (maxX - minX) / xSize;
  const pixelY = (maxY - minY) / ySize;
  const x0 = clamp(Math.floor((Math.max(west, minX) - minX) / pixelX), 0, xSize);
  const x1 = clamp(Math.ceil((Math.min(east, maxX) - minX) / pixelX), 0, xSize);
  const y0 = clamp(Math.floor((maxY - Math.min(north, maxY)) / pixelY), 0, ySize);
  const y1 = clamp(Math.ceil((maxY - Math.max(south, minY)) / pixelY), 0, ySize);
  if (x1 <= x0 || y1 <= y0) {
    throw new HonuaZarrError("invalid-request", "The Zarr bbox does not cover a pixel.");
  }
  return { x0, x1, y0, y1 };
}

function resolveTime(
  store: ParsedStore,
  size: number,
  time: ZarrDirectWindowRequest["time"],
): readonly [number, number] {
  if (time === undefined) return [0, 1];
  if ("index" in time) {
    if (!Number.isInteger(time.index) || time.index < 0 || time.index >= size) {
      throw new HonuaZarrError("invalid-request", "The Zarr time index is outside the time axis.");
    }
    return [time.index, time.index + 1];
  }
  if (!store.temporalStart || !store.temporalStep) {
    throw new HonuaZarrError("invalid-request", "An ISO time window requires t_start and t_step_seconds.");
  }
  const origin = Date.parse(store.temporalStart);
  const start = Date.parse(time.start);
  if (!Number.isFinite(origin) || !Number.isFinite(start)) {
    throw new HonuaZarrError("invalid-request", "The Zarr time window is not a valid timestamp.");
  }
  const stepMs = store.temporalStep * 1000;
  const startIndex = Math.floor((start - origin) / stepMs);
  const stopIndex = time.stop === undefined ? startIndex + 1 : Math.floor((Date.parse(time.stop) - origin) / stepMs);
  if (startIndex < 0 || stopIndex > size || stopIndex <= startIndex) {
    throw new HonuaZarrError("invalid-request", "The Zarr time window is outside the time axis.");
  }
  return [startIndex, stopIndex];
}

function assertIndexWindow(array: ParsedArray, start: number[], stop: number[]): void {
  if (start.length !== array.shape.length || stop.length !== array.shape.length) {
    throw new HonuaZarrError("invalid-request", "The Zarr index window rank must match the array.");
  }
  for (let axis = 0; axis < start.length; axis += 1) {
    const begin = start[axis] ?? -1;
    const end = stop[axis] ?? -1;
    const size = array.shape[axis] ?? 0;
    if (!Number.isInteger(begin) || !Number.isInteger(end) || begin < 0 || end > size || end <= begin) {
      throw new HonuaZarrError("invalid-request", "The Zarr index window is outside the array.");
    }
  }
}

function enumerateChunks(
  array: ParsedArray,
  start: readonly number[],
  stop: readonly number[],
): { index: number[]; key: string }[] {
  const ranges = array.chunks.map((chunk, axis) => {
    const begin = Math.floor((start[axis] ?? 0) / chunk);
    const end = Math.floor(((stop[axis] ?? 1) - 1) / chunk) + 1;
    return [begin, end] as const;
  });
  const cursor = ranges.map(([begin]) => begin);
  const chunks: { index: number[]; key: string }[] = [];
  while (true) {
    const index = cursor.slice();
    chunks.push({ index, key: chunkObjectKey(array, index) });
    let axis = cursor.length - 1;
    while (axis >= 0) {
      const next = (cursor[axis] ?? 0) + 1;
      cursor[axis] = next;
      if (next < (ranges[axis]?.[1] ?? 0)) break;
      cursor[axis] = ranges[axis]?.[0] ?? 0;
      axis -= 1;
    }
    if (axis < 0) break;
  }
  return chunks;
}

function chunkObjectKey(array: ParsedArray, index: readonly number[]): string {
  const body = index.join(array.separator);
  const encoded = array.prefix === "" ? body : `${array.prefix}${array.separator}${body}`;
  return array.relativePath ? `${array.relativePath}/${encoded}` : encoded;
}

function isUncompressed(array: ParsedArray): boolean {
  if (array.format === 2) return array.compressor === null && array.filters.length === 0;
  return array.codecs.length === 1 && array.codecs[0]?.name === "bytes";
}

async function decodeChunk(
  array: ParsedArray,
  raw: Uint8Array,
  codecs: ReadonlyMap<string, ZarrChunkCodec>,
  expected: number,
  signal: AbortSignal,
): Promise<Uint8Array> {
  throwIfAborted(signal);
  if (builtinPipeline(array)) {
    if (isUncompressed(array)) return expectLength(raw, expected);
    const format =
      array.compressor === "gzip" || array.codecs.some((codec) => codec.name === "gzip") ? "gzip" : "deflate";
    return inflate(raw, format, expected, signal);
  }
  const id = foreignCodecId(array);
  const codec = id ? codecs.get(id.toLowerCase()) : undefined;
  if (!codec) {
    throw new HonuaZarrError("unsupported-codec", `Zarr variable "${array.name}" uses an unreviewed codec.`, {
      refusal: "unsupported-codec",
      variable: array.name,
    });
  }
  const decoded = await codec.decode(raw, signal);
  return expectLength(decoded, expected);
}

function expectLength(bytes: Uint8Array, expected: number): Uint8Array {
  if (bytes.byteLength !== expected) {
    throw new HonuaZarrError("invalid-response", "A Zarr chunk did not decode to its full chunk size.", {
      expected,
      actual: bytes.byteLength,
    });
  }
  return bytes;
}

async function inflate(
  bytes: Uint8Array,
  format: "deflate" | "gzip",
  expected: number,
  signal: AbortSignal,
): Promise<Uint8Array> {
  if (typeof DecompressionStream === "undefined") {
    throw new HonuaZarrError("unsupported-codec", "This runtime cannot inflate reviewed Zarr chunks.", {
      refusal: "unsupported-codec",
    });
  }
  const body = new Response(bytesAsBuffer(bytes)).body;
  if (!body) {
    throw new HonuaZarrError("invalid-response", "A compressed Zarr chunk has no readable body.");
  }
  const reader = body.pipeThrough(new DecompressionStream(format)).getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      throwIfAborted(signal);
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > expected) {
        await reader.cancel().catch(() => undefined);
        throw new HonuaZarrError("response-too-large", "A Zarr chunk inflated past its chunk size.", {
          limit: expected,
        });
      }
      parts.push(next.value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    if (signal.aborted) throw new HonuaAbortError("Direct Zarr read was cancelled.");
    if (error instanceof HonuaZarrError || error instanceof HonuaAbortError) throw error;
    throw new HonuaZarrError("invalid-response", "A Zarr chunk could not be inflated.");
  } finally {
    reader.releaseLock();
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  return expectLength(output, expected);
}

function copyChunk(
  decoded: Uint8Array,
  dest: Uint8Array,
  array: ParsedArray,
  chunkIndex: readonly number[],
  reqStart: readonly number[],
  reqStop: readonly number[],
  subsetShape: readonly number[],
): void {
  const rank = array.shape.length;
  const origin = chunkIndex.map((index, axis) => index * (array.chunks[axis] ?? 1));
  const copyStart = origin.map((value, axis) => Math.max(value, reqStart[axis] ?? 0));
  const copyStop = origin.map((value, axis) =>
    Math.min(value + (array.chunks[axis] ?? 0), array.shape[axis] ?? 0, reqStop[axis] ?? 0),
  );
  if (copyStart.some((value, axis) => value >= (copyStop[axis] ?? 0))) return;
  const element = elementSize(array.dtype);
  const inner = rank - 1;
  const run = (copyStop[inner] ?? 0) - (copyStart[inner] ?? 0);
  const cursor = copyStart.slice(0, inner);
  while (true) {
    const srcCoords = cursor.map((value, axis) => value - (origin[axis] ?? 0));
    srcCoords.push((copyStart[inner] ?? 0) - (origin[inner] ?? 0));
    const dstCoords = cursor.map((value, axis) => value - (reqStart[axis] ?? 0));
    dstCoords.push((copyStart[inner] ?? 0) - (reqStart[inner] ?? 0));
    const src = cOrderOffset(srcCoords, array.chunks) * element;
    const dst = cOrderOffset(dstCoords, subsetShape) * element;
    dest.set(decoded.subarray(src, src + run * element), dst);
    if (inner === 0) break;
    let axis = inner - 1;
    while (axis >= 0) {
      cursor[axis] = (cursor[axis] ?? 0) + 1;
      if ((cursor[axis] ?? 0) < (copyStop[axis] ?? 0)) break;
      cursor[axis] = copyStart[axis] ?? 0;
      axis -= 1;
    }
    if (axis < 0) break;
  }
}

function extractPlane(bytes: Uint8Array, plan: AxisPlan): CogSampleArray {
  const y = plan.roles.indexOf("y");
  const x = plan.roles.indexOf("x");
  const height = plan.pixel.height;
  const width = plan.pixel.width;
  const dtype = plan.array.dtype;
  const output = allocateSamples(dtype, width * height);
  const subsetShape = plan.stop.map((value, index) => value - (plan.start[index] ?? 0));
  const element = elementSize(dtype);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const coords = subsetShape.map(() => 0);
  for (let row = 0; row < height; row += 1) {
    for (let column = 0; column < width; column += 1) {
      coords[y] = row;
      coords[x] = column;
      const value = readElement(view, cOrderOffset(coords, subsetShape) * element, dtype);
      writeSample(output, row * width + column, value);
    }
  }
  return output;
}

function allocateSamples(dtype: string, length: number): CogSampleArray {
  switch (dtype) {
    case "|i1":
      return new Int8Array(length);
    case "<i2":
      return new Int16Array(length);
    case "<u2":
      return new Uint16Array(length);
    case "<i4":
      return new Int32Array(length);
    case "<u4":
      return new Uint32Array(length);
    case "<f4":
      return new Float32Array(length);
    case "<f8":
      return new Float64Array(length);
    default:
      return new Uint8Array(length);
  }
}

function writeSample(output: CogSampleArray, index: number, value: number): void {
  output[index] = value;
}

function fillBuffer(bytes: Uint8Array, dtype: string, fill: number | null): void {
  if (fill === null || fill === 0) return;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const element = elementSize(dtype);
  for (let offset = 0; offset < bytes.byteLength; offset += element) writeElement(view, offset, dtype, fill);
}

function readElement(view: DataView, offset: number, dtype: string): number {
  switch (dtype) {
    case "|i1":
      return view.getInt8(offset);
    case "<i2":
      return view.getInt16(offset, true);
    case "<u2":
      return view.getUint16(offset, true);
    case "<i4":
      return view.getInt32(offset, true);
    case "<u4":
      return view.getUint32(offset, true);
    case "<f4":
      return view.getFloat32(offset, true);
    case "<f8":
      return view.getFloat64(offset, true);
    case "<i8":
      return Number(view.getBigInt64(offset, true));
    case "<u8":
      return Number(view.getBigUint64(offset, true));
    default:
      return view.getUint8(offset);
  }
}

function writeElement(view: DataView, offset: number, dtype: string, value: number): void {
  switch (dtype) {
    case "|i1":
      view.setInt8(offset, value);
      return;
    case "<i2":
      view.setInt16(offset, value, true);
      return;
    case "<u2":
      view.setUint16(offset, value, true);
      return;
    case "<i4":
      view.setInt32(offset, value, true);
      return;
    case "<u4":
      view.setUint32(offset, value, true);
      return;
    case "<f4":
      view.setFloat32(offset, value, true);
      return;
    case "<f8":
      view.setFloat64(offset, value, true);
      return;
    default:
      view.setUint8(offset, value);
  }
}

function elementSize(dtype: string): number {
  switch (dtype) {
    case "<i2":
    case "<u2":
      return 2;
    case "<i4":
    case "<u4":
    case "<f4":
      return 4;
    case "<i8":
    case "<u8":
    case "<f8":
      return 8;
    default:
      return 1;
  }
}

function cOrderOffset(coords: readonly number[], shape: readonly number[]): number {
  let offset = 0;
  let stride = 1;
  for (let axis = shape.length - 1; axis >= 0; axis -= 1) {
    offset += (coords[axis] ?? 0) * stride;
    stride *= shape[axis] ?? 1;
  }
  return offset;
}

function byteProduct(shape: readonly number[], element: number): number {
  let total = element;
  for (const extent of shape) {
    if (!Number.isSafeInteger(extent) || extent < 1 || total > Number.MAX_SAFE_INTEGER / extent) {
      throw budgetError("The Zarr window exceeds the decoded byte budget.", ZARR_DIRECT_LIMIT_CEILINGS.maxDecodedBytes);
    }
    total *= extent;
  }
  return total;
}

function budgetError(message: string, limit: number): HonuaZarrError {
  return new HonuaZarrError("response-too-large", message, { refusal: "budget", limit });
}

function dimensionRecord(
  store: ParsedStore,
  array: ParsedArray,
  roles: readonly ZarrAxisRole[],
  name: string,
  index: number,
): ZarrDirectDimension {
  const note = store.axisNotes.find((candidate) => candidate.name === name);
  return {
    name,
    size: array.shape[index] ?? 0,
    chunk: array.chunks[index] ?? 0,
    role: roles[index] ?? "other",
    ...(note?.unit ? { unit: note.unit } : {}),
    ...(note?.coordinates ? { coordinates: note.coordinates } : {}),
  };
}

function bandsFromAxis(array: ParsedArray, axis: number): ZarrDirectBand[] {
  const size = array.shape[axis] ?? 0;
  return Array.from({ length: size }, (_unused, index) => ({
    index: index + 1,
    name: `${array.dimensionNames[axis] ?? "band"}:${index + 1}`,
    variable: array.name,
    dtype: array.dtype,
    nodata: array.fillValue,
  }));
}

function bandsFromVariables(store: ParsedStore): ZarrDirectBand[] {
  return store.arrays.map((array, index) => ({
    index: index + 1,
    name: array.name,
    variable: array.name,
    dtype: array.dtype,
    nodata: array.fillValue,
  }));
}

function inspectionCrs(store: ParsedStore): ZarrDirectInspection["crs"] {
  if (store.srid) return { authority: "EPSG", code: String(store.srid) };
  if (store.crsLabel === "CRS84") return { authority: "OGC", code: "CRS84" };
  return null;
}

function mapLibreCrs(code: string | null): boolean {
  if (!code) return false;
  const normalized = code.trim().toLowerCase();
  return normalized === "4326" || normalized === "crs84";
}

function geographicBox(inspection: ZarrDirectInspection, pixel: ZarrPixelWindow): ZarrMapLibreCoordinates {
  const extent = inspection.extent;
  const x = inspection.dimensions.find((dimension) => dimension.role === "x");
  const y = inspection.dimensions.find((dimension) => dimension.role === "y");
  if (!extent || !x || !y) {
    throw new HonuaZarrError("missing-spatial-extent", "The Zarr store has no usable spatial extent.");
  }
  const [minX, minY, maxX, maxY] = extent;
  const pixelX = (maxX - minX) / x.size;
  const pixelY = (maxY - minY) / y.size;
  const west = minX + pixel.x * pixelX;
  const east = minX + (pixel.x + pixel.width) * pixelX;
  const north = maxY - pixel.y * pixelY;
  const south = maxY - (pixel.y + pixel.height) * pixelY;
  return [
    [west, north],
    [east, north],
    [east, south],
    [west, south],
  ];
}

function fidelityFor(array: ParsedArray, inspection: ZarrDirectInspection): ZarrFidelity {
  return {
    source: "zarr-direct",
    samples: "native",
    dtype: array.dtype,
    nodata: array.fillValue,
    resampling: "nearest",
    presentation: "uint8-png",
    lossyPresentation: true,
    crs: inspection.crs
      ? inspection.crs.authority === "EPSG"
        ? `EPSG:${inspection.crs.code}`
        : inspection.crs.code
      : null,
  };
}

async function pngDataUrl(
  bands: readonly CogSampleArray[],
  width: number,
  height: number,
  dtype: string,
  nodata: number | null,
): Promise<string> {
  const rgba = new Uint8Array((width * 4 + 1) * height);
  const sources = bands.slice(0, 3);
  const first = sources[0];
  if (!first) throw new HonuaZarrError("invalid-request", "A MapLibre Zarr image needs at least one band.");
  const identity = dtype === "|u1" || dtype === "|b1" || dtype === "uint8";
  const scales = sources.map((values) => (identity ? undefined : sampleScale(values, nodata)));
  for (let row = 0; row < height; row += 1) {
    const scan = row * (width * 4 + 1);
    rgba[scan] = 0;
    for (let column = 0; column < width; column += 1) {
      const sampleIndex = row * width + column;
      const sample = Number(first[sampleIndex] ?? 0);
      const offset = scan + 1 + column * 4;
      if (isNoData(sample, nodata)) continue;
      for (let channel = 0; channel < 3; channel += 1) {
        const values = sources[Math.min(channel, sources.length - 1)] ?? first;
        const scale = scales[Math.min(channel, scales.length - 1)];
        const channelSample = Number(values[sampleIndex] ?? 0);
        rgba[offset + channel] = scale ? scale(channelSample) : clamp(Math.round(channelSample), 0, 255);
      }
      rgba[offset + 3] = 255;
    }
  }
  const compressed = await inflatePng(rgba);
  const signature = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = new Uint8Array(13);
  const header = new DataView(ihdr.buffer);
  header.setUint32(0, width);
  header.setUint32(4, height);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const bytes = concat([
    signature,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", compressed),
    pngChunk("IEND", new Uint8Array()),
  ]);
  return `data:image/png;base64,${base64(bytes)}`;
}

function sampleScale(values: CogSampleArray, nodata: number | null): (sample: number) => number {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const value of values) {
    const sample = Number(value);
    if (isNoData(sample, nodata)) continue;
    min = Math.min(min, sample);
    max = Math.max(max, sample);
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) return () => 0;
  if (min === max) return () => 255;
  const span = max - min;
  return (sample) => clamp(Math.round(((sample - min) / span) * 255), 0, 255);
}

function isNoData(sample: number, nodata: number | null): boolean {
  if (!Number.isFinite(sample)) return true;
  return nodata !== null && Number.isFinite(nodata) && sample === nodata;
}

async function inflatePng(scanlines: Uint8Array): Promise<Uint8Array> {
  if (typeof CompressionStream === "undefined") {
    throw new HonuaZarrError("invalid-response", "This runtime cannot encode a PNG presentation.");
  }
  const body = new Response(bytesAsBuffer(scanlines)).body;
  if (!body) throw new HonuaZarrError("invalid-response", "The PNG presentation has no readable body.");
  const reader = body.pipeThrough(new CompressionStream("deflate")).getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    total += next.value.byteLength;
    parts.push(next.value);
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output;
}

const CRC_TABLE = new Uint32Array(256);
for (let index = 0; index < 256; index += 1) {
  let crc = index;
  for (let bit = 0; bit < 8; bit += 1) crc = (crc & 1) === 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  CRC_TABLE[index] = crc >>> 0;
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const chunk = new Uint8Array(12 + data.byteLength);
  const view = new DataView(chunk.buffer);
  view.setUint32(0, data.byteLength);
  chunk.set(new TextEncoder().encode(type), 4);
  chunk.set(data, 8);
  view.setUint32(8 + data.byteLength, crc32(chunk.subarray(4, 8 + data.byteLength)));
  return chunk;
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const length = parts.reduce((total, part) => total + part.byteLength, 0);
  const output = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output;
}

function base64(bytes: Uint8Array): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let output = "";
  for (let index = 0; index < bytes.byteLength; index += 3) {
    const a = bytes[index] ?? 0;
    const b = index + 1 < bytes.byteLength ? (bytes[index + 1] ?? 0) : 0;
    const c = index + 2 < bytes.byteLength ? (bytes[index + 2] ?? 0) : 0;
    const triple = (a << 16) | (b << 8) | c;
    output += alphabet[(triple >> 18) & 63] ?? "";
    output += alphabet[(triple >> 12) & 63] ?? "";
    output += index + 1 < bytes.byteLength ? (alphabet[(triple >> 6) & 63] ?? "") : "=";
    output += index + 2 < bytes.byteLength ? (alphabet[triple & 63] ?? "") : "=";
  }
  return output;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function bytesAsBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  return copy;
}

function linkSignals(session: AbortSignal | undefined, call: AbortSignal | undefined): AbortSignal {
  if (session && call) return AbortSignal.any([session, call]);
  return session ?? call ?? new AbortController().signal;
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new HonuaAbortError("Direct Zarr read was cancelled.");
}
