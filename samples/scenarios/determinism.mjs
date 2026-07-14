import crypto from "node:crypto";

export const DEFAULT_FROZEN_TIME = "2026-05-05T18:10:00.000Z";

const RFC3339_INSTANT = /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(\.\d+)?(?:[Zz]|([+-])(\d{2}):(\d{2}))$/;
const LEAP_SECOND_TRANSITIONS = new Set(
  [
    "1972-07-01",
    "1973-01-01",
    "1974-01-01",
    "1975-01-01",
    "1976-01-01",
    "1977-01-01",
    "1978-01-01",
    "1979-01-01",
    "1980-01-01",
    "1981-07-01",
    "1982-07-01",
    "1983-07-01",
    "1985-07-01",
    "1988-01-01",
    "1990-01-01",
    "1991-01-01",
    "1992-07-01",
    "1993-07-01",
    "1994-07-01",
    "1996-01-01",
    "1997-07-01",
    "1999-01-01",
    "2006-01-01",
    "2009-01-01",
    "2012-07-01",
    "2015-07-01",
    "2017-01-01",
  ].map((date) => Date.parse(`${date}T00:00:00Z`)),
);

function parseRfc3339Details(value) {
  if (typeof value !== "string") return undefined;
  const match = RFC3339_INSTANT.exec(value);
  if (!match) return undefined;
  const [
    ,
    yearText,
    monthText,
    dayText,
    hourText,
    minuteText,
    secondText,
    fractionText,
    ,
    offsetHourText,
    offsetMinuteText,
  ] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const offsetHour = offsetHourText === undefined ? 0 : Number(offsetHourText);
  const offsetMinute = offsetMinuteText === undefined ? 0 : Number(offsetMinuteText);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysInMonth[month - 1] ||
    hour > 23 ||
    minute > 59 ||
    second > 60 ||
    offsetHour > 23 ||
    offsetMinute > 59
  ) {
    return undefined;
  }
  const parseable = second === 60 ? value.replace(/:60(?=(?:\.\d+)?(?:[Zz]|[+-]\d{2}:\d{2})$)/, ":59") : value;
  const parsed = Date.parse(parseable);
  if (!Number.isFinite(parsed)) return undefined;
  const milliseconds = parsed + (second === 60 ? 1_000 : 0);
  const orderingSecond = Math.floor(milliseconds / 1_000);
  if (second === 60 && !LEAP_SECOND_TRANSITIONS.has(orderingSecond * 1_000)) return undefined;
  return {
    milliseconds,
    orderingSecond,
    leapSecond: second === 60,
    fraction: (fractionText ?? "").slice(1).replace(/0+$/, ""),
  };
}

export function parseRfc3339Instant(value) {
  return parseRfc3339Details(value)?.milliseconds;
}

export function compareRfc3339Instants(left, right) {
  const leftDetails = parseRfc3339Details(left);
  const rightDetails = parseRfc3339Details(right);
  if (!leftDetails || !rightDetails) return undefined;
  if (leftDetails.orderingSecond !== rightDetails.orderingSecond) {
    return leftDetails.orderingSecond < rightDetails.orderingSecond ? -1 : 1;
  }
  if (leftDetails.leapSecond !== rightDetails.leapSecond) return leftDetails.leapSecond ? -1 : 1;
  const length = Math.max(leftDetails.fraction.length, rightDetails.fraction.length);
  const leftFraction = leftDetails.fraction.padEnd(length, "0");
  const rightFraction = rightDetails.fraction.padEnd(length, "0");
  return leftFraction === rightFraction ? 0 : leftFraction < rightFraction ? -1 : 1;
}

export function hasAsciiControlCharacters(value) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 31 || code === 127) return true;
  }
  return false;
}

export function createFrozenClock(initialTime = DEFAULT_FROZEN_TIME) {
  const initial = parseRfc3339Instant(initialTime);
  if (initial === undefined) throw new Error(`Invalid frozen clock value: ${initialTime}`);
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
