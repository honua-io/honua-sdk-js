import fs from "node:fs";
import { pathToFileURL } from "node:url";

import { snapshotDeniedNetworkAttempts } from "./migration-workbench-network-guard.mjs";

const TrustedArray = Array;
const TrustedError = Error;
const TrustedWeakSet = WeakSet;
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
  setPrototypeOf: Object.setPrototypeOf.bind(Object),
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

function sanitizeJsonValue(value, seen = new TrustedWeakSet()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
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
  if (trustedIntrinsics.weakSetHas(seen, value)) {
    throw runnerError("The generated migration target returned a cyclic value.");
  }
  trustedIntrinsics.weakSetAdd(seen, value);

  if (trustedIntrinsics.arrayIsArray(value)) {
    const cleanArray = new TrustedArray(value.length);
    trustedIntrinsics.setPrototypeOf(cleanArray, null);
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = trustedIntrinsics.getOwnPropertyDescriptor(value, `${index}`);
      if (!descriptor || !("value" in descriptor)) {
        throw runnerError("The generated migration target returned a sparse or accessor-backed array.");
      }
      defineFrozenValue(cleanArray, index, sanitizeJsonValue(descriptor.value, seen));
    }
    return trustedIntrinsics.freeze(cleanArray);
  }

  const prototype = trustedIntrinsics.getPrototypeOf(value);
  if (prototype !== trustedIntrinsics.objectPrototype && prototype !== null) {
    throw runnerError("The generated migration target returned an object with a custom prototype.");
  }
  const cleanObject = trustedIntrinsics.createNullObject();
  const ownKeys = trustedIntrinsics.ownKeys(value);
  for (let keyIndex = 0; keyIndex < ownKeys.length; keyIndex += 1) {
    const key = ownKeys[keyIndex];
    const descriptor = trustedIntrinsics.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable) {
      continue;
    }
    if (typeof key !== "string" || !("value" in descriptor)) {
      throw runnerError("The generated migration target returned a symbol or accessor-backed property.");
    }
    defineFrozenValue(cleanObject, key, sanitizeJsonValue(descriptor.value, seen));
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
  throw runnerError("The isolated migration target runner received an invalid one-time protocol nonce.");
}

const generatedModule = await import(targetUrl);
const safeValue = sanitizeJsonValue(generatedModule.default);
const networkAttempts = snapshotDeniedNetworkAttempts();
if (networkAttempts.length > 0) {
  throw runnerError(
    `Generated migration target attempted ${networkAttempts.length} denied network operation(s): ${trustedIntrinsics.arrayJoin(
      networkAttempts,
      ", ",
    )}.`,
  );
}

const envelope = trustedIntrinsics.createNullObject();
defineFrozenValue(envelope, "protocol", "honua.migration-workbench.runner.v1");
defineFrozenValue(envelope, "nonce", runnerNonce);
defineFrozenValue(envelope, "value", safeValue);
defineFrozenValue(envelope, "networkAttempts", sanitizeJsonValue(networkAttempts));
const serializedEnvelope = trustedIntrinsics.jsonStringify(trustedIntrinsics.freeze(envelope));
trustedIntrinsics.writeSync(1, `${serializedEnvelope}\n`);
