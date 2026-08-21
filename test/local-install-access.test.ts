import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
});

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}
