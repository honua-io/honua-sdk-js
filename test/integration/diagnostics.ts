/**
 * Failure-diagnostic helpers shared across integration tests. Tests run a
 * public SDK call inside {@link runWithDiagnostics}, which captures the
 * last request the {@link createDiagnosticsInterceptor} interceptor saw
 * and rewrites any thrown error message to include the SDK method name,
 * request path, HTTP status, and a bounded response body excerpt.
 *
 * Failures must be actionable from the CI log alone — that is why the
 * integration lane wires this helper into every test, instead of relying
 * on raw `vitest` assertion output.
 *
 * @module
 */
import {
  HonuaAbortError,
  type HonuaErrorContext,
  HonuaHttpError,
  HonuaNetworkError,
  type HonuaRequestInterceptor,
  type HonuaResponseContext,
  HonuaTimeoutError,
} from "@honua/sdk-js";

/** Maximum response body characters preserved in failure messages. */
export const MAX_BODY_EXCERPT_CHARS = 500;

/**
 * Per-test diagnostic state populated by the request interceptor that
 * {@link createDiagnosticsInterceptor} returns. The integration suite
 * mutates this object in place (last write wins) so the wrapper around
 * each SDK call can assemble a complete failure message even when the
 * thrown error is not a {@link HonuaHttpError}.
 */
export interface DiagnosticsContext {
  lastPath?: string;
  lastMethod?: string;
  lastStatus?: number;
  lastBodySummary?: string;
  lastDurationMs?: number;
}

/**
 * Build a {@link HonuaRequestInterceptor} that records the most recent
 * request, response, and error into `context`. Tests share one context
 * per test (see {@link runWithDiagnostics}) so concurrent requests never
 * stomp on each other; the integration suite runs files serially via
 * `vitest.integration.config.ts` (`fileParallelism: false`).
 */
export function createDiagnosticsInterceptor(context: DiagnosticsContext): HonuaRequestInterceptor {
  return {
    before(request) {
      context.lastPath = request.path;
      context.lastMethod = request.method;
      context.lastStatus = undefined;
      context.lastBodySummary = undefined;
      context.lastDurationMs = undefined;
    },
    async after(response: HonuaResponseContext) {
      context.lastStatus = response.response.status;
      context.lastDurationMs = response.durationMs;
    },
    async error(failure: HonuaErrorContext) {
      context.lastDurationMs = failure.durationMs;
      const error = failure.error;
      if (error instanceof HonuaHttpError) {
        context.lastStatus = error.statusCode;
        context.lastBodySummary = summarizeBody(error.body);
      } else if (error instanceof HonuaTimeoutError) {
        context.lastStatus = 0;
        context.lastBodySummary = `timeout after ${error.timeoutMs}ms`;
      } else if (error instanceof HonuaNetworkError) {
        context.lastStatus = 0;
        context.lastBodySummary = `network error: ${error.message}`;
      } else if (error instanceof HonuaAbortError) {
        context.lastStatus = 0;
        context.lastBodySummary = "request aborted";
      } else if (error instanceof Error) {
        context.lastBodySummary = error.message;
      }
    },
  };
}

/**
 * Render the diagnostic block appended to integration-test failure
 * messages. The format is intentionally line-oriented so log scrapers
 * can extract any one field with `grep`.
 */
export function formatFailureContext(method: string, context: DiagnosticsContext): string {
  const lines: string[] = [
    "[honua-integration]",
    `  SDK method   : ${method}`,
    `  Request path : ${context.lastPath ?? "(no request observed)"}`,
    `  HTTP method  : ${context.lastMethod ?? "(unknown)"}`,
    `  HTTP status  : ${context.lastStatus !== undefined ? String(context.lastStatus) : "(no response)"}`,
  ];
  if (context.lastDurationMs !== undefined) {
    lines.push(`  Duration ms  : ${context.lastDurationMs.toFixed(1)}`);
  }
  lines.push(`  Body excerpt : ${context.lastBodySummary ?? "(empty body)"}`);
  return lines.join("\n");
}

/**
 * Wrap a single SDK invocation so that a thrown error carries the
 * shared diagnostic block. This is the canonical way every integration
 * test should call into the SDK — never call SDK methods directly with
 * `await`, because the bare exception will not include the request path
 * or response body that CI logs need to triage drift.
 *
 * Usage:
 * ```ts
 * const features = await runWithDiagnostics(
 *   diagnostics,
 *   "client.featureLayer().queryFeatures",
 *   () => client.featureLayer(serviceId, layerId).queryFeatures({ where: "1=1" }),
 * );
 * ```
 */
export async function runWithDiagnostics<T>(
  context: DiagnosticsContext,
  method: string,
  fn: () => Promise<T>,
): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    const block = formatFailureContext(method, context);
    if (error instanceof Error) {
      error.message = `${error.message}\n${block}`;
      throw error;
    }
    throw new Error(`${String(error)}\n${block}`);
  }
}

function summarizeBody(body: unknown): string {
  if (body === undefined || body === null) {
    return "(empty body)";
  }
  let serialized: string;
  if (typeof body === "string") {
    serialized = body;
  } else {
    try {
      serialized = JSON.stringify(body);
    } catch {
      serialized = String(body);
    }
  }
  if (serialized.length > MAX_BODY_EXCERPT_CHARS) {
    return `${serialized.slice(0, MAX_BODY_EXCERPT_CHARS)}… [truncated, original ${serialized.length} chars]`;
  }
  return serialized;
}
