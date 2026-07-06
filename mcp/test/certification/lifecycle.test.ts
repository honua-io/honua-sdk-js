import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { describe, expect, it } from "vitest";
import { runDeepContracts } from "../../src/certification/lifecycle.js";

/**
 * Skip-with-reason behavior for the deep contracts: against a surface that lacks
 * a tool (the pre-P1 demo), each contract must SKIP with a loud reason rather
 * than fail — and mutating contracts must never run against a non-disposable
 * target without an explicit opt-in.
 */

function stubClient(): Client {
  return {
    async callTool() {
      throw new Error("stub client should not be called when tools are absent");
    },
    async readResource() {
      throw new Error("stub client should not be called when tools are absent");
    },
    async close() {},
  } as unknown as Client;
}

describe("runDeepContracts skip-with-reason", () => {
  it("skips every deep contract when the surface advertises none of the tools", async () => {
    const contracts = await runDeepContracts({
      client: stubClient(),
      advertisedToolNames: new Set<string>(),
      isDisposableBackend: false,
      env: {} as NodeJS.ProcessEnv,
    });
    expect(contracts).toHaveLength(4);
    for (const c of contracts) {
      expect(c.status).toBe("skipped");
      expect(c.detail.length).toBeGreaterThan(0);
    }
    const byName = (name: string) => contracts.find((c) => c.contract === name);
    expect(byName("mutating-round-trip")?.detail).toMatch(/not advertised/);
    expect(byName("async-job-lifecycle")?.detail).toMatch(/not advertised/);
    expect(byName("query-pagination")?.detail).toMatch(/not advertised/);
  });

  it("refuses to mutate a non-disposable target without the explicit opt-in", async () => {
    const contracts = await runDeepContracts({
      client: stubClient(),
      advertisedToolNames: new Set(["honua_edit_features", "honua_query_features", "honua_execute_plan"]),
      isDisposableBackend: false,
      env: {} as NodeJS.ProcessEnv,
    });
    const byName = (name: string) => contracts.find((c) => c.contract === name);
    expect(byName("mutating-round-trip")?.status).toBe("skipped");
    expect(byName("mutating-round-trip")?.detail).toMatch(/HONUA_MCP_CERT_ALLOW_MUTATION/);
    expect(byName("async-job-lifecycle")?.status).toBe("skipped");
    expect(byName("async-job-lifecycle")?.detail).toMatch(/HONUA_MCP_CERT_ALLOW_MUTATION/);
    // The permission-denied case needs an unauthenticated pass to run.
    expect(byName("mutating-permission-denied")?.status).toBe("skipped");
    expect(byName("mutating-permission-denied")?.detail).toMatch(/unauthenticated pass/);
  });
});
