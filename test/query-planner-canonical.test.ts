import { describe, expect, it } from "vitest";

import { canonicalStringify, toJsonValue } from "../src/query-planner/canonical.js";

describe("canonical JSON data-property construction", () => {
  it("preserves exact nested and integer-like key serialization", () => {
    const input = JSON.parse('{"z":[{"b":2,"a":1}],"10":"ten","2":"two","01":"leading","a":-0}');
    expect(canonicalStringify(toJsonValue(input))).toBe(
      '{"2":"two","10":"ten","01":"leading","a":0,"z":[{"a":1,"b":2}]}',
    );
  });

  it("keeps special keys as writable own data properties without prototype pollution", () => {
    const input = JSON.parse('{"__proto__":{"polluted":true},"constructor":"safe","prototype":1,"toString":2}');
    const converted = toJsonValue(input) as Record<string, unknown>;
    expect(Object.getPrototypeOf(converted)).toBe(Object.prototype);
    expect(Object.getOwnPropertyDescriptor(converted, "__proto__")).toEqual({
      value: { polluted: true },
      enumerable: true,
      writable: true,
      configurable: true,
    });
    expect(canonicalStringify(toJsonValue(input))).toBe(
      '{"__proto__":{"polluted":true},"constructor":"safe","prototype":1,"toString":2}',
    );
    expect(Object.hasOwn(Object.prototype, "polluted")).toBe(false);
  });

  it("does not invoke inherited setters while constructing either detached tree", () => {
    const key = "canonicalJsonInheritedSetterProbe";
    const previous = Object.getOwnPropertyDescriptor(Object.prototype, key);
    let writes = 0;
    Object.defineProperty(Object.prototype, key, {
      configurable: true,
      set: () => writes++,
    });
    try {
      const input = JSON.parse(`{"${key}":"owned"}`);
      expect(canonicalStringify(toJsonValue(input))).toBe(`{"${key}":"owned"}`);
      expect(writes).toBe(0);
    } finally {
      if (previous) Object.defineProperty(Object.prototype, key, previous);
      else Reflect.deleteProperty(Object.prototype, key);
    }
  });

  it("detaches null-prototype inputs and shared acyclic references", () => {
    const shared = { value: 1 };
    const input = Object.assign(Object.create(null), { b: shared, a: shared });
    const converted = toJsonValue(input) as Record<string, unknown>;
    shared.value = 9;
    expect(Object.getPrototypeOf(converted)).toBe(Object.prototype);
    expect(converted.a).not.toBe(converted.b);
    expect(canonicalStringify(toJsonValue(converted))).toBe('{"a":{"value":1},"b":{"value":1}}');
  });

  it("reads each accessor only once while detaching and serializes only its snapshot", () => {
    let reads = 0;
    const input = {
      get nested() {
        reads++;
        return { value: reads };
      },
    };
    const converted = toJsonValue(input);
    expect(canonicalStringify(converted)).toBe('{"nested":{"value":1}}');
    expect(reads).toBe(1);
    expect(canonicalStringify(converted)).toBe('{"nested":{"value":1}}');
    expect(reads).toBe(1);
  });

  it("omits undefined object members but rejects undefined array values", () => {
    expect(canonicalStringify(toJsonValue({ kept: null, omitted: undefined }))).toBe('{"kept":null}');
    expect(() => toJsonValue({ values: [undefined] })).toThrow("$.values[0] must not be undefined");
  });

  it("retains cycle, nonfinite and non-JSON value rejection", () => {
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    expect(() => toJsonValue(cycle)).toThrow("$.self must not contain cycles");
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(() => toJsonValue({ value })).toThrow("$.value must contain only finite numbers");
    }
    for (const value of [new Date(), new Map()]) {
      expect(() => toJsonValue({ value })).toThrow("$.value must contain only plain JSON objects");
    }
    for (const value of [1n, Symbol("value"), () => 1]) {
      expect(() => toJsonValue({ value })).toThrow(/\$\.value contains unsupported/);
    }
  });
});
