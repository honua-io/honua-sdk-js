import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createFixtureClient } from "../certification/fixture-client.js";
import { createServer } from "../index.js";
import { connectUpstream, resolveProxyOptions } from "../proxy.js";
import { resolveCorpus } from "./corpus.js";
import { resolveDrivers } from "./drivers/index.js";
import { grade } from "./grade.js";
import { type EvalReport, assembleReport } from "./report.js";
import type { ModelDriver, Scenario, ToolCallResult, WorkflowContext } from "./types.js";

/**
 * Cross-model eval runner (honua-server #1956).
 *
 * Backend selection mirrors the certifier: offline-first and deterministic.
 *   - HONUA_MCP_REMOTE_URL set → drive the live remote /mcp over streamable HTTP
 *     (the same surface the stdio proxy bridges).
 *   - otherwise → the offline in-memory fixture server (no network, no models).
 *
 * Drivers default to whatever `resolveDrivers` returns: the deterministic control
 * always, plus Claude/GPT when their API keys are present.
 */

export interface RunEvalOptions {
  env?: NodeJS.ProcessEnv;
  drivers?: ModelDriver[];
  corpus?: Scenario[];
  /** Force the in-memory fixture surface even if HONUA_MCP_REMOTE_URL is set. */
  forceOffline?: boolean;
}

interface SurfaceConnection {
  client: Client;
  backend: "fixture" | "live";
  mcpTransport: string;
  remoteUrl?: string | undefined;
  close(): Promise<void>;
}

async function connectSurface(env: NodeJS.ProcessEnv, forceOffline: boolean): Promise<SurfaceConnection> {
  const live = !forceOffline && typeof env.HONUA_MCP_REMOTE_URL === "string" && env.HONUA_MCP_REMOTE_URL.length > 0;

  if (live) {
    const options = resolveProxyOptions(env);
    const client = await connectUpstream(options);
    return {
      client,
      backend: "live",
      mcpTransport: "streamable-http",
      remoteUrl: options.remoteUrl,
      close: async () => {
        await client.close().catch(() => {});
      },
    };
  }

  const server = createServer(createFixtureClient());
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "honua-mcp-eval", version: "1.0.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return {
    client,
    backend: "fixture",
    mcpTransport: "in-memory",
    close: async () => {
      await client.close().catch(() => {});
      await server.close().catch(() => {});
    },
  };
}

function flattenToolResult(result: unknown): ToolCallResult {
  const r = result as { isError?: boolean; content?: { type: string; text?: string }[] };
  const isError = r.isError === true;
  const texts = (r.content ?? [])
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string);
  const text = texts.length > 0 ? texts.join("\n") : JSON.stringify(r.content ?? result);
  return { isError, text };
}

function buildContext(client: Client, tools: WorkflowContext["tools"]): WorkflowContext {
  return {
    tools,
    async callTool(name, args) {
      try {
        const result = await client.callTool({ name, arguments: args });
        return flattenToolResult(result);
      } catch (err) {
        return { isError: true, text: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}

export async function runEval(options: RunEvalOptions = {}): Promise<EvalReport> {
  const env = options.env ?? process.env;
  const corpus = options.corpus ?? resolveCorpus(env);
  const drivers = options.drivers ?? resolveDrivers({ env });
  const forceOffline = options.forceOffline ?? false;

  const surface = await connectSurface(env, forceOffline);
  try {
    const listed = await surface.client.listTools();
    const tools: WorkflowContext["tools"] = listed.tools.map((t) => ({
      name: t.name,
      description: t.description ?? "",
      inputSchema: t.inputSchema,
    }));
    const ctx = buildContext(surface.client, tools);

    const graded: Parameters<typeof assembleReport>[0]["graded"] = [];
    for (const driver of drivers) {
      for (const scenario of corpus) {
        const transcript = await driver.runWorkflow(scenario, ctx);
        graded.push({ grade: grade(scenario, transcript), transcript });
      }
    }

    return assembleReport({
      backend: surface.backend,
      mcpTransport: surface.mcpTransport,
      remoteUrl: surface.remoteUrl,
      corpus,
      drivers,
      graded,
    });
  } finally {
    await surface.close();
  }
}
