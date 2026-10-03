import { fileURLToPath } from "node:url";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import { connectProxyTransport } from "../src/proxy.js";
import { catalog, initialize, startFixture, startProxy } from "./fixtures/initialize-view/harness.mjs";

const executable =
  process.env.HONUA_PROXY_TEST_EXECUTABLE ?? fileURLToPath(new URL("../dist/src/proxy.js", import.meta.url));

describe("published proxy protocol boundary: initialize-bound sessions", () => {
  it("waits for downstream initialize and closes both transports on HTTP failure", async () => {
    const fixture = await startFixture();
    const [client, downstream] = InMemoryTransport.createLinkedPair();
    const upstream = await connectProxyTransport({ remoteUrl: fixture.url }, downstream);
    try {
      await client.start();
      expect(fixture.traffic).toEqual([]);
      const request = async (message: JSONRPCMessage) => {
        const received = new Promise<JSONRPCMessage>((resolve) => {
          client.onmessage = resolve;
        });
        await client.send(message);
        return received;
      };
      const initialized = await request(initialize("setup"));
      expect(initialized).toMatchObject({ id: 1, result: { _meta: { "fixture/initialize": "preserve" } } });
      const listed = await request({ jsonrpc: "2.0", id: 2, method: "tools/list" });
      expect(listed).toMatchObject({ id: 2, result: catalog("setup") });
      const closed = new Promise<void>((resolve) => {
        client.onclose = resolve;
      });
      await client.send({ jsonrpc: "2.0", id: 3, method: "tools/list", params: { view: "full" } });
      await closed;
      expect(fixture.sessions.size).toBe(1);
    } finally {
      await client.close();
      await upstream.close();
      await fixture.close();
    }
  });

  it("accepts initialized before sending an immediately following tools/list", async () => {
    const fixture = await startFixture({ initializedDelayMs: 200 });
    const proxy = startProxy(executable, fixture.url);
    try {
      await proxy.request(initialize("setup"));
      proxy.send({ jsonrpc: "2.0", method: "notifications/initialized" });
      const listed = await proxy.request({ jsonrpc: "2.0", id: 2, method: "tools/list" });
      expect(listed.result).toEqual(catalog("setup"));
    } finally {
      await proxy.close();
      await fixture.close();
    }
  });

  it("closes stdio after an asynchronous SSE reader failure", async () => {
    const fixture = await startFixture({ brokenSse: true });
    const proxy = startProxy(executable, fixture.url);
    try {
      await proxy.request(initialize("setup"));
      proxy.send({ jsonrpc: "2.0", method: "notifications/initialized" });
      proxy.send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
      await proxy.expectExit();
      expect(fixture.sessions.size).toBe(1);
    } finally {
      await proxy.close();
      await fixture.close();
    }
  });

  it.each(["setup", undefined])("retains %s initialize view on selector-free requests", async (view) => {
    const fixture = await startFixture();
    const proxy = startProxy(executable, fixture.url);
    try {
      const request = initialize(view);
      const response = await proxy.request(request);
      expect(response.result._meta).toEqual({ "fixture/initialize": "preserve" });
      proxy.send({ jsonrpc: "2.0", method: "notifications/initialized" });
      const listed = await proxy.request({ jsonrpc: "2.0", id: 2, method: "tools/list" });
      expect(listed.result).toEqual(catalog(view ?? "default"));
      const called = await proxy.request({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "fixture", arguments: {} },
      });
      expect(called.result._meta.view).toBe(view ?? "default");
      const requests = fixture.traffic.filter((entry) => entry.direction === "http-request");
      expect(JSON.parse(requests[0].body)).toEqual(request);
      expect(requests.filter((entry) => JSON.parse(entry.body).method === "initialize")).toHaveLength(1);
      expect(requests.slice(1).every((entry) => entry.session === requests[1].session)).toBe(true);
      expect(requests.slice(1).every((entry) => entry.protocolVersion === "2025-06-18")).toBe(true);
      expect(JSON.parse(requests.find((entry) => JSON.parse(entry.body).method === "tools/list").body)).toEqual({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list",
      });
    } finally {
      await proxy.close();
      await fixture.close();
    }
  });

  it("keeps concurrent setup/default sessions isolated and restores after a full-catalog override", async () => {
    const fixture = await startFixture();
    const setup = startProxy(executable, fixture.url, "fixture-key");
    const defaultView = startProxy(executable, fixture.url);
    try {
      await Promise.all([setup.request(initialize("setup")), defaultView.request(initialize())]);
      for (const proxy of [setup, defaultView]) proxy.send({ jsonrpc: "2.0", method: "notifications/initialized" });
      const list = (proxy, id, params?) =>
        proxy.request({ jsonrpc: "2.0", id, method: "tools/list", ...(params ? { params } : {}) });
      const [firstSetup, firstDefault] = await Promise.all([list(setup, 2), list(defaultView, 2)]);
      expect(firstSetup.result).toEqual(catalog("setup"));
      expect(firstDefault.result).toEqual(catalog("default"));
      expect((await list(setup, 3, { view: "full" })).result).toEqual(catalog("full"));
      const [restoredSetup, retainedDefault] = await Promise.all([list(setup, 4), list(defaultView, 4)]);
      expect(restoredSetup.result).toEqual(firstSetup.result);
      expect(retainedDefault.result).toEqual(firstDefault.result);
      expect([...fixture.sessions.values()].sort()).toEqual(["default", "setup"]);
    } finally {
      await Promise.all([setup.close(), defaultView.close()]);
      await fixture.close();
    }
  });
});
