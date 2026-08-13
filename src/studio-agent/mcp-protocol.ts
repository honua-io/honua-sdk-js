/**
 * JSON-RPC 2.0 / MCP wire types.
 *
 * **Origin.** Ported verbatim from `honua-studio`'s `src/mcp/protocol.ts`
 * (honua-studio#7, REQ-001/002/004), where it is zero-import, DOM-free, and
 * node-tested.
 *
 * These mirror the subset of the MCP `2025-03-26` Streamable HTTP transport
 * that {@link McpClient} actually speaks — `initialize`, `tools/list`,
 * `tools/call` — against honua-server's `POST /mcp` endpoint. Deliberately
 * NOT a full MCP SDK surface (no resources/prompts/sampling/roots): the
 * Studio tool plane only ever needs these three methods (see
 * `./mcp-client.ts`'s module doc for why this is a hand-rolled client rather
 * than `@modelcontextprotocol/sdk`).
 *
 * @module
 */

/** The MCP protocol revision this client speaks. */
export const MCP_PROTOCOL_VERSION = "2025-03-26";

export interface JsonRpcRequest<TParams = unknown> {
  readonly jsonrpc: "2.0";
  readonly id: string | number;
  readonly method: string;
  readonly params?: TParams;
}

export interface JsonRpcErrorObject {
  readonly code: number;
  readonly message: string;
  readonly data?: unknown;
}

export interface JsonRpcSuccessResponse<TResult = unknown> {
  readonly jsonrpc: "2.0";
  readonly id: string | number | null;
  readonly result: TResult;
}

export interface JsonRpcErrorResponse {
  readonly jsonrpc: "2.0";
  readonly id: string | number | null;
  readonly error: JsonRpcErrorObject;
}

export type JsonRpcResponse<TResult = unknown> = JsonRpcSuccessResponse<TResult> | JsonRpcErrorResponse;

export function isJsonRpcErrorResponse(response: JsonRpcResponse): response is JsonRpcErrorResponse {
  return "error" in response && response.error !== undefined;
}

// ── initialize ────────────────────────────────────────────────

export interface McpClientInfo {
  readonly name: string;
  readonly version: string;
}

export interface McpInitializeParams {
  readonly protocolVersion: string;
  /** Sent empty — this client declares no optional capabilities (no roots/sampling). */
  readonly capabilities: Record<string, never>;
  readonly clientInfo: McpClientInfo;
}

export interface McpInitializeResult {
  readonly protocolVersion: string;
  readonly capabilities?: Record<string, unknown>;
  readonly serverInfo?: McpClientInfo;
}

// ── tools/list ────────────────────────────────────────────────

/** MCP behavior annotations advertised per tool. */
export interface McpToolAnnotations {
  readonly title?: string;
  readonly readOnlyHint?: boolean;
  readonly destructiveHint?: boolean;
  readonly idempotentHint?: boolean;
}

export interface McpToolDescriptor {
  readonly name: string;
  readonly title?: string;
  readonly description?: string;
  readonly inputSchema: Record<string, unknown>;
  readonly outputSchema?: Record<string, unknown>;
  readonly annotations?: McpToolAnnotations;
}

export interface McpToolsListParams {
  readonly cursor?: string;
}

export interface McpToolsListResult {
  readonly tools: readonly McpToolDescriptor[];
  readonly nextCursor?: string;
}

// ── tools/call ────────────────────────────────────────────────

export interface McpToolsCallParams {
  readonly name: string;
  readonly arguments?: Record<string, unknown>;
}

/** One content block. `type` is `"text"` for every block this client reads; the union stays open for forward compatibility. */
export interface McpContentBlock {
  readonly type: string;
  readonly text?: string;
  readonly [key: string]: unknown;
}

/**
 * The MCP error-contract "structured content" honua-server promises ("tool
 * failures are returned inside `result` with `isError: true` and a structured
 * `code` ... read the embedded message"). The exact JSON Schema for this shape
 * is not published anywhere this client could import from —
 * `./mcp-client.ts`'s module doc records the interpretation this type encodes
 * and how `parseToolError` degrades gracefully if a real server's shape
 * differs.
 */
export interface McpStructuredError {
  readonly code: string;
  readonly message: string;
  readonly [key: string]: unknown;
}

export interface McpToolsCallResult {
  readonly content?: readonly McpContentBlock[];
  readonly structuredContent?: Record<string, unknown>;
  readonly isError?: boolean;
}

/** Every documented `code` value from the honua-server MCP error contract. Open — a server may add one. */
export type McpToolErrorCode =
  | "invalid_argument"
  | "not_found"
  | "failed_precondition"
  | "permission_denied"
  | "unauthenticated"
  | "insufficient_scope"
  | "internal"
  | "unknown"
  | string;

/** The 14 `honua_studio_*` composition/lifecycle tools this session can route to. */
export const HONUA_STUDIO_MCP_TOOL_NAMES = [
  "honua_studio_create_draft",
  "honua_studio_get_draft",
  "honua_studio_update_draft",
  "honua_studio_validate_draft",
  "honua_studio_preview_draft",
  "honua_studio_add_layer",
  "honua_studio_remove_layer",
  "honua_studio_set_layer_style",
  "honua_studio_set_view",
  "honua_studio_add_widget",
  "honua_studio_remove_widget",
  "honua_studio_bind_interaction",
  "honua_studio_remove_interaction",
  "honua_studio_propose_publication",
] as const;

export type HonuaStudioMcpToolName = (typeof HONUA_STUDIO_MCP_TOOL_NAMES)[number];

/** True for a tool name the session routes through MCP rather than the local kit executor. */
export function isHonuaStudioMcpToolName(name: string): name is HonuaStudioMcpToolName {
  return (HONUA_STUDIO_MCP_TOOL_NAMES as readonly string[]).includes(name);
}

/** Mirrors `StudioPackageDraft` restricted to the fields a session reads. */
export interface StudioMcpDraft {
  readonly draftId: string;
  readonly packageKey?: string;
  readonly generation: number;
  readonly envelope?: {
    readonly family?: string;
    readonly schemaVersion?: string;
    readonly format?: string;
    readonly body?: Record<string, unknown>;
  };
  readonly [key: string]: unknown;
}
