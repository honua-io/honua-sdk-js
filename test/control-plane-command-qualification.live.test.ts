/**
 * Live qualification of the shared command layer against a pinned Honua server.
 *
 * Skipped unless both `HONUA_COMMAND_QUALIFICATION_BASE_URL` and
 * `HONUA_COMMAND_QUALIFICATION_API_KEY` are set. The key is the caller's own
 * admin credential (the server's `HONUA_ADMIN_PASSWORD` on a local candidate);
 * the test mints a short-lived `admin:read` key and revokes it.
 *
 * What this proves: CLI, MCP, Studio, and direct JS send one derived
 * `X-Correlation-ID` for the same `connection.test`, and the server audit
 * trail records that id on every request that reaches the admin audit matrix.
 * What it does not prove: this candidate does not write an audit row for an
 * authorization challenge, and listing connections with `X-Honua-Tenant` does
 * not isolate tenants, so cross-tenant denial is not asserted here.
 */

import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

import { run } from "../src/cli/main.js";
import { HonuaCommandError, connectionTestCommand, createHonuaCommandRuntime } from "../src/control-plane/index.js";
import { HonuaClient } from "../src/index.js";
import { createHonuaStudioCommandAdapter } from "../src/studio/index.js";

const baseUrl = process.env.HONUA_COMMAND_QUALIFICATION_BASE_URL?.replace(/\/$/, "");
const adminKey = process.env.HONUA_COMMAND_QUALIFICATION_API_KEY;
const enabled = Boolean(baseUrl && adminKey);

afterEach(() => {
  vi.restoreAllMocks();
});

describe.skipIf(!enabled)("pinned candidate command audit join", () => {
  it("records one server audit correlation for CLI, MCP, Studio, and JS", async () => {
    // The route template constrains the id to a GUID. A non-GUID misses the
    // endpoint, so the server returns an unaudited routing 404.
    const connectionId = randomUUID();
    const joined = await probeAll(adminKey!, connectionId);
    expect(joined.correlationIds.size).toBe(1);
    const correlationId = [...joined.correlationIds][0]!;
    const rows = await auditRows(correlationId);
    expect(rows.length).toBeGreaterThanOrEqual(4);
    expect(new Set(rows.map((row) => row.correlationId))).toEqual(new Set([correlationId]));
    expect(new Set(rows.map((row) => row.actor))).toEqual(new Set([rows[0]?.actor]));
    expect(new Set(rows.map((row) => row.action))).toEqual(new Set(["admin.post"]));
    expect(new Set(rows.map((row) => row.outcome))).toEqual(new Set(["Failure"]));
    expect(rows.every((row) => row.resourceId?.endsWith(`/connections/${connectionId}/test`))).toBe(true);
  }, 60_000);

  it("returns the same authorization denial for an admin:read key on every transport", async () => {
    const minted = await createReadKey();
    try {
      const connectionId = randomUUID();
      const joined = await probeAll(minted.key, connectionId);
      expect(joined.exitCode).toBe(2);
      expect(joined.correlationIds.size).toBe(1);
      expect([...joined.kinds]).toEqual(["authorization"]);
      expect([...joined.statusCodes]).toEqual([403]);
    } finally {
      await revokeKey(minted.id);
    }
  }, 60_000);
});

interface AuditRow {
  readonly correlationId?: string;
  readonly actor?: string;
  readonly action?: string;
  readonly outcome?: string;
  readonly resourceId?: string;
}

interface ProbeJoin {
  readonly correlationIds: ReadonlySet<string>;
  readonly kinds: ReadonlySet<string>;
  readonly statusCodes: ReadonlySet<number>;
  readonly exitCode: number;
}

async function probeAll(credential: string, connectionId: string): Promise<ProbeJoin> {
  const client = new HonuaClient({ baseUrl: baseUrl!, apiKey: credential });
  const input = { connectionId };
  const correlationIds = new Set<string>();
  const kinds = new Set<string>();
  const statusCodes = new Set<number>();

  const output = capture();
  const exitCode = await run(["connection", "test", connectionId, "--yes", "--json", "--base-url", baseUrl!], {
    apiKey: credential,
  });
  const cli = JSON.parse(output.join("")) as { correlationId?: string; errorKind?: string; statusCode?: number };
  if (cli.correlationId) correlationIds.add(cli.correlationId);
  if (cli.errorKind) kinds.add(cli.errorKind);
  if (cli.statusCode !== undefined) statusCodes.add(cli.statusCode);

  // MCP's `execute` sets `transport: "mcp"` and calls this same runtime. The tool
  // module imports zod, which the SDK unit lane does not install, so the live
  // probe uses the invocation the adapter builds rather than loading that module.
  const mcpError = await createHonuaCommandRuntime({ client })
    .execute(connectionTestCommand, input, { transport: "mcp" })
    .catch((thrown: unknown) => thrown);
  expect(mcpError).toBeInstanceOf(HonuaCommandError);
  const mcp = mcpError as HonuaCommandError;
  if (mcp.correlationId) correlationIds.add(mcp.correlationId);
  kinds.add(mcp.kind);
  if (mcp.statusCode !== undefined) statusCodes.add(mcp.statusCode);

  const studioError = await createHonuaStudioCommandAdapter({ client })
    .execute(connectionTestCommand, input)
    .catch((thrown: unknown) => thrown);
  expect(studioError).toBeInstanceOf(HonuaCommandError);
  const studio = studioError as HonuaCommandError;
  if (studio.correlationId) correlationIds.add(studio.correlationId);
  kinds.add(studio.kind);
  if (studio.statusCode !== undefined) statusCodes.add(studio.statusCode);

  const sdkError = await createHonuaCommandRuntime({ client })
    .execute(connectionTestCommand, input, { transport: "sdk" })
    .catch((thrown: unknown) => thrown);
  expect(sdkError).toBeInstanceOf(HonuaCommandError);
  const sdk = sdkError as HonuaCommandError;
  if (sdk.correlationId) correlationIds.add(sdk.correlationId);
  kinds.add(sdk.kind);
  if (sdk.statusCode !== undefined) statusCodes.add(sdk.statusCode);

  return { correlationIds, kinds, statusCodes, exitCode };
}

function capture(): string[] {
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

async function auditRows(correlationId: string): Promise<readonly AuditRow[]> {
  const response = await fetch(
    `${baseUrl}/api/v1/admin/observability/audit?correlationId=${encodeURIComponent(correlationId)}&pageSize=20`,
    { headers: { Accept: "application/json", "X-API-Key": adminKey! } },
  );
  if (!response.ok) throw new Error(`audit query failed with HTTP ${response.status}`);
  const body = (await response.json()) as { items?: readonly AuditRow[] };
  return body.items ?? [];
}

async function createReadKey(): Promise<{ id: string; key: string }> {
  const response = await fetch(`${baseUrl}/api/v1/admin/api-keys`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "X-API-Key": adminKey!,
    },
    body: JSON.stringify({
      name: `sdk-1424-read-${randomUUID()}`,
      permissions: ["admin:read"],
      expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
    }),
  });
  if (response.status !== 201) throw new Error(`read-key create failed with HTTP ${response.status}`);
  const body = (await response.json()) as { data?: { apiKey?: { id?: string }; key?: string } };
  const id = body.data?.apiKey?.id;
  const key = body.data?.key;
  if (!id || !key) throw new Error("read-key create response did not include an id and a secret");
  return { id, key };
}

async function revokeKey(id: string): Promise<void> {
  const response = await fetch(`${baseUrl}/api/v1/admin/api-keys/${id}/revoke`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "X-API-Key": adminKey!,
    },
    body: "{}",
  });
  if (!response.ok) throw new Error(`read-key revoke failed with HTTP ${response.status}`);
}
