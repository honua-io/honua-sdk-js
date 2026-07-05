import { afterEach, describe, expect, it } from "vitest";
import { startMockUpstream } from "../../src/certification/mock-upstream.js";
import { certifyTarget } from "../../src/certification/run.js";
import {
  type CertificationTarget,
  openCertificationTarget,
  resolveProxyEntry,
  resolveRemoteProxyOptions,
  resolveTargetMode,
} from "../../src/certification/target.js";

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const c of cleanups.splice(0)) {
    await c();
  }
});

describe("target mode resolution", () => {
  it("defaults to offline", () => {
    expect(resolveTargetMode({} as NodeJS.ProcessEnv)).toBe("offline");
  });

  it("accepts explicit modes", () => {
    expect(resolveTargetMode({ HONUA_MCP_CERT_TARGET: "remote" } as NodeJS.ProcessEnv)).toBe("remote");
    expect(resolveTargetMode({ HONUA_MCP_CERT_TARGET: "stdio-proxy" } as NodeJS.ProcessEnv)).toBe("stdio-proxy");
  });

  it("rejects unknown modes", () => {
    expect(() => resolveTargetMode({ HONUA_MCP_CERT_TARGET: "bogus" } as NodeJS.ProcessEnv)).toThrow(/offline/);
  });

  it("requires a remote URL for remote mode", () => {
    expect(() => resolveRemoteProxyOptions({} as NodeJS.ProcessEnv)).toThrow(/HONUA_MCP_REMOTE_URL/);
  });

  it("reads remote credentials from the environment", () => {
    const opts = resolveRemoteProxyOptions({
      HONUA_MCP_REMOTE_URL: "https://demo.honua.io/mcp",
      HONUA_MCP_AUTH_TOKEN: "tok",
    } as NodeJS.ProcessEnv);
    expect(opts.remoteUrl).toBe("https://demo.honua.io/mcp");
    expect(opts.authToken).toBe("tok");
  });
});

describe("offline target end-to-end", () => {
  it("certifies the mock operator upstream to a PASS", async () => {
    const target = await openCertificationTarget({ HONUA_MCP_CERT_TARGET: "offline" } as NodeJS.ProcessEnv);
    const report = await certifyTarget(target, {} as NodeJS.ProcessEnv); // closes the target
    expect(report.summary.pass).toBe(true);
    expect(report.protocol.targetMode).toBe("offline");
    expect(report.summary.contractsFailed).toBe(0);
  });
});

describe("remote target (against an in-process mock /mcp)", () => {
  it("connects through the proxy client path and certifies", async () => {
    const mock = await startMockUpstream();
    cleanups.push(() => mock.close());

    const env = {
      HONUA_MCP_CERT_TARGET: "remote",
      HONUA_MCP_REMOTE_URL: mock.url,
      HONUA_MCP_AUTH_TOKEN: mock.authToken,
    } as NodeJS.ProcessEnv;

    const target: CertificationTarget = await openCertificationTarget(env);
    const report = await certifyTarget(target, env); // closes the connected clients
    expect(report.protocol.targetMode).toBe("remote");
    expect(report.protocol.backend).toBe("live");
    expect(report.summary.pass).toBe(true);
    // auth contract still exercised via a fresh unauthenticated connection.
    const authChecks = report.contracts.filter((c) => c.contract === "auth-unauthenticated");
    expect(authChecks.every((c) => c.status === "passed")).toBe(true);
  }, 30_000);
});

describe("stdio-proxy target (proxy binary against the in-process mock)", () => {
  const built = (() => {
    try {
      resolveProxyEntry();
      return true;
    } catch {
      return false;
    }
  })();

  it.skipIf(!built)(
    "certifies end-to-end through the spawned honua-mcp-proxy",
    async () => {
      const env = { HONUA_MCP_CERT_TARGET: "stdio-proxy" } as NodeJS.ProcessEnv;
      const target = await openCertificationTarget(env);
      const report = await certifyTarget(target, env);
      expect(report.protocol.targetMode).toBe("stdio-proxy");
      expect(report.protocol.mcpTransport).toBe("stdio→streamable-http");
      expect(report.summary.pass).toBe(true);
      expect(report.summary.toolsDiscovered).toBeGreaterThanOrEqual(18);
    },
    30_000,
  );
});
