import type { HonuaHttpError } from "./errors.js";
import {
  DEFAULT_RETRY_METHODS,
  type NormalizedRetryOptions,
  isAuthRefreshStatus,
  shouldRetryRequest,
} from "./request-pipeline.js";
import type { HonuaRequestContext } from "./types.js";

/** Internal signal thrown from a JSON finalizer when an HTTP 200 carries a GeoServices error envelope. */
export class GeoServicesEnvelopeFailure {
  public constructor(public readonly error: HonuaHttpError) {}
}

export type HttpFailureRecovery =
  | { readonly action: "auth-refresh"; readonly request: HonuaRequestContext }
  | { readonly action: "retry" }
  | { readonly action: "terminal" };

export interface HttpFailureRecoveryContext {
  readonly request: HonuaRequestContext;
  readonly response: Response;
  readonly httpError: HonuaHttpError;
  readonly attempt: number;
  readonly refreshedAuth: boolean;
  readonly readOnlyQuery: boolean;
  readonly retryOptions: NormalizedRetryOptions | undefined;
  readonly hasAuthProvider: boolean;
  readonly retrySignal: AbortSignal | undefined;
  readonly cloneRequest: (request: HonuaRequestContext) => HonuaRequestContext;
  readonly refreshAuth: (
    request: HonuaRequestContext,
    statusCode: number,
    readOnlyQuery: boolean,
  ) => Promise<HonuaRequestContext | undefined>;
  readonly sleepBeforeRetry: (attempt: number, response: Response, signal: AbortSignal | undefined) => Promise<void>;
  readonly beforeReplay?: (
    request: Readonly<HonuaRequestContext>,
    statusCode: number | undefined,
    reason: "authentication" | "retry",
  ) => void | Promise<void>;
}

/** Decide whether a failed HTTP or GeoServices envelope response should refresh auth, retry, or terminate. */
export async function recoverHttpFailure(context: HttpFailureRecoveryContext): Promise<HttpFailureRecovery> {
  const { request, response, httpError, attempt, refreshedAuth, readOnlyQuery, beforeReplay } = context;
  const statusCode = httpError.statusCode;
  const canReplay = DEFAULT_RETRY_METHODS.has(request.method) || readOnlyQuery;

  if (!refreshedAuth && isAuthRefreshStatus(statusCode) && context.hasAuthProvider && canReplay) {
    await beforeReplay?.(context.cloneRequest(request), statusCode, "authentication");
    const refreshed = await context.refreshAuth(request, statusCode, readOnlyQuery);
    if (refreshed) return { action: "auth-refresh", request: refreshed };
  }

  if (shouldRetryRequest(context.retryOptions, request.method, attempt, statusCode, httpError, readOnlyQuery)) {
    await beforeReplay?.(context.cloneRequest(request), statusCode, "retry");
    await context.sleepBeforeRetry(attempt, response, context.retrySignal);
    return { action: "retry" };
  }

  return { action: "terminal" };
}
