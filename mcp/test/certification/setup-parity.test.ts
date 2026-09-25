import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it, vi } from "vitest";
import {
  type SetupCatalogManifest,
  type SetupCatalogSnapshot,
  certifySetupCatalogParity,
  parseSetupCatalogManifest,
  readSetupCatalog,
} from "../../src/certification/setup-parity.js";

const digest = "a".repeat(64);
const tool: Tool = {
  name: "honua_get_style",
  description: "Server-authored descriptor",
  inputSchema: { type: "object", properties: { layerId: { type: "integer" } }, required: ["layerId"] },
  outputSchema: { type: "object", properties: { style: { type: "object" } } },
  annotations: { readOnlyHint: true },
  _meta: { "honua.studio": { view: "setup", revision: "setup.v2" } },
};

function manifest(): SetupCatalogManifest {
  return {
    schemaVersion: "honua.setup-catalog-manifest/v1",
    candidateId: `manifest-sha256:${digest}`,
    serverImage: `ghcr.io/honua-io/honua-server@sha256:${digest}`,
    packages: [
      {
        name: "@honua/mcp-server",
        version: "0.1.10-beta.0",
        integrity: `sha512-${Buffer.alloc(64).toString("base64")}`,
      },
    ],
    serverInfo: { name: "honua", version: "2026.1" },
    view: "setup",
    revision: "setup.v2",
    revisionDigest: `sha256:${digest}`,
    membershipDigest: `sha256:${digest}`,
    descriptorDigest: `sha256:${digest}`,
    tools: [structuredClone(tool)],
  };
}

function snapshot(pin: SetupCatalogManifest): SetupCatalogSnapshot {
  return {
    tools: structuredClone(pin.tools),
    serverInfo: pin.serverInfo,
    metadata: {
      view: pin.view,
      revision: pin.revision,
      revisionDigest: pin.revisionDigest,
      membershipDigest: pin.membershipDigest,
      descriptorDigest: pin.descriptorDigest,
      toolCount: pin.tools.length,
    },
  };
}

describe("bounded setup catalog qualification", () => {
  it("qualifies exactly the enabled manifest without requiring a full Admin roster", () => {
    const pin = manifest();
    const receipt = certifySetupCatalogParity(pin, digest, snapshot(pin), snapshot(pin));
    expect(receipt).toMatchObject({ pass: true, scope: "catalog-parity-only", expectedTools: 1, differences: [] });
    expect(receipt.directDescriptorSha256).toBe(receipt.proxiedDescriptorSha256);
  });

  it.each(["inputSchema", "outputSchema", "annotations", "_meta", "description"] as const)(
    "fails when the stdio proxy changes %s",
    (key) => {
      const pin = manifest();
      const proxied = snapshot(pin);
      delete proxied.tools[0][key];
      const receipt = certifySetupCatalogParity(pin, digest, snapshot(pin), proxied);
      expect(receipt.pass).toBe(false);
      expect(receipt.differences).toContain("stdio: honua_get_style descriptor differs from the pin");
    },
  );

  it("fails equal HTTP/stdio drift from the independent server pin", () => {
    const pin = manifest();
    const changed = snapshot(pin);
    changed.tools[0].annotations = { readOnlyHint: false };
    const receipt = certifySetupCatalogParity(pin, digest, changed, changed);
    expect(receipt.pass).toBe(false);
    expect(receipt.differences).toHaveLength(2);
  });

  it("reports missing, unexpected and duplicate tools without confusing them with pagination", () => {
    const pin = manifest();
    const changed = snapshot(pin);
    changed.tools = [
      { ...tool, name: "other" },
      { ...tool, name: "other" },
    ];
    const receipt = certifySetupCatalogParity(pin, digest, changed, snapshot(pin));
    expect(receipt.differences).toEqual(
      expect.arrayContaining([
        "HTTP: duplicate tool names",
        "HTTP: missing enabled tool honua_get_style; check candidate view and effective permissions",
        "HTTP: unexpected tool other",
      ]),
    );
  });

  it.each(["view", "revision", "revisionDigest", "membershipDigest", "descriptorDigest", "toolCount"])(
    "fails stale server %s metadata",
    (key) => {
      const pin = manifest();
      const changed = snapshot(pin);
      changed.metadata[key] = "wrong";
      expect(certifySetupCatalogParity(pin, digest, changed, snapshot(pin)).pass).toBe(false);
    },
  );

  it("fails a different initialized server", () => {
    const pin = manifest();
    const changed = snapshot(pin);
    changed.serverInfo = { name: "another", version: "2026.1" };
    expect(certifySetupCatalogParity(pin, digest, snapshot(pin), changed).differences).toContain(
      "stdio: server identity differs from the pin",
    );
  });

  it("does not copy descriptor text or metadata into redacted receipts", () => {
    const pin = manifest();
    const changed = snapshot(pin);
    changed.tools[0].description = "private-upstream-detail";
    changed.metadata.unexpected = "private-upstream-detail";
    expect(JSON.stringify(certifySetupCatalogParity(pin, digest, snapshot(pin), changed))).not.toContain(
      "private-upstream-detail",
    );
  });
});

describe("pinned server manifest", () => {
  function parse(value: unknown) {
    const bytes = JSON.stringify(value);
    return parseSetupCatalogManifest(bytes, createHash("sha256").update(bytes).digest("hex"));
  }

  it("requires a digest supplied independently of the captured manifest", () => {
    expect(() => parseSetupCatalogManifest(JSON.stringify(manifest()), digest)).toThrow("independently pinned");
    expect(parse(manifest())).toEqual(manifest());
  });

  it.each([
    { serverImage: "ghcr.io/honua-io/honua-server:nightly" },
    { packages: [] },
    { packages: [{ name: "@honua/mcp-server", version: "latest", integrity: "missing" }] },
    { view: "full" },
    { revisionDigest: "unknown" },
    { revisionDigest: digest },
    { membershipDigest: `sha512:${digest}` },
    { descriptorDigest: `sha256:${digest.slice(1)}` },
    { tools: [] },
    { tools: [tool, tool] },
    { tools: [{ name: "bad" }] },
    { serverInfo: {} },
  ])("rejects unqualified input %j", (patch) => {
    expect(() => parse({ ...manifest(), ...patch })).toThrow();
  });
});

describe("complete view inventory", () => {
  it("sends the same view on all pages and retains metadata", async () => {
    const pin = manifest();
    const meta = snapshot(pin).metadata;
    const listTools = vi
      .fn()
      .mockResolvedValueOnce({ tools: [tool], nextCursor: "second", _meta: meta })
      .mockResolvedValueOnce({ tools: [{ ...tool, name: "second" }], _meta: meta });
    const result = await readSetupCatalog({ listTools, getServerVersion: () => pin.serverInfo }, "setup");
    expect(listTools.mock.calls).toEqual([[{ view: "setup" }], [{ view: "setup", cursor: "second" }]]);
    expect(result.tools).toHaveLength(2);
    expect(result.metadata).toEqual(meta);
  });

  it("rejects revision changes between pages", async () => {
    const meta = snapshot(manifest()).metadata;
    const listTools = vi
      .fn()
      .mockResolvedValueOnce({ tools: [tool], nextCursor: "second", _meta: meta })
      .mockResolvedValueOnce({ tools: [tool], _meta: { ...meta, revision: "changed" } });
    await expect(readSetupCatalog({ listTools, getServerVersion: () => ({}) }, "setup")).rejects.toThrow(
      "changed view metadata",
    );
  });

  it("rejects missing metadata and cursor loops", async () => {
    await expect(
      readSetupCatalog({ listTools: async () => ({ tools: [tool] }), getServerVersion: () => ({}) }, "setup"),
    ).rejects.toThrow("omitted");
    await expect(
      readSetupCatalog(
        {
          listTools: async () => ({ tools: [tool], nextCursor: "loop", _meta: snapshot(manifest()).metadata }),
          getServerVersion: () => ({}),
        },
        "setup",
      ),
    ).rejects.toThrow("repeated cursor");
  });
});

it("runs direct HTTP and a real stdio child against a paginated bounded server", async () => {
  const pin = manifest();
  pin.tools.push({ ...tool, name: "honua_render_map" });
  const requests: { method: string; params?: { view?: string; cursor?: string } }[] = [];
  const directory = await mkdtemp(path.join(tmpdir(), "setup-parity-"));
  const server = createServer(async (req, res) => {
    if (req.method !== "POST") {
      res.writeHead(405).end();
      return;
    }
    if (req.headers.authorization !== "Bearer private-test-token") {
      res.writeHead(401).end();
      return;
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const request = JSON.parse(Buffer.concat(chunks).toString());
    requests.push(request);
    if (request.id === undefined) {
      res.writeHead(202).end();
      return;
    }
    const result =
      request.method === "initialize"
        ? { protocolVersion: "2025-03-26", serverInfo: pin.serverInfo, capabilities: { tools: {} } }
        : {
            tools: [pin.tools[request.params?.cursor ? 1 : 0]],
            ...(request.params?.cursor ? {} : { nextCursor: "next" }),
            _meta: snapshot(pin).metadata,
          };
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const manifestPath = path.join(directory, "manifest.json");
    const outputPath = path.join(directory, "receipt.json");
    const bytes = JSON.stringify(pin);
    await writeFile(manifestPath, bytes);
    const child = spawn(
      process.execPath,
      [
        "dist/src/certification/setup-parity.js",
        manifestPath,
        createHash("sha256").update(bytes).digest("hex"),
        outputPath,
      ],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          HONUA_MCP_REMOTE_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`,
          HONUA_MCP_AUTH_TOKEN: "private-test-token",
          HONUA_API_KEY: "",
          HONUA_ADMIN_KEY: "",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let output = "";
    child.stdout.on("data", (data) => {
      output += data;
    });
    child.stderr.on("data", (data) => {
      output += data;
    });
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      child.on("error", reject);
      child.on("close", resolve);
    });
    expect(output).not.toContain("private-test-token");
    expect(exitCode, output).toBe(0);
    const receipt = JSON.parse(await readFile(outputPath, "utf8"));
    expect(receipt).toMatchObject({ pass: true, directTools: 2, proxiedTools: 2 });
    expect(requests.filter((request) => request.method === "tools/list").map((request) => request.params)).toEqual([
      { view: "setup" },
      { view: "setup", cursor: "next" },
      { view: "setup" },
      { view: "setup", cursor: "next" },
    ]);
    expect(
      requests.every((request) => ["initialize", "notifications/initialized", "tools/list"].includes(request.method)),
    ).toBe(true);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
