import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";

import { certifyAdminCatalogParity, listAllTools } from "../../src/certification/admin-parity.js";

function adminTools(count: number): Tool[] {
  return Array.from({ length: count }, (_, index) => ({
    name: `honua_admin_fixture_${String(index).padStart(3, "0")}`,
    title: `Admin fixture ${index}`,
    description: "Fixture descriptor",
    inputSchema: {
      type: "object",
      properties: index === 0 ? { secret_ref: { type: "string" } } : {},
    },
    outputSchema: {
      type: "object",
      properties: {
        status: { type: "string" },
        requiresApproval: { type: "boolean" },
      },
    },
    annotations: { readOnlyHint: index % 2 === 0, destructiveHint: index % 2 !== 0 },
  }));
}

describe("119-operation admin MCP transport parity", () => {
  it("follows every tools/list cursor before certifying the catalog", async () => {
    const catalog = adminTools(119);
    const seen: Array<string | undefined> = [];
    const tools = await listAllTools({
      async listTools(request) {
        seen.push(request?.cursor);
        if (!request?.cursor) return { tools: catalog.slice(0, 50), nextCursor: "page-2" };
        if (request.cursor === "page-2") return { tools: catalog.slice(50, 100), nextCursor: "page-3" };
        return { tools: catalog.slice(100) };
      },
    });

    expect(seen).toEqual([undefined, "page-2", "page-3"]);
    expect(tools).toHaveLength(119);
  });

  it("fails closed when a server repeats a tools/list cursor", async () => {
    await expect(
      listAllTools({
        async listTools() {
          return { tools: [], nextCursor: "same-page" };
        },
      }),
    ).rejects.toThrow("repeated cursor same-page");
  });

  it("compares names, input/output schemas, and annotations", () => {
    const catalog = adminTools(119);
    expect(certifyAdminCatalogParity(catalog, structuredClone(catalog))).toEqual({
      schemaVersion: "honua.admin-mcp-parity.v1",
      family: "honua_admin_*",
      expectedTools: 119,
      directTools: 119,
      proxiedTools: 119,
      pass: true,
      differences: [],
    });
  });

  it("fails on count regression and descriptor drift", () => {
    const direct = adminTools(119);
    const proxied = structuredClone(direct.slice(0, 118));
    proxied[0] = { ...proxied[0], annotations: { readOnlyHint: false } };
    const receipt = certifyAdminCatalogParity(direct, proxied);
    expect(receipt.pass).toBe(false);
    expect(receipt.differences).toEqual(
      expect.arrayContaining([expect.stringContaining("expected 119"), expect.stringContaining("descriptor differs")]),
    );
  });

  it("detects approval-output and secret-reference schema drift", () => {
    const direct = adminTools(119);
    const proxied = structuredClone(direct);
    proxied[0] = {
      ...proxied[0],
      inputSchema: { type: "object", properties: { secret_ref: { type: "number" } } },
      outputSchema: { type: "object", properties: { requiresApproval: { type: "string" } } },
    };
    expect(certifyAdminCatalogParity(direct, proxied).differences).toContain(
      "honua_admin_fixture_000 descriptor differs",
    );
  });

  it("fails when either transport repeats an admin tool name", () => {
    const direct = adminTools(119);
    direct[118] = structuredClone(direct[0]);
    const proxied = adminTools(119);

    const receipt = certifyAdminCatalogParity(direct, proxied);

    expect(receipt.pass).toBe(false);
    expect(receipt.differences).toContain("direct catalog repeats admin tool honua_admin_fixture_000");
    expect(receipt.differences).toContain("honua_admin_fixture_118 is missing from the direct HTTP catalog");
  });
});
