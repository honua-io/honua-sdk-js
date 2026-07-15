import dgram from "node:dgram";
import dns from "node:dns";
import dnsPromises from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import net from "node:net";
import tls from "node:tls";

const networkAttempts = [];

function denyNetwork(api) {
  return function deniedNetworkOperation() {
    networkAttempts.push(api);
    const error = new Error(`Generated migration target attempted a denied network operation (${api}).`);
    error.code = "HONUA_NETWORK_DENIED";
    throw error;
  };
}

function replaceMethod(target, name, api) {
  if (target && typeof target[name] === "function") {
    target[name] = denyNetwork(api);
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

replaceMethod(net.Socket?.prototype, "connect", "net.Socket.connect");
replaceMethod(tls.TLSSocket?.prototype, "connect", "tls.TLSSocket.connect");
replaceMethod(dns.Resolver?.prototype, "resolve", "dns.Resolver.resolve");
replaceMethod(dns.Resolver?.prototype, "resolve4", "dns.Resolver.resolve4");
replaceMethod(dns.Resolver?.prototype, "resolve6", "dns.Resolver.resolve6");

if (typeof globalThis.fetch === "function") {
  globalThis.fetch = denyNetwork("globalThis.fetch");
}
if (typeof globalThis.WebSocket === "function") {
  globalThis.WebSocket = class DeniedWebSocket {
    constructor() {
      return denyNetwork("globalThis.WebSocket")();
    }
  };
}
if (typeof globalThis.EventSource === "function") {
  globalThis.EventSource = class DeniedEventSource {
    constructor() {
      return denyNetwork("globalThis.EventSource")();
    }
  };
}

// Keep named ESM imports aligned with the patched CommonJS builtin exports.
syncBuiltinESMExports();

export function snapshotDeniedNetworkAttempts() {
  return Object.freeze([...networkAttempts]);
}
