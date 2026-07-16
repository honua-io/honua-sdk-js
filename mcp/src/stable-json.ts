import type { JsonValue } from "@honua/sdk-js/query-planner";

const MAX_NODES = 8_192;
const MAX_DEPTH = 32;
const MAX_BYTES = 1_048_576;
const MAX_OBJECT_PROPERTIES = 128;
const MAX_ARRAY_LENGTH = 1_024;
const MAX_STRING_CODE_UNITS = 65_536;
const SNAPSHOT_ERRORS = new WeakSet<object>();

interface SnapshotBudget {
  nodes: number;
  bytes: number;
}

/** Stable boundary error whose message never includes a reflected value or trap error. */
export class McpJsonSnapshotError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "McpJsonSnapshotError";
    SNAPSHOT_ERRORS.add(this);
  }
}

/**
 * Detach untrusted JSON without invoking property getters.
 *
 * The clone is deeply frozen and bounded before any asynchronous authorization
 * callback can observe it. Reflection failures (including Proxy traps) collapse
 * to one stable error instead of reflecting attacker-controlled messages.
 */
export function snapshotMcpJson(input: unknown, label: string): JsonValue {
  try {
    return snapshot(input, 0, new WeakSet<object>(), { nodes: 0, bytes: 0 });
  } catch (error) {
    if (error !== null && typeof error === "object" && SNAPSHOT_ERRORS.has(error)) throw error;
    throw new McpJsonSnapshotError(`${label} could not be safely snapshotted`);
  }
}

function snapshot(value: unknown, depth: number, ancestors: WeakSet<object>, budget: SnapshotBudget): JsonValue {
  budget.nodes += 1;
  if (budget.nodes > MAX_NODES) invalid("MCP JSON exceeds the node limit");
  if (depth > MAX_DEPTH) invalid("MCP JSON exceeds the depth limit");
  addBytes(budget, 8);

  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (value.length > MAX_STRING_CODE_UNITS) invalid("MCP JSON contains an oversized string");
    addBytes(budget, utf8Bytes(value));
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) invalid("MCP JSON contains a non-finite number");
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value !== "object") invalid("MCP JSON contains an unsupported value");
  if (ancestors.has(value)) invalid("MCP JSON must not contain cycles");
  ancestors.add(value);

  const result = Array.isArray(value)
    ? snapshotArray(value, depth, ancestors, budget)
    : snapshotObject(value, depth, ancestors, budget);
  ancestors.delete(value);
  return result;
}

function snapshotArray(
  input: object,
  depth: number,
  ancestors: WeakSet<object>,
  budget: SnapshotBudget,
): readonly JsonValue[] {
  if (Object.getPrototypeOf(input) !== Array.prototype) invalid("MCP JSON arrays must use the standard prototype");
  const lengthDescriptor = Reflect.getOwnPropertyDescriptor(input, "length");
  const length = lengthDescriptor && "value" in lengthDescriptor ? lengthDescriptor.value : undefined;
  if (!Number.isSafeInteger(length) || (length as number) < 0 || (length as number) > MAX_ARRAY_LENGTH) {
    invalid("MCP JSON contains an invalid or oversized array");
  }

  const keys = Reflect.ownKeys(input);
  if (keys.some((key) => typeof key !== "string")) invalid("MCP JSON must not contain symbol keys");
  if (keys.length !== (length as number) + 1 || !keys.includes("length")) {
    invalid("MCP JSON arrays must be dense and must not contain extra properties");
  }

  const output: JsonValue[] = [];
  for (let index = 0; index < (length as number); index += 1) {
    const descriptor = Reflect.getOwnPropertyDescriptor(input, String(index));
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
      invalid("MCP JSON arrays must contain enumerable data properties");
    }
    output.push(snapshot(descriptor.value, depth + 1, ancestors, budget));
  }
  return Object.freeze(output);
}

function snapshotObject(
  input: object,
  depth: number,
  ancestors: WeakSet<object>,
  budget: SnapshotBudget,
): { readonly [key: string]: JsonValue } {
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) invalid("MCP JSON values must be plain objects");
  const keys = Reflect.ownKeys(input);
  if (keys.length > MAX_OBJECT_PROPERTIES) invalid("MCP JSON object exceeds the property limit");
  if (keys.some((key) => typeof key !== "string")) invalid("MCP JSON must not contain symbol keys");

  const output: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>;
  for (const key of (keys as string[]).sort()) {
    if (key.length > MAX_STRING_CODE_UNITS) invalid("MCP JSON contains an oversized property name");
    addBytes(budget, utf8Bytes(key));
    const descriptor = Reflect.getOwnPropertyDescriptor(input, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
      invalid("MCP JSON objects must contain enumerable data properties");
    }
    Object.defineProperty(output, key, {
      value: snapshot(descriptor.value, depth + 1, ancestors, budget),
      enumerable: true,
      writable: false,
      configurable: false,
    });
  }
  return Object.freeze(output);
}

function addBytes(budget: SnapshotBudget, increment: number): void {
  const next = budget.bytes + increment;
  if (!Number.isSafeInteger(next) || next > MAX_BYTES) invalid("MCP JSON exceeds the byte limit");
  budget.bytes = next;
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function invalid(message: string): never {
  throw new McpJsonSnapshotError(message);
}
