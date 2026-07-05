import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { compileValidator } from "./json-schema.js";
import { type JsonSchema, buildReferenceToolLookup, loadSchemaFile, loadSchemaIndex } from "./schema-index.js";

/**
 * In-process mock of the honua-server `/mcp` operator surface.
 *
 * This is the offline, CI-default certification target: a representative
 * streamable-HTTP MCP catalog shaped like the real honua-server `/mcp` (see
 * honua-server #1950), NOT the retired 9-tool static `@honua/mcp-server`. It
 * exists so the `mcp-sdk` CI gate can certify the operator surface — tools with
 * output schemas, structured errors, cursor pagination, and an auth boundary —
 * on every PR without a live server.
 *
 * Fixtures are derived from the vendored geospatial-mcp schemas: every mapped
 * tool advertises the vendored inputSchema verbatim, so the certifier's
 * conformance check exercises the real standard shape rather than a hand-rolled
 * approximation.
 *
 * Nothing here is a product server. It is a labeled test fixture whose only job
 * is to give the certifier a faithful `/mcp`-shaped surface to certify offline.
 */

/** Canonical structured error the operator surface returns on failure paths. */
export interface StructuredOperatorError {
  /**
   * Stable, machine-actionable code. The auth boundary emits `unauthenticated`
   * / `permission_denied`; argument validation emits `invalid_argument`.
   */
  code: "unauthenticated" | "permission_denied" | "invalid_argument" | "not_found" | "execution_failed";
  /** geoprocessing-error envelope (validates against common/geoprocessing-error.schema.json). */
  error: {
    kind:
      | "ValidationFailed"
      | "AuthorizationDenied"
      | "UnknownDataset"
      | "UnknownProcess"
      | "ExecutionFailed"
      | "Timeout"
      | "Cancelled"
      | "OutputBindingFailed";
    message: string;
    stepId?: string;
    violations?: { code: string; message: string; fieldPath?: string }[];
  };
}

export interface OperatorTool {
  name: string;
  title: string;
  description: string;
  inputSchema: JsonSchema;
  outputSchema: JsonSchema;
  readOnly: boolean;
  /** Deterministic structured output for a successful (authenticated) call. */
  sampleOutput: Record<string, unknown>;
}

const OBJECT_SCHEMA = (properties: Record<string, JsonSchema>, required: string[] = []): JsonSchema => ({
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  properties,
  required,
  additionalProperties: true,
});

/** Load a vendored tool inputSchema by its advertised (reference) name. */
function vendoredInputSchema(referenceName: string): JsonSchema {
  const index = loadSchemaIndex();
  const lookup = buildReferenceToolLookup(index);
  const entry = lookup.get(referenceName);
  if (!entry) {
    throw new Error(`operator-catalog: no vendored schema mapped for ${referenceName}`);
  }
  // Advertise the vendored shape verbatim (minus the schema $id, which is a
  // registry URL, not a tool inputSchema field) so conformance exercises the
  // real standard shape.
  const schema = { ...loadSchemaFile(entry.schema) };
  delete schema.$id;
  return schema;
}

/**
 * Representative operator catalog. Every tool that maps to a vendored standard
 * schema advertises that schema; the two open-core discovery tools without a
 * standard schema (`honua_list_capabilities`, `honua_resolve_entity`) advertise
 * a plain inline shape and are certified for well-formedness + contracts only.
 */
export function buildOperatorTools(): OperatorTool[] {
  return [
    {
      name: "honua_list_layers",
      title: "List layers",
      description: "Discover published services and their layers.",
      inputSchema: vendoredInputSchema("honua_list_layers"),
      outputSchema: OBJECT_SCHEMA(
        {
          layers: {
            type: "array",
            items: OBJECT_SCHEMA(
              {
                serviceId: { type: "string" },
                layerId: { type: "integer" },
                name: { type: "string" },
                geometryType: { type: "string" },
              },
              ["serviceId", "layerId", "name"],
            ),
          },
          nextCursor: { type: "string" },
        },
        ["layers"],
      ),
      readOnly: true,
      sampleOutput: {
        layers: [{ serviceId: "svc-parks", layerId: 0, name: "Parks", geometryType: "Polygon" }],
      },
    },
    {
      name: "honua_query_features",
      title: "Query features",
      description: "Query features from a published layer with attribute/spatial filters.",
      inputSchema: vendoredInputSchema("honua_query_features"),
      outputSchema: OBJECT_SCHEMA(
        {
          features: {
            type: "array",
            items: OBJECT_SCHEMA({ attributes: { type: "object" } }, ["attributes"]),
          },
          count: { type: "integer", minimum: 0 },
          nextCursor: { type: "string" },
        },
        ["features", "count"],
      ),
      readOnly: true,
      sampleOutput: {
        features: [{ attributes: { OBJECTID: 1, NAME: "Central Park" } }],
        count: 1,
      },
    },
    {
      name: "honua_render_map",
      title: "Render map",
      description: "Render an image of ordered layers over an extent.",
      inputSchema: vendoredInputSchema("honua_render_map"),
      outputSchema: OBJECT_SCHEMA(
        {
          image: OBJECT_SCHEMA(
            {
              format: { type: "string" },
              base64: { type: "string" },
              width: { type: "integer" },
              height: { type: "integer" },
            },
            ["format", "base64", "width", "height"],
          ),
        },
        ["image"],
      ),
      readOnly: true,
      sampleOutput: {
        image: { format: "image/png", base64: "iVBORw0KGgo=", width: 512, height: 512 },
      },
    },
    {
      name: "honua_geocode_address",
      title: "Geocode address",
      description: "Resolve a freeform address to ranked candidates.",
      inputSchema: vendoredInputSchema("honua_geocode_address"),
      outputSchema: OBJECT_SCHEMA(
        {
          candidates: {
            type: "array",
            items: OBJECT_SCHEMA(
              {
                label: { type: "string" },
                score: { type: "number" },
                lon: { type: "number" },
                lat: { type: "number" },
              },
              ["label", "score", "lon", "lat"],
            ),
          },
        },
        ["candidates"],
      ),
      readOnly: true,
      sampleOutput: {
        candidates: [{ label: "1600 Pennsylvania Ave NW", score: 0.98, lon: -77.0365, lat: 38.8977 }],
      },
    },
    {
      name: "honua_solve_route",
      title: "Solve route",
      description: "Solve an ordered route through a sequence of stops.",
      inputSchema: vendoredInputSchema("honua_solve_route"),
      outputSchema: OBJECT_SCHEMA(
        {
          route: OBJECT_SCHEMA({ distanceMeters: { type: "number" }, durationSeconds: { type: "number" } }, [
            "distanceMeters",
            "durationSeconds",
          ]),
        },
        ["route"],
      ),
      readOnly: true,
      sampleOutput: { route: { distanceMeters: 1234.5, durationSeconds: 210 } },
    },
    {
      name: "honua_plan_analysis",
      title: "Plan analysis",
      description: "Compile a natural-language intent into an analysis plan.",
      inputSchema: vendoredInputSchema("honua_plan_analysis"),
      outputSchema: OBJECT_SCHEMA(
        {
          plan: OBJECT_SCHEMA({ planId: { type: "string" }, steps: { type: "array" } }, ["planId", "steps"]),
        },
        ["plan"],
      ),
      readOnly: true,
      sampleOutput: {
        plan: { planId: "plan-001", steps: [{ stepId: "s1", kind: "QueryFeatures" }] },
      },
    },
    {
      name: "honua_ground_candidates",
      title: "Ground candidates",
      description: "Ground a goal to a workflow family and ranked candidates.",
      inputSchema: vendoredInputSchema("honua_ground_candidates"),
      outputSchema: OBJECT_SCHEMA({ intentId: { type: "string" }, candidates: { type: "array" } }, [
        "intentId",
        "candidates",
      ]),
      readOnly: true,
      sampleOutput: { intentId: "int-001", candidates: [{ family: "Analyze", score: 0.9 }] },
    },
    {
      name: "honua_clarify_intent",
      title: "Clarify intent",
      description: "Re-run grounding with the operator's answers merged in.",
      inputSchema: vendoredInputSchema("honua_clarify_intent"),
      outputSchema: OBJECT_SCHEMA({ intentId: { type: "string" }, resolved: { type: "boolean" } }, [
        "intentId",
        "resolved",
      ]),
      readOnly: true,
      sampleOutput: { intentId: "int-001", resolved: true },
    },
    {
      name: "honua_validate_plan",
      title: "Validate plan",
      description: "Validate a (possibly partial) analysis plan and report structured violations.",
      inputSchema: vendoredInputSchema("honua_validate_plan"),
      outputSchema: OBJECT_SCHEMA(
        {
          valid: { type: "boolean" },
          violations: {
            type: "array",
            items: OBJECT_SCHEMA({ code: { type: "string" }, message: { type: "string" } }, ["code", "message"]),
          },
        },
        ["valid", "violations"],
      ),
      readOnly: true,
      sampleOutput: { valid: false, violations: [{ code: "EMPTY_PLAN_ID", message: "planId is empty" }] },
    },
    {
      name: "honua_dry_run_plan",
      title: "Dry-run plan",
      description: "Preview a plan's execution without submitting a job.",
      inputSchema: vendoredInputSchema("honua_dry_run_plan"),
      outputSchema: OBJECT_SCHEMA(
        {
          planId: { type: "string" },
          estimated: OBJECT_SCHEMA({ steps: { type: "integer" } }, ["steps"]),
        },
        ["planId", "estimated"],
      ),
      readOnly: true,
      sampleOutput: { planId: "plan-001", estimated: { steps: 1 } },
    },
    {
      name: "honua_list_capabilities",
      title: "List capabilities",
      description: "List capabilities advertised by the connected honua deployment.",
      inputSchema: OBJECT_SCHEMA({
        family: { type: "string", description: "Optional capability family filter." },
      }),
      outputSchema: OBJECT_SCHEMA(
        {
          capabilities: {
            type: "array",
            items: OBJECT_SCHEMA({ name: { type: "string" }, supported: { type: "boolean" } }, ["name", "supported"]),
          },
        },
        ["capabilities"],
      ),
      readOnly: true,
      sampleOutput: { capabilities: [{ name: "query", supported: true }] },
    },
    {
      name: "honua_resolve_entity",
      title: "Resolve entity",
      description: "Resolve a freeform reference to canonical platform entities.",
      inputSchema: OBJECT_SCHEMA({ query: { type: "string", minLength: 1 } }, ["query"]),
      outputSchema: OBJECT_SCHEMA(
        {
          entities: {
            type: "array",
            items: OBJECT_SCHEMA({ id: { type: "string" }, kind: { type: "string" } }, ["id", "kind"]),
          },
        },
        ["entities"],
      ),
      readOnly: true,
      sampleOutput: { entities: [{ id: "svc-parks", kind: "service" }] },
    },
    // ── Mutating / control-plane tools (never round-tripped) ─────────
    {
      name: "honua_execute_plan",
      title: "Execute plan",
      description: "Submit an executable plan and return an execution-job reference.",
      inputSchema: vendoredInputSchema("honua_execute_plan"),
      outputSchema: OBJECT_SCHEMA({ jobId: { type: "string" }, status: { type: "string" } }, ["jobId", "status"]),
      readOnly: false,
      sampleOutput: { jobId: "job-001", status: "Submitted" },
    },
    {
      name: "honua_cancel_job",
      title: "Cancel job",
      description: "Request cancellation of a submitted execution job.",
      inputSchema: vendoredInputSchema("honua_cancel_job"),
      outputSchema: OBJECT_SCHEMA({ jobId: { type: "string" }, status: { type: "string" } }, ["jobId", "status"]),
      readOnly: false,
      sampleOutput: { jobId: "job-001", status: "Cancelling" },
    },
    {
      name: "honua_propose_operation",
      title: "Propose operation",
      description: "Propose an in-scope control-plane operation for human approval.",
      inputSchema: vendoredInputSchema("honua_propose_operation"),
      outputSchema: OBJECT_SCHEMA({ proposalId: { type: "string" }, status: { type: "string" } }, [
        "proposalId",
        "status",
      ]),
      readOnly: false,
      sampleOutput: { proposalId: "prop-001", status: "PendingApproval" },
    },
    {
      name: "honua_publish_service",
      title: "Publish service",
      description: "Publish a result package as a hosted service.",
      inputSchema: vendoredInputSchema("honua_publish_service"),
      outputSchema: OBJECT_SCHEMA({ publishedServiceId: { type: "string" }, uri: { type: "string" } }, [
        "publishedServiceId",
        "uri",
      ]),
      readOnly: false,
      sampleOutput: { publishedServiceId: "svc-pub-001", uri: "honua://services/svc-pub-001" },
    },
    {
      name: "honua_create_map_package",
      title: "Create map package",
      description: "Compose a map package from an intent and inputs.",
      inputSchema: vendoredInputSchema("honua_create_map_package"),
      outputSchema: OBJECT_SCHEMA({ mapPackageId: { type: "string" }, uri: { type: "string" } }, [
        "mapPackageId",
        "uri",
      ]),
      readOnly: false,
      sampleOutput: { mapPackageId: "map-001", uri: "honua://maps/map-001" },
    },
    {
      name: "honua_create_app_package",
      title: "Create app package",
      description: "Compose an app package from an intent and inputs.",
      inputSchema: vendoredInputSchema("honua_create_app_package"),
      outputSchema: OBJECT_SCHEMA({ appPackageId: { type: "string" }, uri: { type: "string" } }, [
        "appPackageId",
        "uri",
      ]),
      readOnly: false,
      sampleOutput: { appPackageId: "app-001", uri: "honua://apps/app-001" },
    },
  ];
}

export interface OperatorResource {
  uri: string;
  name: string;
  mimeType: string;
  contents: unknown;
}

export function buildOperatorResources(): OperatorResource[] {
  return [
    {
      uri: "honua://results/res-001",
      name: "Result package res-001",
      mimeType: "application/json",
      contents: { result_package_id: "res-001", status: "Ready", artifacts: [] },
    },
    {
      uri: "honua://workspaces/ws-001",
      name: "Workspace ws-001",
      mimeType: "application/json",
      contents: { workspace_id: "ws-001", artifacts: [] },
    },
    {
      uri: "honua://styles/topographic",
      name: "Style topographic",
      mimeType: "application/json",
      contents: { style_id: "topographic", title: "Topographic" },
    },
    {
      uri: "honua://services/svc-parks",
      name: "Published service svc-parks",
      mimeType: "application/json",
      contents: { published_service_id: "svc-parks", title: "Parks" },
    },
  ];
}

/** Page size for the paginated tools/list and resources/list responses. */
export const CATALOG_PAGE_SIZE = 12;

const UNAUTHENTICATED_ERROR: StructuredOperatorError = {
  code: "unauthenticated",
  error: {
    kind: "AuthorizationDenied",
    message: "Request is not authenticated. Provide a bearer token or API key.",
  },
};

function invalidArgumentError(
  violations: { code: string; message: string; fieldPath?: string }[],
): StructuredOperatorError {
  return {
    code: "invalid_argument",
    error: {
      kind: "ValidationFailed",
      message: "One or more arguments failed validation.",
      violations,
    },
  };
}

function validateToolArgs(tool: OperatorTool, args: unknown): { code: string; message: string; fieldPath?: string }[] {
  const validate = compileValidator(tool.inputSchema);
  const valid = validate(args) as boolean;
  if (valid) {
    return [];
  }
  return (validate.errors ?? []).map((e) => ({
    code: "SCHEMA_VIOLATION",
    message: `${e.instancePath || "(root)"} ${e.message ?? "is invalid"}`.trim(),
    fieldPath: e.instancePath || undefined,
  }));
}

export interface OperatorCatalogOptions {
  /**
   * Whether an initial catalog page is followed by a `nextCursor` (default
   * true). The certifier's pagination contract requires at least one paginated
   * list; disable only for negative tests.
   */
  paginate?: boolean;
}

/**
 * Build the low-level MCP `Server` for the mock operator catalog. Auth is
 * enforced per request from `extra.authInfo` (populated by the HTTP transport
 * from the bearer token), so a single server instance drives both the
 * authenticated certification pass and the unauthenticated auth-contract pass.
 */
export function createOperatorCatalogServer(options: OperatorCatalogOptions = {}): Server {
  const paginate = options.paginate ?? true;
  const tools = buildOperatorTools();
  const resources = buildOperatorResources();
  const toolsByName = new Map(tools.map((t) => [t.name, t]));

  const server = new Server(
    { name: "honua", version: "operator-mcp-mock" },
    {
      capabilities: { tools: { listChanged: true }, resources: { listChanged: true } },
      instructions: "Mock honua /mcp operator surface for offline certification.",
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async (request) => {
    const advertised = tools.map((t) => ({
      name: t.name,
      title: t.title,
      description: t.description,
      inputSchema: t.inputSchema as Record<string, unknown>,
      outputSchema: t.outputSchema as Record<string, unknown>,
      annotations: { readOnlyHint: t.readOnly },
    }));
    return paginateList(advertised, request.params?.cursor, paginate, "tools");
  });

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const tool = toolsByName.get(request.params.name);
    if (!tool) {
      throw new McpError(ErrorCode.InvalidParams, `Unknown tool: ${request.params.name}`, {
        code: "not_found",
        error: { kind: "UnknownProcess", message: `Unknown tool: ${request.params.name}` },
      } satisfies StructuredOperatorError);
    }

    // Auth boundary: tools/call requires an authenticated request.
    if (!extra.authInfo) {
      return toolErrorResult(UNAUTHENTICATED_ERROR);
    }

    // Argument validation: invalid args yield a structured, actionable tool
    // result (isError) — never a protocol-level error.
    const violations = validateToolArgs(tool, request.params.arguments ?? {});
    if (violations.length > 0) {
      return toolErrorResult(invalidArgumentError(violations));
    }

    return {
      content: [{ type: "text", text: JSON.stringify(tool.sampleOutput) }],
      structuredContent: tool.sampleOutput,
      isError: false,
    };
  });

  server.setRequestHandler(ListResourcesRequestSchema, async (request) => {
    const advertised = resources.map((r) => ({ uri: r.uri, name: r.name, mimeType: r.mimeType }));
    return paginateList(advertised, request.params?.cursor, paginate, "resources");
  });

  server.setRequestHandler(ReadResourceRequestSchema, async (request, extra) => {
    // Auth boundary: resources/read requires an authenticated request. Resources
    // have no `isError` result channel, so the structured signal is carried on a
    // protocol error's `data`.
    if (!extra.authInfo) {
      throw new McpError(ErrorCode.InvalidRequest, UNAUTHENTICATED_ERROR.error.message, UNAUTHENTICATED_ERROR);
    }
    const resource = resources.find((r) => r.uri === request.params.uri);
    if (!resource) {
      throw new McpError(ErrorCode.InvalidParams, `Unknown resource: ${request.params.uri}`, {
        code: "not_found",
        error: { kind: "UnknownDataset", message: `Unknown resource: ${request.params.uri}` },
      } satisfies StructuredOperatorError);
    }
    return {
      contents: [{ uri: resource.uri, mimeType: resource.mimeType, text: JSON.stringify(resource.contents) }],
    };
  });

  return server;
}

function toolErrorResult(error: StructuredOperatorError) {
  return {
    content: [{ type: "text", text: error.error.message }],
    structuredContent: error,
    isError: true,
  };
}

/**
 * Split a catalog into a first page + `nextCursor`, honoring an incoming cursor.
 * The cursor is an opaque, deterministic offset token.
 */
function paginateList<T>(
  items: T[],
  cursor: string | undefined,
  paginate: boolean,
  key: "tools" | "resources",
): Record<string, unknown> {
  if (!paginate || items.length <= CATALOG_PAGE_SIZE) {
    return { [key]: items };
  }
  const offset = decodeCursor(cursor);
  const page = items.slice(offset, offset + CATALOG_PAGE_SIZE);
  const nextOffset = offset + page.length;
  const result: Record<string, unknown> = { [key]: page };
  if (nextOffset < items.length) {
    result.nextCursor = encodeCursor(nextOffset);
  }
  return result;
}

function encodeCursor(offset: number): string {
  return Buffer.from(`offset:${offset}`, "utf8").toString("base64");
}

function decodeCursor(cursor: string | undefined): number {
  if (!cursor) {
    return 0;
  }
  try {
    const decoded = Buffer.from(cursor, "base64").toString("utf8");
    const match = /^offset:(\d+)$/.exec(decoded);
    if (match) {
      return Number.parseInt(match[1], 10);
    }
  } catch {
    // fall through
  }
  return 0;
}
