/**
 * Security evals at the MCP tool surface (honua-sdk-js#1425, AC "Security evals
 * reject self-approval, secret disclosure, shared-admin fallback, and unbounded
 * actions").
 *
 * The SDK half of this suite lives in `test/security/` at the repository root
 * and proves the four properties through the shipped clients. This file proves
 * them at the surface an agent *actually touches*: the MCP tool catalog. A
 * guarantee that holds in `HonuaClient` and is lost in the tool schema that
 * wraps it is not a guarantee — the tool schema is what the model reads, and
 * the tool handler is what the model can reach.
 *
 * Everything here is driven over a real `McpServer` on an in-memory transport,
 * so the assertions are on the JSON Schema and the responses a client genuinely
 * receives, not on the module-level zod objects. There is no model, no network,
 * and no filesystem mutation.
 *
 * The genuine-model canary — does a real model *try* any of this, and does it
 * recover when refused — stays open on #1425. Nothing here substitutes for it.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { HonuaClient } from "@honua/sdk-js";
import { HONUA_COMMAND_IDS, createHonuaCommandRuntime } from "@honua/sdk-js/control-plane";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import { requireSecureCredentialEndpoint } from "../src/credential-endpoint.js";
import { clampLimit } from "../src/helpers.js";
import { createBootstrapServer, createServer, resolveRuntimeOptions } from "../src/index.js";
import { resolveProxyOptions } from "../src/proxy.js";
import { controlPlaneCommandToolName } from "../src/tools/control-plane-command.js";
import * as docsSearch from "../src/tools/docs-search.js";
import { asClient, createMockClient } from "./test-helpers.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

/** Connect a real MCP client to `server` over an in-memory transport pair. */
async function connected(server: ReturnType<typeof createServer>) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "security-eval", version: "1.0.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return {
    client,
    async close() {
      await client.close();
      await server.close();
    },
  };
}

/** Every property name in a JSON Schema, at every depth. */
function schemaPropertyNames(schema: unknown, found: string[] = []): string[] {
  if (typeof schema !== "object" || schema === null) return found;
  const node = schema as Record<string, unknown>;
  for (const [key, child] of Object.entries((node.properties as Record<string, unknown>) ?? {})) {
    found.push(key);
    schemaPropertyNames(child, found);
  }
  for (const key of ["items", "additionalProperties", "not"]) {
    if (node[key]) schemaPropertyNames(node[key], found);
  }
  for (const key of ["anyOf", "oneOf", "allOf"]) {
    for (const branch of (node[key] as unknown[]) ?? []) schemaPropertyNames(branch, found);
  }
  return found;
}

// ───────────────────────────────────────────────────────────────────────────
// Self-approval
// ───────────────────────────────────────────────────────────────────────────

describe("MCP security eval :: self-approval", () => {
  it("publishes no tool argument that would let a caller assert its own decision", async () => {
    // Attacker/confused agent: a model does not look for a security boundary,
    // it looks for an argument. A single `approve` or `force` field anywhere in
    // the published catalog is an invitation the model will accept, and the
    // schema is the only part of the boundary it can see.
    const session = await connected(createServer(asClient(createMockClient())));
    try {
      const catalog = await session.client.listTools();
      expect(catalog.tools.length).toBeGreaterThan(0);
      for (const tool of catalog.tools) {
        for (const name of schemaPropertyNames(tool.inputSchema)) {
          expect(
            name.toLowerCase(),
            `${tool.name}.${name} reads as an approval or policy-override argument`,
          ).not.toMatch(
            /^(approve|approved|approval|autoapprove|selfapprove|skipapproval|bypass\w*|force|policyoverride|overridepolicy)$/,
          );
        }
      }
    } finally {
      await session.close();
    }
  });

  it("publishes no mutating tool at all on the standalone surface", async () => {
    // The strongest form of "cannot self-approve" is "cannot approve". The
    // platform-free surface is read-only by construction, so there is no
    // decision for a proposer to make on it. Every published tool declares
    // itself non-destructive, and the one installer that does mutate is not
    // registered here.
    const session = await connected(createServer(asClient(createMockClient())));
    try {
      const catalog = await session.client.listTools();
      expect(catalog.tools.map((tool) => tool.name)).not.toContain("honua_admin_install_local");
      for (const tool of catalog.tools) {
        expect(tool.annotations?.destructiveHint ?? false, `${tool.name} must not be destructive`).toBe(false);
      }
    } finally {
      await session.close();
    }
  });

  it("makes the one mutating tool demand an explicit confirmation argument", async () => {
    // The bootstrap surface *does* mutate — it writes compose files and starts
    // containers. `confirm` is a literal `true`, not a boolean with a default,
    // so a model cannot reach the installer by omitting the field or by
    // guessing `false`.
    const session = await connected(createBootstrapServer());
    try {
      const catalog = await session.client.listTools();
      expect(catalog.tools.map((tool) => tool.name)).toEqual(["honua_admin_install_local"]);
      const schema = catalog.tools[0]?.inputSchema as Record<string, unknown>;
      expect((schema.required as string[]) ?? []).toContain("confirm");
      const confirm = (schema.properties as Record<string, Record<string, unknown>>).confirm;
      expect(confirm.const ?? confirm.enum).toBeDefined();

      const install = vi.spyOn(await import("../src/tools/admin-install-local.js"), "execute");
      const refusal = (await session.client.callTool({
        name: "honua_admin_install_local",
        arguments: { directory: ".honua", confirm: false },
      })) as { isError?: boolean };
      expect(refusal.isError).toBe(true);
      expect(install).not.toHaveBeenCalled();
    } finally {
      await session.close();
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Secret disclosure
// ───────────────────────────────────────────────────────────────────────────

/**
 * Credential shapes with no innocent reading in a documentation excerpt.
 *
 * Narrower than the SDK's own recognizer on purpose: that one also carries a
 * `name: value` heuristic, and documentation legitimately contains prose such
 * as "a reference, not a password: ...". See the matching table in
 * `test/security/secret-disclosure.test.ts`.
 */
const UNAMBIGUOUS_CREDENTIALS: readonly [string, RegExp][] = [
  ["PEM private key block", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["AWS access key id", /\bA(?:KIA|SIA)[0-9A-Z]{16}\b/],
  ["GitHub token", /\bgh[pousr]_[A-Za-z0-9]{20,}\b/],
  ["JSON web token", /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/],
  ["inline bearer token", /\bBearer\s+(?!<|\$\{|YOUR|your)[A-Za-z0-9._~+/=-]{20,}/],
];

describe("MCP security eval :: secret disclosure", () => {
  it("returns no credential material from honua_docs_search over the real corpus", async () => {
    // Attacker: documentation search returns *verbatim excerpts*, so a
    // credential committed anywhere in the indexed corpus becomes a tool
    // response — reachable by an agent that never opened the file, and pasted
    // into whatever transcript that agent writes. These queries deliberately
    // target the credential-adjacent documentation, where a real leak would
    // most likely sit.
    vi.stubEnv("HONUA_DOCS_CORPUS_PATH", repoRoot);
    for (const query of ["api key authentication", "admin credential secret", "token bearer authorization"]) {
      const response = (await docsSearch.execute(undefined, { query, limit: 10 })) as {
        content: { text: string }[];
      };
      const text = response.content.map((part) => part.text).join("\n");
      expect(text.length).toBeGreaterThan(0);
      for (const [name, pattern] of UNAMBIGUOUS_CREDENTIALS) {
        expect(pattern.test(text), `honua_docs_search("${query}") returned a ${name}`).toBe(false);
      }
    }
  });

  it("refuses an endpoint whose URL carries the credential before any transport is built", () => {
    // Attacker/confused agent: configures the proxy with
    // `https://user:pass@host/mcp` or `?api_key=...`, and every request the
    // proxy makes — plus every log line, every error, and every process listing
    // that shows the argv — now carries it.
    for (const bad of [
      "https://svc:s3cr3t-p4ssw0rd@mcp.example.test/mcp",
      "https://mcp.example.test/mcp?api_key=hnu_live_0123456789abcdef",
      "https://mcp.example.test/mcp#token=abc",
    ]) {
      expect(() => requireSecureCredentialEndpoint(bad, "remoteUrl"), bad).toThrow(
        /must not include embedded credentials/,
      );
    }
    // And a credentialed endpoint must be encrypted unless it is exact loopback.
    expect(() => requireSecureCredentialEndpoint("http://mcp.example.test/mcp", "remoteUrl")).toThrow(/HTTPS/);
    expect(() => requireSecureCredentialEndpoint("http://127.0.0.1:8080/mcp", "remoteUrl")).not.toThrow();
  });

  it("refuses to send an API key over unencrypted, non-loopback HTTP", () => {
    // The same rule on the direct-SDK surface: a key configured against a plain
    // http:// origin is a key on the wire in clear text.
    expect(() =>
      resolveRuntimeOptions({ HONUA_BASE_URL: "http://maps.example.test", HONUA_API_KEY: "hnu_live_abc" }),
    ).toThrow(/not allowed/);
    expect(() =>
      resolveRuntimeOptions({ HONUA_BASE_URL: "http://localhost:8080", HONUA_API_KEY: "hnu_live_abc" }),
    ).not.toThrow();
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Shared-admin fallback
// ───────────────────────────────────────────────────────────────────────────

describe("MCP security eval :: shared-admin fallback", () => {
  it("never lets the standalone surface pick up the root admin key", () => {
    // Attacker/confused agent: sets `HONUA_ADMIN_KEY` once for a `honua admin`
    // step, and every subsequent MCP tool call in that process silently runs at
    // root. The direct-SDK surface reads exactly one credential variable.
    const options = resolveRuntimeOptions({
      HONUA_BASE_URL: "https://maps.example.test",
      HONUA_ADMIN_KEY: "honua-root-admin-key-DO-NOT-SHARE-0123456789",
    });
    expect(options.apiKey).toBeUndefined();
    expect(JSON.stringify(options)).not.toContain("honua-root-admin-key");
  });

  it("refuses to guess when both an admin key and a scoped key are configured", () => {
    // The subtler failure: a precedence rule. Whichever way it resolved, half
    // the operators would be wrong about which principal their agent is acting
    // as — so the proxy refuses the ambiguous configuration outright instead of
    // silently preferring the more powerful credential.
    expect(() =>
      resolveProxyOptions({
        HONUA_MCP_REMOTE_URL: "https://mcp.example.test/mcp",
        HONUA_ADMIN_KEY: "honua-root-admin-key-DO-NOT-SHARE-0123456789",
        HONUA_API_KEY: "scoped-caller-key-9f2a",
      }),
    ).toThrow(/credential precedence is not allowed/);
  });

  it("refuses to guess between a bearer token and an API key too", () => {
    // Same rule, the other pair. Two configured schemes is a configuration bug,
    // and resolving it silently is how an agent ends up authenticated as
    // someone the operator did not intend.
    expect(() =>
      resolveProxyOptions({
        HONUA_MCP_REMOTE_URL: "https://mcp.example.test/mcp",
        HONUA_MCP_AUTH_TOKEN: "bearer-token-value",
        HONUA_API_KEY: "scoped-caller-key-9f2a",
      }),
    ).toThrow(/exactly one upstream authentication scheme/);
  });

  it("publishes no tool argument through which a caller could supply a credential", async () => {
    // Attacker: if a tool accepted an `apiKey` or `adminKey` argument, a model
    // that found one anywhere — a prompt, a file, a previous tool result —
    // would pass it, and the server would act on a credential nobody scoped.
    // Authentication is the server process's own configuration, never a tool
    // argument.
    const session = await connected(createServer(asClient(createMockClient())));
    try {
      const catalog = await session.client.listTools();
      for (const tool of catalog.tools) {
        for (const name of schemaPropertyNames(tool.inputSchema)) {
          expect(name.toLowerCase(), `${tool.name}.${name} accepts a credential`).not.toMatch(
            /^(apikey|api_key|adminkey|admin_key|authorization|bearer|token|password|secret|credential|cookie)$/,
          );
        }
      }
    } finally {
      await session.close();
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────
// The generated control-plane command tools
// ───────────────────────────────────────────────────────────────────────────

/**
 * Keys a caller must never be able to smuggle into a command's input.
 *
 * Re-declared rather than imported so this eval fails if the shipped sealed
 * schema stops covering one of them, instead of following it down.
 */
const SELF_APPROVAL_KEYS = [
  "status",
  "approve",
  "approved",
  "approvedBy",
  "autoApprove",
  "selfApprove",
  "skipApproval",
  "bypassPolicy",
  "policyOverride",
  "force",
] as const;

const COMMAND_INPUT: Readonly<Record<string, Record<string, unknown>>> = {
  "connection.test": { connectionId: "conn-1" },
  "import.create": { sourceKind: "geojson", sourceUrl: "https://data.example.test/a.geojson" },
  "map-package.publish": { package: { id: "pkg-ops", version: "1.0.0", layers: [] } },
  "studio.draft.saveVersion": { draftId: "draft-1" },
};

interface RecordedCall {
  readonly method: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string | undefined;
}

function commandRecorder(): { calls: RecordedCall[]; fetchFn: typeof fetch } {
  const calls: RecordedCall[] = [];
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    for (const [name, value] of new Headers(init?.headers).entries()) headers[name.toLowerCase()] = value;
    calls.push({
      method: init?.method ?? "GET",
      url: String(input),
      headers,
      body: typeof init?.body === "string" ? init.body : undefined,
    });
    return new Response(JSON.stringify({ packageId: "pkg-1", jobId: "job-1", ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { calls, fetchFn };
}

/** An MCP session whose server publishes the generated command tools. */
async function commandSession(fetchFn: typeof fetch) {
  const client = new HonuaClient({ baseUrl: "https://control.example.test", apiKey: "scoped-caller-key", fetchFn });
  const server = createServer(client, {
    controlPlaneCommands: {
      runtime: createHonuaCommandRuntime({ client }),
      identity: { actor: "user-1", tenantId: "acme" },
    },
  });
  return connected(server);
}

describe("MCP security eval :: the generated control-plane command tools", () => {
  it("lets a smuggled approval key reach the command's refusal instead of silently stripping it", async () => {
    // This is the whole reason the projected input object is `passthrough`. A
    // Zod object strips unknown keys by default, so the *safe-looking* choice
    // would hand an agent that sent `approvedBy` a silent success — the
    // publication proceeding as if the field had never been sent, with the
    // agent believing it had been honoured. Letting the key through to the
    // command's sealed schema is what makes MCP refuse exactly as the CLI does.
    for (const id of HONUA_COMMAND_IDS) {
      for (const key of SELF_APPROVAL_KEYS) {
        const capture = commandRecorder();
        const session = await commandSession(capture.fetchFn);
        try {
          const result = (await session.client.callTool({
            name: controlPlaneCommandToolName(id),
            arguments: { input: { ...COMMAND_INPUT[id], [key]: true } },
          })) as { isError?: boolean; content: { text: string }[] };
          expect(result.isError, `${id}/${key} must be refused`).toBe(true);
          const text = result.content.map((part) => part.text).join("\n");
          expect(text, `${id}/${key} must be refused as validation`).toMatch(/validation/i);
          expect(capture.calls, `${id}/${key} must issue no request`).toHaveLength(0);
        } finally {
          await session.close();
        }
      }
    }
  });

  it("refuses an authority or credential argument at the MCP boundary, before the command runs", async () => {
    // The other half: the *outer* object is strict, so an agent cannot dress an
    // authority claim as an invocation field. `actor`, `tenantId`, `headers`,
    // and `adminKey` are host configuration, not model input — a model-supplied
    // one would be an authority claim wearing an argument's clothes.
    for (const field of ["actor", "tenantId", "identity", "headers", "adminKey", "apiKey", "authorization"]) {
      const capture = commandRecorder();
      const session = await commandSession(capture.fetchFn);
      try {
        const result = (await session.client.callTool({
          name: controlPlaneCommandToolName("map-package.publish"),
          arguments: { input: COMMAND_INPUT["map-package.publish"], [field]: "attacker@example.test" },
        })) as { isError?: boolean };
        expect(result.isError, `${field} must be refused`).toBe(true);
        expect(capture.calls, `${field} must issue no request`).toHaveLength(0);
      } finally {
        await session.close();
      }
    }
  });

  it("publishes no identity, credential, or header argument on any generated tool", async () => {
    // A schema sweep rather than a spot check: the projection is generated, so
    // the guarantee has to hold for whatever the catalog grows into.
    const capture = commandRecorder();
    const session = await commandSession(capture.fetchFn);
    try {
      const catalog = await session.client.listTools();
      const commandTools = catalog.tools.filter((tool) => tool.name.startsWith("honua_command_"));
      expect(commandTools.length).toBe(HONUA_COMMAND_IDS.length);
      for (const tool of commandTools) {
        const top = Object.keys(((tool.inputSchema as Record<string, unknown>).properties ?? {}) as object);
        expect(top.sort(), `${tool.name} exposes only the invocation fields`).toEqual(
          ["dryRun", "idempotencyKey", "ifMatch", "input"].sort(),
        );
      }
    } finally {
      await session.close();
    }
  });

  it("runs a command on the host's own credential and stamps the receipt server-enforced", async () => {
    // Shared-admin fallback at the MCP surface: the runtime is built from the
    // host's `HonuaClient`, so the credential on the wire is the caller's own
    // and the claimed identity is echoed onto the receipt without ever
    // travelling as a header.
    const capture = commandRecorder();
    const session = await commandSession(capture.fetchFn);
    try {
      const result = (await session.client.callTool({
        name: controlPlaneCommandToolName("map-package.publish"),
        arguments: { input: COMMAND_INPUT["map-package.publish"] },
      })) as { isError?: boolean; content: { text: string }[] };
      expect(result.isError ?? false).toBe(false);
      const receipt = JSON.parse(result.content[0]?.text ?? "{}") as Record<string, unknown>;
      expect(receipt.authorization).toBe("server-enforced");
      expect(receipt.transport).toBe("mcp");

      expect(capture.calls).toHaveLength(1);
      expect(capture.calls[0]?.headers["x-api-key"]).toBe("scoped-caller-key");
      const wire = JSON.stringify(capture.calls);
      expect(wire).not.toContain("x-honua-admin-key");
      expect(wire).not.toContain("x-honua-actor");
      expect(wire).not.toContain("user-1");
    } finally {
      await session.close();
    }
  });

  it("previews without contacting the server, so a dry run cannot be mistaken for a publication", async () => {
    // An unbounded-action guard as much as an approval one: `dryRun` must never
    // reach `execute`, or an agent "just checking" would publish.
    const capture = commandRecorder();
    const session = await commandSession(capture.fetchFn);
    try {
      const result = (await session.client.callTool({
        name: controlPlaneCommandToolName("map-package.publish"),
        arguments: { input: COMMAND_INPUT["map-package.publish"], dryRun: true },
      })) as { content: { text: string }[] };
      const receipt = JSON.parse(result.content[0]?.text ?? "{}") as Record<string, unknown>;
      expect(receipt.status).toBe("dry-run");
      expect(capture.calls).toHaveLength(0);
    } finally {
      await session.close();
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Unbounded actions
// ───────────────────────────────────────────────────────────────────────────

describe("MCP security eval :: unbounded actions", () => {
  it("clamps a runaway feature limit to the published ceiling", () => {
    // Confused agent: "get me everything", so it sends `limit: 1000000`. The
    // response would not merely be slow — it would blow the model's own context
    // window, which ends the session and loses the work. The clamp is what
    // makes an over-large ask survivable.
    expect(clampLimit(1_000_000)).toBe(2_000);
    expect(clampLimit(Number.MAX_SAFE_INTEGER)).toBe(2_000);
    expect(clampLimit(Number.POSITIVE_INFINITY)).toBe(2_000);
    expect(clampLimit(0)).toBe(1);
    expect(clampLimit(-5)).toBe(1);
    expect(clampLimit(undefined)).toBe(100);
  });

  it("drives the clamp through the published query tool, not just the helper", async () => {
    // A helper nobody calls is not a bound. This asserts the clamped value is
    // what the SDK query actually receives when a tool call asks for a million
    // features.
    const mock = createMockClient();
    const session = await connected(createServer(asClient(mock)));
    try {
      await session.client.callTool({
        name: "honua_query_features",
        arguments: { serviceId: "Parks", layerId: 0, limit: 1_000_000 },
      });
      const calls = (mock.queryFeatures as unknown as { mock: { calls: unknown[][] } }).mock.calls;
      expect(calls.length).toBeGreaterThan(0);
      const query = calls.at(-1)?.find((argument) => typeof argument === "object" && argument !== null) as
        | Record<string, unknown>
        | undefined;
      expect(JSON.stringify(query)).not.toContain("1000000");
    } finally {
      await session.close();
    }
  });

  it("caps how many documents a single documentation search can return", async () => {
    // Attacker/confused agent: `limit: 10000` on a corpus search returns the
    // whole corpus as one tool result. The schema ceiling is what stops a
    // retrieval tool from becoming a context-window denial of service.
    const session = await connected(createServer(asClient(createMockClient())));
    try {
      const catalog = await session.client.listTools();
      const tool = catalog.tools.find((entry) => entry.name === "honua_docs_search");
      const limit = (tool?.inputSchema as Record<string, Record<string, Record<string, unknown>>>).properties?.limit;
      expect(limit?.maximum).toBe(10);

      const refusal = (await session.client.callTool({
        name: "honua_docs_search",
        arguments: { query: "capability error", limit: 10_000 },
      })) as { isError?: boolean };
      expect(refusal.isError).toBe(true);
    } finally {
      await session.close();
    }
  });

  it("bounds the readiness wait on the one long-running tool", async () => {
    // The installer waits for Docker containers to come up. Without a ceiling
    // an agent told to "install Honua" would sit on a hung pull indefinitely;
    // without a floor it would declare failure before anything could start.
    const session = await connected(createBootstrapServer());
    try {
      const catalog = await session.client.listTools();
      const schema = catalog.tools[0]?.inputSchema as Record<string, Record<string, Record<string, unknown>>>;
      expect(schema.properties?.timeoutMs?.maximum).toBe(600_000);
      expect(schema.properties?.timeoutMs?.minimum).toBe(1_000);

      const refusal = (await session.client.callTool({
        name: "honua_admin_install_local",
        arguments: { directory: ".honua", confirm: true, timeoutMs: 86_400_000 },
      })) as { isError?: boolean };
      expect(refusal.isError).toBe(true);
    } finally {
      await session.close();
    }
  });

  it("keeps the shipped documentation corpus credential-free at the file level", () => {
    // Belt to the excerpt scan's braces: every possible excerpt is clean if the
    // corpus is, and no per-query test can enumerate every possible excerpt.
    for (const file of ["llms.txt", "llms-full.txt"]) {
      const text = readFileSync(path.join(repoRoot, file), "utf8");
      for (const [name, pattern] of UNAMBIGUOUS_CREDENTIALS) {
        expect(pattern.test(text), `${file} contains a ${name}`).toBe(false);
      }
    }
  });
});
