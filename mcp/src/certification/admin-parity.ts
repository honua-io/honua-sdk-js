#!/usr/bin/env node

import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  ADMIN_MCP_CONTRACT_SERVER_SHA,
  ADMIN_MCP_COVERAGE_SHA256,
  ADMIN_MCP_EXCLUDED_OPERATIONS,
  ADMIN_MCP_EXCLUSION_ROSTER_SHA256,
  ADMIN_MCP_PUBLISHED_TOOL_NAMES,
  ADMIN_PUBLISHED_OPERATION_COUNT,
  MCP_DEFAULT_STATIC_TOOL_COUNT,
  MCP_DEFAULT_TOTAL_TOOL_COUNT,
} from "@honua/sdk-js/control-plane";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { connectUpstream, createProxyServer, resolveProxyOptions } from "../proxy.js";

export interface AdminParityReceipt {
  readonly schemaVersion: "honua.admin-mcp-parity.v1";
  readonly family: "honua_admin_*";
  readonly expectedTools: number;
  readonly expectedStaticTools: number;
  readonly expectedTotalTools: number;
  readonly directTools: number;
  readonly proxiedTools: number;
  readonly directStaticTools: number;
  readonly proxiedStaticTools: number;
  readonly directTotalTools: number;
  readonly proxiedTotalTools: number;
  readonly coverageSha256: string;
  readonly exclusionRosterSha256: string;
  readonly contractServerSha: string | null;
  readonly pass: boolean;
  readonly differences: readonly string[];
}

export interface AdminParityExpectation {
  readonly publishedToolNames: readonly string[];
  readonly excludedToolNames: readonly string[];
  readonly expectedStaticTools: number;
  readonly expectedTotalTools: number;
}

const DEFAULT_EXPECTATION: AdminParityExpectation = {
  publishedToolNames: ADMIN_MCP_PUBLISHED_TOOL_NAMES,
  excludedToolNames: ADMIN_MCP_EXCLUDED_OPERATIONS.map((operation) => operation.toolName),
  expectedStaticTools: MCP_DEFAULT_STATIC_TOOL_COUNT,
  expectedTotalTools: MCP_DEFAULT_TOTAL_TOOL_COUNT,
};

export function certifyAdminCatalogParity(
  directCatalog: readonly Tool[],
  proxiedCatalog: readonly Tool[],
  expectation: AdminParityExpectation = DEFAULT_EXPECTATION,
): AdminParityReceipt {
  const direct = normalizeAdminTools(directCatalog);
  const proxied = normalizeAdminTools(proxiedCatalog);
  const expectedTools = expectation.publishedToolNames.length;
  const directStaticTools = directCatalog.length - direct.length;
  const proxiedStaticTools = proxiedCatalog.length - proxied.length;
  const differences: string[] = [];
  if (expectedTools !== ADMIN_PUBLISHED_OPERATION_COUNT) {
    differences.push(
      `certification expectation contains ${expectedTools} admin tools; generated contract requires ${ADMIN_PUBLISHED_OPERATION_COUNT}`,
    );
  }
  if (direct.length !== expectedTools) {
    differences.push(`direct catalog exposes ${direct.length} admin tools; expected ${expectedTools}`);
  }
  if (proxied.length !== expectedTools) {
    differences.push(`proxied catalog exposes ${proxied.length} admin tools; expected ${expectedTools}`);
  }
  if (directStaticTools !== expectation.expectedStaticTools) {
    differences.push(
      `direct catalog exposes ${directStaticTools} static tools; expected ${expectation.expectedStaticTools}`,
    );
  }
  if (proxiedStaticTools !== expectation.expectedStaticTools) {
    differences.push(
      `proxied catalog exposes ${proxiedStaticTools} static tools; expected ${expectation.expectedStaticTools}`,
    );
  }
  if (directCatalog.length !== expectation.expectedTotalTools) {
    differences.push(
      `direct catalog exposes ${directCatalog.length} total tools; expected ${expectation.expectedTotalTools}`,
    );
  }
  if (proxiedCatalog.length !== expectation.expectedTotalTools) {
    differences.push(
      `proxied catalog exposes ${proxiedCatalog.length} total tools; expected ${expectation.expectedTotalTools}`,
    );
  }
  if (expectation.expectedStaticTools + expectedTools !== expectation.expectedTotalTools) {
    differences.push(
      `certification equation failed: ${expectation.expectedStaticTools} static + ${expectedTools} admin ` +
        `!= ${expectation.expectedTotalTools} total tools`,
    );
  }
  for (const duplicate of findDuplicateNames(direct)) {
    differences.push(`direct catalog repeats admin tool ${duplicate}`);
  }
  for (const duplicate of findDuplicateNames(proxied)) {
    differences.push(`proxied catalog repeats admin tool ${duplicate}`);
  }
  for (const duplicate of findDuplicateNames(directCatalog)) {
    if (!duplicate.startsWith("honua_admin_")) differences.push(`direct catalog repeats static tool ${duplicate}`);
  }
  for (const duplicate of findDuplicateNames(proxiedCatalog)) {
    if (!duplicate.startsWith("honua_admin_")) differences.push(`proxied catalog repeats static tool ${duplicate}`);
  }
  compareExpectedRoster("direct", direct, expectation, differences);
  compareExpectedRoster("proxied", proxied, expectation, differences);
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
    expectedStaticTools: expectation.expectedStaticTools,
    expectedTotalTools: expectation.expectedTotalTools,
    directTools: direct.length,
    proxiedTools: proxied.length,
    directStaticTools,
    proxiedStaticTools,
    directTotalTools: directCatalog.length,
    proxiedTotalTools: proxiedCatalog.length,
    coverageSha256: ADMIN_MCP_COVERAGE_SHA256,
    exclusionRosterSha256: ADMIN_MCP_EXCLUSION_ROSTER_SHA256,
    contractServerSha: ADMIN_MCP_CONTRACT_SERVER_SHA,
    pass: differences.length === 0,
    differences,
  };
}

function compareExpectedRoster(
  transport: "direct" | "proxied",
  tools: ReadonlyArray<{ readonly name: string }>,
  expectation: AdminParityExpectation,
  differences: string[],
): void {
  const actual = new Set(tools.map((tool) => tool.name));
  const expected = new Set(expectation.publishedToolNames);
  for (const name of [...expected].sort()) {
    if (!actual.has(name)) differences.push(`${name} is missing from the ${transport} catalog contract`);
  }
  for (const name of [...actual].sort()) {
    if (!expected.has(name))
      differences.push(`${name} is not classified as published in the ${transport} catalog contract`);
  }
  for (const name of [...expectation.excludedToolNames].sort()) {
    if (actual.has(name)) differences.push(`${transport} catalog advertises explicitly excluded admin tool ${name}`);
  }
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
 * Hostile-server safety ceiling on the number of `tools/list` pages a single
 * catalog read may consume.
 *
 * This is deliberately NOT the expected roster size. A roster assertion says
 * "this catalog is wrong"; this ceiling says "this server never stopped
 * paging". Conflating the two produced a single unactionable diagnostic and,
 * worse, made an opt-in profile catalog (base + analysis + Esri GP) impossible
 * to read at all because the *transport* refused any catalog larger than the
 * default roster.
 */
export const MCP_TOOLS_LIST_MAX_PAGES = 1_024;

/**
 * Hostile-server safety ceiling on the number of tools a single catalog read
 * may accumulate. Independent of {@link MCP_DEFAULT_TOTAL_TOOL_COUNT} so that
 * enabling additive server profiles is a roster question, not a transport
 * failure.
 */
export const MCP_TOOLS_LIST_MAX_TOOLS = 8_192;

/** Maximum accepted `tools/list` continuation cursor length, in characters. */
export const MCP_TOOLS_LIST_MAX_CURSOR_LENGTH = 1_024;

/**
 * Read the complete MCP tool catalog. The server deliberately pages large
 * catalogs, so a single tools/list response is not certification evidence for
 * the 432-tool default roster (47 static plus 385 Admin MCP tools).
 *
 * Roster size is *not* enforced here. This function is responsible only for
 * retrieving a complete, non-hostile catalog; deciding whether that catalog is
 * the 432-tool default roster or a profile-enabled superset belongs to the
 * certification and preflight callers.
 */
export async function listAllTools(client: {
  listTools(request?: { cursor?: string }): Promise<{ tools: Tool[]; nextCursor?: string }>;
}): Promise<Tool[]> {
  const tools: Tool[] = [];
  let cursor: string | undefined;
  const seenCursors = new Set<string>();
  let pageCount = 0;
  do {
    pageCount += 1;
    if (pageCount > MCP_TOOLS_LIST_MAX_PAGES) {
      throw new Error(
        `MCP tools/list exceeded the ${MCP_TOOLS_LIST_MAX_PAGES}-page pagination safety ceiling after ${tools.length} tools; the server did not terminate its cursor chain. This is a pagination fault, not a roster assertion.`,
      );
    }
    const page = await client.listTools(cursor ? { cursor } : undefined);
    if (tools.length + page.tools.length > MCP_TOOLS_LIST_MAX_TOOLS) {
      throw new Error(
        `MCP tools/list exceeded the ${MCP_TOOLS_LIST_MAX_TOOLS}-tool pagination safety ceiling on page ${pageCount}; the server returned an implausible catalog. This is a pagination fault, not a roster assertion.`,
      );
    }
    tools.push(...page.tools);
    cursor = page.nextCursor;
    if (cursor !== undefined && (cursor.length === 0 || cursor.length > MCP_TOOLS_LIST_MAX_CURSOR_LENGTH)) {
      throw new Error("MCP tools/list returned an invalid bounded cursor");
    }
    if (cursor && seenCursors.has(cursor)) {
      throw new Error(`MCP tools/list repeated cursor ${cursor}`);
    }
    if (cursor && page.tools.length === 0) {
      throw new Error("MCP tools/list returned an empty page with a continuation cursor");
    }
    if (cursor) seenCursors.add(cursor);
  } while (cursor);
  return tools;
}

export async function runAdminParityCertification(
  env: NodeJS.ProcessEnv = process.env,
  outputPath = "admin-mcp-parity.json",
): Promise<AdminParityReceipt> {
  if (ADMIN_MCP_CONTRACT_SERVER_SHA === null) {
    throw new Error(
      "Admin MCP live certification is blocked until config/admin-client.v1.json pins the final server head.",
    );
  }
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
