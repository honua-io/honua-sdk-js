/**
 * Typed error channel for {@link McpClient}.
 *
 * **Origin.** Ported verbatim from `honua-studio`'s `src/mcp/errors.ts`
 * (honua-studio#7 REQ-001), where it is zero-import, DOM-free, and
 * node-tested.
 *
 * Three distinguishable failure classes, mirroring the layering the
 * honua-server MCP contract itself draws (transport vs. JSON-RPC protocol vs.
 * tool-level result):
 *
 *  - {@link McpTransportError} — the HTTP request itself failed (network,
 *    non-2xx with no parseable JSON-RPC envelope, malformed body).
 *  - {@link McpProtocolError} — a JSON-RPC-level error (`response.error`,
 *    e.g. `-32600 invalid_request`, `-32601 method not found`,
 *    `-32602 invalid params`) — the envelope round-tripped but the request
 *    itself was rejected before any tool ran.
 *  - {@link McpToolError} — a tool ran and reported failure
 *    (`result.isError: true`) with a structured `code`.
 *
 * {@link isMcpGenerationConflict} is the one discriminant the session
 * branches on by name — it is what triggers the single reload+retry against a
 * fresh draft generation.
 *
 * @module
 */

import type { McpToolErrorCode } from "./mcp-protocol.js";

export class McpTransportError extends Error {
  public readonly cause?: unknown;

  public constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "McpTransportError";
    this.cause = cause;
  }
}

/** A JSON-RPC-level error (`response.error`) — the request was rejected before any tool logic ran. */
export class McpProtocolError extends Error {
  public readonly code: number;
  public readonly data: unknown;

  public constructor(message: string, code: number, data?: unknown) {
    super(message);
    this.name = "McpProtocolError";
    this.code = code;
    this.data = data;
  }
}

/**
 * A tool-level failure (`tools/call` result with `isError: true`). `code`
 * follows the honua-server MCP error contract's vocabulary when the server
 * supplies one; `"unknown"` when the result carried no recognizable
 * structured error (see `./mcp-client.ts`'s `parseToolError`).
 */
export class McpToolError extends Error {
  public readonly code: McpToolErrorCode;
  public readonly toolName: string;
  public readonly data: unknown;

  public constructor(message: string, code: McpToolErrorCode, toolName: string, data?: unknown) {
    super(message);
    this.name = "McpToolError";
    this.code = code;
    this.toolName = toolName;
    this.data = data;
  }
}

/** True only for the optimistic-concurrency discriminant (`failed_precondition` from a Studio draft generation check). */
export function isMcpGenerationConflict(error: unknown): error is McpToolError {
  return error instanceof McpToolError && error.code === "failed_precondition";
}

export function isMcpNotFound(error: unknown): error is McpToolError {
  return error instanceof McpToolError && error.code === "not_found";
}

export function isMcpToolError(error: unknown): error is McpToolError {
  return error instanceof McpToolError;
}
