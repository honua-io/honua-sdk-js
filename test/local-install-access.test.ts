import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/control-plane/generated/admin-operations.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/control-plane/generated/admin-operations.js")>()),
  ADMIN_RELEASE_CONTRACT_COMPATIBLE: true,
  ADMIN_RELEASE_OPERATION_COUNT: 396,
  ADMIN_RELEASE_CONTRACT_STATUS: "compatible",
}));

import { installHonuaLocal } from "../src/local-install.js";

const cleanup: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of cleanup.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("local installer access handoff", () => {
  it("keeps material file-bound and returns exact secret-free identity and grant evidence", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "honua-local-access-"));
    cleanup.push(directory);
    const material = "hnua_one-time-material-that-must-not-enter-the-receipt";
    const credentialId = "11111111-1111-4111-8111-111111111111";
    const grants = ["admin:read", "admin:write"];
    const fetchFn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      if (url.pathname === "/healthz/ready") return new Response("ready", { status: 200 });
      if (url.pathname === "/api/v1/admin/api-keys" && init?.method === "POST") {
        return jsonResponse(
          {
            success: true,
            data: {
              apiKey: { id: credentialId, name: "honua-local-agent", permissions: grants, status: "active" },
              key: material,
            },
          },
          201,
        );
      }
      if (url.pathname === "/api/v1/admin/api-keys" && init?.method === "GET") {
        return jsonResponse({
          success: true,
          data: [
            {
              id: credentialId,
              name: "honua-local-agent",
              keyPrefix: material.slice(0, 12),
              permissions: grants,
              status: "active",
            },
          ],
        });
      }
      if (url.pathname === `/api/v1/admin/api-keys/${credentialId}/effective-permissions`) {
        return jsonResponse({
          success: true,
          data: {
            id: credentialId,
            name: "honua-local-agent",
            permissions: grants,
            status: "active",
            canAuthenticate: true,
          },
        });
      }
      throw new Error(`unexpected request ${init?.method ?? "GET"} ${url.pathname}`);
    });
    const result = await installHonuaLocal(
      { directory, profile: "gp-dev", timeoutMs: 1_000 },
      {
        fetchFn,
        randomSecret: (bytes) => `generated-${bytes}`,
        run: async () => ({ exitCode: 0, stdout: "ok", stderr: "" }),
        wait: async () => undefined,
      },
    );

    expect(result.accessCredential).toEqual({
      id: credentialId,
      name: "honua-local-agent",
      status: "active",
      requestedGrants: grants,
      effectiveGrants: grants,
      canAuthenticate: true,
      referenceType: "private-env-file",
      referenceDigestSha256: createHash("sha256")
        .update(`file:${path.join(directory, ".env")}#HONUA_ADMIN_KEY`, "utf8")
        .digest("hex"),
      provisioned: true,
    });
    expect(JSON.stringify(result)).not.toContain(material);
    expect(readFileSync(result.envFile, "utf8")).toContain(`HONUA_ADMIN_KEY=${material}`);
    expect(readFileSync(result.mcpConfigFile, "utf8")).toContain(material);
    if (process.platform !== "win32") {
      expect(statSync(result.envFile).mode & 0o777).toBe(0o600);
      expect(statSync(result.mcpConfigFile).mode & 0o777).toBe(0o600);
    }
    const reused = await installHonuaLocal(
      { directory, profile: "gp-dev", timeoutMs: 1_000 },
      {
        fetchFn,
        randomSecret: (bytes) => `unused-${bytes}`,
        run: async () => ({ exitCode: 0, stdout: "ok", stderr: "" }),
        wait: async () => undefined,
      },
    );
    expect(reused.accessCredential).toEqual({ ...result.accessCredential, provisioned: false });
    expect(JSON.stringify(reused)).not.toContain(material);
    expect(fetchFn).toHaveBeenCalledTimes(6);
    expect(fetchFn.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  });

  it("fails closed instead of reusing a broader existing local-agent credential", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "honua-local-access-scope-"));
    cleanup.push(directory);
    const material = "hnua_existing-material-that-must-not-enter-the-error";
    const envFile = path.join(directory, ".env");
    writeFileSync(
      envFile,
      [
        "HONUA_SERVER_IMAGE=example.invalid/honua@sha256:1234",
        "HONUA_HTTP_PORT=8080",
        "POSTGRES_PASSWORD=postgres",
        "HONUA_ADMIN_PASSWORD=root",
        "HONUA_CONNECTION_ENCRYPTION_MASTER_KEY=master",
        `HONUA_ADMIN_KEY=${material}`,
        "",
      ].join("\n"),
      "utf8",
    );
    const fetchFn = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      if (url.pathname === "/healthz/ready") return new Response("ready", { status: 200 });
      if (url.pathname === "/api/v1/admin/api-keys") {
        return jsonResponse({
          success: true,
          data: [
            {
              id: "11111111-1111-4111-8111-111111111111",
              name: "honua-local-agent",
              keyPrefix: material.slice(0, 12),
              permissions: ["admin:approve", "admin:read", "admin:write"],
              status: "active",
            },
          ],
        });
      }
      throw new Error(`unexpected request ${url.pathname}`);
    });

    await expect(
      installHonuaLocal(
        { directory, profile: "gp-dev", timeoutMs: 1_000 },
        {
          fetchFn,
          randomSecret: (bytes) => `unused-${bytes}`,
          run: async () => ({ exitCode: 0, stdout: "ok", stderr: "" }),
          wait: async () => undefined,
        },
      ),
    ).rejects.toThrow("exactly one active local-agent identity");
  });

  it.each(["effective-permissions failure", "broader effective grants"])(
    "revokes a newly issued key after %s",
    async (failure) => {
      const directory = mkdtempSync(path.join(tmpdir(), "honua-local-access-rollback-"));
      cleanup.push(directory);
      const credentialId = "22222222-2222-4222-8222-222222222222";
      const material = "hnua_orphan-prevention-material";
      let revoked = 0;
      const fetchFn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(input instanceof Request ? input.url : input.toString());
        if (url.pathname === "/healthz/ready") return new Response("ready", { status: 200 });
        if (url.pathname === "/api/v1/admin/api-keys" && init?.method === "POST") {
          return jsonResponse(
            {
              success: true,
              data: {
                apiKey: {
                  id: credentialId,
                  name: "honua-local-agent",
                  permissions: ["admin:read", "admin:write"],
                  status: "active",
                },
                key: material,
              },
            },
            201,
          );
        }
        if (url.pathname === `/api/v1/admin/api-keys/${credentialId}/effective-permissions`) {
          if (failure === "effective-permissions failure") {
            return jsonResponse({ title: "Unavailable", status: 503 }, 503);
          }
          return jsonResponse({
            success: true,
            data: {
              id: credentialId,
              name: "honua-local-agent",
              permissions: ["admin:approve", "admin:read", "admin:write"],
              status: "active",
              canAuthenticate: true,
            },
          });
        }
        if (url.pathname === `/api/v1/admin/api-keys/${credentialId}/revoke` && init?.method === "POST") {
          revoked += 1;
          return jsonResponse({ success: true, data: { id: credentialId, status: "revoked" } });
        }
        throw new Error(`unexpected request ${init?.method ?? "GET"} ${url.pathname}`);
      });

      await expect(
        installHonuaLocal(
          { directory, timeoutMs: 1_000 },
          {
            fetchFn,
            randomSecret: (bytes) => `generated-${bytes}`,
            run: async () => ({ exitCode: 0, stdout: "ok", stderr: "" }),
            wait: async () => undefined,
          },
        ),
      ).rejects.toThrow();
      expect(revoked).toBe(1);
      expect(readFileSync(path.join(directory, ".env"), "utf8")).not.toContain(material);
    },
  );

  it("revokes and scrubs a newly issued key when private-file persistence fails", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "honua-local-access-persist-"));
    cleanup.push(directory);
    mkdirSync(path.join(directory, ".mcp.json"));
    const credentialId = "33333333-3333-4333-8333-333333333333";
    const material = "hnua_persistence-failure-material";
    let revoked = 0;
    const fetchFn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      if (url.pathname === "/healthz/ready") return new Response("ready", { status: 200 });
      if (url.pathname === "/api/v1/admin/api-keys" && init?.method === "POST") {
        return jsonResponse(
          {
            success: true,
            data: {
              apiKey: {
                id: credentialId,
                name: "honua-local-agent",
                permissions: ["admin:read", "admin:write"],
                status: "active",
              },
              key: material,
            },
          },
          201,
        );
      }
      if (url.pathname === `/api/v1/admin/api-keys/${credentialId}/effective-permissions`) {
        return jsonResponse({
          success: true,
          data: {
            id: credentialId,
            name: "honua-local-agent",
            permissions: ["admin:read", "admin:write"],
            status: "active",
            canAuthenticate: true,
          },
        });
      }
      if (url.pathname === `/api/v1/admin/api-keys/${credentialId}/revoke` && init?.method === "POST") {
        revoked += 1;
        return jsonResponse({ success: true, data: { id: credentialId, status: "revoked" } });
      }
      throw new Error(`unexpected request ${init?.method ?? "GET"} ${url.pathname}`);
    });

    await expect(
      installHonuaLocal(
        { directory, timeoutMs: 1_000 },
        {
          fetchFn,
          randomSecret: (bytes) => `generated-${bytes}`,
          run: async () => ({ exitCode: 0, stdout: "ok", stderr: "" }),
          wait: async () => undefined,
        },
      ),
    ).rejects.toThrow();
    expect(revoked).toBe(1);
    expect(readFileSync(path.join(directory, ".env"), "utf8")).not.toContain(material);
  });

  it.skipIf(process.platform === "win32")(
    "atomically replaces an existing permissive credential file with owner-only permissions",
    async () => {
      const directory = mkdtempSync(path.join(tmpdir(), "honua-local-access-mode-"));
      cleanup.push(directory);
      const material = "hnua_existing-private-material";
      const envFile = path.join(directory, ".env");
      writeFileSync(
        envFile,
        [
          "HONUA_SERVER_IMAGE=example.invalid/honua@sha256:1234",
          "HONUA_HTTP_PORT=8080",
          "POSTGRES_PASSWORD=postgres",
          "HONUA_ADMIN_PASSWORD=root",
          "HONUA_CONNECTION_ENCRYPTION_MASTER_KEY=master",
          `HONUA_ADMIN_KEY=${material}`,
          "",
        ].join("\n"),
        { encoding: "utf8", mode: 0o644 },
      );
      chmodSync(envFile, 0o644);
      const fetchFn = vi.fn(async (input: string | URL | Request) => {
        const url = new URL(input instanceof Request ? input.url : input.toString());
        if (url.pathname === "/healthz/ready") return new Response("ready", { status: 200 });
        if (url.pathname === "/api/v1/admin/api-keys") {
          return jsonResponse({
            success: true,
            data: [
              {
                id: "44444444-4444-4444-8444-444444444444",
                name: "honua-local-agent",
                keyPrefix: material.slice(0, 12),
                permissions: ["admin:read", "admin:write"],
                status: "active",
              },
            ],
          });
        }
        throw new Error(`unexpected request ${url.pathname}`);
      });

      const result = await installHonuaLocal(
        { directory, timeoutMs: 1_000 },
        {
          fetchFn,
          run: async () => ({ exitCode: 0, stdout: "ok", stderr: "" }),
          wait: async () => undefined,
        },
      );
      expect(statSync(result.envFile).mode & 0o777).toBe(0o600);
    },
  );

  it.skipIf(process.platform === "win32")("refuses a symbolic-link credential target", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "honua-local-access-symlink-"));
    cleanup.push(directory);
    const external = path.join(directory, "external.env");
    writeFileSync(external, "DO_NOT_OVERWRITE=true\n", "utf8");
    symlinkSync(external, path.join(directory, ".env"));

    await expect(
      installHonuaLocal(
        { directory, timeoutMs: 1_000 },
        {
          randomSecret: (bytes) => `generated-${bytes}`,
          run: async () => ({ exitCode: 0, stdout: "ok", stderr: "" }),
          wait: async () => undefined,
        },
      ),
    ).rejects.toThrow("symbolic-link credential file");
    expect(readFileSync(external, "utf8")).toBe("DO_NOT_OVERWRITE=true\n");
  });
});

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}
