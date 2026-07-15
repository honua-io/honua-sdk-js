import dgram from "node:dgram";
import dns from "node:dns";
import dnsPromises from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import { createRequire, syncBuiltinESMExports } from "node:module";
import net from "node:net";
import os from "node:os";
import tls from "node:tls";

const require = createRequire(import.meta.url);
const httpClient = require("node:_http_client");
const tlsWrap = require("node:_tls_wrap");

const TrustedArray = Array;
const TrustedError = Error;
const trustedDefineProperty = Object.defineProperty.bind(Object);
const trustedFreeze = Object.freeze.bind(Object);
const trustedGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor.bind(Object);
const trustedGetPrototypeOf = Object.getPrototypeOf.bind(Object);
const trustedOwnKeys = Reflect.ownKeys.bind(Reflect);
const trustedString = String;
const objectPrototype = Object.prototype;
const MAX_RECORDED_ATTEMPTS = 128;
const networkAttempts = new TrustedArray();
const processControlAttempts = new TrustedArray();
const patchedNetworkPrototypes = new WeakSet();
const dgramSocketConstructor = dgram.Socket;
const dnsResolverConstructor = dns.Resolver;
const dnsPromisesResolverConstructor = dnsPromises.Resolver;
const httpAgentConstructor = http.Agent;
const httpsAgentConstructor = https.Agent;
const tlsSocketConstructor = tls.TLSSocket;

function appendNetworkAttempt(api) {
  if (networkAttempts.length >= MAX_RECORDED_ATTEMPTS) {
    throw new TrustedError("Generated migration target exceeded the denied network-attempt bound.");
  }
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

function deniedProcessControlError(api) {
  if (processControlAttempts.length >= MAX_RECORDED_ATTEMPTS) {
    throw new TrustedError("Generated migration target exceeded the denied process-control-attempt bound.");
  }
  trustedDefineProperty(processControlAttempts, processControlAttempts.length, {
    value: api,
    enumerable: true,
    configurable: false,
    writable: false,
  });
  const error = new TrustedError(`Generated migration target attempted a denied process control operation (${api}).`);
  trustedDefineProperty(error, "code", {
    value: "HONUA_PROCESS_CONTROL_DENIED",
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

function denyProcessControl(api) {
  return function deniedProcessControlOperation() {
    throw deniedProcessControlError(api);
  };
}

function replaceProcessControlMethod(target, name, api) {
  const descriptor = trustedGetOwnPropertyDescriptor(target, name);
  if (descriptor && typeof descriptor.value === "function") {
    trustedDefineProperty(target, name, {
      ...descriptor,
      value: denyProcessControl(api),
      configurable: false,
      writable: false,
    });
  }
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

function ownCallableNames(target, exclusions = new Set()) {
  return trustedOwnKeys(target).filter((name) => {
    if (exclusions.has(name)) return false;
    const descriptor = trustedGetOwnPropertyDescriptor(target, name);
    return Boolean(descriptor && typeof descriptor.value === "function");
  });
}

for (const [target, methods, namespace] of [
  [http, ["get", "request"], "http"],
  [https, ["get", "request"], "https"],
  [net, ["connect", "createConnection", "_createServerHandle"], "net"],
  [tls, ["connect", "createSecurePair"], "tls"],
  [tlsWrap, ["connect", "TLSSocket"], "_tls_wrap"],
  [httpClient, ["ClientRequest"], "_http_client"],
  [dgram, ["createSocket", "_createSocketHandle"], "dgram"],
  [dns, ownCallableNames(dns, new Set(["Resolver"])), "dns"],
  [dnsPromises, ownCallableNames(dnsPromises, new Set(["Resolver"])), "dns/promises"],
]) {
  for (const method of methods) {
    replaceMethod(target, method, `${namespace}.${trustedString(method)}`);
  }
}

replaceAllPrototypeMethods(dnsResolverConstructor, "dns.Resolver");
replaceAllPrototypeMethods(dnsPromisesResolverConstructor, "dns.promises.Resolver");
replaceAllPrototypeMethods(dgramSocketConstructor, "dgram.Socket", false);
replaceAllPrototypeMethods(net.Server, "net.Server", false);
replaceAllPrototypeMethods(httpAgentConstructor, "http.Agent", false);
replaceAllPrototypeMethods(httpsAgentConstructor, "https.Agent", false);
replaceMethod(net.Socket?.prototype, "connect", "net.Socket.connect");
replaceMethod(tlsSocketConstructor?.prototype, "connect", "tls.TLSSocket.connect");
replaceMethod(dgram, "Socket", "dgram.Socket");
replaceMethod(dns, "Resolver", "dns.Resolver");
replaceMethod(dnsPromises, "Resolver", "dns.promises.Resolver");
replaceMethod(http, "ClientRequest", "http.ClientRequest");
replaceMethod(http, "WebSocket", "http.WebSocket");
replaceMethod(tls, "TLSSocket", "tls.TLSSocket");

for (const name of ["kill", "_kill", "_debugProcess", "_debugEnd", "binding", "_linkedBinding", "dlopen"]) {
  replaceProcessControlMethod(process, name, `process.${name}`);
}
replaceProcessControlMethod(os, "setPriority", "os.setPriority");

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

export function snapshotDeniedProcessControlAttempts() {
  const copy = new TrustedArray(processControlAttempts.length);
  for (let index = 0; index < processControlAttempts.length; index += 1) {
    trustedDefineProperty(copy, index, {
      value: processControlAttempts[index],
      enumerable: true,
      configurable: false,
      writable: false,
    });
  }
  return trustedFreeze(copy);
}
