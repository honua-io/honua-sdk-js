#!/usr/bin/env node

import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { ADMIN_PUBLISHED_OPERATION_COUNT } from "@honua/sdk-js/control-plane";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { connectUpstream, createProxyServer, resolveProxyOptions } from "../proxy.js";

export interface AdminParityReceipt {
  readonly schemaVersion: "honua.admin-mcp-parity.v1";
  readonly family: "honua_admin_*";
  readonly expectedTools: number;
  readonly directTools: number;
  readonly proxiedTools: number;
  readonly pass: boolean;
  readonly differences: readonly string[];
}

export function certifyAdminCatalogParity(
  directCatalog: readonly Tool[],
  proxiedCatalog: readonly Tool[],
  expectedTools = ADMIN_PUBLISHED_OPERATION_COUNT,
): AdminParityReceipt {
  const direct = normalizeAdminTools(directCatalog);
  const proxied = normalizeAdminTools(proxiedCatalog);
  const differences: string[] = [];
  if (direct.length !== expectedTools) {
    differences.push(`direct catalog exposes ${direct.length} admin tools; expected ${expectedTools}`);
  }
  if (proxied.length !== expectedTools) {
    differences.push(`proxied catalog exposes ${proxied.length} admin tools; expected ${expectedTools}`);
  }
  for (const duplicate of findDuplicateNames(direct)) {
    differences.push(`direct catalog repeats admin tool ${duplicate}`);
  }
  for (const duplicate of findDuplicateNames(proxied)) {
    differences.push(`proxied catalog repeats admin tool ${duplicate}`);
  }
  const directByName = new Map(direct.map((tool) => [tool.name, tool]));
  const proxiedByName = new Map(proxied.map((tool) => [tool.name, tool]));
  for (const name of [...new Set([...directByName.keys(), ...proxiedByName.keys()])].sort()) {
    const directTool = directByName.get(name);
    const proxiedTool = proxiedByName.get(name);
    if (!directTool) differences.push(`${name} is missing from the direct HTTP catalog`);
    else if (!proxiedTool) differences.push(`${name} is missing from the proxied catalog`);
    else if (stableJson(directTool) !== stableJson(proxiedTool)) differences.push(`${name} descriptor differs`);
  }
  return {
    schemaVersion: "honua.admin-mcp-parity.v1",
    family: "honua_admin_*",
    expectedTools,
    directTools: direct.length,
    proxiedTools: proxied.length,
    pass: differences.length === 0,
    differences,
  };
}

function findDuplicateNames(tools: ReadonlyArray<{ readonly name: string }>): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const tool of tools) {
    if (seen.has(tool.name)) duplicates.add(tool.name);
    else seen.add(tool.name);
  }
  return [...duplicates].sort();
}

export function normalizeAdminTools(tools: readonly Tool[]) {
  return tools
    .filter((tool) => tool.name.startsWith("honua_admin_"))
    .map((tool) => ({
      name: tool.name,
      title: tool.title,
      description: tool.description,
      inputSchema: tool.inputSchema,
      outputSchema: tool.outputSchema,
      annotations: tool.annotations,
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

/**
 * Read the complete MCP tool catalog. The server deliberately pages large
 * catalogs, so a single tools/list response is not certification evidence for
 * the 119-tool admin family.
 */
export async function listAllTools(client: {
  listTools(request?: { cursor?: string }): Promise<{ tools: Tool[]; nextCursor?: string }>;
}): Promise<Tool[]> {
  const tools: Tool[] = [];
  let cursor: string | undefined;
  const seenCursors = new Set<string>();
  do {
    const page = await client.listTools(cursor ? { cursor } : undefined);
    tools.push(...page.tools);
    cursor = page.nextCursor;
    if (cursor && seenCursors.has(cursor)) {
      throw new Error(`MCP tools/list repeated cursor ${cursor}`);
    }
    if (cursor) seenCursors.add(cursor);
  } while (cursor);
  return tools;
}

export async function runAdminParityCertification(
  env: NodeJS.ProcessEnv = process.env,
  outputPath = "admin-mcp-parity.json",
): Promise<AdminParityReceipt> {
  const upstream = await connectUpstream(resolveProxyOptions(env));
  const proxy = createProxyServer(upstream);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const proxied = new Client({ name: "honua-admin-parity", version: "1.0.0" });
  try {
    await proxy.connect(serverTransport);
    await proxied.connect(clientTransport);
    const directTools = await listAllTools(upstream);
    const proxiedTools = await listAllTools(proxied);
    const receipt = certifyAdminCatalogParity(directTools, proxiedTools);
    await writeFile(outputPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
    if (!receipt.pass) throw new Error(`Admin MCP parity failed: ${receipt.differences.join("; ")}`);
    return receipt;
  } finally {
    await proxied.close().catch(() => {});
    await proxy.close().catch(() => {});
    await upstream.close().catch(() => {});
  }
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runAdminParityCertification(process.env, process.argv[2]).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
