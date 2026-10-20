import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { certify } from "../../src/certification/certifier.js";
import { buildOperatorTools } from "../../src/certification/operator-catalog.js";
import {
  type McpToolRoster,
  type RosterResolution,
  advertisableNames,
  checkRosterParity,
  loadVendoredRoster,
  parseRoster,
  resolveDurableControlPlane,
  resolveRoster,
  rosterUrl,
  vendoredRosterPin,
} from "../../src/certification/roster.js";
import { openCertificationTarget } from "../../src/certification/target.js";

const tmpDirs: string[] = [];
afterAll(() => {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const SHA = "87966c3f7b6c840ffc4d4da0b451714ab717b18a";
const OTHER_SHA = "0123456789abcdef0123456789abcdef01234567";

function roster(overrides: Partial<McpToolRoster> = {}): McpToolRoster {
  return {
    serverSha: SHA,
    static: ["honua_list_layers", "honua_query_features", "honua_propose_rollback"],
    projectedAdmin: ["honua_admin_server_status", "honua_admin_connections_create"],
    requiresDurableControlPlane: ["honua_admin_connections_create"],
    views: {
      default: ["honua_list_layers", "honua_query_features", "honua_admin_connections_create"],
      setup: ["honua_admin_server_status"],
      configure: [],
      operate: ["honua_propose_rollback"],
      analyze: ["honua_query_features"],
    },
    retired: ["honua_propose_operation"],
    ...overrides,
  };
}

function rosterDocument(r: McpToolRoster): Record<string, unknown> {
  return { schemaVersion: 1, generatedAt: "2026-10-08T00:00:00Z", ...r };
}

/**
 * Documented fixture tools in the offline operator catalog that the product
 * server deliberately does not serve (see the NOTE in operator-catalog.ts):
 * `honua_edit_features` exercises the standard's optional mutation profile for
 * other adopters. Everything else in the catalog must be a real server tool.
 */
const MUTATION_PROFILE_ADOPTER_FIXTURES = new Set(["honua_edit_features"]);

describe("roster document", () => {
  it("parses the v1 shape and keeps only the consumed fields", () => {
    const parsed = parseRoster(rosterDocument(roster()));
    expect(parsed.static).toContain("honua_list_layers");
    expect(parsed.views.default).toHaveLength(3);
    expect(parsed.retired).toEqual(["honua_propose_operation"]);
    expect([...advertisableNames(parsed)].sort()).toEqual(
      [
        "honua_admin_connections_create",
        "honua_admin_server_status",
        "honua_list_layers",
        "honua_propose_rollback",
        "honua_query_features",
      ].sort(),
    );
  });

  it("rejects a malformed roster rather than treating it as empty", () => {
    expect(() => parseRoster([])).toThrow(/object/);
    expect(() => parseRoster({ ...rosterDocument(roster()), static: "honua_list_layers" })).toThrow(/static/);
    const { views: _views, ...noViews } = rosterDocument(roster());
    expect(() => parseRoster(noViews)).toThrow(/views/);
    expect(() => parseRoster({ ...rosterDocument(roster()), views: { default: [] } })).toThrow(/views\.setup/);
  });

  it("builds the raw honua-server URL at a commit", () => {
    expect(rosterUrl(SHA)).toBe(
      `https://raw.githubusercontent.com/honua-io/honua-server/${SHA}/docs/gis/data/mcp-tool-roster.v1.json`,
    );
  });
});

describe("roster parity", () => {
  const durable = { durableControlPlane: true };

  it("passes when every advertised tool is rostered and views.default is advertised", () => {
    const result = checkRosterParity(
      ["honua_list_layers", "honua_query_features", "honua_admin_connections_create", "honua_propose_rollback"],
      roster(),
      durable,
    );
    expect(result).toMatchObject({ ok: true, unrostered: [], missingDefault: [], retiredAdvertised: [] });
  });

  it("fails on an advertised tool outside static ∪ projectedAdmin", () => {
    const result = checkRosterParity(
      ["honua_list_layers", "honua_query_features", "honua_admin_connections_create", "honua_mystery"],
      roster(),
      durable,
    );
    expect(result.ok).toBe(false);
    expect(result.unrostered).toEqual(["honua_mystery"]);
  });

  it("fails when a views.default tool is not advertised", () => {
    const result = checkRosterParity(["honua_list_layers", "honua_admin_connections_create"], roster(), durable);
    expect(result.ok).toBe(false);
    expect(result.missingDefault).toEqual(["honua_query_features"]);
  });

  it("fails when a retired tool is still advertised", () => {
    const result = checkRosterParity(
      ["honua_list_layers", "honua_query_features", "honua_admin_connections_create", "honua_propose_operation"],
      roster(),
      durable,
    );
    expect(result.ok).toBe(false);
    expect(result.retiredAdvertised).toEqual(["honua_propose_operation"]);
    expect(result.unrostered).toEqual([]);
  });

  it("tolerates absent durable-control-plane tools only on a Redis-off topology", () => {
    const advertised = ["honua_list_layers", "honua_query_features"];
    expect(checkRosterParity(advertised, roster(), durable).missingDefault).toEqual(["honua_admin_connections_create"]);
    const redisOff = checkRosterParity(advertised, roster(), { durableControlPlane: false });
    expect(redisOff.ok).toBe(true);
    expect(redisOff.tolerated).toEqual(["honua_admin_connections_create"]);
  });

  it("reads the topology from HONUA_MCP_CERT_TOPOLOGY (durable by default)", () => {
    expect(resolveDurableControlPlane({})).toBe(true);
    expect(resolveDurableControlPlane({ HONUA_MCP_CERT_TOPOLOGY: "redis-off" })).toBe(false);
  });
});

describe("roster resolution", () => {
  it("loads an explicit HONUA_MCP_ROSTER_FILE", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mcp-roster-"));
    tmpDirs.push(dir);
    const file = join(dir, "roster.json");
    writeFileSync(file, JSON.stringify(rosterDocument(roster())), "utf8");
    const resolved = await resolveRoster({ env: { HONUA_MCP_ROSTER_FILE: file } });
    expect(resolved.status).toBe("loaded");
  });

  it("is blocked, not passed, when the roster does not exist at the server sha", async () => {
    const requested: string[] = [];
    const fetchFn = (async (url: string) => {
      requested.push(url);
      return new Response("404: Not Found", { status: 404 });
    }) as unknown as typeof fetch;
    const resolved = await resolveRoster({ env: { HONUA_MCP_ROSTER_SERVER_SHA: OTHER_SHA }, fetchFn });
    expect(requested).toEqual([rosterUrl(OTHER_SHA)]);
    expect(resolved.status).toBe("blocked");
    if (resolved.status === "blocked") {
      expect(resolved.reason).toContain(OTHER_SHA);
      expect(resolved.reason).toContain("HONUA_MCP_ROSTER_TOKEN");
    }
  });

  it("sends the read token and loads the roster fetched at the server sha", async () => {
    let auth: string | null = null;
    const fetchFn = (async (_url: string, init?: RequestInit) => {
      auth = new Headers(init?.headers).get("authorization");
      return new Response(JSON.stringify(rosterDocument(roster())), { status: 200 });
    }) as unknown as typeof fetch;
    const resolved = await resolveRoster({
      env: { HONUA_MCP_ROSTER_SERVER_SHA: OTHER_SHA, HONUA_MCP_ROSTER_TOKEN: "t0k" },
      fetchFn,
    });
    expect(resolved.status).toBe("loaded");
    expect(auth).toBe("token t0k");
  });

  it("is blocked on a network failure or a non-sha pin", async () => {
    const failing = (async () => {
      throw new Error("ENOTFOUND");
    }) as unknown as typeof fetch;
    const failed = await resolveRoster({ env: { HONUA_MCP_ROSTER_SERVER_SHA: OTHER_SHA }, fetchFn: failing });
    expect(failed.status).toBe("blocked");
    const notSha = await resolveRoster({ env: { HONUA_MCP_ROSTER_SERVER_SHA: "trunk" } });
    expect(notSha.status).toBe("blocked");
  });
});

describe("roster-parity certification contract", () => {
  async function certifyOffline(rosterResolution?: RosterResolution) {
    const target = await openCertificationTarget({ HONUA_MCP_CERT_TARGET: "offline" } as NodeJS.ProcessEnv);
    try {
      return await certify({
        client: target.client,
        targetMode: target.mode,
        backend: target.backend,
        surface: target.serverLabel,
        ...(rosterResolution ? { roster: rosterResolution } : {}),
      });
    } finally {
      await target.close();
    }
  }

  it("is skipped for a target that is not the product /mcp", async () => {
    const report = await certifyOffline();
    const parity = report.contracts.find((c) => c.contract === "roster-parity");
    expect(parity?.status).toBe("skipped");
    expect(report.summary.contractsBlocked).toBe(0);
  });

  it("keeps the certification from passing when the roster is blocked", async () => {
    const report = await certifyOffline({ status: "blocked", source: "test", reason: "roster absent at sha" });
    const parity = report.contracts.find((c) => c.contract === "roster-parity");
    expect(parity?.status).toBe("blocked");
    expect(parity?.detail).toContain("roster absent at sha");
    expect(report.summary.contractsBlocked).toBe(1);
    expect(report.summary.pass).toBe(false);
  });

  it("passes against a roster that lists the advertised catalog, and fails on a retired name", async () => {
    const names = buildOperatorTools().map((t) => t.name);
    const matching = roster({
      static: names,
      projectedAdmin: [],
      requiresDurableControlPlane: [],
      views: { default: names, setup: [], configure: [], operate: [], analyze: [] },
    });
    const pass = await certifyOffline({ status: "loaded", roster: matching, source: "test" });
    expect(pass.contracts.find((c) => c.contract === "roster-parity")?.status).toBe("passed");

    const retiring = { ...matching, static: names.slice(1), retired: [names[0]] };
    const fail = await certifyOffline({ status: "loaded", roster: retiring, source: "test" });
    const parity = fail.contracts.find((c) => c.contract === "roster-parity");
    expect(parity?.status).toBe("failed");
    expect(parity?.detail).toContain(`retired tool(s) advertised: ${names[0]}`);
  });
});

describe("operator catalog ⊆ honua-server roster", () => {
  it("never names the retired honua_propose_operation", () => {
    expect(buildOperatorTools().map((t) => t.name)).not.toContain("honua_propose_operation");
  });

  it("pins the vendored roster to the candidate's ADMIN_RELEASE_SERVER_SHA", () => {
    const generated = readFileSync(
      new URL("../../../src/control-plane/generated/admin-operations.ts", import.meta.url),
      "utf8",
    );
    const releaseSha = /ADMIN_RELEASE_SERVER_SHA = "([0-9a-f]{40})"/.exec(generated)?.[1];
    expect(releaseSha).toBeDefined();
    expect(vendoredRosterPin()).toBe(releaseSha);
  });

  const vendored = loadVendoredRoster();

  it.runIf(vendored.status === "loaded")("lists every operator-catalog tool (except documented fixtures)", () => {
    if (vendored.status !== "loaded") return;
    const known = advertisableNames(vendored.roster);
    const retired = new Set(vendored.roster.retired);
    const catalog = buildOperatorTools()
      .map((t) => t.name)
      .filter((name) => !MUTATION_PROFILE_ADOPTER_FIXTURES.has(name));
    expect(catalog.filter((name) => !known.has(name))).toEqual([]);
    expect(catalog.filter((name) => retired.has(name))).toEqual([]);
  });

  it.runIf(vendored.status === "blocked")(
    "reports the catalog check as BLOCKED until the roster exists at the pinned sha",
    () => {
      // Not a pass: the subset check above cannot run without the server roster.
      // This records why, and flips to the real check once the roster is vendored.
      if (vendored.status !== "blocked") return;
      expect(vendored.reason).toMatch(/does not exist at the pinned honua-server@[0-9a-f]{40}/);
    },
  );
});
