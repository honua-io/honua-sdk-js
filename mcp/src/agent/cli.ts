#!/usr/bin/env node
import { homedir } from "node:os";
import path from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { isMainEntrypoint } from "../entrypoint.js";
import { HonuaAgentGateway } from "./gateway.js";
import { createLocalAgentRuntime } from "./local-runtime.js";

export async function runAgent(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const directory = env.HONUA_AGENT_INSTALL_DIRECTORY ?? path.join(homedir(), ".honua", "local");
  const gateway = new HonuaAgentGateway(createLocalAgentRuntime(directory));
  const close = () => {
    void gateway.close().catch(() => {});
  };
  process.stdin.once("end", close);
  process.stdin.once("close", close);
  await gateway.connect(new StdioServerTransport());
}

if (isMainEntrypoint(import.meta.url)) {
  if (process.argv.includes("--help")) {
    process.stdout.write(
      "honua-agent-mcp — persistent local Honua MCP gateway\nConfigure HONUA_AGENT_INSTALL_DIRECTORY in the host; default ~/.honua/local.\n",
    );
  } else {
    runAgent().catch(() => {
      process.stderr.write("Honua agent connector failed; inspect local configuration.\n");
      process.exitCode = 1;
    });
  }
}
