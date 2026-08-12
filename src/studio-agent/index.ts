/**
 * `@honua/sdk-js/studio-agent` — the agent session that turns a prompt into a
 * live map.
 *
 * One entrypoint, three layers:
 *
 *  1. **Wire contract** ({@link StudioAiChatRequest} and friends) — the
 *     provider-neutral shapes honua-server's Studio AI proxy speaks over
 *     `POST /v1/studio/ai/chat` (SSE) and `GET /v1/studio/ai/capabilities`.
 *  2. **Transports** — {@link SseChatTransport} for the real proxy and
 *     {@link McpClient} for honua-server's `POST /mcp` tool plane. Both are
 *     hand-rolled, dependency-free `fetch` wrappers with typed error
 *     channels; `mcp-client.ts`'s module doc records why this does not use
 *     `@modelcontextprotocol/sdk`.
 *  3. **Session** ({@link createStudioAgentSession}) — the turn loop that
 *     streams a chat turn, dispatches the tool calls the model emits (local
 *     `@honua/sdk-js/agent-tools` verbs through a kit, `honua_studio_*`
 *     composition tools through MCP), feeds results back, and repeats until
 *     the model stops asking. It never throws mid-stream.
 *
 * ```ts
 * import { createHonuaAiMapKit } from "@honua/sdk-js/agent-tools";
 * import { createStudioAgentSession } from "@honua/sdk-js/studio-agent";
 *
 * const kit = createHonuaAiMapKit({ runtime, policy: { allowActions: true } });
 * const session = createStudioAgentSession({
 *   baseUrl: "/api",
 *   kit,
 *   system: () => kit.systemPrompt(),
 *   draft: { draftId, generation },
 * });
 *
 * const turn = await session.chat("Filter the parcels chart to whatever I click on the map.");
 * if (turn.status !== "completed") console.warn(turn.errorMessage);
 * ```
 *
 * The transports and the MCP client are ported from `honua-studio`
 * (`src/chat/*`, `src/mcp/*`) with their origin and design decisions recorded
 * in each module's documentation.
 *
 * @experimental This entrypoint tracks honua-server's Studio AI proxy and
 * `honua_studio_*` tool contracts plus geospatial-mcp ADR-0030's interaction
 * vocabulary; all three may change before 1.0.
 *
 * @packageDocumentation
 */

export {
  CHAT_EVENT_TYPE_TO_SSE_NAME,
  SSE_EVENT_NAME_TO_TYPE,
} from "./ai-contract.js";
export type {
  StudioAiCapabilitiesResponse,
  StudioAiCapability,
  StudioAiChatEvent,
  StudioAiChatEventType,
  StudioAiChatMessage,
  StudioAiChatRequest,
  StudioAiRole,
  StudioAiStopReason,
  StudioAiTokenSource,
  StudioAiToolChoice,
  StudioAiToolChoiceMode,
  StudioAiToolDefinition,
} from "./ai-contract.js";

export { SseFrameParser } from "./sse-parser.js";
export type { SseFrame } from "./sse-parser.js";

export { ChatTransportError } from "./transport.js";
export type { ChatTransport } from "./transport.js";

export { SseChatTransport, fetchStudioAiCapabilities } from "./sse-transport.js";
export type { FetchStudioAiCapabilitiesOptions, SseChatTransportOptions } from "./sse-transport.js";

export { McpClient } from "./mcp-client.js";
export type { McpClientOptions } from "./mcp-client.js";

export {
  McpProtocolError,
  McpToolError,
  McpTransportError,
  isMcpGenerationConflict,
  isMcpNotFound,
  isMcpToolError,
} from "./mcp-errors.js";

export {
  HONUA_STUDIO_MCP_TOOL_NAMES,
  MCP_PROTOCOL_VERSION,
  isHonuaStudioMcpToolName,
  isJsonRpcErrorResponse,
} from "./mcp-protocol.js";
export type {
  HonuaStudioMcpToolName,
  JsonRpcErrorObject,
  JsonRpcErrorResponse,
  JsonRpcRequest,
  JsonRpcResponse,
  JsonRpcSuccessResponse,
  McpClientInfo,
  McpContentBlock,
  McpInitializeParams,
  McpInitializeResult,
  McpStructuredError,
  McpToolAnnotations,
  McpToolDescriptor,
  McpToolErrorCode,
  McpToolsCallParams,
  McpToolsCallResult,
  McpToolsListParams,
  McpToolsListResult,
  StudioMcpDraft,
} from "./mcp-protocol.js";

export { createStudioAgentSession, parseStudioDraftResult } from "./session.js";
export type {
  StudioAgentChatOptions,
  StudioAgentDraftBinding,
  StudioAgentSession,
  StudioAgentSessionEvent,
  StudioAgentSessionOptions,
  StudioAgentToolDispatch,
  StudioAgentToolPlane,
  StudioAgentTurn,
  StudioAgentTurnStatus,
} from "./session.js";
