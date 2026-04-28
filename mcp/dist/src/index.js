#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { HonuaClient } from "@honua/sdk-js";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as layerSchemaResource from "./resources/layer-schema.js";
import * as servicesResource from "./resources/services.js";
import * as countFeatures from "./tools/count-features.js";
import * as describeLayer from "./tools/describe-layer.js";
import * as getExtent from "./tools/get-extent.js";
import * as listServices from "./tools/list-services.js";
import * as queryFeatures from "./tools/query-features.js";
import * as statistics from "./tools/statistics.js";
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_SERVER_VERSION = "0.0.3-alpha.0";
export const SERVER_VERSION = resolveServerVersion();
function resolveServerVersion() {
    try {
        const packageJsonPath = new URL("../../package.json", import.meta.url);
        const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
        if (typeof packageJson.version === "string" && packageJson.version.length > 0) {
            return packageJson.version;
        }
    }
    catch {
        // Fall back to a static version if package metadata is unavailable.
    }
    return DEFAULT_SERVER_VERSION;
}
function parsePositiveInteger(env, name, defaultValue) {
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
function parseNonNegativeInteger(env, name, defaultValue) {
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
function isLoopbackHost(hostname) {
    const normalized = hostname.toLowerCase();
    return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1" || normalized === "[::1]";
}
export function resolveRuntimeOptions(env) {
    const baseUrl = env.HONUA_BASE_URL;
    if (!baseUrl) {
        throw new Error("HONUA_BASE_URL environment variable is required.");
    }
    let parsedUrl;
    try {
        parsedUrl = new URL(baseUrl);
    }
    catch {
        throw new Error(`HONUA_BASE_URL must be a valid absolute URL: ${baseUrl}`);
    }
    if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
        throw new Error(`HONUA_BASE_URL must use http or https: ${baseUrl}`);
    }
    const apiKey = env.HONUA_API_KEY;
    if (apiKey && parsedUrl.protocol === "http:" && !isLoopbackHost(parsedUrl.hostname)) {
        throw new Error("HONUA_API_KEY over non-local HTTP is not allowed. Use HTTPS, or use localhost for local development.");
    }
    const rawTransportInput = env.HONUA_TRANSPORT ?? "grpc-web";
    const normalizedTransport = rawTransportInput.trim().toLowerCase();
    const transport = normalizedTransport === "grpc-web" || normalizedTransport === "grpc" || normalizedTransport === "grcp"
        ? "grpc-web"
        : normalizedTransport === "rest"
            ? "rest"
            : undefined;
    if (!transport) {
        throw new Error(`HONUA_TRANSPORT must be "grpc-web" (aliases: "grpc", "grcp") or "rest", received "${rawTransportInput}"`);
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
export function createClientFromEnv(env = process.env) {
    const options = resolveRuntimeOptions(env);
    return new HonuaClient({
        baseUrl: options.baseUrl,
        apiKey: options.apiKey,
        transport: options.transport,
        timeoutMs: options.timeoutMs,
        retry: options.retryMaxRetries > 0 ? { maxRetries: options.retryMaxRetries } : undefined,
    });
}
export function createServer(client) {
    const server = new McpServer({
        name: "honua",
        version: SERVER_VERSION,
    });
    // ── Tools ──────────────────────────────────────────────────────
    server.tool("honua_list_services", "Discover all available feature services. Set includeDetails=true for descriptions, layer counts, and spatial references.", listServices.schema.shape, async (args) => listServices.execute(client, listServices.schema.parse(args)));
    server.tool("honua_describe_layer", "Get full schema for a layer — fields, geometry type, extent, relationships.", describeLayer.schema.shape, async (args) => describeLayer.execute(client, describeLayer.schema.parse(args)));
    server.tool("honua_query_features", "Query features with attribute filters, spatial filters, field selection, and pagination. returnGeometry defaults to false to save tokens.", queryFeatures.schema.shape, async (args) => queryFeatures.execute(client, queryFeatures.schema.parse(args)));
    server.tool("honua_count_features", "Count features matching a filter without returning data. Use before querying to check cardinality.", countFeatures.schema.shape, async (args) => countFeatures.execute(client, countFeatures.schema.parse(args)));
    server.tool("honua_get_extent", "Get the spatial bounding box of features matching a filter.", getExtent.schema.shape, async (args) => getExtent.execute(client, getExtent.schema.parse(args)));
    server.tool("honua_statistics", "Compute aggregate statistics (count, sum, avg, min, max, stddev) on a field, optionally grouped.", statistics.schema.shape, async (args) => statistics.execute(client, statistics.schema.parse(args)));
    // ── Resources ──────────────────────────────────────────────────
    server.resource("services-catalog", servicesResource.uri, async (uri) => servicesResource.read(client));
    server.resource("layer-schema", new ResourceTemplate(layerSchemaResource.uriTemplate, { list: undefined }), async (uri, params) => layerSchemaResource.read(client, params.encodedServiceId, params.layerId));
    return server;
}
async function main() {
    const client = createClientFromEnv();
    const server = createServer(client);
    const transport = new StdioServerTransport();
    await server.connect(transport);
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
    main().catch((err) => {
        process.stderr.write(`Fatal: ${err instanceof Error ? err.message : String(err)}\n`);
        process.exit(1);
    });
}
