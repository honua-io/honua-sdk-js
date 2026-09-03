import { mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { run } from "../src/cli/main.js";
import { writePrivateFileAtomic } from "../src/private-file.js";

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

const ADMIN_SECRET_CASES = [
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
    rollbackPath: "/api-keys/11111111-1111-4111-8111-111111111111/revoke",
    recoveryPreferred: false,
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
    rollbackPath: null,
    recoveryPreferred: true,
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
    rollbackPath: "/oauth-clients/22222222-2222-4222-8222-222222222222",
    recoveryPreferred: false,
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
    rollbackPath: "/embed/keys/33333333-3333-4333-8333-333333333333/revoke",
    recoveryPreferred: false,
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
    rollbackPath: null,
    recoveryPreferred: true,
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
    rollbackPath: null,
    recoveryPreferred: true,
  },
] as const;

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

  it("accepts content-type and preserves path/query identifiers as strings", async () => {
    const output = capture();
    expect(
      await run([
        "admin",
        "api",
        "getConnection",
        "--content-type",
        "application/json",
        "--path",
        "id=00123",
        "--query",
        "runId=1e3",
        "--dry-run",
        "--json",
      ]),
    ).toBe(0);
    expect(JSON.parse(output.join(""))).toMatchObject({ request: { path: { id: "00123" }, query: { runId: "1e3" } } });
  });

  it("deep-redacts credential-bearing dry-run headers, query values, and bodies", async () => {
    const output = capture();
    const secrets = ["bearer-secret", "cookie-secret", "query-secret", "body-secret", "nested-secret"];
    const code = await run([
      "admin",
      "connect",
      "createConnection",
      "--header",
      "Authorization=Bearer bearer-secret",
      "--header",
      "Cookie=honua-admin-auth-session=cookie-secret",
      "--query",
      "accessToken=query-secret",
      "--body",
      '{"name":"local","password":"body-secret","nested":{"clientSecret":"nested-secret"},"secretReference":"vault://connection"}',
      "--dry-run",
      "--json",
    ]);
    expect(code).toBe(0);
    const rendered = output.join("");
    for (const secret of secrets) expect(rendered).not.toContain(secret);
    expect(JSON.parse(rendered)).toMatchObject({
      request: {
        headers: { Authorization: "[REDACTED]", Cookie: "[REDACTED]" },
        query: { accessToken: "[REDACTED]" },
        body: {
          name: "local",
          password: "[REDACTED]",
          nested: { clientSecret: "[REDACTED]" },
          secretReference: "vault://connection",
        },
      },
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

  it.each(ADMIN_SECRET_CASES)(
    "writes $operationId material only to an explicit new private sink",
    async ({ operationId, secret, response }) => {
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
          operationId === "createAdminApiKey" ||
          operationId === "registerOAuthClient" ||
          operationId === "createEmbedKey"
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
    },
  );

  it("rolls back issuance when the prepared one-time sink pathname is substituted", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "honua-admin-secret-substitution-"));
    const secretOutput = path.join(directory, "credential");
    const stolen = path.join(directory, "stolen.tmp");
    const output = capture();
    let issued = false;
    const fetchFn = vi.fn(async () => {
      if (!issued) {
        issued = true;
        const temporary = readdirSync(directory).find(
          (name) => name.startsWith(".credential.") && name.endsWith(".tmp"),
        );
        if (!temporary) throw new Error("prepared sink temp was not found");
        const temporaryPath = path.join(directory, temporary);
        renameSync(temporaryPath, stolen);
        await writePrivateFileAtomic(temporaryPath, "attacker-substitution");
        return new Response(JSON.stringify(ADMIN_SECRET_CASES[0].response), {
          status: 201,
          headers: { "content-type": "application/json" },
        });
      }
      return Response.json({ success: true, data: { status: "revoked" } });
    });
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
          "--secret-output",
          secretOutput,
        ]),
        output.join(""),
      ).toBe(2);
      expect(fetchFn).toHaveBeenCalledTimes(2);
      expect(output.join("")).not.toContain(ADMIN_SECRET_CASES[0].secret);
      expect(readFileSync(stolen).includes(Buffer.from(ADMIN_SECRET_CASES[0].secret))).toBe(false);
      expect(readdirSync(directory)).not.toContain("credential");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it.each(ADMIN_SECRET_CASES)(
    "recovers or rolls back $operationId when the requested sink is raced after issuance",
    async ({ operationId, secret, response, rollbackPath, recoveryPreferred }) => {
      const directory = mkdtempSync(path.join(tmpdir(), "honua-admin-secret-race-"));
      const secretOutput = path.join(directory, "credential");
      const output = capture();
      let issued = false;
      const fetchFn = vi.fn(async (_input: string | URL | Request) => {
        if (!issued) {
          issued = true;
          writeFileSync(secretOutput, "racer", "utf8");
          return new Response(JSON.stringify(response), {
            status: operationId.startsWith("create") || operationId === "registerOAuthClient" ? 201 : 200,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response(JSON.stringify({ success: true, data: {} }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      });
      vi.stubGlobal("fetch", fetchFn);
      try {
        const pathArgs =
          operationId === "rotateAdminApiKey"
            ? ["--path", "id=11111111-1111-4111-8111-111111111111"]
            : operationId === "rotateEmbedKey"
              ? ["--path", "id=33333333-3333-4333-8333-333333333333"]
              : [];
        const bodyArgs =
          operationId === "createAdminApiKey" ||
          operationId === "registerOAuthClient" ||
          operationId === "createEmbedKey"
            ? ["--body", "{}"]
            : [];
        expect(
          await run([
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
          ]),
          output.join(""),
        ).toBe(2);
        expect(readFileSync(secretOutput, "utf8")).toBe("racer");
        const rendered = output.join("");
        expect(rendered).not.toContain(secret);
        const recoveryFiles = readdirSync(directory).filter((name) => name.endsWith(".tmp"));
        if (recoveryPreferred) {
          expect(fetchFn).toHaveBeenCalledTimes(1);
          expect(recoveryFiles).toHaveLength(1);
          const recoveryPath = path.join(directory, recoveryFiles[0]!);
          expect(readFileSync(recoveryPath, "utf8")).toBe(secret);
          if (process.platform !== "win32") expect(statSync(recoveryPath).mode & 0o777).toBe(0o600);
          expect(rendered).toContain("verified private recovery file");
          expect(rendered).toContain(recoveryPath);
        } else {
          expect(fetchFn).toHaveBeenCalledTimes(2);
          expect(recoveryFiles).toHaveLength(0);
          expect(rendered).toContain("was rolled back");
          const rollbackCall = fetchFn.mock.calls[1]?.[0];
          const rollbackUrl = rollbackCall instanceof Request ? rollbackCall.url : String(rollbackCall);
          expect(rollbackUrl).toContain(rollbackPath);
        }
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );

  it("reports a scrubbed combined failure and retains recovery material when rollback fails", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "honua-admin-secret-rollback-failure-"));
    const secretOutput = path.join(directory, "credential");
    const output = capture();
    let issued = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        if (!issued) {
          issued = true;
          writeFileSync(secretOutput, "racer", "utf8");
          return new Response(JSON.stringify(ADMIN_SECRET_CASES[0].response), {
            status: 201,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response(JSON.stringify({ message: "rollback-server-secret" }), {
          status: 500,
          headers: { "content-type": "application/json" },
        });
      }),
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
          secretOutput,
        ]),
      ).toBe(2);
      const rendered = output.join("");
      expect(rendered).toContain("persistence and compensating rollback both failed");
      expect(rendered).not.toContain("rollback-server-secret");
      expect(rendered).not.toContain(ADMIN_SECRET_CASES[0].secret);
      const recoveryFiles = readdirSync(directory).filter((name) => name.endsWith(".tmp"));
      expect(recoveryFiles).toHaveLength(1);
      expect(readFileSync(path.join(directory, recoveryFiles[0]!), "utf8")).toBe(ADMIN_SECRET_CASES[0].secret);
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
