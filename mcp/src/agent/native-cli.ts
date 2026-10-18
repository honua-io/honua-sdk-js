#!/usr/bin/env node
import { homedir } from "node:os";
import path from "node:path";
import { isMainEntrypoint } from "../entrypoint.js";
import { createLocalAgentRuntime } from "./local-runtime.js";
import { createNativeAgentHttpServer } from "./native-http.js";

/** Host-only native bridge. The browser continues to use Console's authenticated BFF. */
export async function runNativeAgentGateway(env: NodeJS.ProcessEnv = process.env) {
  const port = Number(env.HONUA_AGENT_GATEWAY_PORT ?? "7863");
  const host = env.HONUA_AGENT_GATEWAY_HOST ?? "127.0.0.1";
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid gateway port");
  if (!["127.0.0.1", "::1", "0.0.0.0"].includes(host))
    throw new Error("Gateway host must be an explicit listen address");
  const server = createNativeAgentHttpServer({
    runtime: createLocalAgentRuntime(env.HONUA_AGENT_INSTALL_DIRECTORY ?? path.join(homedir(), ".honua", "local")),
    bridgeKey: env.HONUA_AGENT_GATEWAY_KEY ?? "",
    ...(env.HONUA_AGENT_DEVOPS_CONFIG ? { devopsConfiguration: env.HONUA_AGENT_DEVOPS_CONFIG } : {}),
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const close = () => {
    server.closeAllConnections();
    server.close();
  };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
  server.once("close", () => {
    process.removeListener("SIGINT", close);
    process.removeListener("SIGTERM", close);
  });
  return server;
}

if (isMainEntrypoint(import.meta.url)) {
  if (process.argv.includes("--help")) {
    process.stdout.write(
      "honua-agent-gateway — authenticated native HTTP bridge over the unified Honua MCP gateway.\nConfigure HONUA_AGENT_INSTALL_DIRECTORY and HONUA_AGENT_GATEWAY_KEY on the host. Default listen address: 127.0.0.1:7863.\n",
    );
  } else {
    runNativeAgentGateway().catch(() => {
      process.stderr.write("Native Honua gateway failed; inspect host configuration.\n");
      process.exitCode = 1;
    });
  }
}
