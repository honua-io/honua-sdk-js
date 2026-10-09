import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * honua-server MCP tool roster (`docs/gis/data/mcp-tool-roster.v1.json`) and the
 * `roster-parity` check the certifier runs against a live `/mcp`.
 *
 * The roster is the server's own generated list of every tool name its composed
 * registry can advertise. It is the authority this repo's catalogs and corpora
 * are checked against, so a retired tool (e.g. `honua_propose_operation`) can no
 * longer linger here after the server drops it.
 *
 * The roster is read BY SERVER SHA: the same honua-server commit the pinned
 * candidate image was built from (`ADMIN_RELEASE_SERVER_SHA`). When the file does
 * not exist at that sha (the server change that adds it has not reached the pin
 * yet), the check reports `blocked` with the reason. It never passes without a
 * roster to compare against.
 */

/** Path of the roster inside the honua-server repository. */
export const ROSTER_REPO_PATH = "docs/gis/data/mcp-tool-roster.v1.json";

/** Raw-content URL of the roster at a honua-server commit. */
export function rosterUrl(serverSha: string): string {
  return `https://raw.githubusercontent.com/honua-io/honua-server/${serverSha}/${ROSTER_REPO_PATH}`;
}

export type RosterViewName = "default" | "setup" | "configure" | "operate" | "analyze";

export const ROSTER_VIEW_NAMES: readonly RosterViewName[] = ["default", "setup", "configure", "operate", "analyze"];

/** Shape of `mcp-tool-roster.v1.json` (fields this repo consumes). */
export interface McpToolRoster {
  serverSha: string | null;
  /** Hand-authored IMcpTool names, every capability gate enabled. */
  static: string[];
  /** `honua_admin_*` tools the default production composition publishes. */
  projectedAdmin: string[];
  /** Subset of projectedAdmin that registers only with a durable proposal store (Redis). */
  requiresDurableControlPlane: string[];
  views: Record<RosterViewName, string[]>;
  /** Names the server no longer advertises. */
  retired: string[];
}

export type RosterResolution =
  | { status: "loaded"; roster: McpToolRoster; source: string }
  | { status: "blocked"; reason: string; source: string };

function readNameArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`roster field "${field}" must be an array of tool-name strings`);
  }
  return [...(value as string[])];
}

/** Validate and normalize a parsed roster document. Throws on a malformed shape. */
export function parseRoster(raw: unknown): McpToolRoster {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("roster must be a JSON object");
  }
  const doc = raw as Record<string, unknown>;
  const views = doc.views;
  if (typeof views !== "object" || views === null || Array.isArray(views)) {
    throw new Error('roster field "views" must be an object');
  }
  const viewMap = {} as Record<RosterViewName, string[]>;
  for (const view of ROSTER_VIEW_NAMES) {
    viewMap[view] = readNameArray((views as Record<string, unknown>)[view], `views.${view}`);
  }
  return {
    serverSha: typeof doc.serverSha === "string" ? doc.serverSha : null,
    static: readNameArray(doc.static, "static"),
    projectedAdmin: readNameArray(doc.projectedAdmin, "projectedAdmin"),
    requiresDurableControlPlane: readNameArray(doc.requiresDurableControlPlane, "requiresDurableControlPlane"),
    views: viewMap,
    retired: readNameArray(doc.retired, "retired"),
  };
}

/** Every name the server can advertise: `static ∪ projectedAdmin`. */
export function advertisableNames(roster: McpToolRoster): Set<string> {
  return new Set([...roster.static, ...roster.projectedAdmin]);
}

/**
 * Vendored copy of the roster, kept beside its provenance so the offline unit
 * test can check this repo's catalog without network access. Probed from both
 * the compiled (`dist/src/certification`) and source (`src/certification`)
 * layouts.
 */
function resolveVendoredRosterDir(): URL {
  const candidates = [
    "../../../certification/honua-server-mcp-roster/",
    "../../certification/honua-server-mcp-roster/",
  ];
  for (const candidate of candidates) {
    const url = new URL(candidate, import.meta.url);
    if (existsSync(new URL("PROVENANCE.md", url))) {
      return url;
    }
  }
  return new URL(candidates[0], import.meta.url);
}

export const VENDORED_ROSTER_DIR = resolveVendoredRosterDir();

/** The honua-server sha the vendored roster provenance is pinned to, if any. */
export function vendoredRosterPin(): string | null {
  const provenance = new URL("PROVENANCE.md", VENDORED_ROSTER_DIR);
  if (!existsSync(provenance)) {
    return null;
  }
  const match = /Server commit:\*\* `([0-9a-f]{40})`/.exec(readFileSync(provenance, "utf8"));
  return match ? match[1] : null;
}

/** Load the vendored roster, or report why it is blocked. */
export function loadVendoredRoster(): RosterResolution {
  const pin = vendoredRosterPin();
  const file = new URL("mcp-tool-roster.v1.json", VENDORED_ROSTER_DIR);
  const source = `vendored ${fileURLToPath(file)}${pin ? ` (honua-server@${pin})` : ""}`;
  if (!existsSync(file)) {
    return {
      status: "blocked",
      source,
      reason: `no vendored roster: ${ROSTER_REPO_PATH} does not exist at the pinned honua-server@${pin ?? "(unpinned)"} yet`,
    };
  }
  try {
    return { status: "loaded", roster: parseRoster(JSON.parse(readFileSync(file, "utf8"))), source };
  } catch (err) {
    return { status: "blocked", source, reason: `vendored roster is malformed: ${errorMessage(err)}` };
  }
}

export interface ResolveRosterOptions {
  env?: NodeJS.ProcessEnv;
  fetchFn?: typeof fetch;
}

/**
 * Resolve the roster a live certification compares against:
 *   1. `HONUA_MCP_ROSTER_FILE` — an explicit local roster file;
 *   2. the server sha `HONUA_MCP_ROSTER_SERVER_SHA` (the candidate's
 *      `ADMIN_RELEASE_SERVER_SHA`), defaulting to the vendored provenance pin:
 *      the vendored copy when it is pinned to that sha, otherwise the raw file
 *      fetched from honua-server at that sha.
 * Any failure resolves to `blocked` with the reason, never to a pass.
 */
export async function resolveRoster(options: ResolveRosterOptions = {}): Promise<RosterResolution> {
  const env = options.env ?? process.env;
  const file = env.HONUA_MCP_ROSTER_FILE?.trim();
  if (file) {
    try {
      return { status: "loaded", roster: parseRoster(JSON.parse(readFileSync(file, "utf8"))), source: file };
    } catch (err) {
      return { status: "blocked", source: file, reason: `roster file unreadable: ${errorMessage(err)}` };
    }
  }

  const sha = env.HONUA_MCP_ROSTER_SERVER_SHA?.trim() || vendoredRosterPin();
  if (!sha) {
    return {
      status: "blocked",
      source: "(none)",
      reason: "no honua-server sha to read the roster at (set HONUA_MCP_ROSTER_SERVER_SHA)",
    };
  }
  if (!/^[0-9a-f]{7,40}$/.test(sha)) {
    return { status: "blocked", source: sha, reason: `HONUA_MCP_ROSTER_SERVER_SHA is not a commit sha: ${sha}` };
  }

  if (vendoredRosterPin() === sha) {
    const vendored = loadVendoredRoster();
    if (vendored.status === "loaded") {
      return vendored;
    }
  }

  const url = rosterUrl(sha);
  const fetchFn = options.fetchFn ?? fetch;
  // honua-server may be private to this workflow's token; a read token makes a
  // 404 mean "absent at that sha" rather than "not visible".
  const token = env.HONUA_MCP_ROSTER_TOKEN?.trim();
  try {
    const response = await fetchFn(url, {
      redirect: "follow",
      ...(token ? { headers: { Authorization: `token ${token}` } } : {}),
    });
    if (response.status === 404) {
      return {
        status: "blocked",
        source: url,
        reason: token
          ? `${ROSTER_REPO_PATH} does not exist at honua-server@${sha} (the roster has not reached the pinned server sha yet)`
          : `${ROSTER_REPO_PATH} not found at honua-server@${sha}: absent at that sha, or not readable without HONUA_MCP_ROSTER_TOKEN`,
      };
    }
    if (!response.ok) {
      return { status: "blocked", source: url, reason: `roster fetch failed with HTTP ${response.status}` };
    }
    return { status: "loaded", roster: parseRoster(await response.json()), source: url };
  } catch (err) {
    return { status: "blocked", source: url, reason: `roster fetch failed: ${errorMessage(err)}` };
  }
}

export interface RosterParityOptions {
  /**
   * Whether the certified topology has a durable control plane (Redis). When
   * false, the `requiresDurableControlPlane` names may legitimately be absent.
   */
  durableControlPlane: boolean;
}

export interface RosterParityResult {
  ok: boolean;
  /** Advertised names the roster does not list in `static ∪ projectedAdmin`. */
  unrostered: string[];
  /** `views.default` names the surface did not advertise. */
  missingDefault: string[];
  /** Retired names the surface still advertises. */
  retiredAdvertised: string[];
  /** `views.default` names absent only because the topology lacks a durable control plane. */
  tolerated: string[];
}

/**
 * Compare a surface's advertised `tools/list` names with the roster:
 *   - every advertised name ∈ `static ∪ projectedAdmin`;
 *   - every `views.default` name is advertised (the certifier connects without a
 *     workflow-view selector, i.e. the default view);
 *   - no `retired` name is advertised;
 *   - without a durable control plane, `requiresDurableControlPlane` names may be absent.
 */
export function checkRosterParity(
  advertised: Iterable<string>,
  roster: McpToolRoster,
  options: RosterParityOptions,
): RosterParityResult {
  const advertisedSet = new Set(advertised);
  const known = advertisableNames(roster);
  const durableOnly = new Set(roster.requiresDurableControlPlane);
  const retired = new Set(roster.retired);

  const unrostered = [...advertisedSet].filter((name) => !known.has(name) && !retired.has(name)).sort();
  const retiredAdvertised = [...advertisedSet].filter((name) => retired.has(name)).sort();
  const missingDefault: string[] = [];
  const tolerated: string[] = [];
  for (const name of roster.views.default) {
    if (advertisedSet.has(name)) continue;
    if (!options.durableControlPlane && durableOnly.has(name)) {
      tolerated.push(name);
    } else {
      missingDefault.push(name);
    }
  }
  missingDefault.sort();
  tolerated.sort();
  return {
    ok: unrostered.length === 0 && missingDefault.length === 0 && retiredAdvertised.length === 0,
    unrostered,
    missingDefault,
    retiredAdvertised,
    tolerated,
  };
}

/** One-line human summary of a parity result. */
export function describeRosterParity(result: RosterParityResult, advertisedCount: number): string {
  if (result.ok) {
    const tolerated =
      result.tolerated.length > 0
        ? `; ${result.tolerated.length} durable-control-plane tool(s) absent on this topology: ${result.tolerated.join(", ")}`
        : "";
    return `all ${advertisedCount} advertised tools are rostered, views.default is fully advertised, no retired tool is advertised${tolerated}`;
  }
  const parts: string[] = [];
  if (result.retiredAdvertised.length > 0)
    parts.push(`retired tool(s) advertised: ${result.retiredAdvertised.join(", ")}`);
  if (result.unrostered.length > 0) parts.push(`advertised but not in roster: ${result.unrostered.join(", ")}`);
  if (result.missingDefault.length > 0)
    parts.push(`views.default tool(s) not advertised: ${result.missingDefault.join(", ")}`);
  return parts.join("; ");
}

/** Whether the certified topology has a durable control plane (default: yes). */
export function resolveDurableControlPlane(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (env.HONUA_MCP_CERT_TOPOLOGY ?? "durable").trim().toLowerCase();
  return raw !== "redis-off" && raw !== "ephemeral";
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
