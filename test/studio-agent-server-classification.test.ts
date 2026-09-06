/**
 * Contract replay against honua-server's **shipped** Studio tool
 * classification.
 *
 * `test/studio-agent-session.test.ts` drives the policy with a synthetic
 * catalog whose descriptors are spread over several `view` values so each
 * decision path can be exercised in isolation. That is deliberately not the
 * server's contract. This suite pins the contract itself: the fixtures under
 * `tools-list.candidate-setup.page{1,2}.v1.json` are transcribed from
 * honua-io/honua-server trunk at commit `ebb2cc6a4` (PR honua-server#3695,
 * `McpWorkflowViewDescriptorClassifier` + `McpWorkflowViewCatalog.Setup`), so a
 * change on either side of the wire fails here rather than on a candidate
 * server.
 *
 * What the server actually publishes, and what these tests hold it to:
 *
 *  - Every `honua_studio_*` draft tool in the server-authored `setup` workflow
 *    view carries `_meta["honua.studio"] = { family: "honua.studio.composition",
 *    view: "setup", revision: "setup.v1" }`.
 *  - `view` is the VIEW name, never a stage id — the `compose` and `publication`
 *    stage members are both stamped `setup`.
 *  - Non-Studio members of the same view (`honua_query_features`,
 *    `honua_propose_operation`, …) are left unclassified on purpose. Sharing a
 *    workflow view is not a routing credential.
 *
 * The point of the whole exercise is the last assertion in the first block: the
 * default policy — no consumer allowlist, no source edit — routes the live
 * family, including the two `honua_studio_*_control` verbs that never existed in
 * the SDK's deleted 15-name table.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { type HonuaAgentRuntime, createHonuaAiMapKit } from "@honua/sdk-js/agent-tools";
import {
  CHAT_EVENT_TYPE_TO_SSE_NAME,
  HONUA_STUDIO_MCP_TOOL_NAMES,
  HONUA_STUDIO_TOOL_FAMILY,
  HONUA_STUDIO_TOOL_METADATA_KEY,
  HONUA_STUDIO_TOOL_SETUP_VIEW,
  type McpToolDescriptor,
  type McpToolsListResult,
  type StudioAiCapabilitiesResponse,
  type StudioAiChatEvent,
  StudioToolCatalog,
  createStudioAgentSession,
  readStudioToolClassification,
} from "@honua/sdk-js/studio-agent";

// ── The pinned candidate catalog ──────────────────────────────

const fixturesDir = resolve(dirname(fileURLToPath(import.meta.url)), "fixtures/studio-agent");

function candidatePage(name: string): McpToolsListResult {
  return JSON.parse(readFileSync(resolve(fixturesDir, name), "utf8")) as McpToolsListResult;
}

const CANDIDATE_PAGES: readonly McpToolsListResult[] = [
  candidatePage("tools-list.candidate-setup.page1.v1.json"),
  candidatePage("tools-list.candidate-setup.page2.v1.json"),
];

const CANDIDATE_DESCRIPTORS: readonly McpToolDescriptor[] = CANDIDATE_PAGES.flatMap((page) => [...page.tools]);

/** The server's Studio roster at `ebb2cc6a4`, in the order `tools/list` serves it. */
const SERVER_STUDIO_TOOLS: readonly string[] = [
  "honua_studio_create_draft",
  "honua_studio_get_draft",
  "honua_studio_update_draft",
  "honua_studio_validate_draft",
  "honua_studio_preview_draft",
  "honua_studio_add_layer",
  "honua_studio_remove_layer",
  "honua_studio_set_layer_style",
  "honua_studio_set_layer_visibility",
  "honua_studio_set_view",
  "honua_studio_add_widget",
  "honua_studio_remove_widget",
  "honua_studio_bind_interaction",
  "honua_studio_remove_interaction",
  "honua_studio_add_control",
  "honua_studio_remove_control",
  "honua_studio_propose_publication",
];

/** Members of the same server-authored `setup` view that the server does NOT classify. */
const UNCLASSIFIED_VIEW_NEIGHBOURS: readonly string[] = [
  "honua_list_capabilities",
  "honua_query_features",
  "honua_propose_operation",
];

// ── Catalog-level contract ────────────────────────────────────

describe("honua-server Studio classification contract", () => {
  it("stamps every Studio descriptor with the composition family, the setup view, and one revision", () => {
    const classifications = SERVER_STUDIO_TOOLS.map((name) => {
      const descriptor = CANDIDATE_DESCRIPTORS.find((candidate) => candidate.name === name);
      expect(descriptor, `${name} missing from the candidate catalog`).toBeDefined();
      return readStudioToolClassification(descriptor as McpToolDescriptor);
    });

    for (const classification of classifications) {
      expect(classification).toEqual({
        family: HONUA_STUDIO_TOOL_FAMILY,
        // The VIEW name, not the stage id: `honua_studio_propose_publication`
        // lives in the server's `publication` stage and is still stamped `setup`.
        view: HONUA_STUDIO_TOOL_SETUP_VIEW,
        revision: "setup.v1",
      });
    }
  });

  it("leaves non-Studio members of the same setup view unclassified", () => {
    for (const name of UNCLASSIFIED_VIEW_NEIGHBOURS) {
      const descriptor = CANDIDATE_DESCRIPTORS.find((candidate) => candidate.name === name);
      expect(descriptor, `${name} missing from the candidate catalog`).toBeDefined();
      expect((descriptor as McpToolDescriptor)._meta?.[HONUA_STUDIO_TOOL_METADATA_KEY]).toBeUndefined();
      expect(readStudioToolClassification(descriptor as McpToolDescriptor)).toBeUndefined();
    }
  });

  it("routes the whole live family under the DEFAULT policy, with no consumer allowlist", () => {
    const catalog = StudioToolCatalog.fromDescriptors(CANDIDATE_DESCRIPTORS);

    expect(catalog.names).toEqual(SERVER_STUDIO_TOOLS);
    expect(catalog.rejections.map((rejection) => rejection.name)).toEqual(UNCLASSIFIED_VIEW_NEIGHBOURS);
    for (const rejection of catalog.rejections) {
      expect(rejection.reason).toBe("unclassified");
    }
  });

  it("routes the control verbs the deleted 15-name table never knew about", () => {
    const catalog = StudioToolCatalog.fromDescriptors(CANDIDATE_DESCRIPTORS);

    for (const name of ["honua_studio_add_control", "honua_studio_remove_control"]) {
      expect((HONUA_STUDIO_MCP_TOOL_NAMES as readonly string[]).includes(name)).toBe(false);
      expect(catalog.has(name)).toBe(true);
      expect(catalog.descriptor(name)?.name).toBe(name);
    }
  });

  it("reports no migration diagnostic: the live server covers the whole deprecated baseline", () => {
    const report = StudioToolCatalog.fromDescriptors(CANDIDATE_DESCRIPTORS, {
      required: HONUA_STUDIO_MCP_TOOL_NAMES,
    }).report(CANDIDATE_PAGES.length);

    expect(report.missingRequired).toEqual([]);
    expect(report.diagnostics).toEqual([]);
    expect(report.discovered).toBe(CANDIDATE_DESCRIPTORS.length);
    expect(report.pages).toBe(2);
  });

  it("surfaces the server's family, view and revision on the discovery report", () => {
    const report = StudioToolCatalog.fromDescriptors(CANDIDATE_DESCRIPTORS).report(CANDIDATE_PAGES.length);

    expect(report.classification).toEqual({
      families: [HONUA_STUDIO_TOOL_FAMILY],
      views: [HONUA_STUDIO_TOOL_SETUP_VIEW],
      revisions: ["setup.v1"],
    });
  });

  it("reports an empty classification block when the routed set is empty", () => {
    const report = StudioToolCatalog.fromDescriptors([]).report(0);

    expect(report.classification).toEqual({ families: [], views: [], revisions: [] });
  });

  it("carries the server's revision change through to the report", () => {
    const bumped = CANDIDATE_DESCRIPTORS.map((descriptor) =>
      descriptor._meta?.[HONUA_STUDIO_TOOL_METADATA_KEY]
        ? {
            ...descriptor,
            _meta: {
              [HONUA_STUDIO_TOOL_METADATA_KEY]: {
                family: HONUA_STUDIO_TOOL_FAMILY,
                view: HONUA_STUDIO_TOOL_SETUP_VIEW,
                revision: "setup.v2",
              },
            },
          }
        : descriptor,
    );

    const before = StudioToolCatalog.fromDescriptors(CANDIDATE_DESCRIPTORS).report(2);
    const after = StudioToolCatalog.fromDescriptors(bumped).report(2);

    expect(before.classification.revisions).toEqual(["setup.v1"]);
    expect(after.classification.revisions).toEqual(["setup.v2"]);
    expect(after.routed).toEqual(before.routed);
  });

  it("accepts a policy pinned to the view name the server actually stamps", () => {
    const pinned = StudioToolCatalog.fromDescriptors(CANDIDATE_DESCRIPTORS, {
      views: [HONUA_STUDIO_TOOL_SETUP_VIEW],
    });

    expect(pinned.names).toEqual(SERVER_STUDIO_TOOLS);
  });

  it("rejects the live family when the policy pins a stage id instead of the view name", () => {
    // `compose` and `publication` are STAGES of the `setup` view. A consumer that
    // mistakes one for a view must get a recorded rejection, not a silent grant.
    const mistaken = StudioToolCatalog.fromDescriptors(CANDIDATE_DESCRIPTORS, {
      views: ["compose", "publication"],
    });

    expect(mistaken.names).toEqual([]);
    const reasons = new Set(
      mistaken.rejections.filter((rejection) => rejection.name.startsWith("honua_studio_")).map((r) => r.reason),
    );
    expect([...reasons]).toEqual(["view"]);
  });

  it("never routes a classified descriptor from a family the policy does not approve", () => {
    const hostile: McpToolDescriptor = {
      name: "honua_studio_exfiltrate_draft",
      description: "Classified into somebody else's family.",
      inputSchema: { type: "object" },
      _meta: {
        [HONUA_STUDIO_TOOL_METADATA_KEY]: {
          family: "honua.attacker.composition",
          view: HONUA_STUDIO_TOOL_SETUP_VIEW,
          revision: "setup.v1",
        },
      },
    };

    const catalog = StudioToolCatalog.fromDescriptors([...CANDIDATE_DESCRIPTORS, hostile]);

    expect(catalog.has(hostile.name)).toBe(false);
    expect(catalog.rejections.find((rejection) => rejection.name === hostile.name)?.reason).toBe("family");
    expect(catalog.classification.families).toEqual([HONUA_STUDIO_TOOL_FAMILY]);
  });

  it("never routes an unclassified honua_studio_ descriptor served alongside the classified family", () => {
    const impostor: McpToolDescriptor = {
      name: "honua_studio_shadow_export",
      description: "A prefix sibling with no server classification at all.",
      inputSchema: { type: "object" },
    };

    const catalog = StudioToolCatalog.fromDescriptors([...CANDIDATE_DESCRIPTORS, impostor]);

    expect(catalog.has(impostor.name)).toBe(false);
    expect(catalog.rejections.find((rejection) => rejection.name === impostor.name)?.reason).toBe("unclassified");
  });
});

// ── Session-level replay ──────────────────────────────────────

const CAPABILITIES: StudioAiCapabilitiesResponse = {
  enabled: true,
  defaultProvider: "anthropic",
  providers: [
    {
      provider: "anthropic",
      kind: "anthropic",
      model: "test-model",
      maxTokens: 4096,
      toolSupport: true,
      streaming: true,
      isDefault: true,
      configured: true,
    },
  ],
};

function sseBody(events: readonly StudioAiChatEvent[]): string {
  const secured = events.some((event) => event.type === "toolCallStop")
    ? [
        ...events,
        {
          type: "transcriptProvenance",
          provenance: {
            schemaVersion: "honua.studio-ai.transcript.v1",
            canonicalization: "honua-canonical-json-v1",
            digestAlgorithm: "sha-256",
            signatureAlgorithm: "Ed25519",
            keyId: "candidate-fixture",
            canonicalTranscript: "candidate-fixture",
            transcriptDigest: "candidate-fixture",
            signature: "candidate-fixture",
          },
        } satisfies StudioAiChatEvent,
      ]
    : events;
  return secured
    .map((event) => {
      const { type, ...rest } = event;
      return `event: ${CHAT_EVENT_TYPE_TO_SSE_NAME[type]}\ndata: ${JSON.stringify({ type, ...rest })}\n\n`;
    })
    .join("");
}

function jsonResponse(body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json", ...headers },
  });
}

interface CandidateServer {
  readonly fetchImpl: typeof fetch;
  readonly advertised: Array<readonly string[]>;
  readonly mcpCalls: Array<{ readonly name: string; readonly arguments: Record<string, unknown> }>;
}

/**
 * A `POST /mcp` + chat-SSE server that serves the pinned candidate catalog over
 * two real pages, so discovery, pagination, advertisement and dispatch all run
 * against the same bytes honua-server sends.
 */
function createCandidateServer(turns: ReadonlyArray<readonly StudioAiChatEvent[]>): CandidateServer {
  const advertised: Array<readonly string[]> = [];
  const mcpCalls: Array<{ readonly name: string; readonly arguments: Record<string, unknown> }> = [];
  const remaining = [...turns];

  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);

    if (url.endsWith("/v1/studio/ai/capabilities")) {
      return jsonResponse({ success: true, data: CAPABILITIES });
    }

    if (url.endsWith("/v1/studio/ai/chat")) {
      const body = JSON.parse(String(init?.body)) as { readonly tools?: ReadonlyArray<{ readonly name: string }> };
      advertised.push((body.tools ?? []).map((tool) => tool.name));
      const events = remaining.shift() ?? [{ type: "messageStop", stopReason: "endTurn" }];
      return new Response(sseBody(events), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }

    if (url.endsWith("/mcp")) {
      const envelope = JSON.parse(String(init?.body)) as {
        readonly id: string;
        readonly method: string;
        readonly params?: Record<string, unknown>;
      };
      if (envelope.method === "initialize") {
        return jsonResponse(
          { jsonrpc: "2.0", id: envelope.id, result: { protocolVersion: "2025-03-26" } },
          { "mcp-session-id": "candidate-session" },
        );
      }
      if (envelope.method === "tools/list") {
        const cursor = envelope.params?.cursor as string | undefined;
        const page = cursor === undefined ? CANDIDATE_PAGES[0] : CANDIDATE_PAGES[1];
        if (cursor !== undefined && cursor !== CANDIDATE_PAGES[0]?.nextCursor) {
          throw new Error(`Unexpected tools/list cursor: ${cursor}`);
        }
        return jsonResponse({ jsonrpc: "2.0", id: envelope.id, result: page });
      }
      const name = String(envelope.params?.name);
      mcpCalls.push({ name, arguments: (envelope.params?.arguments ?? {}) as Record<string, unknown> });
      return jsonResponse({
        jsonrpc: "2.0",
        id: envelope.id,
        result: { structuredContent: { draftId: "draft-1", generation: 3 } },
      });
    }

    throw new Error(`Unexpected request: ${url}`);
  }) as typeof fetch;

  return { fetchImpl, advertised, mcpCalls };
}

function makeRuntime(): HonuaAgentRuntime {
  return {
    id: "ops",
    snapshot: () => ({
      appId: "ops",
      sources: [{ id: "incidents", protocol: "geoservices-feature-service", capabilities: ["query"] }],
      layers: [{ id: "incident-points", sourceId: "incidents" }],
      selection: [],
    }),
    setFilter: (id) => ({ id }),
    setViewport: (viewport) => viewport,
  };
}

describe("StudioAgentSession against the pinned candidate catalog", () => {
  it("advertises and dispatches a server verb absent from the deprecated table, with no allowlist", async () => {
    const call = {
      id: "call-1",
      name: "honua_studio_add_control",
      args: { control: { id: "layer-list", kind: "layerList" } },
    };
    const server = createCandidateServer([
      [
        { type: "messageStart", model: "test-model" },
        { type: "toolCallStart", toolCallId: call.id, toolName: call.name },
        { type: "toolCallStop", toolCallId: call.id, toolArguments: call.args },
        { type: "messageStop", stopReason: "toolCall" },
      ],
      [
        { type: "messageStart", model: "test-model" },
        { type: "textDelta", text: "Added the layer list control." },
        { type: "messageStop", stopReason: "endTurn" },
      ],
    ]);

    const session = createStudioAgentSession({
      baseUrl: "/api",
      fetchImpl: server.fetchImpl,
      kit: createHonuaAiMapKit({ runtime: makeRuntime(), policy: { allowActions: true } }),
      draft: { draftId: "draft-1", generation: 2 },
      certification: {
        candidateId: "candidate-classification-fixture",
        releaseId: "candidate-release",
        endpointIdentity: "candidate-proxy",
        actionId: "classification-dispatch",
        runNonce: "candidate-run",
      },
      transcriptVerifier: {
        verify: async () => ({ ok: true, transcriptDigest: "candidate-classification-fixture" }),
      },
    });

    const turn = await session.chat("Add a layer list control.");

    expect(turn.status).toBe("completed");
    expect(turn.toolCalls[0]).toMatchObject({ plane: "composition", toolName: call.name, ok: true });
    expect(server.mcpCalls.map((mcpCall) => mcpCall.name)).toEqual([call.name]);
    // The whole live family reached the model on the very first turn.
    for (const name of SERVER_STUDIO_TOOLS) {
      expect(server.advertised[0]).toContain(name);
    }
    for (const name of UNCLASSIFIED_VIEW_NEIGHBOURS) {
      expect(server.advertised[0]).not.toContain(name);
    }
  });

  it("publishes the server's classification on the session's discovery report", async () => {
    const server = createCandidateServer([]);
    const session = createStudioAgentSession({
      baseUrl: "/api",
      fetchImpl: server.fetchImpl,
      kit: createHonuaAiMapKit({ runtime: makeRuntime(), policy: { allowActions: true } }),
    });

    const report = await session.refreshTools();

    expect(report.pages).toBe(2);
    expect(report.routed).toEqual(SERVER_STUDIO_TOOLS);
    expect(report.classification).toEqual({
      families: [HONUA_STUDIO_TOOL_FAMILY],
      views: [HONUA_STUDIO_TOOL_SETUP_VIEW],
      revisions: ["setup.v1"],
    });
    expect(report.missingRequired).toEqual([]);
    expect(session.toolDiscovery?.classification.revisions).toEqual(["setup.v1"]);
  });
});
