import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it, vi } from "vitest";
import { DeferredInitializationTransport, readWorkflowView } from "../src/proxy-initialization.js";

function initialize(value?: unknown): JSONRPCMessage {
  return {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "1" },
      _meta: { "honua.io/workflow-view": value },
    },
  };
}

function harness() {
  const raw: Transport = { start: vi.fn(async () => {}), send: vi.fn(async () => {}), close: vi.fn(async () => {}) };
  const transport = new DeferredInitializationTransport(raw);
  return { raw, transport, emit: (message: JSONRPCMessage) => raw.onmessage?.(message) };
}

describe("proxy initialize boundary", () => {
  it.each([undefined, null, "", "  "])("preserves the server's optional selector semantics: %j", (value) => {
    expect(readWorkflowView(initialize(value))).toBeUndefined();
  });

  it.each([42, {}, [], "x".repeat(65)])("rejects malformed selectors: %j", (value) => {
    expect(() => readWorkflowView(initialize(value))).toThrow();
  });

  it("retains a valid selector exactly, without trimming a nonempty server name", () => {
    expect(readWorkflowView(initialize(" setup "))).toBe(" setup ");
  });

  it("starts the real transport once and replays initialize before queued messages", async () => {
    const h = harness();
    const selected = h.transport.waitForInitialize();
    const first = initialize("setup");
    const notification: JSONRPCMessage = { jsonrpc: "2.0", method: "notifications/initialized" };
    h.emit(first);
    h.emit(notification);
    expect(await selected).toBe("setup");
    const messages: JSONRPCMessage[] = [];
    h.transport.onmessage = (message) => messages.push(message);
    await h.transport.start();
    expect(messages).toEqual([first, notification]);
    h.emit({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    expect(messages).toHaveLength(3);
    expect(h.raw.start).toHaveBeenCalledTimes(1);
    await h.transport.close();
  });

  it("rejects requests before initialize without connecting upstream", async () => {
    const h = harness();
    const selected = h.transport.waitForInitialize();
    h.emit({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    await expect(selected).rejects.toThrow("Invalid initialize");
    expect(h.raw.send).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.objectContaining({ code: -32600 }) }),
    );
  });

  it.each(["connecting", "connected"])("rejects duplicate initialization while %s", async (phase) => {
    const h = harness();
    const selected = h.transport.waitForInitialize();
    h.emit(initialize("setup"));
    await selected;
    const received = vi.fn();
    h.transport.onmessage = received;
    if (phase === "connected") await h.transport.start();
    h.emit(initialize("full"));
    expect(h.raw.send).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.objectContaining({ message: "Duplicate initialize is not permitted" }) }),
    );
    expect(received).toHaveBeenCalledTimes(phase === "connected" ? 1 : 0);
    await expect(h.transport.send({ jsonrpc: "2.0", method: "notifications/initialized" })).rejects.toThrow("closed");
  });

  it.each(["count", "bytes"])("bounds %s while the upstream handshake is pending", async (bound) => {
    const h = harness();
    const selected = h.transport.waitForInitialize();
    h.emit(initialize("setup"));
    await selected;
    if (bound === "bytes") h.emit({ jsonrpc: "2.0", id: 2, method: "ping", params: { data: "x".repeat(65536) } });
    else for (let id = 2; id <= 17; id++) h.emit({ jsonrpc: "2.0", id, method: "ping" });
    expect(h.raw.send).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.objectContaining({ message: "Proxy initialization buffer exceeded" }) }),
    );
    await expect(h.transport.start()).rejects.toThrow("not available");
  });

  it("bounds the initial handshake time", async () => {
    vi.useFakeTimers();
    try {
      const h = harness();
      const selected = h.transport.waitForInitialize();
      const rejected = expect(selected).rejects.toThrow("timed out");
      await vi.advanceTimersByTimeAsync(30_000);
      await rejected;
      expect(h.raw.close).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
});
