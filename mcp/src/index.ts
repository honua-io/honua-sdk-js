#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { HonuaClient } from "@honua/sdk-js";
import type { HonuaTransport } from "@honua/sdk-js";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { type NlMapControlMcpHost, registerNlMapControlMcpTools } from "./nl-map-control.js";
import * as layerSchemaResource from "./resources/layer-schema.js";
import * as servicesResource from "./resources/services.js";
import * as stylesResource from "./resources/styles.js";
import * as applyStylePreset from "./tools/apply-style-preset.js";
import * as countFeatures from "./tools/count-features.js";
import * as describeLayer from "./tools/describe-layer.js";
import * as explainCapabilityGap from "./tools/explain-capability-gap.js";
import * as getExtent from "./tools/get-extent.js";
import * as getStyle from "./tools/get-style.js";
import * as listServices from "./tools/list-services.js";
import * as listSources from "./tools/list-sources.js";
import * as queryFeatures from "./tools/query-features.js";
import * as statistics from "./tools/statistics.js";

export {
  createNlMapControlMcpHost,
  registerNlMapControlMcpTools,
} from "./nl-map-control.js";
export type {
  CreateNlMapControlMcpHostOptions,
  McpNlMapExecutionResponse,
  McpNlMapPlanResponse,
  McpNlMapReceipt,
  NlMapControlMcpHost,
  NlMapControlMcpRequestContext,
} from "./nl-map-control.js";

export interface RuntimeOptions {
  baseUrl: string;
  apiKey: string | undefined;
  transport: HonuaTransport;
  timeoutMs: number;
  retryMaxRetries: number;
}

export interface CreateServerOptions {
  /** Optional BYO-LLM/map-runtime host for the experimental NL map-plan tools. */
  readonly nlMapControl?: NlMapControlMcpHost;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_SERVER_VERSION = "0.0.3-alpha.0";

export const SERVER_VERSION = resolveServerVersion();

function resolveServerVersion(): string {
  try {
    const packageJsonPath = new URL("../../package.json", import.meta.url);
    const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { version?: unknown };
    if (typeof packageJson.version === "string" && packageJson.version.length > 0) {
      return packageJson.version;
    }
  } catch {
    // Fall back to a static version if package metadata is unavailable.
  }

  return DEFAULT_SERVER_VERSION;
}

function parsePositiveInteger(env: NodeJS.ProcessEnv, name: string, defaultValue: number): number {
  const raw = env[name];
  if (raw === undefined) {
    return defaultValue;
  }

  const normalized = raw.trim();
  if (!/^\d+$/.test(normalized)) {
    throw new Error(`${name} must be a positive integer, received "${raw}"`);
  }

  const parsed = Number.parseInt(normalized, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer, received "${raw}"`);
  }

  return parsed;
}

function parseNonNegativeInteger(env: NodeJS.ProcessEnv, name: string, defaultValue: number): number {
  const raw = env[name];
  if (raw === undefined) {
    return defaultValue;
  }

  const normalized = raw.trim();
  if (!/^\d+$/.test(normalized)) {
    throw new Error(`${name} must be a non-negative integer, received "${raw}"`);
  }

  const parsed = Number.parseInt(normalized, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer, received "${raw}"`);
  }

  return parsed;
}

function isLoopbackHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1" || normalized === "[::1]";
}

export function resolveRuntimeOptions(env: NodeJS.ProcessEnv): RuntimeOptions {
  const baseUrl = env.HONUA_BASE_URL;
  if (!baseUrl) {
    throw new Error("HONUA_BASE_URL environment variable is required.");
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(baseUrl);
  } catch {
    throw new Error(`HONUA_BASE_URL must be a valid absolute URL: ${baseUrl}`);
  }

  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    throw new Error(`HONUA_BASE_URL must use http or https: ${baseUrl}`);
  }

  const apiKey = env.HONUA_API_KEY;
  if (apiKey && parsedUrl.protocol === "http:" && !isLoopbackHost(parsedUrl.hostname)) {
    throw new Error(
      "HONUA_API_KEY over non-local HTTP is not allowed. Use HTTPS, or use localhost for local development.",
    );
  }

  const rawTransportInput = env.HONUA_TRANSPORT ?? "grpc-web";
  const normalizedTransport = rawTransportInput.trim().toLowerCase();
  const transport: HonuaTransport | undefined =
    normalizedTransport === "grpc-web" || normalizedTransport === "grpc" || normalizedTransport === "grcp"
      ? "grpc-web"
      : normalizedTransport === "rest"
        ? "rest"
        : undefined;
  if (!transport) {
    throw new Error(
      `HONUA_TRANSPORT must be "grpc-web" (aliases: "grpc", "grcp") or "rest", received "${rawTransportInput}"`,
    );
  }

  const timeoutMs = parsePositiveInteger(env, "HONUA_TIMEOUT_MS", DEFAULT_TIMEOUT_MS);
  const retryMaxRetries = parseNonNegativeInteger(env, "HONUA_RETRY_MAX_RETRIES", DEFAULT_MAX_RETRIES);

  return {
    baseUrl: parsedUrl.toString(),
    apiKey,
    transport,
    timeoutMs,
    retryMaxRetries,
  };
}

export function createClientFromEnv(env: NodeJS.ProcessEnv = process.env): HonuaClient {
  const options = resolveRuntimeOptions(env);
  return new HonuaClient({
    baseUrl: options.baseUrl,
    apiKey: options.apiKey,
    transport: options.transport,
    timeoutMs: options.timeoutMs,
    retry: options.retryMaxRetries > 0 ? { maxRetries: options.retryMaxRetries } : undefined,
  });
}

/**
 * The PLATFORM-FREE standalone MCP surface (issue #369).
 *
 * This is the direct-SDK operator surface: ten read-only geospatial tools wired
 * straight onto `@honua/sdk-js`. Point it at ANY public FeatureServer / OGC API /
 * STAC / WFS / OData endpoint with ZERO Honua-server assumptions — no admin API,
 * no `/healthz`, no `/mcp` catalog. This is what the `honua-mcp` bin runs (see
 * {@link runStandalone}), and what the platform-free certification lanes + eval
 * corpora exercise.
 *
 * The tool contract is PROTOCOL-NEUTRAL (issue #1005): sources are addressed by
 * a `<protocol>:<address>` reference (`honua_list_sources` emits them), filters
 * are the SDK's typed semantic filter, geometry is GeoJSON, and execution goes
 * through the canonical `Dataset`/`Source`/`Query`/`Result` contract so one call
 * means the same thing on every protocol. The GeoServices `serviceId`/`layerId`
 * pair is still accepted as a deprecated compatibility input; no tool schema
 * requires an Esri-only field.
 *
 * Tools that need a Honua-only surface (server-side styling via OGC API – Styles,
 * a `/rest/services` catalog) degrade gracefully on a plain target: they return a
 * structured "not available on this target" result rather than crashing or
 * returning misleading empty data (see `capability.ts`).
 *
 * The Honua-ENHANCED surface — the full `/mcp` operator catalog with governed
 * mutation, jobs, and publishing — is a superset reached over streamable-HTTP and
 * mirrored to stdio by `honua-mcp-proxy` ({@link runProxy}); it requires a Honua
 * deployment. Standalone is the front door; the proxy is the upgrade path.
 */
export function createServer(client: HonuaClient, options: CreateServerOptions = {}) {
  const server = new McpServer({
    name: "honua",
    version: SERVER_VERSION,
  });

  // ── Tools ──────────────────────────────────────────────────────

  server.tool(
    "honua_list_sources",
    'Discover queryable sources on this endpoint, across protocols. Returns protocol-neutral `<protocol>:<address>` source references (e.g. "ogc-features:hotels", "geoservices-feature-service:Parks/0") to pass verbatim to the query tools, plus each source\'s capabilities. Each protocol family degrades independently with a reason.',
    listSources.schema.shape,
    async (args) => listSources.execute(client, listSources.schema.parse(args)),
  );

  server.tool(
    "honua_list_services",
    "[GeoServices-specific; prefer honua_list_sources] Discover feature services on a FeatureServer folder. Set includeDetails=true for descriptions, layer counts, and spatial references. Degrades gracefully when the target has no service catalog.",
    listServices.schema.shape,
    async (args) => listServices.execute(client, listServices.schema.parse(args)),
  );

  if (options.nlMapControl) {
    registerNlMapControlMcpTools(server, options.nlMapControl);
  }

  server.tool(
    "honua_describe_layer",
    "Describe a source: its protocol, the capabilities it actually supports, field schema, geometry type, and extent. Address it with `source` (from honua_list_sources); the serviceId/layerId pair is deprecated but still accepted.",
    describeLayer.schema.shape,
    async (args) => describeLayer.execute(client, describeLayer.schema.parse(args)),
  );

  server.tool(
    "honua_query_features",
    "Query features from any supported protocol. Address the source with `source`; filter with the typed protocol-neutral `filter`, a GeoJSON `geometry` or `bbox` plus `spatialRel`, and `temporal`. returnGeometry defaults to false to save tokens. A construct the backing protocol cannot express returns a structured capability error, never a silently empty result.",
    queryFeatures.schema.shape,
    async (args) => queryFeatures.execute(client, queryFeatures.schema.parse(args)),
  );

  server.tool(
    "honua_count_features",
    "Count features matching a filter without returning data. Use before querying to check cardinality.",
    countFeatures.schema.shape,
    async (args) => countFeatures.execute(client, countFeatures.schema.parse(args)),
  );

  server.tool(
    "honua_get_extent",
    "Get the spatial bounding box of features matching a filter.",
    getExtent.schema.shape,
    async (args) => getExtent.execute(client, getExtent.schema.parse(args)),
  );

  server.tool(
    "honua_statistics",
    "Compute aggregate statistics (count, sum, avg, min, max, stddev, var) on a field, optionally grouped. Protocols without server-side aggregation answer client-side and report the degradation.",
    statistics.schema.shape,
    async (args) => statistics.execute(client, statistics.schema.parse(args)),
  );

  server.tool(
    "honua_explain_capability_gap",
    "Explain whether a source/protocol supports a capability and suggest a safe fallback when it does not.",
    explainCapabilityGap.schema.shape,
    async (args) => explainCapabilityGap.execute(client, explainCapabilityGap.schema.parse(args)),
  );

  server.tool(
    "honua_get_style",
    "Resolve a style from a server's OGC API – Styles surface. Pass styleId for the canonical StyleRef (style_id, title, encodings incl. inlined MapLibre); omit it to list available styles. On a plain FeatureServer with no styling surface, reports a structured 'not available on this target' result.",
    getStyle.schema.shape,
    async (args) => getStyle.execute(client, getStyle.schema.parse(args)),
  );

  server.tool(
    "honua_apply_style_preset",
    "Resolve a style preset and its MapLibre stylesheet for client-side application. Read-only: returns the stylesheet to apply locally; it does not mutate server state. Degrades gracefully on a target with no styling surface.",
    applyStylePreset.schema.shape,
    async (args) => applyStylePreset.execute(client, applyStylePreset.schema.parse(args)),
  );

  // ── Resources ──────────────────────────────────────────────────

  server.resource("services-catalog", servicesResource.uri, async (uri) => servicesResource.read(client));

  server.resource(
    "layer-schema",
    new ResourceTemplate(layerSchemaResource.uriTemplate, { list: undefined }),
    async (uri, params) =>
      layerSchemaResource.read(client, params.encodedServiceId as string, params.layerId as string),
  );

  server.resource("styles-catalog", stylesResource.uri, async (uri) => stylesResource.readCatalog(client));

  server.resource("style", new ResourceTemplate(stylesResource.uriTemplate, { list: undefined }), async (uri, params) =>
    stylesResource.read(client, params.styleId as string),
  );

  return server;
}

/* v8 ignore start -- live-process entry: wires the stdio transport to a real
   SDK client against HONUA_BASE_URL; exercised by running the bin, not unit tests.
   The unit-testable logic (option resolution, client construction, server wiring)
   lives in the exported functions above and is covered there. */
/**
 * Run the platform-free standalone server end-to-end over stdio.
 *
 * Builds a `HonuaClient` from the environment (`HONUA_BASE_URL` + optional
 * transport/auth) and exposes {@link createServer} — the nine read-only tools —
 * to a stdio MCP client (Claude Desktop / Claude Code / any MCP agent). Point
 * `HONUA_BASE_URL` at any public FeatureServer/OGC endpoint; no Honua server is
 * required. For the Honua-enhanced `/mcp` catalog, use `honua-mcp-proxy` instead.
 */
export async function runStandalone(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const client = createClientFromEnv(env);
  const server = createServer(client);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

/** `honua-mcp` bin entry — the platform-free standalone server. */
async function main() {
  await runStandalone();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    process.stderr.write(`Fatal: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
/* v8 ignore stop */
