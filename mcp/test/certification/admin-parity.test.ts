import {
  ADMIN_MCP_CONTRACT_SERVER_SHA,
  ADMIN_MCP_COVERAGE_SHA256,
  ADMIN_MCP_EXCLUDED_OPERATIONS,
  ADMIN_MCP_EXCLUSION_ROSTER_SHA256,
  ADMIN_MCP_PUBLISHED_TOOL_NAMES,
  MCP_DEFAULT_STATIC_TOOL_COUNT,
  MCP_DEFAULT_TOTAL_TOOL_COUNT,
} from "@honua/sdk-js/control-plane";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";

import { certifyAdminCatalogParity, listAllTools } from "../../src/certification/admin-parity.js";

function adminTools(): Tool[] {
  return ADMIN_MCP_PUBLISHED_TOOL_NAMES.map((name, index) => ({
    name,
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

function staticTools(): Tool[] {
  return Array.from({ length: MCP_DEFAULT_STATIC_TOOL_COUNT }, (_, index) => ({
    name: `honua_fixture_static_${String(index).padStart(2, "0")}`,
    description: "Static fixture descriptor",
    inputSchema: { type: "object", properties: {} },
  }));
}

function defaultCatalog(): Tool[] {
  return [...staticTools(), ...adminTools()];
}

describe("complete Admin MCP default-roster transport parity", () => {
  it("follows every tools/list cursor before certifying the catalog", async () => {
    const catalog = defaultCatalog();
    const seen: Array<string | undefined> = [];
    const tools = await listAllTools({
      async listTools(request) {
        seen.push(request?.cursor);
        if (!request?.cursor) return { tools: catalog.slice(0, 150), nextCursor: "page-2" };
        if (request.cursor === "page-2") return { tools: catalog.slice(150, 300), nextCursor: "page-3" };
        return { tools: catalog.slice(300) };
      },
    });

    expect(seen).toEqual([undefined, "page-2", "page-3"]);
    expect(tools).toHaveLength(432);
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

  it("certifies the exact 47 + 385 = 432 roster, schemas, annotations, and provenance", () => {
    const catalog = defaultCatalog();
    expect(certifyAdminCatalogParity(catalog, structuredClone(catalog))).toEqual({
      schemaVersion: "honua.admin-mcp-parity.v1",
      family: "honua_admin_*",
      expectedTools: 385,
      expectedStaticTools: 47,
      expectedTotalTools: 432,
      directTools: 385,
      proxiedTools: 385,
      directStaticTools: 47,
      proxiedStaticTools: 47,
      directTotalTools: 432,
      proxiedTotalTools: 432,
      coverageSha256: ADMIN_MCP_COVERAGE_SHA256,
      exclusionRosterSha256: ADMIN_MCP_EXCLUSION_ROSTER_SHA256,
      contractServerSha: ADMIN_MCP_CONTRACT_SERVER_SHA,
      pass: true,
      differences: [],
    });
  });

  it("fails on count regression and descriptor drift", () => {
    const direct = defaultCatalog();
    const proxied = structuredClone(direct.slice(0, -1));
    proxied[MCP_DEFAULT_STATIC_TOOL_COUNT] = {
      ...proxied[MCP_DEFAULT_STATIC_TOOL_COUNT],
      annotations: { readOnlyHint: false },
    } as Tool;
    const receipt = certifyAdminCatalogParity(direct, proxied);
    expect(receipt.pass).toBe(false);
    expect(receipt.differences).toEqual(
      expect.arrayContaining([expect.stringContaining("expected 385"), expect.stringContaining("descriptor differs")]),
    );
  });

  it("detects approval-output and secret-reference schema drift", () => {
    const direct = defaultCatalog();
    const proxied = structuredClone(direct);
    const firstAdmin = MCP_DEFAULT_STATIC_TOOL_COUNT;
    proxied[firstAdmin] = {
      ...proxied[firstAdmin],
      inputSchema: { type: "object", properties: { secret_ref: { type: "number" } } },
      outputSchema: { type: "object", properties: { requiresApproval: { type: "string" } } },
    };
    expect(certifyAdminCatalogParity(direct, proxied).differences).toContain(
      `${ADMIN_MCP_PUBLISHED_TOOL_NAMES[0]} descriptor differs`,
    );
  });

  it("fails when either transport repeats an admin tool name", () => {
    const direct = defaultCatalog();
    direct[direct.length - 1] = structuredClone(direct[MCP_DEFAULT_STATIC_TOOL_COUNT]);
    const proxied = defaultCatalog();

    const receipt = certifyAdminCatalogParity(direct, proxied);

    expect(receipt.pass).toBe(false);
    expect(receipt.differences).toContain(`direct catalog repeats admin tool ${ADMIN_MCP_PUBLISHED_TOOL_NAMES[0]}`);
    expect(receipt.differences).toContain(
      `${ADMIN_MCP_PUBLISHED_TOOL_NAMES.at(-1)} is missing from the direct catalog contract`,
    );
  });

  it("fails if a secret/session exclusion is advertised or the default static equation drifts", () => {
    const direct = defaultCatalog();
    direct.push({
      name: ADMIN_MCP_EXCLUDED_OPERATIONS[0].toolName,
      description: "must never be advertised",
      inputSchema: { type: "object" },
    });
    const proxied = defaultCatalog().slice(1);

    const receipt = certifyAdminCatalogParity(direct, proxied);

    expect(receipt.pass).toBe(false);
    expect(receipt.differences).toContain(
      `direct catalog advertises explicitly excluded admin tool ${ADMIN_MCP_EXCLUDED_OPERATIONS[0].toolName}`,
    );
    expect(receipt.differences).toContain("proxied catalog exposes 46 static tools; expected 47");
    expect(receipt.differences).toContain(
      `proxied catalog exposes ${MCP_DEFAULT_TOTAL_TOOL_COUNT - 1} total tools; expected ${MCP_DEFAULT_TOTAL_TOOL_COUNT}`,
    );
  });
});
