const MAX_SAFE_INTEGER_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);
const MIN_SAFE_INTEGER_BIGINT = BigInt(Number.MIN_SAFE_INTEGER);
const MIN_PROTO_INT64 = -(1n << 63n);
const MAX_PROTO_INT64 = (1n << 63n) - 1n;

export function toProtoObjectId(value: string): bigint {
  const token = value.trim();
  if (!/^(?:0|-?[1-9][0-9]*)$/.test(token)) {
    throw new RangeError("string objectIds must contain canonical decimal int64 values");
  }
  const parsed = BigInt(token);
  if (parsed < MIN_PROTO_INT64 || parsed > MAX_PROTO_INT64) {
    throw new RangeError("string objectIds must remain within the signed int64 range");
  }
  return parsed;
}

export function toSafeNumberOrString(value: bigint): number | string {
  if (value <= MAX_SAFE_INTEGER_BIGINT && value >= MIN_SAFE_INTEGER_BIGINT) {
    return Number(value);
  }
  return value.toString();
}
