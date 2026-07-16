const MAX_STABLE_ARRAY_LENGTH = 10_000;

class StableDataError extends TypeError {}

/** @internal Snapshot a plain data object without invoking any property accessors. */
export function snapshotOwnDataObject(value: unknown, label: string): Readonly<Record<string, unknown>> {
  try {
    if (typeof value !== "object" || value === null) {
      throw new StableDataError(`${label} must be a plain data object.`);
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new StableDataError(`${label} must be a plain data object.`);
    }

    const snapshot: Record<string, unknown> = {};
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key === "symbol") {
        throw new StableDataError(`${label} cannot contain symbol keys.`);
      }
      const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
        throw new StableDataError(`${label} must contain only stable enumerable data fields.`);
      }
      Object.defineProperty(snapshot, key, {
        configurable: false,
        enumerable: true,
        writable: false,
        value: descriptor.value,
      });
    }
    return Object.freeze(snapshot);
  } catch (error) {
    if (error instanceof StableDataError) throw error;
    // Proxy traps and other unstable reflection failures are intentionally not
    // forwarded because their messages can contain caller credentials.
    throw new TypeError(`${label} must be a stable plain data object.`);
  }
}

/** @internal Snapshot a dense array without invoking indexed accessors or its iterator. */
export function snapshotOwnDataArray(value: unknown, label: string): readonly unknown[] {
  try {
    if (!Array.isArray(value)) throw new StableDataError(`${label} must be an array.`);
    const lengthDescriptor = Reflect.getOwnPropertyDescriptor(value, "length");
    const length = lengthDescriptor && "value" in lengthDescriptor ? lengthDescriptor.value : undefined;
    if (typeof length !== "number" || !Number.isSafeInteger(length) || length < 0 || length > MAX_STABLE_ARRAY_LENGTH) {
      throw new StableDataError(`${label} exceeds the supported array length.`);
    }

    const snapshot = new Array<unknown>(length);
    let entries = 0;
    for (const key of Reflect.ownKeys(value)) {
      if (key === "length") continue;
      if (typeof key === "symbol" || !isArrayIndex(key, length)) {
        throw new StableDataError(`${label} must contain only dense array entries.`);
      }
      const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
        throw new StableDataError(`${label} must contain only stable enumerable data entries.`);
      }
      snapshot[Number(key)] = descriptor.value;
      entries += 1;
    }
    if (entries !== length) throw new StableDataError(`${label} must be dense.`);
    return Object.freeze(snapshot);
  } catch (error) {
    if (error instanceof StableDataError) throw error;
    throw new TypeError(`${label} must be a stable dense array.`);
  }
}

function isArrayIndex(key: string, length: number): boolean {
  if (!/^(?:0|[1-9]\d*)$/.test(key)) return false;
  const index = Number(key);
  return Number.isSafeInteger(index) && index >= 0 && index < length && String(index) === key;
}
