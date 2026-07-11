import type { HonuaPluginDiagnostic, HonuaPluginJsonValue } from "./types.js";

const MAX_DEPTH = 64;
const MAX_NODES = 20_000;
const MAX_STRING_LENGTH = 1_000_000;

export interface PlainJsonSnapshot {
  readonly ok: boolean;
  readonly value?: HonuaPluginJsonValue;
  readonly diagnostics: readonly HonuaPluginDiagnostic[];
}

/**
 * Parse untrusted JSON text into an inert snapshot. Requiring text is the only
 * portable JavaScript boundary that can reject Proxy/accessor-bearing objects
 * without first executing their reflection traps or getters. A bounded lexical
 * pass enforces node/depth limits before `JSON.parse` materializes the value.
 */
export function snapshotPlainJson(input: unknown, rootPath: string): PlainJsonSnapshot {
  if (typeof input !== "string") {
    return {
      ok: false,
      diagnostics: [
        diagnostic(
          "INPUT_JSON_TEXT_REQUIRED",
          rootPath,
          "Expected JSON text; object values, proxies, accessors, and other executable inputs are forbidden.",
        ),
      ],
    };
  }
  if (input.length > MAX_STRING_LENGTH) {
    return {
      ok: false,
      diagnostics: [
        diagnostic("INPUT_JSON_TEXT_TOO_LONG", rootPath, `JSON text must not exceed ${MAX_STRING_LENGTH} code units.`),
      ],
    };
  }
  const preflight = preflightJsonText(input, rootPath);
  if (preflight) return { ok: false, diagnostics: [preflight] };

  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch {
    return {
      ok: false,
      diagnostics: [diagnostic("INPUT_JSON_SYNTAX", rootPath, "Expected syntactically valid JSON text.")],
    };
  }

  const diagnostics: HonuaPluginDiagnostic[] = [];
  const state = { nodes: 0, ancestors: new WeakSet<object>() };
  const value = copyJson(parsed, rootPath, 0, state, diagnostics);
  if (value === undefined || diagnostics.length > 0) return { ok: false, diagnostics };
  return { ok: true, value: deepFreeze(value), diagnostics: [] };
}

function preflightJsonText(text: string, path: string): HonuaPluginDiagnostic | undefined {
  let index = 0;
  let nodes = 0;

  function skipWhitespace(): void {
    while (index < text.length) {
      const code = text.charCodeAt(index);
      if (code !== 9 && code !== 10 && code !== 13 && code !== 32) break;
      index += 1;
    }
  }

  function scanString(): boolean {
    if (text[index] !== '"') return false;
    index += 1;
    while (index < text.length) {
      const code = text.charCodeAt(index);
      if (code === 34) {
        index += 1;
        return true;
      }
      if (code < 32) return false;
      if (code === 92) {
        index += 1;
        if (index >= text.length) return false;
        if (text[index] === "u") index += 4;
      }
      index += 1;
    }
    return false;
  }

  function parseValue(depth: number): HonuaPluginDiagnostic | undefined {
    skipWhitespace();
    nodes += 1;
    if (nodes > MAX_NODES) return diagnostic("INPUT_TOO_LARGE", path, `JSON input exceeds ${MAX_NODES} values.`);
    if (depth > MAX_DEPTH) return diagnostic("INPUT_TOO_DEEP", path, `JSON input exceeds ${MAX_DEPTH} levels.`);
    const token = text[index];
    if (token === '"') return scanString() ? undefined : syntax();
    if (token === "{") {
      index += 1;
      skipWhitespace();
      if (text[index] === "}") {
        index += 1;
        return undefined;
      }
      while (index < text.length) {
        if (!scanString()) return syntax();
        skipWhitespace();
        if (text[index] !== ":") return syntax();
        index += 1;
        const failure = parseValue(depth + 1);
        if (failure) return failure;
        skipWhitespace();
        if (text[index] === "}") {
          index += 1;
          return undefined;
        }
        if (text[index] !== ",") return syntax();
        index += 1;
        skipWhitespace();
      }
      return syntax();
    }
    if (token === "[") {
      index += 1;
      skipWhitespace();
      if (text[index] === "]") {
        index += 1;
        return undefined;
      }
      while (index < text.length) {
        const failure = parseValue(depth + 1);
        if (failure) return failure;
        skipWhitespace();
        if (text[index] === "]") {
          index += 1;
          return undefined;
        }
        if (text[index] !== ",") return syntax();
        index += 1;
      }
      return syntax();
    }
    for (const literal of ["true", "false", "null"]) {
      if (text.startsWith(literal, index)) {
        index += literal.length;
        return undefined;
      }
    }
    const start = index;
    while (index < text.length) {
      const code = text.charCodeAt(index);
      if (code === 9 || code === 10 || code === 13 || code === 32 || code === 44 || code === 93 || code === 125) break;
      index += 1;
    }
    return index > start ? undefined : syntax();
  }

  function syntax(): HonuaPluginDiagnostic {
    return diagnostic("INPUT_JSON_SYNTAX", path, "Expected syntactically valid JSON text.");
  }

  const failure = parseValue(0);
  if (failure) return failure;
  skipWhitespace();
  return index === text.length ? undefined : syntax();
}

function copyJson(
  input: unknown,
  path: string,
  depth: number,
  state: { nodes: number; ancestors: WeakSet<object> },
  diagnostics: HonuaPluginDiagnostic[],
): HonuaPluginJsonValue | undefined {
  state.nodes += 1;
  if (state.nodes > MAX_NODES) {
    diagnostics.push(diagnostic("INPUT_TOO_LARGE", path, `JSON input exceeds ${MAX_NODES} values.`));
    return undefined;
  }
  if (depth > MAX_DEPTH) {
    diagnostics.push(diagnostic("INPUT_TOO_DEEP", path, `JSON input exceeds ${MAX_DEPTH} levels.`));
    return undefined;
  }
  if (typeof input === "string") {
    if (input.length > MAX_STRING_LENGTH) {
      diagnostics.push(
        diagnostic("INPUT_STRING_TOO_LONG", path, `JSON strings must not exceed ${MAX_STRING_LENGTH} code units.`),
      );
      return undefined;
    }
    return input;
  }
  if (input === null || typeof input === "boolean") return input;
  if (typeof input === "number") {
    if (!Number.isFinite(input)) {
      diagnostics.push(diagnostic("INPUT_NON_FINITE_NUMBER", path, "JSON numbers must be finite."));
      return undefined;
    }
    return Object.is(input, -0) ? 0 : input;
  }
  if (typeof input !== "object") {
    diagnostics.push(diagnostic("INPUT_NON_JSON_VALUE", path, "Expected a JSON value."));
    return undefined;
  }
  if (state.ancestors.has(input)) {
    diagnostics.push(diagnostic("INPUT_CYCLE", path, "JSON input must not contain cycles."));
    return undefined;
  }

  let prototype: object | null;
  let ownKeys: readonly PropertyKey[];
  try {
    prototype = Object.getPrototypeOf(input);
    ownKeys = Reflect.ownKeys(input);
  } catch {
    diagnostics.push(diagnostic("INPUT_NOT_INERT_JSON", path, "Could not inspect inert plain JSON."));
    return undefined;
  }

  const array = Array.isArray(input);
  if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) {
    diagnostics.push(diagnostic("INPUT_NON_PLAIN_OBJECT", path, "Expected a plain JSON object or array."));
    return undefined;
  }
  if (ownKeys.some((key) => typeof key === "symbol")) {
    diagnostics.push(diagnostic("INPUT_SYMBOL_KEY", path, "JSON input must not contain symbol keys."));
    return undefined;
  }

  // Every own value consumes at least one node. Reject breadth before asking
  // the object for any property descriptor; Object.getOwnPropertyDescriptors
  // would otherwise allocate and materialize every descriptor first.
  const directValueCount = ownKeys.length - (array && ownKeys.includes("length") ? 1 : 0);
  if (directValueCount > MAX_NODES - state.nodes) {
    diagnostics.push(diagnostic("INPUT_TOO_LARGE", path, `JSON input exceeds ${MAX_NODES} values.`));
    return undefined;
  }

  state.ancestors.add(input);
  const result = array
    ? copyArray(input, ownKeys as readonly string[], path, depth, state, diagnostics)
    : copyObject(input, ownKeys as readonly string[], path, depth, state, diagnostics);
  state.ancestors.delete(input);
  return result;
}

function copyArray(
  input: object,
  ownKeys: readonly string[],
  path: string,
  depth: number,
  state: { nodes: number; ancestors: WeakSet<object> },
  diagnostics: HonuaPluginDiagnostic[],
): readonly HonuaPluginJsonValue[] | undefined {
  const lengthDescriptor = descriptor(input, "length", path, diagnostics);
  if (!lengthDescriptor || !("value" in lengthDescriptor) || typeof lengthDescriptor.value !== "number") {
    diagnostics.push(diagnostic("INPUT_NOT_INERT_JSON", path, "Invalid JSON array length."));
    return undefined;
  }
  const length = lengthDescriptor.value;
  if (!Number.isSafeInteger(length) || length > MAX_NODES - state.nodes) {
    diagnostics.push(diagnostic("INPUT_TOO_LARGE", path, `JSON arrays must not exceed ${MAX_NODES} values.`));
    return undefined;
  }
  const keySet = new Set(ownKeys);
  if (!keySet.has("length") || ownKeys.length !== length + 1) {
    diagnostics.push(
      diagnostic("INPUT_SPARSE_OR_EXTENDED_ARRAY", path, "JSON arrays must be dense and have no named properties."),
    );
    return undefined;
  }
  const result: HonuaPluginJsonValue[] = [];
  for (let index = 0; index < length; index += 1) {
    const childPath = `${path}/${index}`;
    const entryDescriptor = descriptor(input, String(index), childPath, diagnostics);
    if (!isEnumerableDataDescriptor(entryDescriptor)) {
      diagnostics.push(
        diagnostic("INPUT_ACCESSOR_OR_HIDDEN_PROPERTY", childPath, "JSON values must be enumerable data properties."),
      );
      return undefined;
    }
    const copied = copyJson(entryDescriptor.value, childPath, depth + 1, state, diagnostics);
    if (copied === undefined) return undefined;
    result.push(copied);
  }
  return result;
}

function copyObject(
  input: object,
  ownKeys: readonly string[],
  path: string,
  depth: number,
  state: { nodes: number; ancestors: WeakSet<object> },
  diagnostics: HonuaPluginDiagnostic[],
): Readonly<Record<string, HonuaPluginJsonValue>> | undefined {
  const result: Record<string, HonuaPluginJsonValue> = {};
  for (const key of [...ownKeys].sort(asciiCompare)) {
    const childPath = `${path}/${escapePointer(key)}`;
    const entryDescriptor = descriptor(input, key, childPath, diagnostics);
    if (!isEnumerableDataDescriptor(entryDescriptor)) {
      diagnostics.push(
        diagnostic("INPUT_ACCESSOR_OR_HIDDEN_PROPERTY", childPath, "JSON values must be enumerable data properties."),
      );
      return undefined;
    }
    const copied = copyJson(entryDescriptor.value, childPath, depth + 1, state, diagnostics);
    if (copied === undefined) return undefined;
    Object.defineProperty(result, key, { value: copied, enumerable: true, writable: true, configurable: true });
  }
  return result;
}

function descriptor(
  input: object,
  key: PropertyKey,
  path: string,
  diagnostics: HonuaPluginDiagnostic[],
): PropertyDescriptor | undefined {
  try {
    return Object.getOwnPropertyDescriptor(input, key);
  } catch {
    diagnostics.push(diagnostic("INPUT_NOT_INERT_JSON", path, "Could not inspect inert plain JSON."));
    return undefined;
  }
}

function isEnumerableDataDescriptor(
  descriptor: PropertyDescriptor | undefined,
): descriptor is PropertyDescriptor & { value: unknown } {
  return descriptor !== undefined && descriptor.enumerable === true && "value" in descriptor;
}

function escapePointer(value: string): string {
  return value.split("~").join("~0").split("/").join("~1");
}

function asciiCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function diagnostic(code: string, path: string, message: string): HonuaPluginDiagnostic {
  return { code, severity: "error", path, message };
}

export function deepFreeze<T extends HonuaPluginJsonValue>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Array.isArray(value) ? value : Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
