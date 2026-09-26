import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { deflateSync } from "node:zlib";

import { afterEach, describe, expect, it } from "vitest";

import {
  BOUNDED_QUALIFICATION_SCHEMA,
  type BoundedManifest,
  type BoundedQualificationEvidence,
  assembleBoundedQualification,
  parseBoundedManifest,
  qualifyBoundedSetup,
} from "../src/cli/bounded-qualification.js";
import { LOCAL_INSTALL_MCP_PACKAGE, LOCAL_INSTALL_SERVER_IMAGE } from "../src/local-install.js";
import { McpClient } from "../src/studio-agent/mcp-client.js";

const cleanup: string[] = [];
afterEach(() => {
  for (const directory of cleanup.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const DIGEST = "a".repeat(64);
const SERVER_INFO = { name: "honua", version: "2026.1.0" };
const METADATA = {
  view: "setup",
  revision: "setup.v1",
  revisionDigest: DIGEST,
  membershipDigest: "b".repeat(64),
  descriptorDigest: "c".repeat(64),
  toolCount: 2,
};

function tool(name: string, extra: Record<string, unknown> = {}) {
  return { name, inputSchema: { type: "object", properties: {} }, ...extra };
}

function manifest(
  tools = [
    tool("honua_get_style", { description: "do-not-copy-this-descriptor" }),
    tool("honua_describe_process", {
      inputSchema: { type: "object", properties: { processId: { const: "geometry.buffer" } } },
    }),
  ],
): BoundedManifest {
  return {
    schemaVersion: "honua.setup-catalog-manifest/v1",
    candidateId: "candidate-1",
    serverImage: LOCAL_INSTALL_SERVER_IMAGE,
    packages: [{ name: "@honua/mcp-server", version: "0.1.9-beta.0", integrity: `sha512-${"A".repeat(86)}==` }],
    serverInfo: SERVER_INFO,
    view: "setup",
    revision: "setup.v1",
    revisionDigest: DIGEST,
    membershipDigest: "b".repeat(64),
    descriptorDigest: "c".repeat(64),
    tools,
  };
}

function evidence(overrides: Partial<BoundedQualificationEvidence> = {}): BoundedQualificationEvidence {
  const pinned = manifest();
  return {
    generatedAt: "2026-09-26T00:00:00.000Z",
    manifest: pinned,
    manifestSha256: DIGEST,
    install: {
      installed: true,
      ready: true,
      baseUrl: "http://127.0.0.1:18080",
      configuredImage: LOCAL_INSTALL_SERVER_IMAGE,
      repoDigests: [LOCAL_INSTALL_SERVER_IMAGE],
      composeText: "name: honua-local\n",
      mcpPackageArgument: LOCAL_INSTALL_MCP_PACKAGE,
      mcpRemoteUrl: "http://127.0.0.1:18080/mcp",
    },
    access: {
      id: "key-1",
      name: "honua-local-agent",
      requestedGrants: ["admin:read", "admin:write"],
      effectiveGrants: ["admin:write", "admin:read"],
      canAuthenticate: true,
    },
    adminVersion: { version: "2026.1.0", metadataApiVersion: "honua.io/admin/v1" },
    discovery: { serverInfo: SERVER_INFO, tools: pinned.tools, metadata: METADATA, pages: 2 },
    catalogReceipt: {
      schemaVersion: "honua.setup-catalog-parity/v1",
      scope: "catalog-parity-only",
      candidateId: "candidate-1",
      serverImage: LOCAL_INSTALL_SERVER_IMAGE,
      manifestSha256: DIGEST,
      view: "setup",
      pass: true,
      directDescriptorSha256: "d".repeat(64),
      proxiedDescriptorSha256: "d".repeat(64),
    },
    style: {
      discoveredStyleId: "preset-1",
      applied: true,
      appliedStyleId: "preset-1",
      appliedStyleVersion: "3",
      confirmedStyleId: "preset-1",
      confirmedStyleVersion: "3",
      renderedStyleId: "preset-1",
      width: 8,
      height: 8,
      mediaType: "image/png",
      uri: "honua://renders/1",
      png: drawnPng(8, 8),
    },
    ...overrides,
  };
}

describe("bounded setup qualification", () => {
  it("passes a pinned bounded view without a 441-tool denominator", () => {
    const receipt = assembleBoundedQualification(evidence());
    expect(receipt.pass).toBe(true);
    expect(receipt.schemaVersion).toBe(BOUNDED_QUALIFICATION_SCHEMA);
    expect(receipt.discovery.geometryBufferTool).toBe("honua_describe_process");
    expect(receipt.discovery.pages).toBe(2);
    expect(receipt.styleRender?.visiblePixelCount).toBeGreaterThan(0);
    expect(receipt.unsupported).toContain("hard-coded 441-tool success denominator");
    expect(receipt.differences.join(" ")).not.toContain("441");
    expect(receipt.discovery.pages).toBe(2);
    expect(JSON.stringify(receipt)).not.toContain("do-not-copy-this-descriptor");
  });

  it("rejects a full view, a digest mismatch, a guessed profile switch, and a style no-op", () => {
    const bytes = JSON.stringify(manifest());
    expect(() => parseBoundedManifest(bytes, "f".repeat(64))).toThrow(/independently pinned digest/);
    const full = JSON.stringify({ ...manifest(), view: "full" });
    expect(() => parseBoundedManifest(full, createHash("sha256").update(full).digest("hex"))).toThrow(
      /bounded server-authored view/,
    );

    const guessed = assembleBoundedQualification(
      evidence({ install: { ...evidence().install, composeText: "Mcp__Profiles=analysis\n" } }),
    );
    expect(guessed.differences).toContain(
      "refusing a guessed Mcp__Profiles switch; bounded qualification uses the server-authored view",
    );

    const noop = assembleBoundedQualification(
      evidence({
        style: { ...evidence().style, applied: false } as BoundedQualificationEvidence["style"],
      }),
    );
    expect(noop.pass).toBe(false);
    expect(noop.differences.some((item) => item.includes("applied: false"))).toBe(true);

    const flat = assembleBoundedQualification(
      evidence({
        style: {
          ...(evidence().style as Exclude<BoundedQualificationEvidence["style"], { error: string } | undefined>),
          png: drawnPng(8, 8, { flat: true }),
        },
      }),
    );
    expect(flat.differences.some((item) => item.includes("single flat colour"))).toBe(true);
  });

  it("names a missing geometry.buffer task and an HTTP/stdio hash split without blaming pagination", () => {
    const missing = assembleBoundedQualification(evidence({ manifest: manifest([tool("honua_get_style")]) }));
    expect(missing.differences.some((item) => item.includes("does not advertise geometry.buffer"))).toBe(true);

    const split = assembleBoundedQualification(
      evidence({
        catalogReceipt: {
          ...(evidence().catalogReceipt as Record<string, unknown>),
          proxiedDescriptorSha256: "e".repeat(64),
        },
      }),
    );
    expect(split.differences).toContain("HTTP/stdio descriptor hashes differ");
    expect(split.differences.join("\n")).not.toMatch(/441|pagination fault/);
  });

  it("qualifies a private local directory and scrubs a credential echoed by the server", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "honua-qualify-"));
    cleanup.push(directory);
    const secret = "local-agent-credential-value";
    const pinned = manifest();
    const manifestBytes = JSON.stringify(pinned);
    const manifestPath = path.join(directory, "manifest.json");
    const manifestSha256 = createHash("sha256").update(manifestBytes).digest("hex");
    writeFileSync(manifestPath, manifestBytes);
    writeFileSync(
      path.join(directory, "catalog.json"),
      JSON.stringify({
        schemaVersion: "honua.setup-catalog-parity/v1",
        scope: "catalog-parity-only",
        candidateId: pinned.candidateId,
        serverImage: pinned.serverImage,
        manifestSha256,
        view: pinned.view,
        pass: true,
        directDescriptorSha256: "d".repeat(64),
        proxiedDescriptorSha256: "d".repeat(64),
      }),
    );
    writeFileSync(path.join(directory, "compose.yaml"), "name: honua-local\n");
    writeFileSync(
      path.join(directory, ".env"),
      `HONUA_HTTP_PORT=18080\nHONUA_SERVER_IMAGE=${LOCAL_INSTALL_SERVER_IMAGE}\nHONUA_ADMIN_KEY=${secret}\n`,
      { mode: 0o600 },
    );
    writeFileSync(
      path.join(directory, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          honua: {
            command: "npx",
            args: ["-y", "--package", LOCAL_INSTALL_MCP_PACKAGE, "honua-mcp-proxy"],
            env: { HONUA_MCP_REMOTE_URL: "http://127.0.0.1:18080/mcp", HONUA_ADMIN_KEY: secret },
          },
        },
      }),
      { mode: 0o600 },
    );
    const styleJson = path.join(directory, "style.json");
    const stylePng = path.join(directory, "render.png");
    writeFileSync(
      styleJson,
      JSON.stringify({
        discoveredStyleId: "preset-1",
        applied: true,
        appliedStyleId: "preset-1",
        appliedStyleVersion: "3",
        confirmedStyleId: "preset-1",
        confirmedStyleVersion: "3",
        renderedStyleId: "preset-1",
        width: 8,
        height: 8,
        mediaType: "image/png",
        uri: "honua://renders/1",
      }),
    );
    writeFileSync(stylePng, drawnPng(8, 8));
    const views: unknown[] = [];
    const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/healthz/ready")) return new Response("ready", { status: 200 });
      if (url.endsWith("/api/v1/admin/api-keys")) {
        return json({
          data: [
            {
              id: "key-1",
              name: "honua-local-agent",
              status: "active",
              keyPrefix: "local-agent",
              permissions: ["admin:read", "admin:write"],
            },
          ],
        });
      }
      if (url.includes("/effective-permissions")) {
        return json({
          data: { id: "key-1", status: "active", canAuthenticate: true, permissions: ["admin:read", "admin:write"] },
        });
      }
      if (url.endsWith("/api/v1/admin/version"))
        return json({ data: { version: "2026.1.0", metadataApiVersion: "v1" } });
      if (url.endsWith("/mcp")) {
        const body = JSON.parse(String(init?.body)) as {
          id: string;
          method: string;
          params?: { view?: string; cursor?: string };
        };
        if (body.method === "tools/list") views.push(body.params?.view);
        const result =
          body.method === "initialize"
            ? { protocolVersion: "2025-03-26", serverInfo: SERVER_INFO }
            : body.params?.cursor === undefined
              ? { tools: [pinned.tools[0]], nextCursor: "p2", _meta: METADATA }
              : { tools: [pinned.tools[1]], _meta: METADATA };
        return json({ jsonrpc: "2.0", id: body.id, result }, { "mcp-session-id": "session-1" });
      }
      return new Response("missing", { status: 404 });
    }) as typeof fetch;

    const receipt = await qualifyBoundedSetup(
      {
        directory,
        manifestPath,
        manifestSha256,
        catalogReceiptPath: path.join(directory, "catalog.json"),
        styleEvidencePath: styleJson,
        stylePngPath: stylePng,
        outputPath: path.join(directory, "receipt.json"),
        now: () => "2026-09-26T00:00:00.000Z",
      },
      {
        fetchFn,
        run: async () => ({ exitCode: 0, stdout: JSON.stringify([LOCAL_INSTALL_SERVER_IMAGE]), stderr: "" }),
      },
    );

    expect(receipt.pass).toBe(true);
    expect(views).toEqual(["setup", "setup"]);
    expect(JSON.stringify(receipt)).not.toContain(secret);
  });
});

describe("McpClient bounded inventory", () => {
  it("sends the workflow view on every page and the api key on the request", async () => {
    const seen: Array<{ view?: string; apiKey?: string | null }> = [];
    const client = new McpClient({
      baseUrl: "http://127.0.0.1:9",
      apiKey: "local-agent-credential-value",
      workflowView: "setup",
      fetchImpl: (async (_input: RequestInfo | URL, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as {
          id: string;
          method: string;
          params?: { view?: string; cursor?: string };
        };
        const headers = new Headers(init?.headers);
        if (body.method === "tools/list") seen.push({ view: body.params?.view, apiKey: headers.get("x-api-key") });
        const result =
          body.method === "initialize"
            ? { protocolVersion: "2025-03-26", serverInfo: SERVER_INFO }
            : body.params?.cursor === undefined
              ? { tools: [tool("one")], nextCursor: "p2", _meta: { view: "setup" } }
              : { tools: [tool("two")], _meta: { view: "setup" } };
        return json({ jsonrpc: "2.0", id: body.id, result });
      }) as typeof fetch,
    });
    const listing = await client.listAllTools({ view: "setup" });
    expect(listing.pages).toBe(2);
    expect(listing.metadata).toEqual({ view: "setup" });
    expect(seen).toEqual([
      { view: "setup", apiKey: "local-agent-credential-value" },
      { view: "setup", apiKey: "local-agent-credential-value" },
    ]);
    expect(() => new McpClient({ apiKey: "k", auth: { getAccessToken: async () => "t" } })).toThrow(
      /one MCP authentication/,
    );
  });
});

function json(body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json", ...headers },
  });
}

function drawnPng(width: number, height: number, options: { flat?: boolean } = {}): Uint8Array {
  const parts: Buffer[] = [Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])];
  const push = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const typed = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(typed));
    parts.push(length, typed, crc);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  push("IHDR", ihdr);
  const rows: Buffer[] = [];
  for (let row = 0; row < height; row += 1) {
    const pixels: number[] = [0];
    for (let column = 0; column < width; column += 1) {
      const shade = options.flat ? 20 : (row * 17 + column * 29) % 256;
      pixels.push(shade, options.flat ? 20 : (shade * 3) % 256, options.flat ? 20 : (shade * 5) % 256, 255);
    }
    rows.push(Buffer.from(pixels));
  }
  push("IDAT", deflateSync(Buffer.concat(rows)));
  push("IEND", Buffer.alloc(0));
  return new Uint8Array(Buffer.concat(parts));
}

function crc32(bytes: Buffer): number {
  let crc = 0xff_ff_ff_ff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = crc & 1 ? 0xed_b8_83_20 ^ (crc >>> 1) : crc >>> 1;
  }
  return (crc ^ 0xff_ff_ff_ff) >>> 0;
}
