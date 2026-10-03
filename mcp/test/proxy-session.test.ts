import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { catalog, initialize, startFixture, startProxy } from "./fixtures/initialize-view/harness.mjs";

const executable = fileURLToPath(new URL("../dist/src/proxy.js", import.meta.url));

describe("published proxy protocol boundary: initialize-bound sessions", () => {
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
        jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "fixture", arguments: {} },
      });
      expect(called.result._meta.view).toBe(view ?? "default");
      const requests = fixture.traffic.filter((entry) => entry.direction === "http-request");
      expect(JSON.parse(requests[0].body)).toEqual(request);
      expect(requests.filter((entry) => JSON.parse(entry.body).method === "initialize")).toHaveLength(1);
      expect(requests.slice(1).every((entry) => entry.session === requests[1].session)).toBe(true);
      expect(JSON.parse(requests.find((entry) => JSON.parse(entry.body).method === "tools/list").body)).toEqual({
        jsonrpc: "2.0", id: 2, method: "tools/list",
      });
    } finally {
      await proxy.close();
      await fixture.close();
    }
  });

  it("keeps concurrent setup/default sessions isolated and restores after a full-catalog override", async () => {
    const fixture = await startFixture();
    const setup = startProxy(executable, fixture.url);
    const defaultView = startProxy(executable, fixture.url);
    try {
      await Promise.all([setup.request(initialize("setup")), defaultView.request(initialize())]);
      for (const proxy of [setup, defaultView]) proxy.send({ jsonrpc: "2.0", method: "notifications/initialized" });
      const list = (proxy, id, params?) => proxy.request({ jsonrpc: "2.0", id, method: "tools/list", ...(params ? { params } : {}) });
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
