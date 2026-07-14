import type { IsoInstant } from "./source-capability-types.js";

export interface CapabilityJsonLimits {
  readonly depth: number;
  readonly nodes: number;
  readonly bytes: number;
}

interface InputBudget {
  nodes: number;
  bytes: number;
}

const ISO_INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;

/** Clone untrusted I-JSON without consulting prototypes or invoking accessors. */
export function snapshotCapabilityJson(value: unknown, path: string, limits: CapabilityJsonLimits): unknown {
  return snapshotValue(value, path, limits, { nodes: 0, bytes: 0 }, new WeakSet<object>(), 0);
}

export function parseCapabilityJson(value: string | unknown, label: string, limits: CapabilityJsonLimits): unknown {
  if (typeof value !== "string") return snapshotCapabilityJson(value, label, limits);
  if (value.length > limits.bytes || utf8ByteLength(value) > limits.bytes) {
    throw new TypeError(`${label} exceeds the ${limits.bytes} byte limit`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch (cause) {
    throw new TypeError(`${label} must be valid JSON`, { cause });
  }
  assertUniqueJsonObjectNames(value, label, limits.depth);
  return snapshotCapabilityJson(parsed, label, limits);
}

function snapshotValue(
  value: unknown,
  path: string,
  limits: CapabilityJsonLimits,
  budget: InputBudget,
  ancestors: WeakSet<object>,
  depth: number,
): unknown {
  consumeBudget(value, path, limits, budget, depth);
  if (value === undefined) throw new TypeError(`${path} must not be undefined; omit optional object members`);
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") {
    assertUnicodeScalarString(value, path);
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError(`${path} must be a finite I-JSON number`);
    return value;
  }
  if (typeof value !== "object") throw new TypeError(`${path} contains unsupported ${typeof value}`);
  if (ancestors.has(value)) throw new TypeError(`${path} must not contain cycles`);
  ancestors.add(value);
  try {
    if (Array.isArray(value)) return snapshotArray(value, path, limits, budget, ancestors, depth);
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError(`${path} must contain only plain I-JSON objects and arrays`);
    }
    const snapshot: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string") throw new TypeError(`${path} must not contain symbol keys`);
      assertUnicodeScalarString(key, `${path} object key`);
      consumeText(key, `${path}.${key}`, limits, budget);
      const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
      assertEnumerableDataProperty(descriptor, `${path}.${key}`);
      Object.defineProperty(snapshot, key, {
        value: snapshotValue(descriptor.value, `${path}.${key}`, limits, budget, ancestors, depth + 1),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return snapshot;
  } finally {
    ancestors.delete(value);
  }
}

function snapshotArray(
  value: readonly unknown[],
  path: string,
  limits: CapabilityJsonLimits,
  budget: InputBudget,
  ancestors: WeakSet<object>,
  depth: number,
): readonly unknown[] {
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  if (!lengthDescriptor || !("value" in lengthDescriptor) || typeof lengthDescriptor.value !== "number") {
    throw new TypeError(`${path}.length must be an own data property`);
  }
  const length = lengthDescriptor.value;
  if (length > limits.nodes - budget.nodes) throw new TypeError(`${path} exceeds the ${limits.nodes} node limit`);
  for (const key of Reflect.ownKeys(value)) {
    if (key === "length") continue;
    if (typeof key !== "string" || !isArrayIndex(key, length)) {
      throw new TypeError(`${path} contains unsupported array property ${String(key)}`);
    }
  }
  const snapshot: unknown[] = [];
  for (let index = 0; index < length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined) throw new TypeError(`${path}[${index}] must be an own data property`);
    assertEnumerableDataProperty(descriptor, `${path}[${index}]`);
    snapshot.push(snapshotValue(descriptor.value, `${path}[${index}]`, limits, budget, ancestors, depth + 1));
  }
  return snapshot;
}

function consumeBudget(
  value: unknown,
  path: string,
  limits: CapabilityJsonLimits,
  budget: InputBudget,
  depth: number,
): void {
  if (depth > limits.depth) throw new TypeError(`${path} exceeds the maximum graph depth ${limits.depth}`);
  budget.nodes += 1;
  if (budget.nodes > limits.nodes) throw new TypeError(`${path} exceeds the ${limits.nodes} node limit`);
  budget.bytes += scalarByteLength(value, limits.bytes) + 1;
  if (budget.bytes > limits.bytes) throw new TypeError(`${path} exceeds the ${limits.bytes} byte limit`);
}

function consumeText(value: string, path: string, limits: CapabilityJsonLimits, budget: InputBudget): void {
  const remaining = limits.bytes - budget.bytes;
  if (value.length > remaining) throw new TypeError(`${path} exceeds the ${limits.bytes} byte limit`);
  budget.bytes += scalarByteLength(value, limits.bytes) + 1;
  if (budget.bytes > limits.bytes) throw new TypeError(`${path} exceeds the ${limits.bytes} byte limit`);
}

function scalarByteLength(value: unknown, maximum: number): number {
  if (typeof value === "string") {
    if (value.length > maximum) return maximum + 1;
    return utf8ByteLength(JSON.stringify(value));
  }
  if (typeof value === "number") return JSON.stringify(value).length;
  if (typeof value === "boolean") return value ? 4 : 5;
  if (value === null) return 4;
  if (value === undefined) return 9;
  return 2;
}

function assertEnumerableDataProperty(
  descriptor: PropertyDescriptor,
  path: string,
): asserts descriptor is PropertyDescriptor & { readonly value: unknown } {
  if (!("value" in descriptor)) throw new TypeError(`${path} must be a data property; accessors are not supported`);
  if (!descriptor.enumerable) throw new TypeError(`${path} must be enumerable`);
}

function isArrayIndex(key: string, length: number): boolean {
  if (!/^(?:0|[1-9]\d*)$/.test(key)) return false;
  const index = Number(key);
  return Number.isSafeInteger(index) && index >= 0 && index < length && String(index) === key;
}

export function assertPlainCapabilityObject(value: unknown, path: string, allowedKeys?: readonly string[]): void {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${path} must be an object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new TypeError(`${path} must be a plain object`);
  if (allowedKeys !== undefined) assertExactCapabilityKeys(value, path, allowedKeys);
}

export function assertExactCapabilityKeys(value: object, path: string, allowedKeys: readonly string[]): void {
  for (const key of Object.keys(value)) {
    if (!allowedKeys.includes(key)) throw new TypeError(`${path} contains unknown key ${key}`);
  }
}

export function assertUnicodeScalarString(value: string, path: string): void {
  for (let index = 0; index < value.length; index++) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new TypeError(`${path} contains an unpaired high Unicode surrogate`);
      }
      index++;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      throw new TypeError(`${path} contains an unpaired low Unicode surrogate`);
    }
  }
}

export function isCapabilityIsoInstant(value: string): boolean {
  if (!ISO_INSTANT_PATTERN.test(value)) return false;
  const timestamp = Date.parse(value);
  return !Number.isNaN(timestamp) && new Date(timestamp).toISOString().slice(0, 19) === value.slice(0, 19);
}

export function capabilityInstantNanoseconds(value: IsoInstant): bigint {
  const fraction = ISO_INSTANT_PATTERN.exec(value)?.[0].split(".")[1]?.slice(0, -1) ?? "";
  const second = Date.parse(`${value.slice(0, 19)}Z`);
  return BigInt(second) * 1_000_000n + BigInt(fraction.padEnd(9, "0") || "0");
}

export function compareCapabilityStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function deepFreezeCapability<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreezeCapability(child);
  }
  return value;
}

export function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

/** Reject duplicate object names before JSON.parse's last-name-wins result is trusted. */
function assertUniqueJsonObjectNames(source: string, label: string, maximumDepth: number): void {
  let index = 0;
  const whitespace = (): void => {
    while (index < source.length && /\s/.test(source[index]!)) index++;
  };
  const stringToken = (): string => {
    const start = index++;
    while (index < source.length) {
      const character = source[index++]!;
      if (character === "\\") index++;
      else if (character === '"') break;
    }
    return JSON.parse(source.slice(start, index)) as string;
  };
  const visit = (depth: number): void => {
    if (depth > maximumDepth) throw new TypeError(`${label} exceeds maximum JSON nesting depth ${maximumDepth}`);
    whitespace();
    const character = source[index];
    if (character === '"') {
      stringToken();
      return;
    }
    if (character === "{") {
      index++;
      whitespace();
      const names = new Set<string>();
      if (source[index] === "}") {
        index++;
        return;
      }
      while (index < source.length) {
        const name = stringToken();
        if (names.has(name)) throw new TypeError(`${label} JSON contains duplicate object name ${name}`);
        names.add(name);
        whitespace();
        index++;
        visit(depth + 1);
        whitespace();
        if (source[index] === "}") {
          index++;
          return;
        }
        index++;
        whitespace();
      }
      return;
    }
    if (character === "[") {
      index++;
      whitespace();
      if (source[index] === "]") {
        index++;
        return;
      }
      while (index < source.length) {
        visit(depth + 1);
        whitespace();
        if (source[index] === "]") {
          index++;
          return;
        }
        index++;
      }
      return;
    }
    while (index < source.length && !/[\s,}\]]/.test(source[index]!)) index++;
  };
  visit(0);
}
