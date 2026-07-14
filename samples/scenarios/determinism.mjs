import crypto from "node:crypto";

export const DEFAULT_FROZEN_TIME = "2026-05-05T18:10:00.000Z";

export function hasAsciiControlCharacters(value) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 31 || code === 127) return true;
  }
  return false;
}

export function createFrozenClock(initialTime = DEFAULT_FROZEN_TIME) {
  const initial = Date.parse(initialTime);
  if (!Number.isFinite(initial)) throw new Error(`Invalid frozen clock value: ${initialTime}`);
  let current = initial;
  return Object.freeze({
    now: () => current,
    iso: () => new Date(current).toISOString(),
    advance(milliseconds) {
      if (!Number.isSafeInteger(milliseconds) || milliseconds < 0 || milliseconds > 86_400_000) {
        throw new Error("Clock advances must be integer milliseconds between 0 and 86400000.");
      }
      current += milliseconds;
      return current;
    },
    reset() {
      current = initial;
      return current;
    },
  });
}

function seedNumber(seed) {
  const digest = crypto.createHash("sha256").update(seed).digest();
  return digest.readUInt32BE(0) || 0x9e3779b9;
}

export function createSeededIds(seed) {
  let state = seedNumber(String(seed));
  let ordinal = 0;
  return Object.freeze({
    next(prefix = "id") {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      ordinal += 1;
      return `${prefix}-${ordinal.toString(36)}-${(state >>> 0).toString(36).padStart(7, "0")}`;
    },
  });
}

export function canonicalJson(value) {
  return JSON.stringify(sortJson(value, new WeakSet(), "$"));
}

function sortJson(value, ancestors, location) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError(`Non-finite JSON number at ${location}.`);
    return value;
  }
  if (typeof value !== "object") throw new TypeError(`Non-JSON value at ${location}.`);
  if (ancestors.has(value)) throw new TypeError(`Cyclic JSON value at ${location}.`);
  ancestors.add(value);
  let sorted;
  if (Array.isArray(value)) {
    sorted = value.map((entry, index) => sortJson(entry, ancestors, `${location}[${index}]`));
  } else {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null)
      throw new TypeError(`Non-plain JSON object at ${location}.`);
    sorted = Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortJson(value[key], ancestors, `${location}.${key}`)]),
    );
  }
  ancestors.delete(value);
  return sorted;
}

export function fingerprint(value) {
  if (typeof value !== "string" || value.length > 4_096)
    throw new TypeError("Fingerprint input must be a bounded string.");
  return crypto.createHash("sha256").update(value).digest("hex").slice(0, 16);
}
