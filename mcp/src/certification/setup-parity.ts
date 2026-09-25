#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { type Tool, ToolSchema } from "@modelcontextprotocol/sdk/types.js";
import { isMainEntrypoint } from "../entrypoint.js";
import { connectUpstream, resolveProxyOptions } from "../proxy.js";
import { listAllTools } from "./admin-parity.js";

/** A reviewed capture from the pinned server, never a client-authored tool roster. */
export interface SetupCatalogManifest {
  schemaVersion: "honua.setup-catalog-manifest/v1";
  candidateId: string;
  serverImage: string;
  packages: { name: string; version: string; integrity: string }[];
  serverInfo: { name: string; version: string };
  view: string;
  revision: string;
  revisionDigest: string;
  membershipDigest: string;
  descriptorDigest: string;
  tools: Tool[];
}

export interface SetupCatalogSnapshot {
  tools: Tool[];
  metadata: Record<string, unknown>;
  serverInfo: unknown;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function parseSetupCatalogManifest(bytes: string, expectedSha256: string): SetupCatalogManifest {
  if (!/^[a-f0-9]{64}$/.test(expectedSha256) || sha256(bytes) !== expectedSha256) {
    throw new Error("Setup manifest SHA-256 does not match the independently pinned digest");
  }
  const value: unknown = JSON.parse(bytes);
  if (!record(value) || value.schemaVersion !== "honua.setup-catalog-manifest/v1") {
    throw new Error("Expected honua.setup-catalog-manifest/v1");
  }
  for (const key of ["candidateId", "view", "revision"]) {
    if (typeof value[key] !== "string" || !value[key].trim()) throw new Error(`Manifest requires ${key}`);
  }
  if (value.view === "full") throw new Error("Setup qualification requires a bounded server-authored view");
  if (typeof value.serverImage !== "string" || !/^[^\s@]+@sha256:[a-f0-9]{64}$/.test(value.serverImage)) {
    throw new Error("Manifest requires an immutable server image digest");
  }
  for (const key of ["revisionDigest", "membershipDigest", "descriptorDigest"]) {
    if (typeof value[key] !== "string" || !/^sha256:[a-f0-9]{64}$/.test(value[key])) {
      throw new Error(`Manifest requires server-authored ${key}`);
    }
  }
  if (
    !record(value.serverInfo) ||
    typeof value.serverInfo.name !== "string" ||
    typeof value.serverInfo.version !== "string"
  ) {
    throw new Error("Manifest requires the server initialize identity");
  }
  if (
    !Array.isArray(value.packages) ||
    value.packages.length === 0 ||
    value.packages.some(
      (pkg) =>
        !record(pkg) ||
        typeof pkg.name !== "string" ||
        !/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/.test(pkg.name) ||
        typeof pkg.version !== "string" ||
        !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(pkg.version) ||
        typeof pkg.integrity !== "string" ||
        !/^sha512-[A-Za-z0-9+/]{86}==$/.test(pkg.integrity),
    )
  )
    throw new Error("Manifest requires exact package versions and sha512 integrities");
  if (!Array.isArray(value.tools) || value.tools.length === 0) throw new Error("Manifest has no enabled tools");
  for (const tool of value.tools) ToolSchema.parse(tool);
  const names = value.tools.map((tool) => tool.name);
  if (new Set(names).size !== names.length) throw new Error("Manifest repeats a tool name");
  return value as unknown as SetupCatalogManifest;
}

/** Drain the selected view, retaining server revision metadata across every page. */
export async function readSetupCatalog(
  client: {
    listTools(request?: { cursor?: string }): Promise<{
      tools: Tool[];
      nextCursor?: string;
      _meta?: Record<string, unknown>;
    }>;
    getServerVersion(): unknown;
  },
  view: string,
): Promise<SetupCatalogSnapshot> {
  let metadata: Record<string, unknown> | undefined;
  const tools = await listAllTools(
    {
      async listTools(request) {
        const page = await client.listTools(request);
        if (!page._meta) throw new Error("tools/list omitted the server-authored view metadata");
        if (metadata && stableJson(metadata) !== stableJson(page._meta)) {
          throw new Error("tools/list changed view metadata during pagination; repeat against a stable candidate");
        }
        metadata = page._meta;
        return page;
      },
    },
    { view },
  );
  return { tools, metadata: metadata ?? {}, serverInfo: client.getServerVersion() };
}

/** Catalog evidence only: installation, authorization and style execution have separate receipts. */
export function certifySetupCatalogParity(
  manifest: SetupCatalogManifest,
  manifestSha256: string,
  direct: SetupCatalogSnapshot,
  proxied: SetupCatalogSnapshot,
) {
  const differences: string[] = [];
  const expected = new Map(manifest.tools.map((tool) => [tool.name, tool]));
  for (const [transport, snapshot] of [
    ["HTTP", direct],
    ["stdio", proxied],
  ] as const) {
    if (stableJson(snapshot.serverInfo) !== stableJson(manifest.serverInfo))
      differences.push(`${transport}: server identity differs from the pin`);
    const names = snapshot.tools.map((tool) => tool.name);
    if (new Set(names).size !== names.length) differences.push(`${transport}: duplicate tool names`);
    for (const key of ["view", "revision", "revisionDigest", "membershipDigest", "descriptorDigest"] as const) {
      if (snapshot.metadata[key] !== manifest[key]) differences.push(`${transport}: ${key} differs from the pin`);
    }
    if (snapshot.metadata.toolCount !== manifest.tools.length)
      differences.push(`${transport}: declared toolCount differs from the enabled manifest`);
    const actual = new Map(snapshot.tools.map((tool) => [tool.name, tool]));
    for (const name of expected.keys()) {
      if (!actual.has(name))
        differences.push(`${transport}: missing enabled tool ${name}; check candidate view and effective permissions`);
      else if (stableJson(actual.get(name)) !== stableJson(expected.get(name)))
        differences.push(`${transport}: ${name} descriptor differs from the pin`);
    }
    for (const name of actual.keys())
      if (!expected.has(name)) differences.push(`${transport}: unexpected tool ${name}`);
  }
  if (stableJson(direct.metadata) !== stableJson(proxied.metadata))
    differences.push("HTTP/stdio view metadata differs");
  // These local comparison hashes are distinct from the server's wire-byte
  // descriptorDigest: do not claim sorted JavaScript JSON reproduces its bytes.
  const descriptorHash = (tools: Tool[]) => sha256(stableJson([...tools].sort((a, b) => a.name.localeCompare(b.name))));
  return {
    schemaVersion: "honua.setup-catalog-parity/v1" as const,
    scope: "catalog-parity-only" as const,
    candidateId: manifest.candidateId,
    serverImage: manifest.serverImage,
    packages: manifest.packages.map(({ name, version, integrity }) => ({ name, version, integrity })),
    manifestSha256,
    view: manifest.view,
    revision: manifest.revision,
    revisionDigest: manifest.revisionDigest,
    expectedTools: manifest.tools.length,
    directTools: direct.tools.length,
    proxiedTools: proxied.tools.length,
    directDescriptorSha256: descriptorHash(direct.tools),
    proxiedDescriptorSha256: descriptorHash(proxied.tools),
    pass: differences.length === 0,
    differences,
  };
}

export async function runSetupParityCertification(
  manifestPath: string,
  manifestSha256: string,
  outputPath: string,
  env: NodeJS.ProcessEnv = process.env,
) {
  const manifest = parseSetupCatalogManifest(await readFile(manifestPath, "utf8"), manifestSha256);
  const options = resolveProxyOptions(env);
  const upstream = await connectUpstream(options);
  const proxied = new Client({ name: "honua-setup-parity", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL("../proxy.js", import.meta.url))],
    env: Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
    stderr: "pipe",
  });
  // The proxy may report upstream error bodies. Never copy those into a receipt or terminal log.
  transport.stderr?.on("data", () => {});
  try {
    await proxied.connect(transport);
    const direct = await readSetupCatalog(upstream, manifest.view);
    const forwarded = await readSetupCatalog(proxied, manifest.view);
    const receipt = certifySetupCatalogParity(manifest, manifestSha256, direct, forwarded);
    await writeFile(outputPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
    return receipt;
  } finally {
    await proxied.close().catch(() => {});
    await transport.close().catch(() => {});
    await upstream.close().catch(() => {});
  }
}

if (isMainEntrypoint(import.meta.url)) {
  const [manifestPath, digest, outputPath] = process.argv.slice(2);
  if (!manifestPath || !digest || !outputPath || process.argv.length !== 5) {
    process.stderr.write("Usage: setup-parity <server-manifest.json> <pinned-sha256> <receipt.json>\n");
    process.exitCode = 1;
  } else {
    runSetupParityCertification(manifestPath, digest, outputPath)
      .then((receipt) => {
        process.stdout.write(
          `${receipt.pass ? "PASS" : "FAIL"}: bounded setup catalog parity (${receipt.expectedTools} enabled tools)\n`,
        );
        process.exitCode = receipt.pass ? 0 : 1;
      })
      .catch(() => {
        process.stderr.write(
          "Setup parity could not complete; verify the pinned manifest, endpoint, credentials and server view. Upstream details suppressed.\n",
        );
        process.exitCode = 1;
      });
  }
}
