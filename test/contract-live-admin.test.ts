import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const baseUrl = process.env.HONUA_CONTRACT_LIVE_URL;
const apiKey = process.env.HONUA_CONTRACT_LIVE_API_KEY ?? "quickstart-admin-password";

function cli(...args: string[]): string {
  return execFileSync(process.execPath, ["dist/src/cli/bin.js", ...args], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HONUA_BASE_URL: baseUrl,
      HONUA_API_KEY: apiKey,
    },
    encoding: "utf8",
    timeout: 5000,
  });
}

describe.skipIf(!baseUrl)("live Admin contract", () => {
  it("keeps opaque path parameters as strings", () => {
    const output = cli("admin", "api", "getConnection", "--path", "id=00123", "--dry-run");

    // OpenAPI path parameters are strings unless their schema says otherwise.
    // The current CLI coerces this value to the number 123, losing information.
    expect(output).toContain('"id": "00123"');
  });

  it("maps the terminal import command to a server-published route", async () => {
    const response = await fetch(`${baseUrl}/api/v1/admin/imports`, {
      headers: { "X-API-Key": apiKey },
    });

    // Trunk publishes import operations under /admin/import/*, not /imports.
    // This assertion intentionally fails while the command-layer catalog still
    // emits POST /imports.
    expect(response.status).not.toBe(404);
  });
});
