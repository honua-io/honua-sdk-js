import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { readVerifiedLocalEnv } from "@honua/sdk-js/local-install";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { expect, it, vi } from "vitest";

const execute = promisify(execFile);
const executable = fileURLToPath(new URL("../dist/src/agent/cli.js", import.meta.url));

// Network/Docker qualification is explicit; unit CI never pulls images.
it.skipIf(process.env.HONUA_AGENT_LIVE_ENABLED !== "true")(
  "boots the pinned Docker stack through one stdio session and reattaches after process restart",
  async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "honua-agent-gateway-"));
    const socket = createServer();
    await new Promise<void>((resolve) => socket.listen(0, "127.0.0.1", resolve));
    const address = socket.address();
    if (!address || typeof address === "string") throw new Error("No local test port");
    const port = address.port;
    await new Promise<void>((resolve, reject) => socket.close((error) => (error ? reject(error) : resolve())));
    let client: Client | undefined;
    async function connect() {
      const connected = new Client({ name: "honua-agent-live-proof", version: "1" });
      await connected.connect(
        new StdioClientTransport({
          command: process.execPath,
          args: [executable],
          env: {
            ...Object.fromEntries(
              Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
            ),
            HONUA_AGENT_INSTALL_DIRECTORY: directory,
          },
          stderr: "pipe",
        }),
      );
      return connected;
    }
    try {
      client = await connect();
      await vi.waitFor(
        async () => {
          expect((await client?.callTool({ name: "honua_agent_status" }))?.structuredContent?.state).toBe("unattached");
        },
        { timeout: 15_000 },
      );
      expect((await client.listTools()).tools).toHaveLength(4);
      expect((await client.callTool({ name: "honua_agent_inspect_local" })).structuredContent?.ready).toBe(true);
      const installed = await client.callTool(
        { name: "honua_agent_install_local", arguments: { confirm: true, httpPort: port } },
        undefined,
        { timeout: 600_000 },
      );
      expect(installed.isError).not.toBe(true);
      expect(installed.structuredContent?.state).toBe("attached");
      const env = await readVerifiedLocalEnv(directory);
      expect(env.HONUA_ADMIN_KEY).toBeTruthy();
      expect(JSON.stringify(installed).includes(env.HONUA_ADMIN_KEY)).toBe(false);
      const catalog = await client.listTools();
      expect(catalog.tools.some((tool) => !tool.name.startsWith("honua_agent_"))).toBe(true);
      expect(JSON.stringify(catalog).includes(env.HONUA_ADMIN_KEY)).toBe(false);
      const target = installed.structuredContent?.target;
      await client.close();
      client = await connect();
      await vi.waitFor(
        async () => {
          const status = await client?.callTool({ name: "honua_agent_status" });
          expect(status?.structuredContent).toMatchObject({ state: "attached", target });
        },
        { timeout: 30_000 },
      );
      expect((await client.listTools()).tools.some((tool) => !tool.name.startsWith("honua_agent_"))).toBe(true);
    } finally {
      await client?.close();
      const env = await readVerifiedLocalEnv(directory);
      if (env.HONUA_COMPOSE_PROJECT) {
        expect(env.HONUA_COMPOSE_PROJECT).toMatch(/^honua-local-[a-f0-9]{24}$/);
        await execute(
          "docker",
          [
            "compose",
            "--project-name",
            env.HONUA_COMPOSE_PROJECT,
            "--project-directory",
            directory,
            "--file",
            path.join(directory, "compose.yaml"),
            "down",
            "--volumes",
          ],
          { timeout: 120_000 },
        );
      }
      await rm(directory, { recursive: true, force: true });
    }
  },
  900_000,
);
