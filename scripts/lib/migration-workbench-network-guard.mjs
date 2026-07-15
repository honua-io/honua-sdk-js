import dgram from "node:dgram";
import dns from "node:dns";
import dnsPromises from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import net from "node:net";
import tls from "node:tls";

const TrustedArray = Array;
const TrustedError = Error;
const trustedDefineProperty = Object.defineProperty.bind(Object);
const trustedFreeze = Object.freeze.bind(Object);
const trustedGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor.bind(Object);
const trustedGetPrototypeOf = Object.getPrototypeOf.bind(Object);
const trustedOwnKeys = Reflect.ownKeys.bind(Reflect);
const trustedString = String;
const objectPrototype = Object.prototype;
const networkAttempts = new TrustedArray();
const patchedNetworkPrototypes = new WeakSet();

function appendNetworkAttempt(api) {
  trustedDefineProperty(networkAttempts, networkAttempts.length, {
    value: api,
    enumerable: true,
    configurable: false,
    writable: false,
  });
}

function deniedNetworkError(api) {
  appendNetworkAttempt(api);
  const error = new TrustedError(`Generated migration target attempted a denied network operation (${api}).`);
  trustedDefineProperty(error, "code", {
    value: "HONUA_NETWORK_DENIED",
    enumerable: true,
    configurable: false,
    writable: false,
  });
  return error;
}

function denyNetwork(api) {
  return function deniedNetworkOperation() {
    throw deniedNetworkError(api);
  };
}

function replaceMethod(target, name, api) {
  if (!target) {
    return;
  }
  const descriptor = trustedGetOwnPropertyDescriptor(target, name);
  if (!descriptor || typeof descriptor.value !== "function") {
    return;
  }
  trustedDefineProperty(target, name, {
    ...descriptor,
    value: denyNetwork(api),
    configurable: false,
    writable: false,
  });
}

function replaceAllPrototypeMethods(constructor, namespace, includeInherited = true) {
  if (typeof constructor !== "function" || !constructor.prototype) {
    return;
  }
  let prototype = constructor.prototype;
  while (prototype && prototype !== objectPrototype) {
    if (patchedNetworkPrototypes.has(prototype)) {
      prototype = trustedGetPrototypeOf(prototype);
      continue;
    }
    patchedNetworkPrototypes.add(prototype);
    for (const name of trustedOwnKeys(prototype)) {
      if (name === "constructor") {
        continue;
      }
      const descriptor = trustedGetOwnPropertyDescriptor(prototype, name);
      if (!descriptor) {
        continue;
      }
      if (typeof descriptor.value === "function") {
        const methodName = typeof name === "symbol" ? trustedString(name) : name;
        trustedDefineProperty(prototype, name, {
          value: denyNetwork(`${namespace}.${methodName}`),
          enumerable: descriptor.enumerable,
          configurable: false,
          writable: false,
        });
      }
    }
    if (!includeInherited) {
      break;
    }
    prototype = trustedGetPrototypeOf(prototype);
  }
}

for (const [target, methods, namespace] of [
  [http, ["get", "request"], "http"],
  [https, ["get", "request"], "https"],
  [net, ["connect", "createConnection"], "net"],
  [tls, ["connect"], "tls"],
  [dgram, ["createSocket"], "dgram"],
  [dns, ["lookup", "lookupService", "resolve", "resolve4", "resolve6", "resolveAny", "reverse"], "dns"],
  [dnsPromises, ["lookup", "lookupService", "resolve", "resolve4", "resolve6", "resolveAny", "reverse"], "dns/promises"],
]) {
  for (const method of methods) {
    replaceMethod(target, method, `${namespace}.${method}`);
  }
}

replaceAllPrototypeMethods(dns.Resolver, "dns.Resolver");
replaceAllPrototypeMethods(dnsPromises.Resolver, "dns.promises.Resolver");
replaceAllPrototypeMethods(dgram.Socket, "dgram.Socket", false);
replaceMethod(net.Socket?.prototype, "connect", "net.Socket.connect");
replaceMethod(tls.TLSSocket?.prototype, "connect", "tls.TLSSocket.connect");

if (typeof globalThis.fetch === "function") {
  trustedDefineProperty(globalThis, "fetch", {
    value: denyNetwork("globalThis.fetch"),
    enumerable: true,
    configurable: false,
    writable: false,
  });
}
if (typeof globalThis.WebSocket === "function") {
  trustedDefineProperty(globalThis, "WebSocket", {
    value: class DeniedWebSocket {
      constructor() {
        throw deniedNetworkError("globalThis.WebSocket");
      }
    },
    enumerable: true,
    configurable: false,
    writable: false,
  });
}
if (typeof globalThis.EventSource === "function") {
  trustedDefineProperty(globalThis, "EventSource", {
    value: class DeniedEventSource {
      constructor() {
        throw deniedNetworkError("globalThis.EventSource");
      }
    },
    enumerable: true,
    configurable: false,
    writable: false,
  });
}

// Keep named ESM imports aligned with the patched CommonJS builtin exports.
syncBuiltinESMExports();

export function snapshotDeniedNetworkAttempts() {
  const copy = new TrustedArray(networkAttempts.length);
  for (let index = 0; index < networkAttempts.length; index += 1) {
    trustedDefineProperty(copy, index, {
      value: networkAttempts[index],
      enumerable: true,
      configurable: false,
      writable: false,
    });
  }
  return trustedFreeze(copy);
}
