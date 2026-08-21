import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { run } from "../src/cli/main.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function capture() {
  const output: string[] = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    output.push(String(chunk));
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    output.push(String(chunk));
    return true;
  });
  return output;
}

describe("honua admin", () => {
  it("lists the generated operation inventory without contacting a server", async () => {
    const output = capture();
    expect(await run(["admin", "operations", "connect"])).toBe(0);
    const parsed = JSON.parse(output.join("")) as Array<{ operationId: string; group: string }>;
    expect(parsed.length).toBeGreaterThan(0);
    expect(parsed.every((entry) => entry.group === "connect")).toBe(true);
    expect(parsed.some((entry) => entry.operationId === "createConnection")).toBe(true);
  });

  it("prints a deterministic dry-run for a mutating grouped operation", async () => {
    const output = capture();
    const code = await run([
      "admin",
      "connect",
      "createConnection",
      "--body",
      '{"name":"local"}',
      "--dry-run",
      "--json",
    ]);
    expect(code).toBe(0);
    expect(JSON.parse(output.join(""))).toMatchObject({
      operationId: "createConnection",
      method: "POST",
      executed: false,
      request: { body: { name: "local" } },
    });
  });

  it("requires --yes before a mutating request", async () => {
    const output = capture();
    const code = await run([
      "admin",
      "api",
      "createConnection",
      "--base-url",
      "https://example.test",
      "--body",
      '{"name":"local"}',
    ]);
    expect(code).toBe(2);
    expect(output.join("")).toContain("--yes");
  });

  it("rejects a grouped spelling when the operation belongs elsewhere", async () => {
    const output = capture();
    expect(await run(["admin", "secure", "createConnection", "--dry-run"])).toBe(2);
    expect(output.join("")).toContain("belongs to the connect group");
  });

  it.each([
    {
      operationId: "createAdminApiKey",
      secret: "hnua_create-secret",
      response: {
        success: true,
        data: {
          apiKey: {
            id: "11111111-1111-4111-8111-111111111111",
            name: "release-agent",
            keyPrefix: "hnua_create",
            permissions: ["admin:read", "admin:write"],
            status: "active",
          },
          key: "hnua_create-secret",
        },
      },
    },
    {
      operationId: "rotateAdminApiKey",
      secret: "hnua_rotate-secret",
      response: {
        success: true,
        data: {
          apiKey: {
            id: "11111111-1111-4111-8111-111111111111",
            name: "release-agent",
            keyPrefix: "hnua_rotate",
            permissions: ["admin:read", "admin:write"],
            status: "active",
          },
          key: "hnua_rotate-secret",
        },
      },
    },
    {
      operationId: "registerOAuthClient",
      secret: "oauth-client-secret",
      response: {
        success: true,
        data: {
          client: {
            id: "22222222-2222-4222-8222-222222222222",
            clientId: "release-client",
            name: "Release client",
            clientType: "confidential",
            allowedScopes: ["admin:read"],
            status: "active",
          },
          clientSecret: "oauth-client-secret",
        },
      },
    },
    {
      operationId: "createEmbedKey",
      secret: "embed-create-secret",
      response: {
        success: true,
        data: {
          embedKey: {
            id: "33333333-3333-4333-8333-333333333333",
            name: "Public map",
            keyPrefix: "embed_create",
            status: "active",
            scope: { allowedContentIds: ["map-1"], allowedEmbedOrigins: ["https://example.test"] },
          },
          key: "embed-create-secret",
        },
      },
    },
    {
      operationId: "rotateEmbedKey",
      secret: "embed-rotate-secret",
      response: {
        success: true,
        data: {
          embedKey: {
            id: "33333333-3333-4333-8333-333333333333",
            name: "Public map",
            keyPrefix: "embed_rotate",
            status: "active",
            scope: { allowedContentIds: ["map-1"], allowedEmbedOrigins: ["https://example.test"] },
          },
          key: "embed-rotate-secret",
        },
      },
    },
    {
      operationId: "issueAdminOperatorBearer",
      secret: "operator-bearer-secret",
      response: {
        accessToken: "operator-bearer-secret",
        tokenType: "Bearer",
        expiresIn: 300,
        expiresAt: "2026-08-20T12:05:00Z",
      },
    },
  ])("writes $operationId material only to an explicit new private sink", async ({ operationId, secret, response }) => {
    const directory = mkdtempSync(path.join(tmpdir(), "honua-admin-secret-"));
    const secretOutput = path.join(directory, "credential");
    const output = capture();
    const fetchFn = vi.fn(
      async () =>
        new Response(JSON.stringify(response), {
          status: operationId.startsWith("create") || operationId === "registerOAuthClient" ? 201 : 200,
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchFn);
    try {
      const pathArgs =
        operationId === "rotateAdminApiKey" || operationId === "rotateEmbedKey"
          ? ["--path", "id=11111111-1111-4111-8111-111111111111"]
          : [];
      const bodyArgs =
        operationId === "createAdminApiKey" || operationId === "registerOAuthClient" || operationId === "createEmbedKey"
          ? ["--body", "{}"]
          : [];
      const code = await run([
        "admin",
        "api",
        operationId,
        "--base-url",
        "https://example.test",
        "--admin-key",
        "root",
        ...pathArgs,
        ...bodyArgs,
        "--yes",
        "--secret-output",
        secretOutput,
        "--json",
      ]);
      expect(code, output.join("")).toBe(0);
      expect(readFileSync(secretOutput, "utf8")).toBe(secret);
      const sinkStat = statSync(secretOutput);
      expect(sinkStat.isFile()).toBe(true);
      if (process.platform !== "win32") expect(sinkStat.mode & 0o777).toBe(0o600);
      const rendered = output.join("");
      expect(rendered).not.toContain(secret);
      expect(JSON.parse(rendered)).toMatchObject({ operationId, secretWritten: true, secretOutput });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("fails before the request without a sink and refuses an existing sink", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "honua-admin-secret-refusal-"));
    const existing = path.join(directory, "existing");
    writeFileSync(existing, "preserve", "utf8");
    const output = capture();
    const fetchFn = vi.fn();
    vi.stubGlobal("fetch", fetchFn);
    try {
      expect(
        await run([
          "admin",
          "api",
          "createAdminApiKey",
          "--base-url",
          "https://example.test",
          "--admin-key",
          "root",
          "--body",
          "{}",
          "--yes",
        ]),
      ).toBe(2);
      expect(
        await run([
          "admin",
          "api",
          "createAdminApiKey",
          "--base-url",
          "https://example.test",
          "--admin-key",
          "root",
          "--body",
          "{}",
          "--yes",
          "--secret-output",
          existing,
        ]),
      ).toBe(2);
      expect(fetchFn).not.toHaveBeenCalled();
      expect(readFileSync(existing, "utf8")).toBe("preserve");
      expect(output.join("")).not.toContain("preserve");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("suppresses a server error body for a one-time-secret operation", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "honua-admin-secret-error-"));
    const output = capture();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ message: "do not print server-secret-value" }), {
            status: 500,
            headers: { "content-type": "application/json" },
          }),
      ),
    );
    try {
      expect(
        await run([
          "admin",
          "api",
          "createAdminApiKey",
          "--base-url",
          "https://example.test",
          "--admin-key",
          "root",
          "--body",
          "{}",
          "--yes",
          "--secret-output",
          path.join(directory, "credential"),
        ]),
      ).toBe(1);
      expect(output.join("")).not.toContain("server-secret-value");
      expect(output.join("")).toContain("server details were suppressed");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("returns only public OAuth client metadata when no client secret is issued", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "honua-admin-public-oauth-"));
    const secretOutput = path.join(directory, "credential");
    const output = capture();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              success: true,
              data: {
                client: {
                  id: "22222222-2222-4222-8222-222222222222",
                  clientId: "public-release-client",
                  name: "Public release client",
                  clientType: "public",
                  allowedScopes: ["admin:read"],
                  status: "active",
                },
                clientSecret: null,
              },
            }),
            { status: 201, headers: { "content-type": "application/json" } },
          ),
      ),
    );
    try {
      expect(
        await run([
          "admin",
          "api",
          "registerOAuthClient",
          "--base-url",
          "https://example.test",
          "--admin-key",
          "root",
          "--body",
          "{}",
          "--yes",
          "--secret-output",
          secretOutput,
          "--json",
        ]),
      ).toBe(0);
      expect(() => statSync(secretOutput)).toThrow();
      expect(JSON.parse(output.join(""))).toMatchObject({
        operationId: "registerOAuthClient",
        secretWritten: false,
        secretOutput,
        resource: {
          id: "22222222-2222-4222-8222-222222222222",
          clientId: "public-release-client",
          clientType: "public",
          allowedScopes: ["admin:read"],
        },
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
