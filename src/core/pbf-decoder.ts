/**
 * Minimal protobuf wire-format reader and Esri PBF query response decoder.
 *
 * Decodes `FeatureCollectionPBuffer` responses (from `f=pbf`) into the same
 * JSON-compatible shape as `f=json`, making the binary format transparent
 * to callers.
 *
 * No external protobuf library dependency. Implements only the subset of
 * the wire format needed for the Esri PBF query schema.
 *
 * @module
 */

// ── Wire format constants ────────────────────────────────────

const WIRE_VARINT = 0;
const WIRE_64BIT = 1;
const WIRE_LENGTH_DELIMITED = 2;
const WIRE_32BIT = 5;

/**
 * Thrown when a PBF feature response cannot be decoded losslessly into the
 * `f=json` shape — either because it carries Z/M geometry (which the flat
 * 2D fast-path decoder would silently garble) or because the coordinate
 * stream is malformed (odd length / non-finite values from a truncated or
 * hostile payload). `HonuaClient` treats this as a signal to fall back to a
 * fresh `f=json` request, which decodes the same data correctly.
 */
export class PbfDecodeError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "PbfDecodeError";
  }
}

// ── Low-level protobuf reader ────────────────────────────────

/** Reads protobuf wire-format primitives from a byte buffer. */
class PbfReader {
  private readonly view: DataView;
  private readonly bytes: Uint8Array;
  pos: number;
  readonly end: number;

  constructor(buffer: Uint8Array, offset = 0, length?: number) {
    this.bytes = buffer;
    this.view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    this.pos = offset;
    this.end = length !== undefined ? offset + length : buffer.length;
  }

  /** Read an unsigned 32-bit varint. */
  readVarint(): number {
    let result = 0;
    let shift = 0;
    while (this.pos < this.end) {
      const byte = this.bytes[this.pos++];
      result |= (byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) return result >>> 0;
      shift += 7;
      if (shift > 35) throw new Error("Varint too long");
    }
    throw new Error("Unexpected end of buffer reading varint");
  }

  /** Read a 64-bit varint as a JavaScript number (safe for values < 2^53). */
  readVarint64(): number {
    let lo = 0;
    let hi = 0;
    let shift = 0;
    while (shift < 28 && this.pos < this.end) {
      const byte = this.bytes[this.pos++];
      lo |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) return lo >>> 0;
    }
    // Remaining bits go into hi
    while (this.pos < this.end) {
      const byte = this.bytes[this.pos++];
      hi |= (byte & 0x7f) << (shift - 28);
      shift += 7;
      if ((byte & 0x80) === 0) break;
      if (shift > 63) throw new Error("Varint too long");
    }
    return (hi >>> 0) * 0x10000000 + (lo >>> 0);
  }

  /**
   * Read a 64-bit varint as a raw {@link bigint} with no precision loss. Used
   * for attribute decoding where values may exceed `Number.MAX_SAFE_INTEGER`
   * (e.g. BigInteger / 64-bit OID fields), so the caller can preserve exact
   * values as a string instead of silently rounding.
   */
  readVarint64Bigint(): bigint {
    let result = 0n;
    let shift = 0n;
    while (this.pos < this.end) {
      const byte = this.bytes[this.pos++];
      result |= BigInt(byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) return result;
      shift += 7n;
      if (shift > 63n) throw new Error("Varint too long");
    }
    throw new Error("Unexpected end of buffer reading varint");
  }

  /** Read a signed 64-bit varint (zigzag-decoded) as a JavaScript number. */
  readSVarint64(): number {
    const n = this.readVarint64();
    // Zigzag decode: (n >>> 1) ^ -(n & 1)
    // For numbers that fit in 32 bits this is straightforward.
    // For larger numbers, we do the math in floating point (safe for ints < 2^53).
    const half = Math.floor(n / 2);
    return n % 2 === 0 ? half : -(half + 1);
  }

  /** Read a signed 32-bit varint (zigzag-decoded). */
  readSVarint32(): number {
    const n = this.readVarint();
    return (n >>> 1) ^ -(n & 1);
  }

  /** Read a little-endian 64-bit float. */
  readDouble(): number {
    const val = this.view.getFloat64(this.pos, true);
    this.pos += 8;
    return val;
  }

  /** Read a little-endian 32-bit float. */
  readFloat(): number {
    const val = this.view.getFloat32(this.pos, true);
    this.pos += 4;
    return val;
  }

  /** Read a UTF-8 string of the given byte length. */
  readString(byteLength: number): string {
    const slice = this.bytes.subarray(this.pos, this.pos + byteLength);
    this.pos += byteLength;
    return textDecoder.decode(slice);
  }

  /** Read a boolean from a varint. */
  readBool(): boolean {
    return this.readVarint() !== 0;
  }

  /** Read a field tag, returning [fieldNumber, wireType]. */
  readTag(): [number, number] {
    const tag = this.readVarint();
    return [tag >>> 3, tag & 0x07];
  }

  /** Skip a field value based on wire type. */
  skip(wireType: number): void {
    switch (wireType) {
      case WIRE_VARINT:
        this.readVarint64();
        break;
      case WIRE_64BIT:
        this.pos += 8;
        break;
      case WIRE_LENGTH_DELIMITED: {
        const len = this.readVarint();
        this.pos += len;
        break;
      }
      case WIRE_32BIT:
        this.pos += 4;
        break;
      default:
        throw new Error(`Unknown wire type: ${wireType}`);
    }
  }

  /** Create a sub-reader for a length-delimited field. */
  subReader(byteLength: number): PbfReader {
    const sub = new PbfReader(this.bytes, this.pos, byteLength);
    this.pos += byteLength;
    return sub;
  }

  /** Read packed repeated sint64 values. */
  readPackedSInt64(byteLength: number): number[] {
    const result: number[] = [];
    const end = this.pos + byteLength;
    while (this.pos < end) {
      result.push(this.readSVarint64());
    }
    return result;
  }

  /** Read packed repeated uint32 values. */
  readPackedUInt32(byteLength: number): number[] {
    const result: number[] = [];
    const end = this.pos + byteLength;
    while (this.pos < end) {
      result.push(this.readVarint());
    }
    return result;
  }
}

const textDecoder = new TextDecoder();

// ── Esri PBF geometry type enum ──────────────────────────────

const PBF_GEOMETRY_TYPE_NAMES: Record<number, string> = {
  0: "esriGeometryPoint",
  1: "esriGeometryMultipoint",
  2: "esriGeometryPolyline",
  3: "esriGeometryPolygon",
  4: "esriGeometryEnvelope",
  127: "esriGeometryNull",
};

// ── Schema decoders ──────────────────────────────────────────

interface PbfTransform {
  xScale: number;
  yScale: number;
  xTranslate: number;
  yTranslate: number;
}

interface PbfFieldDef {
  name: string;
  fieldType: number;
  alias: string;
}

function decodeScale(reader: PbfReader): { xScale: number; yScale: number } {
  let xScale = 0;
  let yScale = 0;
  while (reader.pos < reader.end) {
    const [field, wire] = reader.readTag();
    if (field === 1 && wire === WIRE_64BIT) xScale = reader.readDouble();
    else if (field === 2 && wire === WIRE_64BIT) yScale = reader.readDouble();
    else reader.skip(wire);
  }
  return { xScale, yScale };
}

function decodeTranslate(reader: PbfReader): { xTranslate: number; yTranslate: number } {
  let xTranslate = 0;
  let yTranslate = 0;
  while (reader.pos < reader.end) {
    const [field, wire] = reader.readTag();
    if (field === 1 && wire === WIRE_64BIT) xTranslate = reader.readDouble();
    else if (field === 2 && wire === WIRE_64BIT) yTranslate = reader.readDouble();
    else reader.skip(wire);
  }
  return { xTranslate, yTranslate };
}

function decodeTransform(reader: PbfReader): PbfTransform {
  let xScale = 1;
  let yScale = 1;
  let xTranslate = 0;
  let yTranslate = 0;
  while (reader.pos < reader.end) {
    const [field, wire] = reader.readTag();
    if (field === 2 && wire === WIRE_LENGTH_DELIMITED) {
      const len = reader.readVarint();
      const sub = reader.subReader(len);
      const s = decodeScale(sub);
      xScale = s.xScale;
      yScale = s.yScale;
    } else if (field === 3 && wire === WIRE_LENGTH_DELIMITED) {
      const len = reader.readVarint();
      const sub = reader.subReader(len);
      const t = decodeTranslate(sub);
      xTranslate = t.xTranslate;
      yTranslate = t.yTranslate;
    } else {
      reader.skip(wire);
    }
  }
  return { xScale, yScale, xTranslate, yTranslate };
}

function decodeField(reader: PbfReader): PbfFieldDef {
  let name = "";
  let fieldType = 0;
  let alias = "";
  while (reader.pos < reader.end) {
    const [field, wire] = reader.readTag();
    if (field === 1 && wire === WIRE_LENGTH_DELIMITED) {
      const len = reader.readVarint();
      name = reader.readString(len);
    } else if (field === 2 && wire === WIRE_VARINT) {
      fieldType = reader.readVarint();
    } else if (field === 3 && wire === WIRE_LENGTH_DELIMITED) {
      const len = reader.readVarint();
      alias = reader.readString(len);
    } else {
      reader.skip(wire);
    }
  }
  return { name, fieldType, alias: alias || name };
}

function decodeSpatialReference(reader: PbfReader): { wkid: number; latestWkid: number } {
  let wkid = 0;
  let latestWkid = 0;
  while (reader.pos < reader.end) {
    const [field, wire] = reader.readTag();
    if (field === 1 && wire === WIRE_VARINT) wkid = reader.readVarint();
    else if (field === 2 && wire === WIRE_VARINT) latestWkid = reader.readVarint();
    else reader.skip(wire);
  }
  return { wkid, latestWkid: latestWkid || wkid };
}

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
const MIN_SAFE = BigInt(Number.MIN_SAFE_INTEGER);
const TWO_POW_64 = 1n << 64n;

/**
 * Reinterpret an unsigned 64-bit value as signed two's-complement, matching how
 * GeoServices PBF encodes `int64` attributes.
 */
function asInt64(unsigned: bigint): bigint {
  return unsigned >= 1n << 63n ? unsigned - TWO_POW_64 : unsigned;
}

/**
 * Preserve 64-bit integer precision: return a JS `number` when the value fits
 * within the safe-integer range, otherwise a decimal string. Mirrors the gRPC
 * transport's `toSafeNumberOrString` so PBF, gRPC, and `f=json` agree on large
 * 64-bit ids instead of the PBF fast path silently rounding above 2^53.
 */
function safeNumberOrString(value: bigint): number | string {
  return value <= MAX_SAFE && value >= MIN_SAFE ? Number(value) : value.toString();
}

function decodeValue(reader: PbfReader): { value: unknown; fieldIndex: number } {
  let value: unknown = null;
  let fieldIndex = -1;
  while (reader.pos < reader.end) {
    const [field, wire] = reader.readTag();
    switch (field) {
      case 1: // string_value
        if (wire === WIRE_LENGTH_DELIMITED) {
          const len = reader.readVarint();
          value = reader.readString(len);
        } else reader.skip(wire);
        break;
      case 2: // float_value
        if (wire === WIRE_32BIT) value = reader.readFloat();
        else reader.skip(wire);
        break;
      case 3: // double_value
        if (wire === WIRE_64BIT) value = reader.readDouble();
        else reader.skip(wire);
        break;
      case 4: // sint_value (sint32)
        if (wire === WIRE_VARINT) value = reader.readSVarint32();
        else reader.skip(wire);
        break;
      case 5: // uint_value
        if (wire === WIRE_VARINT) value = reader.readVarint();
        else reader.skip(wire);
        break;
      case 6: // int64_value (signed two's-complement)
        if (wire === WIRE_VARINT) value = safeNumberOrString(asInt64(reader.readVarint64Bigint()));
        else reader.skip(wire);
        break;
      case 7: // uint64_value
        if (wire === WIRE_VARINT) value = safeNumberOrString(reader.readVarint64Bigint());
        else reader.skip(wire);
        break;
      case 9: // bool_value
        if (wire === WIRE_VARINT) value = reader.readBool();
        else reader.skip(wire);
        break;
      case 10: // null_value
        if (wire === WIRE_VARINT) {
          reader.readVarint(); // consume the bool
          value = null;
        } else reader.skip(wire);
        break;
      case 11: // field_index
        if (wire === WIRE_VARINT) fieldIndex = reader.readVarint();
        else reader.skip(wire);
        break;
      default:
        reader.skip(wire);
    }
  }
  return { value, fieldIndex };
}

function decodeGeometry(
  reader: PbfReader,
  transform: PbfTransform | null,
  layerGeometryType: string,
): Record<string, unknown> | null {
  let lengths: number[] = [];
  let coords: number[] = [];

  while (reader.pos < reader.end) {
    const [field, wire] = reader.readTag();
    if (field === 1 && wire === WIRE_VARINT) {
      reader.readVarint(); // geometryType — we use layerGeometryType instead
    } else if (field === 2 && wire === WIRE_LENGTH_DELIMITED) {
      const len = reader.readVarint();
      lengths = reader.readPackedUInt32(len);
    } else if (field === 3 && wire === WIRE_LENGTH_DELIMITED) {
      const len = reader.readVarint();
      coords = reader.readPackedSInt64(len);
    } else {
      reader.skip(wire);
    }
  }

  if (coords.length === 0) return null;

  // The 2D fast path packs the stream as flat (x, y) pairs. A truncated or
  // hostile payload with an odd number of values would otherwise read past the
  // last x as a `y === undefined`, delta-accumulate to NaN, and propagate
  // silent NaN coordinates through the geometry. Reject it instead so the
  // caller can fall back to f=json.
  if (coords.length % 2 !== 0) {
    throw new PbfDecodeError(`PBF geometry coordinate stream has an odd length (${coords.length})`);
  }

  // Delta-decode and transform coordinates
  const xScale = transform?.xScale ?? 1;
  const yScale = transform?.yScale ?? 1;
  const xTranslate = transform?.xTranslate ?? 0;
  const yTranslate = transform?.yTranslate ?? 0;

  // Undo delta encoding: each coordinate pair is (deltaX, deltaY)
  let prevX = 0;
  let prevY = 0;
  const worldCoords: number[][] = [];
  for (let i = 0; i < coords.length; i += 2) {
    prevX += coords[i];
    prevY += coords[i + 1];
    const x = prevX * xScale + xTranslate;
    const y = prevY * yScale + yTranslate;
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      throw new PbfDecodeError("PBF geometry produced a non-finite coordinate");
    }
    worldCoords.push([x, y]);
  }

  return buildGeoServicesGeometry(layerGeometryType, worldCoords, lengths);
}

function buildGeoServicesGeometry(
  geometryType: string,
  worldCoords: number[][],
  lengths: number[],
): Record<string, unknown> {
  switch (geometryType) {
    case "esriGeometryPoint":
      return worldCoords.length > 0 ? { x: worldCoords[0][0], y: worldCoords[0][1] } : { x: null, y: null };

    case "esriGeometryMultipoint":
      return { points: worldCoords };

    case "esriGeometryPolyline": {
      const paths: number[][][] = [];
      let offset = 0;
      for (const len of lengths) {
        paths.push(worldCoords.slice(offset, offset + len));
        offset += len;
      }
      return { paths: paths.length > 0 ? paths : [worldCoords] };
    }

    case "esriGeometryPolygon": {
      const rings: number[][][] = [];
      let offset = 0;
      for (const len of lengths) {
        rings.push(worldCoords.slice(offset, offset + len));
        offset += len;
      }
      return { rings: rings.length > 0 ? rings : [worldCoords] };
    }

    default:
      return { x: worldCoords[0]?.[0] ?? null, y: worldCoords[0]?.[1] ?? null };
  }
}

function decodeFeature(
  reader: PbfReader,
  fields: PbfFieldDef[],
  transform: PbfTransform | null,
  geometryType: string,
): Record<string, unknown> {
  const attributes: Record<string, unknown> = {};
  let geometry: Record<string, unknown> | null = null;
  const valueEntries: Array<{ value: unknown; fieldIndex: number }> = [];

  while (reader.pos < reader.end) {
    const [field, wire] = reader.readTag();
    if (field === 1 && wire === WIRE_LENGTH_DELIMITED) {
      const len = reader.readVarint();
      const sub = reader.subReader(len);
      valueEntries.push(decodeValue(sub));
    } else if (field === 2 && wire === WIRE_LENGTH_DELIMITED) {
      const len = reader.readVarint();
      const sub = reader.subReader(len);
      geometry = decodeGeometry(sub, transform, geometryType);
    } else {
      reader.skip(wire);
    }
  }

  // Map value entries to field names using field indices
  for (const entry of valueEntries) {
    if (entry.fieldIndex >= 0 && entry.fieldIndex < fields.length) {
      attributes[fields[entry.fieldIndex].name] = entry.value;
    }
  }

  const result: Record<string, unknown> = { attributes };
  if (geometry !== null) {
    result.geometry = geometry;
  }
  return result;
}

function decodeFeatureResult(reader: PbfReader): Record<string, unknown> {
  let objectIdFieldName = "";
  let geometryType = "";
  let spatialReference: { wkid: number; latestWkid: number } | null = null;
  let exceededTransferLimit = false;
  let hasZ = false;
  let hasM = false;
  let transform: PbfTransform | null = null;
  const fields: PbfFieldDef[] = [];
  const featureReaders: PbfReader[] = [];

  while (reader.pos < reader.end) {
    const [field, wire] = reader.readTag();
    switch (field) {
      case 1: // objectIdFieldName
        if (wire === WIRE_LENGTH_DELIMITED) {
          const len = reader.readVarint();
          objectIdFieldName = reader.readString(len);
        } else reader.skip(wire);
        break;
      case 7: // geometryType
        if (wire === WIRE_VARINT) {
          const gt = reader.readVarint();
          geometryType = PBF_GEOMETRY_TYPE_NAMES[gt] ?? "esriGeometryNull";
        } else reader.skip(wire);
        break;
      case 8: // spatialReference
        if (wire === WIRE_LENGTH_DELIMITED) {
          const len = reader.readVarint();
          spatialReference = decodeSpatialReference(reader.subReader(len));
        } else reader.skip(wire);
        break;
      case 9: // exceededTransferLimit
        if (wire === WIRE_VARINT) exceededTransferLimit = reader.readBool();
        else reader.skip(wire);
        break;
      case 10: // hasZ
        if (wire === WIRE_VARINT) hasZ = reader.readBool();
        else reader.skip(wire);
        break;
      case 11: // hasM
        if (wire === WIRE_VARINT) hasM = reader.readBool();
        else reader.skip(wire);
        break;
      case 12: // transform
        if (wire === WIRE_LENGTH_DELIMITED) {
          const len = reader.readVarint();
          transform = decodeTransform(reader.subReader(len));
        } else reader.skip(wire);
        break;
      case 13: // fields (repeated)
        if (wire === WIRE_LENGTH_DELIMITED) {
          const len = reader.readVarint();
          fields.push(decodeField(reader.subReader(len)));
        } else reader.skip(wire);
        break;
      case 15: // features (repeated)
        if (wire === WIRE_LENGTH_DELIMITED) {
          const len = reader.readVarint();
          // Defer feature decoding until we have all fields and transform
          featureReaders.push(reader.subReader(len));
        } else reader.skip(wire);
        break;
      default:
        reader.skip(wire);
    }
  }

  // The geometry decoder reads the packed coordinate stream as flat (x, y)
  // pairs. When the server advertises Z and/or M, each vertex carries extra
  // ordinates, so decoding as 2D pairs would mis-pair every coordinate and
  // garble the geometry. Rather than emit silently corrupt geometry on the
  // binary fast path, signal the caller to fall back to f=json (which decodes
  // Z/M correctly). See HonuaClient.requestBinaryWithJsonFallback.
  if (hasZ || hasM) {
    throw new PbfDecodeError(
      `PBF response carries ${hasZ ? "Z" : ""}${hasZ && hasM ? "/" : ""}${hasM ? "M" : ""} geometry; falling back to f=json`,
    );
  }

  // Now decode features with full field/transform context
  const features = featureReaders.map((fr) => decodeFeature(fr, fields, transform, geometryType));

  // Build JSON-compatible response matching f=json shape
  const result: Record<string, unknown> = {
    objectIdFieldName,
    fields: fields.map((f) => ({
      name: f.name,
      type: mapPbfFieldTypeToGeoServices(f.fieldType),
      alias: f.alias,
    })),
    features,
  };

  if (geometryType && geometryType !== "esriGeometryNull") {
    result.geometryType = geometryType;
  }
  if (spatialReference) {
    result.spatialReference = spatialReference;
  }
  if (hasZ) result.hasZ = true;
  if (hasM) result.hasM = true;
  if (exceededTransferLimit) {
    result.exceededTransferLimit = true;
  }

  return result;
}

function mapPbfFieldTypeToGeoServices(fieldType: number): string {
  switch (fieldType) {
    case 0:
      return "esriFieldTypeSmallInteger";
    case 1:
      return "esriFieldTypeInteger";
    case 2:
      return "esriFieldTypeSingle";
    case 3:
      return "esriFieldTypeDouble";
    case 4:
      return "esriFieldTypeString";
    case 5:
      return "esriFieldTypeDate";
    case 6:
      return "esriFieldTypeOID";
    case 7:
      return "esriFieldTypeGeometry";
    case 8:
      return "esriFieldTypeBlob";
    case 10:
      return "esriFieldTypeGUID";
    case 11:
      return "esriFieldTypeGlobalID";
    case 12:
      return "esriFieldTypeXML";
    case 13:
      return "esriFieldTypeBigInteger";
    default:
      return "esriFieldTypeString";
  }
}

// ── Public API ───────────────────────────────────────────────

/**
 * Decode an Esri FeatureCollectionPBuffer response into a JSON-compatible
 * query response object.
 *
 * The returned object has the same shape as an `f=json` response:
 * `{ objectIdFieldName, geometryType, spatialReference, fields, features, ... }`
 *
 * @param buffer - The raw PBF bytes from a `f=pbf` response.
 * @returns A JSON-compatible query response object.
 */
export function decodePbfQueryResponse(buffer: ArrayBuffer | Uint8Array): Record<string, unknown> {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const reader = new PbfReader(bytes);

  let queryResult: Record<string, unknown> = {};

  // FeatureCollectionPBuffer
  while (reader.pos < reader.end) {
    const [field, wire] = reader.readTag();
    if (field === 1 && wire === WIRE_LENGTH_DELIMITED) {
      // version string — skip
      const len = reader.readVarint();
      reader.pos += len;
    } else if (field === 2 && wire === WIRE_LENGTH_DELIMITED) {
      // queryResult
      const len = reader.readVarint();
      const qrReader = reader.subReader(len);
      // QueryResult → featureResult (field 1)
      while (qrReader.pos < qrReader.end) {
        const [qrField, qrWire] = qrReader.readTag();
        if (qrField === 1 && qrWire === WIRE_LENGTH_DELIMITED) {
          const frLen = qrReader.readVarint();
          queryResult = decodeFeatureResult(qrReader.subReader(frLen));
        } else {
          qrReader.skip(qrWire);
        }
      }
    } else {
      reader.skip(wire);
    }
  }

  return queryResult;
}

/**
 * Check whether a Response has a protobuf content type.
 */
export function isPbfResponse(response: Response): boolean {
  const ct = response.headers.get("content-type") ?? "";
  return ct.includes("application/x-protobuf") || ct.includes("application/protobuf");
}
