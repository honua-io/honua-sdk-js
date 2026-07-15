import fs from "node:fs";
import { pathToFileURL } from "node:url";

import {
  snapshotDeniedNetworkAttempts,
  snapshotDeniedProcessControlAttempts,
} from "./migration-workbench-network-guard.mjs";

const TrustedArray = Array;
const TrustedError = Error;
const TrustedPromise = Promise;
const TrustedWeakSet = WeakSet;
const MAX_JSON_DEPTH = 64;
const MAX_JSON_NODES = 10_000;
const MAX_JSON_STRING_LENGTH = 100_000;
const MAX_JSON_COLLECTION_LENGTH = 10_000;
const trustedFreeze = Object.freeze.bind(Object);
const trustedIntrinsics = trustedFreeze({
  arrayIsArray: Array.isArray.bind(Array),
  arrayJoin: Function.prototype.call.bind(Array.prototype.join),
  createNullObject: Object.create.bind(Object, null),
  defineProperty: Object.defineProperty.bind(Object),
  freeze: trustedFreeze,
  getOwnPropertyDescriptor: Object.getOwnPropertyDescriptor.bind(Object),
  getPrototypeOf: Object.getPrototypeOf.bind(Object),
  jsonStringify: JSON.stringify.bind(JSON),
  numberIsFinite: Number.isFinite.bind(Number),
  objectPrototype: Object.prototype,
  ownKeys: Reflect.ownKeys.bind(Reflect),
  processExit: process.exit.bind(process),
  setPrototypeOf: Object.setPrototypeOf.bind(Object),
  setImmediate: globalThis.setImmediate.bind(globalThis),
  weakSetAdd: Function.prototype.call.bind(WeakSet.prototype.add),
  weakSetHas: Function.prototype.call.bind(WeakSet.prototype.has),
  writeSync: fs.writeSync.bind(fs),
});

function runnerError(message) {
  return new TrustedError(message);
}

function defineFrozenValue(target, key, value, enumerable = true) {
  trustedIntrinsics.defineProperty(target, key, {
    value,
    enumerable,
    configurable: false,
    writable: false,
  });
}

function sanitizeJsonValue(value, state = { seen: new TrustedWeakSet(), nodes: 0 }, depth = 0) {
  if (depth > MAX_JSON_DEPTH) {
    throw runnerError("The generated migration target exceeded the JSON depth bound.");
  }
  state.nodes += 1;
  if (state.nodes > MAX_JSON_NODES) {
    throw runnerError("The generated migration target exceeded the JSON node bound.");
  }
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    if (typeof value === "string" && value.length > MAX_JSON_STRING_LENGTH) {
      throw runnerError("The generated migration target exceeded the JSON string bound.");
    }
    return value;
  }
  if (typeof value === "number") {
    if (!trustedIntrinsics.numberIsFinite(value)) {
      throw runnerError("The generated migration target returned a non-finite number.");
    }
    return value;
  }
  if (typeof value !== "object") {
    throw runnerError(`The generated migration target returned a non-JSON value (${typeof value}).`);
  }
  if (trustedIntrinsics.weakSetHas(state.seen, value)) {
    throw runnerError("The generated migration target returned a cyclic value.");
  }
  trustedIntrinsics.weakSetAdd(state.seen, value);

  if (trustedIntrinsics.arrayIsArray(value)) {
    if (value.length > MAX_JSON_COLLECTION_LENGTH) {
      throw runnerError("The generated migration target exceeded the JSON array bound.");
    }
    const cleanArray = new TrustedArray(value.length);
    trustedIntrinsics.setPrototypeOf(cleanArray, null);
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = trustedIntrinsics.getOwnPropertyDescriptor(value, `${index}`);
      if (!descriptor || !("value" in descriptor)) {
        throw runnerError("The generated migration target returned a sparse or accessor-backed array.");
      }
      defineFrozenValue(cleanArray, index, sanitizeJsonValue(descriptor.value, state, depth + 1));
    }
    return trustedIntrinsics.freeze(cleanArray);
  }

  const prototype = trustedIntrinsics.getPrototypeOf(value);
  if (prototype !== trustedIntrinsics.objectPrototype && prototype !== null) {
    throw runnerError("The generated migration target returned an object with a custom prototype.");
  }
  const cleanObject = trustedIntrinsics.createNullObject();
  const ownKeys = trustedIntrinsics.ownKeys(value);
  if (ownKeys.length > MAX_JSON_COLLECTION_LENGTH) {
    throw runnerError("The generated migration target exceeded the JSON object-key bound.");
  }
  for (let keyIndex = 0; keyIndex < ownKeys.length; keyIndex += 1) {
    const key = ownKeys[keyIndex];
    const descriptor = trustedIntrinsics.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable) {
      continue;
    }
    if (typeof key !== "string" || !("value" in descriptor)) {
      throw runnerError("The generated migration target returned a symbol or accessor-backed property.");
    }
    if (key.length > MAX_JSON_STRING_LENGTH) {
      throw runnerError("The generated migration target exceeded the JSON key bound.");
    }
    defineFrozenValue(cleanObject, key, sanitizeJsonValue(descriptor.value, state, depth + 1));
  }
  return trustedIntrinsics.freeze(cleanObject);
}

const targetPath = process.argv[2];
if (!targetPath) {
  throw runnerError("The isolated migration target runner requires a target module path.");
}
const targetUrl = pathToFileURL(targetPath).href;

const runnerNonce = fs.readFileSync(0, "utf8").trim();
if (!/^[0-9a-f]{64}$/.test(runnerNonce)) {
  throw runnerError("The isolated migration target runner received an invalid protocol correlation nonce.");
}

const generatedModule = await import(targetUrl);
const safeValue = sanitizeJsonValue(generatedModule.default);
// Drain callbacks already queued by module evaluation before snapshotting the
// guarded-attempt evidence. The trusted exit below prevents later timers from
// running after the final evidence snapshot has been serialized.
await new TrustedPromise((resolve) => trustedIntrinsics.setImmediate(resolve));
await new TrustedPromise((resolve) => trustedIntrinsics.setImmediate(resolve));
const networkAttempts = snapshotDeniedNetworkAttempts();
const processControlAttempts = snapshotDeniedProcessControlAttempts();
if (networkAttempts.length > 0) {
  throw runnerError(
    `Generated migration target attempted ${networkAttempts.length} denied network operation(s): ${trustedIntrinsics.arrayJoin(
      networkAttempts,
      ", ",
    )}.`,
  );
}
if (processControlAttempts.length > 0) {
  throw runnerError(
    `Generated migration target attempted ${processControlAttempts.length} denied process control operation(s): ${trustedIntrinsics.arrayJoin(
      processControlAttempts,
      ", ",
    )}.`,
  );
}

const envelope = trustedIntrinsics.createNullObject();
defineFrozenValue(envelope, "protocol", "honua.migration-workbench.runner.v1");
defineFrozenValue(envelope, "nonce", runnerNonce);
defineFrozenValue(envelope, "value", safeValue);
defineFrozenValue(envelope, "networkAttempts", sanitizeJsonValue(networkAttempts));
defineFrozenValue(envelope, "processControlAttempts", sanitizeJsonValue(processControlAttempts));
const serializedEnvelope = trustedIntrinsics.jsonStringify(trustedIntrinsics.freeze(envelope));
trustedIntrinsics.writeSync(1, `${serializedEnvelope}\n`);
trustedIntrinsics.processExit(0);
