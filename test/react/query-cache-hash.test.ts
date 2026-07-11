import { describe, expect, it } from "vitest";

import { stableQueryHash } from "../../src/react/query-cache.js";

class ImmutableReadonlySet<T> implements ReadonlySet<T> {
  readonly #values: Set<T>;

  public constructor(values: readonly T[]) {
    this.#values = new Set(values);
  }

  public get size(): number {
    return this.#values.size;
  }

  public has(value: T): boolean {
    return this.#values.has(value);
  }

  public entries(): SetIterator<[T, T]> {
    return this.#values.entries();
  }

  public keys(): SetIterator<T> {
    return this.#values.keys();
  }

  public values(): SetIterator<T> {
    return this.#values.values();
  }

  public forEach(callbackfn: (value: T, value2: T, set: ReadonlySet<T>) => void, thisArg?: unknown): void {
    for (const value of this.#values) callbackfn.call(thisArg, value, value, this);
  }

  public [Symbol.iterator](): SetIterator<T> {
    return this.values();
  }

  public readonly [Symbol.toStringTag] = "Set";
}

describe("stableQueryHash set semantics", () => {
  it("hashes branded ReadonlySet implementations deterministically by values", () => {
    const query = new ImmutableReadonlySet(["query"]);
    const aggregateAndQuery = new ImmutableReadonlySet(["queryAggregate", "query"]);
    const reversed = new ImmutableReadonlySet(["query", "queryAggregate"]);

    expect(stableQueryHash(query)).not.toBe(stableQueryHash(aggregateAndQuery));
    expect(stableQueryHash(aggregateAndQuery)).toBe(stableQueryHash(reversed));
    expect(stableQueryHash(aggregateAndQuery)).toBe(stableQueryHash(new Set(["query", "queryAggregate"])));
  });

  it("does not consume maps or arbitrary iterables as sets", () => {
    let iterations = 0;
    const iterable = Object.defineProperty({}, Symbol.iterator, {
      enumerable: false,
      value: function* () {
        iterations += 1;
        yield "query";
      },
    });

    expect(stableQueryHash(new Map([["query", true]]))).toBe("{}");
    expect(stableQueryHash(iterable)).toBe("{}");
    expect(iterations).toBe(0);
  });
});
