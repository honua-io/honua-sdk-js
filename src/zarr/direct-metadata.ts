import type { ZarrObjectTransport } from "./direct-transport.js";
import type { ZarrAxisRole, ZarrDirectFormat, ZarrLayoutStatus } from "./direct-types.js";
import { HonuaZarrError } from "./errors.js";

const MAX_VARIABLES = 64;

export interface ParsedCodec {
  readonly name: string;
  readonly endian?: "little" | "big";
}

export interface ParsedAxisNote {
  readonly name: string;
  readonly unit?: string;
  readonly coordinates?: readonly number[];
  readonly start?: number;
  readonly end?: number;
}

export interface ParsedArray {
  readonly name: string;
  readonly relativePath: string;
  readonly format: ZarrDirectFormat;
  readonly shape: readonly number[];
  readonly chunks: readonly number[];
  readonly dtype: string;
  readonly order: string;
  readonly compressor: string | null;
  readonly codecs: readonly ParsedCodec[];
  readonly filters: readonly string[];
  readonly fillValue: number | null;
  readonly dimensionNames: readonly string[];
  readonly separator: "." | "/";
  readonly prefix: "" | "c";
  readonly layout: ZarrLayoutStatus;
  readonly layoutReason?: string;
}

export interface ParsedStore {
  readonly format: ZarrDirectFormat;
  readonly arrays: readonly ParsedArray[];
  readonly primary: string;
  readonly srid: number | null;
  /** EPSG:code, CRS84, or the raw crs attribute when it is not a reviewed map CRS. */
  readonly crsLabel: string | null;
  readonly extent: readonly [number, number, number, number] | null;
  readonly xDimension: string | null;
  readonly yDimension: string | null;
  readonly tDimension: string | null;
  readonly temporalStart: string | null;
  readonly temporalEnd: string | null;
  readonly temporalStep: number | null;
  readonly axisNotes: readonly ParsedAxisNote[];
}

/** Reads only known metadata keys. Group members come from an explicit variables manifest. */
export async function discoverZarrStore(transport: ZarrObjectTransport, signal: AbortSignal): Promise<ParsedStore> {
  const rootDocument = await readJson(transport, "zarr.json", signal);
  if (rootDocument !== undefined) {
    return readV3(transport, rootDocument, signal);
  }
  const group = await readJson(transport, ".zgroup", signal);
  const attrs = await readJson(transport, ".zattrs", signal);
  const consolidated = await readJson(transport, ".zmetadata", signal);
  if (group !== undefined) {
    const names = variableNames(attrs, consolidated);
    if (names.length === 0) {
      throw new HonuaZarrError(
        "invalid-response",
        "The Zarr group has no variables manifest. Directory listing is not used.",
      );
    }
    const arrays: ParsedArray[] = [];
    for (const name of names) {
      arrays.push(await readV2Array(transport, name, name, signal));
    }
    return finishStore(2, arrays, attrs);
  }
  const rootArray = await readJson(transport, ".zarray", signal);
  if (rootArray === undefined) {
    throw new HonuaZarrError("invalid-response", "The URL is not a reviewed Zarr v2 or v3 store.");
  }
  const name = singleArrayName(transport.storeUrl);
  const array = parseV2Array(name, "", rootArray, await readJson(transport, ".zattrs", signal));
  return finishStore(2, [array], attrs);
}

async function readV3(
  transport: ZarrObjectTransport,
  rootDocument: unknown,
  signal: AbortSignal,
): Promise<ParsedStore> {
  const root = record(rootDocument, "Zarr v3 zarr.json is not an object.");
  const format = root.zarr_format;
  if (format !== 3) {
    throw new HonuaZarrError("unsupported-version", "zarr.json is not Zarr v3.", {
      refusal: "unsupported-version",
      zarrFormat: format ?? null,
    });
  }
  const nodeType = typeof root.node_type === "string" ? root.node_type : "";
  const attributes = isRecord(root.attributes) ? root.attributes : undefined;
  if (nodeType === "array") {
    const array = parseV3Array(singleArrayName(transport.storeUrl), "", root);
    return finishStore(3, [array], attributes);
  }
  if (nodeType !== "group") {
    throw new HonuaZarrError("invalid-response", "Zarr v3 node_type must be group or array.");
  }
  const names = stringList(attributes?.variables, "variables");
  if (names.length === 0) {
    throw new HonuaZarrError(
      "invalid-response",
      "The Zarr v3 group has no variables manifest. Directory listing is not used.",
    );
  }
  const arrays: ParsedArray[] = [];
  for (const name of names) {
    const document = await readJson(transport, `${name}/zarr.json`, signal);
    if (document === undefined) {
      throw new HonuaZarrError("invalid-response", `Zarr v3 array "${name}" is missing zarr.json.`, {
        variable: name,
      });
    }
    arrays.push(parseV3Array(name, name, record(document, `Zarr v3 array "${name}" is malformed.`)));
  }
  return finishStore(3, arrays, attributes);
}

async function readV2Array(
  transport: ZarrObjectTransport,
  name: string,
  relativePath: string,
  signal: AbortSignal,
): Promise<ParsedArray> {
  const document = await readJson(transport, `${relativePath}/.zarray`, signal);
  if (document === undefined) {
    throw new HonuaZarrError("invalid-response", `Zarr array "${name}" is missing .zarray.`, { variable: name });
  }
  const attrs = await readJson(transport, `${relativePath}/.zattrs`, signal);
  return parseV2Array(name, relativePath, document, attrs);
}

function parseV2Array(name: string, relativePath: string, document: unknown, attrs: unknown): ParsedArray {
  const root = record(document, `Zarr array "${name}" has a malformed .zarray document.`);
  const format = root.zarr_format;
  if (format !== 2) {
    throw new HonuaZarrError("unsupported-version", `Zarr array "${name}" is not version 2.`, {
      refusal: "unsupported-version",
      variable: name,
      zarrFormat: format ?? null,
    });
  }
  const shape = positiveInts(root.shape, `${name} shape`);
  const chunks = positiveInts(root.chunks, `${name} chunks`);
  const dtype = requiredString(root.dtype, `${name} dtype`);
  const order = typeof root.order === "string" ? root.order : "C";
  const separator = dimensionSeparator(root.dimension_separator, name);
  const filters = filterIds(root.filters, name);
  const compressor = compressorId(root.compressor, name);
  const names = dimensionNames(attrs, root, shape.length);
  const layout = layoutStatus({ order, separator, shape, chunks, names, grid: "regular" });
  return {
    name,
    relativePath,
    format: 2,
    shape,
    chunks,
    dtype,
    order,
    compressor,
    codecs: compressor ? [{ name: compressor }] : [],
    filters,
    fillValue: fillValue(root.fill_value, dtype, name),
    dimensionNames: names,
    separator,
    prefix: "",
    layout: layout.status,
    ...(layout.reason ? { layoutReason: layout.reason } : {}),
  };
}

function parseV3Array(name: string, relativePath: string, root: Record<string, unknown>): ParsedArray {
  if (root.node_type !== "array") {
    throw new HonuaZarrError("invalid-response", `Zarr v3 node "${name}" is not an array.`, { variable: name });
  }
  const shape = positiveInts(root.shape, `${name} shape`);
  const grid = isRecord(root.chunk_grid) ? root.chunk_grid : undefined;
  const gridName = typeof grid?.name === "string" ? grid.name : "";
  const configuration = isRecord(grid?.configuration) ? grid.configuration : undefined;
  const chunks =
    gridName === "regular" ? positiveInts(configuration?.chunk_shape, `${name} chunk_shape`) : shape.map(() => 0);
  if (gridName === "regular" && chunks.length !== shape.length) {
    throw new HonuaZarrError("invalid-response", `Zarr v3 array "${name}" chunk rank does not match its shape.`, {
      variable: name,
    });
  }
  const dtype = v3Dtype(requiredString(root.data_type, `${name} data_type`), name);
  const codecs = v3Codecs(root.codecs, name);
  const encoding = chunkKeyEncoding(root.chunk_key_encoding, name);
  const names = dimensionNames(undefined, root, shape.length);
  const gzip = codecs.find((codec) => codec.name === "gzip");
  const extra = codecs.filter((codec) => codec.name !== "bytes" && codec.name !== "gzip");
  const layout = layoutStatus({
    order: "C",
    separator: encoding?.separator,
    shape,
    chunks: gridName === "regular" ? chunks : [],
    names,
    grid: gridName,
    encoding: encoding?.name,
  });
  return {
    name,
    relativePath,
    format: 3,
    shape,
    chunks: gridName === "regular" ? chunks : shape,
    dtype,
    order: "C",
    compressor: gzip ? "gzip" : (extra[0]?.name ?? null),
    codecs,
    filters: [],
    fillValue: fillValue(root.fill_value, dtype, name),
    dimensionNames: names,
    separator: encoding?.separator ?? "/",
    prefix: encoding?.prefix ?? "c",
    layout: layout.status,
    ...(layout.reason ? { layoutReason: layout.reason } : {}),
  };
}

function finishStore(format: ZarrDirectFormat, arrays: readonly ParsedArray[], attrs: unknown): ParsedStore {
  if (arrays.length === 0) {
    throw new HonuaZarrError("invalid-response", "The Zarr store contains no arrays.");
  }
  const root = isRecord(attrs) ? attrs : undefined;
  const primary = optionalString(root?.primary_variable) ?? arrays[0]?.name ?? "";
  return {
    format,
    arrays,
    primary: arrays.some((array) => array.name === primary) ? primary : (arrays[0]?.name ?? primary),
    srid: sridOf(root),
    crsLabel: crsLabelOf(root),
    extent: extentOf(root),
    xDimension: optionalString(root?.x_dimension),
    yDimension: optionalString(root?.y_dimension),
    tDimension: optionalString(root?.t_dimension),
    temporalStart: optionalString(root?.t_start),
    temporalEnd: optionalString(root?.t_end),
    temporalStep: positiveNumber(root?.t_step_seconds),
    axisNotes: axisNotes(root?.axes),
  };
}

function layoutStatus(input: {
  order: string;
  separator: "." | "/" | undefined;
  shape: readonly number[];
  chunks: readonly number[];
  names: readonly string[];
  grid: string;
  encoding?: string;
}): { status: ZarrLayoutStatus; reason?: string } {
  if (input.order !== "C") return { status: "unsupported", reason: "Fortran order is not a reviewed layout." };
  if (input.grid !== "regular") return { status: "unsupported", reason: "Only regular chunk grids are reviewed." };
  if (input.encoding !== undefined && input.encoding !== "default" && input.encoding !== "v2") {
    return { status: "unsupported", reason: "The chunk key encoding is not a reviewed layout." };
  }
  if (input.separator === undefined) {
    return { status: "unsupported", reason: "The chunk key separator is not a reviewed layout." };
  }
  if (input.shape.length !== input.chunks.length || input.names.length !== input.shape.length) {
    return { status: "unsupported", reason: "Shape, chunks, and dimension names do not have the same rank." };
  }
  if (input.chunks.some((chunk) => chunk <= 0)) {
    return { status: "unsupported", reason: "Chunk extents must be positive." };
  }
  return { status: "supported" };
}

export function axisRole(
  name: string,
  store: Pick<ParsedStore, "xDimension" | "yDimension" | "tDimension">,
): ZarrAxisRole {
  if (store.xDimension && name === store.xDimension) return "x";
  if (store.yDimension && name === store.yDimension) return "y";
  if (store.tDimension && name === store.tDimension) return "time";
  const lower = name.toLowerCase();
  if (lower === "x" || lower === "lon" || lower === "longitude") return "x";
  if (lower === "y" || lower === "lat" || lower === "latitude") return "y";
  if (lower === "time" || lower === "t") return "time";
  if (lower === "band" || lower === "bands" || lower === "channel") return "band";
  return "other";
}

async function readJson(
  transport: ZarrObjectTransport,
  key: string,
  signal: AbortSignal,
): Promise<unknown | undefined> {
  const object = await transport.read(key, "metadata", transport.limits.maxMetadataBytes, signal);
  if (!object) return undefined;
  try {
    return JSON.parse(new TextDecoder().decode(object.bytes)) as unknown;
  } catch {
    throw new HonuaZarrError("invalid-response", "A Zarr metadata document is not valid JSON.", { key });
  }
}

function variableNames(attrs: unknown, consolidated: unknown): string[] {
  const fromAttrs = stringList(isRecord(attrs) ? attrs.variables : undefined, "variables");
  if (fromAttrs.length > 0) return fromAttrs;
  const metadata = isRecord(consolidated) ? consolidated.metadata : undefined;
  if (!isRecord(metadata)) return [];
  const names: string[] = [];
  for (const key of Object.keys(metadata)) {
    if (!key.endsWith("/.zarray")) continue;
    const name = key.slice(0, -"/.zarray".length);
    if (!name || name.includes("/") || name.includes("..")) continue;
    names.push(name);
    if (names.length > MAX_VARIABLES) {
      throw new HonuaZarrError("invalid-response", `Zarr discovery is capped at ${MAX_VARIABLES} variables.`);
    }
  }
  return names;
}

function stringList(value: unknown, label: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new HonuaZarrError("invalid-response", `Zarr ${label} must be an array of names.`);
  }
  const names: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || entry.trim() === "") continue;
    if (entry.includes("/") || entry.includes("\\") || entry.includes("..") || entry.includes("\0")) {
      throw new HonuaZarrError("invalid-request", `Zarr variable "${entry}" is not a single path segment.`);
    }
    names.push(entry);
    if (names.length > MAX_VARIABLES) {
      throw new HonuaZarrError("invalid-response", `Zarr discovery is capped at ${MAX_VARIABLES} variables.`);
    }
  }
  return names;
}

function dimensionNames(attrs: unknown, root: Record<string, unknown>, rank: number): string[] {
  const fromAttrs = namesOf(isRecord(attrs) ? attrs._ARRAY_DIMENSIONS : undefined);
  if (fromAttrs?.length === rank) return fromAttrs;
  const fromArray = namesOf(root._ARRAY_DIMENSIONS) ?? namesOf(root.dimension_names);
  if (fromArray?.length === rank) return fromArray;
  return Array.from({ length: rank }, (_unused, index) => `dim_${index}`);
}

function namesOf(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const names = value.map((entry, index) => (typeof entry === "string" && entry !== "" ? entry : `dim_${index}`));
  return names;
}

function dimensionSeparator(value: unknown, name: string): "." | "/" {
  if (value === undefined) return ".";
  if (value === "." || value === "/") return value;
  throw new HonuaZarrError("invalid-request", `Zarr array "${name}" uses an unreviewed dimension separator.`, {
    refusal: "unsupported-layout",
    variable: name,
    layout: "unsupported",
    structural: "supported",
  });
}

function filterIds(value: unknown, name: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new HonuaZarrError("invalid-response", `Zarr array "${name}" has malformed filters.`, { variable: name });
  }
  return value.map((entry) => {
    const id = isRecord(entry) && typeof entry.id === "string" ? entry.id : "";
    if (!id) {
      throw new HonuaZarrError("invalid-response", `Zarr array "${name}" has a malformed filter.`, { variable: name });
    }
    return id;
  });
}

function compressorId(value: unknown, name: string): string | null {
  if (value === undefined || value === null) return null;
  if (isRecord(value) && typeof value.id === "string" && value.id !== "") return value.id;
  throw new HonuaZarrError("invalid-response", `Zarr array "${name}" has a malformed compressor.`, { variable: name });
}

function v3Codecs(value: unknown, name: string): ParsedCodec[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new HonuaZarrError("invalid-response", `Zarr v3 array "${name}" is missing its codec pipeline.`, {
      variable: name,
    });
  }
  return value.map((entry) => {
    if (!isRecord(entry) || typeof entry.name !== "string" || entry.name === "") {
      throw new HonuaZarrError("invalid-response", `Zarr v3 array "${name}" has a malformed codec entry.`, {
        variable: name,
      });
    }
    if (entry.name !== "bytes") return { name: entry.name };
    const configuration = isRecord(entry.configuration) ? entry.configuration : undefined;
    const endian = configuration?.endian;
    if (endian === undefined) return { name: "bytes", endian: "little" as const };
    if (endian === "little" || endian === "big") return { name: "bytes", endian };
    throw new HonuaZarrError("invalid-response", `Zarr v3 array "${name}" has a malformed bytes codec.`, {
      variable: name,
    });
  });
}

function chunkKeyEncoding(
  value: unknown,
  name: string,
): { name: string; separator?: "." | "/"; prefix: "" | "c" } | undefined {
  if (value === undefined) return { name: "default", separator: "/", prefix: "c" };
  if (!isRecord(value)) {
    throw new HonuaZarrError("invalid-response", `Zarr v3 array "${name}" has a malformed chunk key encoding.`, {
      variable: name,
    });
  }
  const encodingName = typeof value.name === "string" ? value.name : "default";
  const configuration = isRecord(value.configuration) ? value.configuration : undefined;
  const configured = configuration?.separator;
  const separator = configured === "/" || configured === "." ? configured : configured === undefined ? undefined : null;
  const fallback = encodingName === "v2" ? "." : "/";
  const resolved = separator === undefined ? fallback : separator === null ? undefined : separator;
  const prefix: "" | "c" = encodingName === "v2" ? "" : "c";
  return { name: encodingName, ...(resolved ? { separator: resolved } : {}), prefix };
}

function v3Dtype(dataType: string, name: string): string {
  const mapped: Record<string, string> = {
    bool: "|b1",
    int8: "|i1",
    uint8: "|u1",
    int16: "<i2",
    uint16: "<u2",
    int32: "<i4",
    uint32: "<u4",
    int64: "<i8",
    uint64: "<u8",
    float32: "<f4",
    float64: "<f8",
  };
  const dtype = mapped[dataType];
  if (!dtype) {
    throw new HonuaZarrError("unsupported-dtype", `Zarr v3 array "${name}" uses an unreviewed data type.`, {
      refusal: "unsupported-dtype",
      variable: name,
      dataType,
    });
  }
  return dtype;
}

function fillValue(value: unknown, dtype: string, name: string): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "number") return value;
  if (typeof value !== "string") return null;
  const text = value.trim().toLowerCase();
  if (text === "nan") return Number.NaN;
  if (text === "infinity" || text === "+infinity" || text === "inf" || text === "+inf") return Number.POSITIVE_INFINITY;
  if (text === "-infinity" || text === "-inf") return Number.NEGATIVE_INFINITY;
  if (text.startsWith("0x")) {
    const bits = Number.parseInt(text.slice(2), 16);
    if (dtype === "<f4" && Number.isSafeInteger(bits)) {
      const view = new DataView(new ArrayBuffer(4));
      view.setUint32(0, bits, true);
      return view.getFloat32(0, true);
    }
    if (dtype === "<f8") {
      const view = new DataView(new ArrayBuffer(8));
      const high = Number.parseInt(text.slice(2, text.length - 8), 16);
      const low = Number.parseInt(text.slice(-8), 16);
      if (Number.isFinite(high) && Number.isFinite(low)) {
        view.setUint32(0, low, true);
        view.setUint32(4, high, true);
        return view.getFloat64(0, true);
      }
    }
  }
  if (dtype === "<f4" || dtype === "<f8") {
    throw new HonuaZarrError("invalid-response", `Zarr array "${name}" has an unreadable floating fill value.`, {
      variable: name,
    });
  }
  return null;
}

function crsLabelOf(attrs: Record<string, unknown> | undefined): string | null {
  const srid = sridOf(attrs);
  if (srid) return `EPSG:${srid}`;
  const crs = optionalString(attrs?.crs);
  if (!crs) return null;
  if (/^(?:ogc:)?crs84$/iu.test(crs.trim())) return "CRS84";
  return crs;
}

function sridOf(attrs: Record<string, unknown> | undefined): number | null {
  const wkid = attrs?.crs_wkid;
  if (typeof wkid === "number" && Number.isSafeInteger(wkid) && wkid > 0) return wkid;
  const crs = optionalString(attrs?.crs);
  const match = crs ? /^(?:epsg:)?(\d+)$/iu.exec(crs.trim()) : undefined;
  if (!match) return null;
  const code = Number(match[1]);
  return Number.isSafeInteger(code) && code > 0 ? code : null;
}

function extentOf(attrs: Record<string, unknown> | undefined): [number, number, number, number] | null {
  const extent = attrs?.extent;
  if (!Array.isArray(extent) || extent.length !== 4) return null;
  if (extent.some((value) => typeof value !== "number" || !Number.isFinite(value))) return null;
  const [minX, minY, maxX, maxY] = extent as [number, number, number, number];
  if (maxX <= minX || maxY <= minY) return null;
  return [minX, minY, maxX, maxY];
}

function axisNotes(value: unknown): ParsedAxisNote[] {
  if (!Array.isArray(value)) return [];
  const notes: ParsedAxisNote[] = [];
  for (const entry of value) {
    if (!isRecord(entry) || typeof entry.name !== "string" || entry.name === "") continue;
    const coordinates = Array.isArray(entry.coordinates)
      ? entry.coordinates.filter((item): item is number => typeof item === "number" && Number.isFinite(item))
      : undefined;
    const start = typeof entry.start === "number" && Number.isFinite(entry.start) ? entry.start : undefined;
    const end = typeof entry.end === "number" && Number.isFinite(entry.end) ? entry.end : undefined;
    const unit = optionalString(entry.unit) ?? undefined;
    notes.push({
      name: entry.name,
      ...(unit ? { unit } : {}),
      ...(coordinates && coordinates.length > 0 ? { coordinates } : {}),
      ...(start === undefined ? {} : { start }),
      ...(end === undefined ? {} : { end }),
    });
  }
  return notes;
}

function positiveInts(value: unknown, label: string): number[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new HonuaZarrError("invalid-response", `Zarr ${label} must be a non-empty integer array.`);
  }
  return value.map((entry) => {
    if (typeof entry !== "number" || !Number.isSafeInteger(entry) || entry <= 0) {
      throw new HonuaZarrError("invalid-response", `Zarr ${label} contains a non-positive integer.`);
    }
    return entry;
  });
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value === "") {
    throw new HonuaZarrError("invalid-response", `Zarr metadata is missing ${label}.`);
  }
  return value;
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function positiveNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function singleArrayName(storeUrl: string): string {
  const path = new URL(storeUrl).pathname.replace(/\/$/u, "");
  const slash = path.lastIndexOf("/");
  const name = slash >= 0 ? path.slice(slash + 1) : path;
  return name || "data";
}

function record(value: unknown, message: string): Record<string, unknown> {
  if (!isRecord(value)) throw new HonuaZarrError("invalid-response", message);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
