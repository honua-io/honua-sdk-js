import { randomUUID } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";

import {
  type HonuaAuthCredentials,
  type HonuaAuthCredentialsProvider,
  HonuaClient,
  type HonuaClientOptions,
  type HonuaErrorContext,
  HonuaHttpError,
  HonuaNetworkError,
  type HonuaRequestContext,
  type HonuaRequestInterceptor,
  type HonuaResponseContext,
  HonuaTimeoutError,
  isHonuaError,
} from "@honua/sdk-js/honua";

export interface NodeBackendQuickstartConfig {
  readonly host: string;
  readonly port: number;
  readonly honuaBaseUrl: string;
  readonly serviceId: string;
  readonly layerId: number;
  readonly ogcCollectionId: string;
  readonly apiKey?: string;
  readonly serviceAccountToken?: string;
  readonly serviceAccountTokenTtlMs: number;
  readonly timeoutMs: number;
  readonly retryMaxRetries: number;
  readonly retryBaseDelayMs: number;
  readonly retryMaxDelayMs: number;
  readonly maxFeatureLimit: number;
  readonly defaultFeatureLimit: number;
}

export interface NodeBackendLogger {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

export interface StartNodeBackendQuickstartServerOptions {
  readonly config?: Partial<NodeBackendQuickstartConfig>;
  readonly client?: HonuaClient;
  readonly logger?: NodeBackendLogger;
  readonly fetchFn?: typeof fetch;
  readonly now?: () => number;
}

export interface NodeBackendQuickstartServer {
  readonly server: http.Server;
  readonly url: string;
  close(): Promise<void>;
}

interface RequestContext {
  readonly requestId: string;
  readonly requestUrl: URL;
}

class RouteError extends Error {
  public readonly statusCode: number;
  public readonly code: string;

  public constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.name = "RouteError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

const DEFAULT_CONFIG: NodeBackendQuickstartConfig = {
  host: "127.0.0.1",
  port: 8787,
  honuaBaseUrl: "http://127.0.0.1:4455",
  serviceId: "CivicRequests",
  layerId: 0,
  ogcCollectionId: "civic-requests",
  serviceAccountTokenTtlMs: 5 * 60 * 1000,
  timeoutMs: 5_000,
  retryMaxRetries: 2,
  retryBaseDelayMs: 100,
  retryMaxDelayMs: 1_000,
  maxFeatureLimit: 100,
  defaultFeatureLimit: 5,
};

export const consoleJsonLogger: NodeBackendLogger = {
  info(message, fields) {
    writeConsoleLog("info", message, fields);
  },
  warn(message, fields) {
    writeConsoleLog("warn", message, fields);
  },
  error(message, fields) {
    writeConsoleLog("error", message, fields);
  },
};

export function createNodeBackendQuickstartConfig(
  overrides: Partial<NodeBackendQuickstartConfig> = {},
): NodeBackendQuickstartConfig {
  return {
    ...DEFAULT_CONFIG,
    ...overrides,
  };
}

export function loadNodeBackendQuickstartConfig(env: NodeJS.ProcessEnv = process.env): NodeBackendQuickstartConfig {
  return createNodeBackendQuickstartConfig({
    host: env.HONUA_NODE_BACKEND_HOST ?? env.HOST ?? DEFAULT_CONFIG.host,
    port: readIntegerEnv(env.HONUA_NODE_BACKEND_PORT ?? env.PORT, DEFAULT_CONFIG.port),
    honuaBaseUrl: env.HONUA_BASE_URL ?? DEFAULT_CONFIG.honuaBaseUrl,
    serviceId: env.HONUA_SERVICE_ID ?? DEFAULT_CONFIG.serviceId,
    layerId: readIntegerEnv(env.HONUA_LAYER_ID, DEFAULT_CONFIG.layerId),
    ogcCollectionId: env.HONUA_OGC_COLLECTION_ID ?? DEFAULT_CONFIG.ogcCollectionId,
    apiKey: emptyToUndefined(env.HONUA_API_KEY ?? env.HONUA_SERVICE_ACCOUNT_API_KEY),
    serviceAccountToken: emptyToUndefined(env.HONUA_SERVICE_ACCOUNT_TOKEN),
    serviceAccountTokenTtlMs: readIntegerEnv(
      env.HONUA_SERVICE_ACCOUNT_TOKEN_TTL_MS,
      DEFAULT_CONFIG.serviceAccountTokenTtlMs,
    ),
    timeoutMs: readIntegerEnv(env.HONUA_TIMEOUT_MS, DEFAULT_CONFIG.timeoutMs),
    retryMaxRetries: readIntegerEnv(env.HONUA_RETRY_MAX_RETRIES, DEFAULT_CONFIG.retryMaxRetries),
    retryBaseDelayMs: readIntegerEnv(env.HONUA_RETRY_BASE_DELAY_MS, DEFAULT_CONFIG.retryBaseDelayMs),
    retryMaxDelayMs: readIntegerEnv(env.HONUA_RETRY_MAX_DELAY_MS, DEFAULT_CONFIG.retryMaxDelayMs),
    maxFeatureLimit: readIntegerEnv(env.HONUA_MAX_FEATURE_LIMIT, DEFAULT_CONFIG.maxFeatureLimit),
    defaultFeatureLimit: readIntegerEnv(env.HONUA_DEFAULT_FEATURE_LIMIT, DEFAULT_CONFIG.defaultFeatureLimit),
  });
}

export function createHonuaBackendClient(
  config: NodeBackendQuickstartConfig,
  options: {
    readonly logger?: NodeBackendLogger;
    readonly fetchFn?: typeof fetch;
    readonly now?: () => number;
  } = {},
): HonuaClient {
  const logger = options.logger ?? consoleJsonLogger;
  const auth = createServerSideAuthProvider(config, logger, options.now);
  const clientOptions: HonuaClientOptions = {
    baseUrl: config.honuaBaseUrl,
    fetchFn: options.fetchFn,
    timeoutMs: config.timeoutMs,
    retry: {
      maxRetries: config.retryMaxRetries,
      baseDelayMs: config.retryBaseDelayMs,
      maxDelayMs: config.retryMaxDelayMs,
      retryStatuses: [429, 502, 503, 504],
    },
    interceptors: [createLoggingInterceptor(logger)],
  };

  if (auth) {
    clientOptions.auth = auth;
    clientOptions.authRefreshSkewMs = Math.min(60_000, Math.max(0, config.serviceAccountTokenTtlMs / 2));
  }

  return new HonuaClient(clientOptions);
}

export function createServerSideAuthProvider(
  config: NodeBackendQuickstartConfig,
  logger: NodeBackendLogger = consoleJsonLogger,
  now: () => number = Date.now,
): HonuaAuthCredentialsProvider | undefined {
  if (!config.serviceAccountToken && !config.apiKey) {
    return undefined;
  }

  return ({ reason, forceRefresh }): HonuaAuthCredentials | undefined => {
    if (config.serviceAccountToken) {
      logger.info("honua.auth.credentials", {
        mode: "service-account",
        reason,
        forceRefresh,
      });
      return {
        bearerToken: config.serviceAccountToken,
        expiresAt: now() + config.serviceAccountTokenTtlMs,
      };
    }

    if (config.apiKey) {
      logger.info("honua.auth.credentials", {
        mode: "api-key",
        reason,
        forceRefresh,
      });
      return { apiKey: config.apiKey };
    }

    return undefined;
  };
}

export function createNodeBackendQuickstartServer(options: StartNodeBackendQuickstartServerOptions = {}): http.Server {
  const config = createNodeBackendQuickstartConfig(options.config);
  const logger = options.logger ?? consoleJsonLogger;
  const client =
    options.client ??
    createHonuaBackendClient(config, {
      logger,
      fetchFn: options.fetchFn,
      now: options.now,
    });

  return http.createServer(async (req, res) => {
    const requestId = requestIdFromHeaders(req.headers);
    const startedAt = Date.now();
    res.setHeader("x-request-id", requestId);

    try {
      const requestUrl = new URL(req.url ?? "/", "http://127.0.0.1");
      await routeRequest(req, res, {
        config,
        client,
        logger,
        context: { requestId, requestUrl },
      });
    } catch (error) {
      writeProblemResponse(res, error, requestId, logger);
    } finally {
      logger.info("http.request.complete", {
        requestId,
        method: req.method ?? "GET",
        path: new URL(req.url ?? "/", "http://127.0.0.1").pathname,
        statusCode: res.statusCode,
        durationMs: Date.now() - startedAt,
      });
    }
  });
}

export async function startNodeBackendQuickstartServer(
  options: StartNodeBackendQuickstartServerOptions = {},
): Promise<NodeBackendQuickstartServer> {
  const config = createNodeBackendQuickstartConfig(options.config);
  const server = createNodeBackendQuickstartServer({
    ...options,
    config,
  });
  await listen(server, config.port, config.host);
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to bind Node backend quickstart server.");
  }

  return {
    server,
    url: `http://${address.address}:${address.port}`,
    async close() {
      await closeServer(server);
    },
  };
}

function createLoggingInterceptor(logger: NodeBackendLogger): HonuaRequestInterceptor {
  return {
    before(context: HonuaRequestContext) {
      logger.info("honua.request.start", {
        method: context.method,
        path: pathWithoutQuery(context.path),
      });
    },
    after(context: HonuaResponseContext) {
      logger.info("honua.request.complete", {
        method: context.request.method,
        path: pathWithoutQuery(context.request.path),
        statusCode: context.response.status,
        durationMs: Math.round(context.durationMs),
      });
    },
    error(context: HonuaErrorContext) {
      logger.error("honua.request.error", {
        method: context.request.method,
        path: pathWithoutQuery(context.request.path),
        errorName: errorName(context.error),
        statusCode: context.error instanceof HonuaHttpError ? context.error.statusCode : undefined,
        durationMs: context.durationMs === undefined ? undefined : Math.round(context.durationMs),
      });
    },
  };
}

async function routeRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  options: {
    readonly config: NodeBackendQuickstartConfig;
    readonly client: HonuaClient;
    readonly logger: NodeBackendLogger;
    readonly context: RequestContext;
  },
): Promise<void> {
  if (req.method === "OPTIONS") {
    res.writeHead(204, commonHeaders());
    res.end();
    return;
  }

  if (req.method !== "GET") {
    throw new RouteError(405, "method_not_allowed", "Only GET requests are supported by this sample API.");
  }

  const pathname = options.context.requestUrl.pathname;
  if (pathname === "/" || pathname === "/health") {
    writeJson(res, 200, {
      status: "ok",
      serviceId: options.config.serviceId,
      layerId: options.config.layerId,
      ogcCollectionId: options.config.ogcCollectionId,
    });
    return;
  }

  if (pathname === "/api/services") {
    await handleListServices(res, options.client, options.context);
    return;
  }

  if (pathname === "/api/features") {
    await handleQueryFeatures(res, options.config, options.client, options.context);
    return;
  }

  if (pathname === "/api/ogc/items") {
    await handleOgcItems(res, options.config, options.client, options.context);
    return;
  }

  throw new RouteError(404, "not_found", `No route is registered for ${pathname}.`);
}

async function handleListServices(
  res: http.ServerResponse,
  client: HonuaClient,
  context: RequestContext,
): Promise<void> {
  const refresh = parseBoolean(context.requestUrl.searchParams.get("refresh"), false);
  const response = await client.listServices({ refresh });
  writeJson(res, 200, {
    source: "honua",
    services: response.services ?? [],
    cache: response.cache,
  });
}

async function handleQueryFeatures(
  res: http.ServerResponse,
  config: NodeBackendQuickstartConfig,
  client: HonuaClient,
  context: RequestContext,
): Promise<void> {
  const params = context.requestUrl.searchParams;
  const limit = readLimit(params.get("limit"), config);
  const where = params.get("where") ?? "1=1";
  const outFields = readOutFields(params.get("outFields"));
  const returnGeometry = parseBoolean(params.get("returnGeometry"), true);
  const response = await client.queryFeatures({
    serviceId: config.serviceId,
    layerId: config.layerId,
    where,
    outFields,
    returnGeometry,
    outSr: 4326,
    resultRecordCount: limit,
    method: "GET",
  });

  writeJson(res, 200, {
    source: "FeatureServer",
    serviceId: config.serviceId,
    layerId: config.layerId,
    count: response.features?.length ?? 0,
    exceededTransferLimit: response.exceededTransferLimit ?? false,
    fields: response.fields ?? [],
    features: response.features ?? [],
  });
}

async function handleOgcItems(
  res: http.ServerResponse,
  config: NodeBackendQuickstartConfig,
  client: HonuaClient,
  context: RequestContext,
): Promise<void> {
  const params = context.requestUrl.searchParams;
  const collectionId = params.get("collection") ?? config.ogcCollectionId;
  const response = await client.listOgcItems({
    collectionId,
    limit: readLimit(params.get("limit"), config),
    bbox: emptyToUndefined(params.get("bbox")),
    filter: emptyToUndefined(params.get("filter")),
  });

  writeJson(res, 200, {
    source: "ogc-features",
    collectionId,
    count: response.features.length,
    featureCollection: response,
  });
}

function writeJson(res: http.ServerResponse, statusCode: number, body: unknown): void {
  res.writeHead(statusCode, commonHeaders());
  res.end(JSON.stringify(body));
}

function writeProblemResponse(
  res: http.ServerResponse,
  error: unknown,
  requestId: string,
  logger: NodeBackendLogger,
): void {
  if (res.headersSent) {
    res.end();
    return;
  }

  const problem = problemFromError(error, requestId);
  logger.error("http.request.error", {
    requestId,
    code: problem.error.code,
    statusCode: problem.error.status,
    errorName: errorName(error),
  });
  writeJson(res, problem.error.status, problem);
}

function problemFromError(
  error: unknown,
  requestId: string,
): {
  error: {
    status: number;
    code: string;
    message: string;
    requestId: string;
    upstreamStatus?: number;
  };
} {
  if (error instanceof RouteError) {
    return {
      error: {
        status: error.statusCode,
        code: error.code,
        message: error.message,
        requestId,
      },
    };
  }

  if (error instanceof HonuaTimeoutError) {
    return {
      error: {
        status: 504,
        code: "honua_timeout",
        message: "Honua request timed out.",
        requestId,
      },
    };
  }

  if (error instanceof HonuaNetworkError) {
    return {
      error: {
        status: 502,
        code: "honua_network_error",
        message: "Honua request failed before a response was received.",
        requestId,
      },
    };
  }

  if (error instanceof HonuaHttpError) {
    return {
      error: {
        status: 502,
        code: "honua_upstream_error",
        message: "Honua returned an unsuccessful upstream response.",
        requestId,
        upstreamStatus: error.statusCode,
      },
    };
  }

  if (isHonuaError(error)) {
    return {
      error: {
        status: 502,
        code: "honua_sdk_error",
        message: error.message,
        requestId,
      },
    };
  }

  return {
    error: {
      status: 500,
      code: "internal_error",
      message: "The backend sample encountered an unexpected error.",
      requestId,
    },
  };
}

function readLimit(value: string | null, config: NodeBackendQuickstartConfig): number {
  if (value === null || value.trim() === "") {
    return config.defaultFeatureLimit;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) {
    throw new RouteError(400, "invalid_limit", "limit must be an integer.");
  }
  if (parsed < 1 || parsed > config.maxFeatureLimit) {
    throw new RouteError(400, "invalid_limit", `limit must be between 1 and ${config.maxFeatureLimit}.`);
  }
  return parsed;
}

function readOutFields(value: string | null): string[] {
  if (!value) {
    return ["*"];
  }
  const fields = value
    .split(",")
    .map((field) => field.trim())
    .filter((field) => field.length > 0);
  return fields.length > 0 ? fields : ["*"];
}

function parseBoolean(value: string | null, fallback: boolean): boolean {
  if (value === null || value === "") {
    return fallback;
  }
  return ["1", "true", "yes", "y"].includes(value.toLowerCase());
}

function readIntegerEnv(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : fallback;
}

function emptyToUndefined(value: string | null | undefined): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function requestIdFromHeaders(headers: http.IncomingHttpHeaders): string {
  const value = headers["x-request-id"];
  if (typeof value === "string" && value.trim().length > 0) {
    return value;
  }
  return randomUUID();
}

function commonHeaders(): Record<string, string> {
  return {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, OPTIONS",
    "access-control-allow-headers": "content-type, x-request-id",
  };
}

function pathWithoutQuery(path: string): string {
  return path.split("?", 1)[0] ?? path;
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

function writeConsoleLog(level: "info" | "warn" | "error", message: string, fields?: Record<string, unknown>): void {
  const entry = JSON.stringify({
    level,
    message,
    time: new Date().toISOString(),
    ...fields,
  });
  if (level === "error") {
    console.error(entry);
    return;
  }
  console.log(entry);
}

async function closeServer(server: http.Server): Promise<void> {
  if (!server.listening) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

async function listen(server: http.Server, port: number, host: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const server = await startNodeBackendQuickstartServer({
    config: loadNodeBackendQuickstartConfig(),
  });
  const address = server.server.address() as AddressInfo;
  process.stdout.write(`nodeBackendQuickstartUrl=http://${address.address}:${address.port}\n`);

  const shutdown = async () => {
    await server.close();
    process.exit(0);
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}
