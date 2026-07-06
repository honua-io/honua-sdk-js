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
 * NOTE ON `honua_edit_features`: the real honua-server `/mcp` surface exposes NO
 * feature-mutation tool — Honua does not support AI operational data editing
 * (honua-server ADR-0028). This fixture nonetheless advertises `honua_edit_features`
 * so the certifier keeps exercising the standard's OPTIONAL `mutation`-profile
 * certification path (insert→update→delete round-trip, auth-boundary contract)
 * for *other* adopters that choose to offer governed editing. It is a
 * mutation-profile-adopter fixture, NOT a mirror of honua-server's product surface.
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
 * Representative operator catalog. Every tool advertises its vendored standard
 * inputSchema verbatim — including the Honua-extension discovery tools
 * (`honua_list_capabilities`, `honua_resolve_entity`) and
 * `honua_publish_service`, which the standard maps to its own `publish_service`
 * entry as a documented divergence from the known-gap `publish_result` family.
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
      inputSchema: vendoredInputSchema("honua_list_capabilities"),
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
      inputSchema: vendoredInputSchema("honua_resolve_entity"),
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
      description:
        "Publish a source table as a new hosted service (documented divergence from the standard publish_result family, which remains a known-gap).",
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
    {
      // OPTIONAL mutation-profile tool (geospatial-mcp `mutation` profile) — matched
      // as an advertised-only known gap, never round-tripped by the read-only path;
      // the mutating-round-trip contract drives its insert→update→delete lifecycle.
      // This fixture opts into the optional mutation profile so that path stays
      // certified; the real honua-server surface does NOT advertise this tool —
      // Honua does not support AI operational data editing (honua-server ADR-0028).
      name: "honua_edit_features",
      title: "Edit features",
      description: "Apply feature inserts, updates, and deletes to a published editable layer.",
      inputSchema: OBJECT_SCHEMA(
        {
          serviceId: { type: "string", minLength: 1 },
          layerId: { type: "integer", minimum: 0 },
          adds: {
            type: "array",
            items: OBJECT_SCHEMA({ attributes: { type: "object" } }, ["attributes"]),
          },
          updates: {
            type: "array",
            items: OBJECT_SCHEMA({ objectId: { type: "integer" }, attributes: { type: "object" } }, [
              "objectId",
              "attributes",
            ]),
          },
          deletes: { type: "array", items: { type: "integer" } },
        },
        ["serviceId", "layerId"],
      ),
      outputSchema: OBJECT_SCHEMA({
        addResults: { type: "array", items: EDIT_RESULT_SCHEMA },
        updateResults: { type: "array", items: EDIT_RESULT_SCHEMA },
        deleteResults: { type: "array", items: EDIT_RESULT_SCHEMA },
      }),
      readOnly: false,
      sampleOutput: { addResults: [], updateResults: [], deleteResults: [] },
    },
  ];
}

const EDIT_RESULT_SCHEMA: JsonSchema = OBJECT_SCHEMA({ objectId: { type: "integer" }, success: { type: "boolean" } }, [
  "objectId",
  "success",
]);

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
 * Mutable per-server state backing the deep certification contracts. The mock is
 * a small but REAL stateful backend: `honua_edit_features` mutates an in-memory
 * feature store that `honua_query_features` reads back (so an insert→query→
 * update→query→delete→query round-trip observes real effects), and
 * `honua_execute_plan` registers a job whose `honua://jobs/{id}` resource advances
 * a documented Submitted→Running→Succeeded state machine on each poll.
 */
interface CatalogState {
  /** `${serviceId}::${layerId}` → objectId → attributes. */
  features: Map<string, Map<number, Record<string, unknown>>>;
  nextObjectId: number;
  jobs: Map<string, JobState>;
  nextJobSeq: number;
}

interface JobState {
  jobId: string;
  /** Number of times the job resource has been polled (drives the state machine). */
  polls: number;
  resultPackageId: string;
}

/** Feature-store key seeded so the pagination + mutation contracts have real rows. */
const SEED_SERVICE = "svc-parks";
const SEED_LAYER = 0;

function seedFeatureStore(): Map<string, Map<number, Record<string, unknown>>> {
  const layer = new Map<number, Record<string, unknown>>();
  // OBJECTID 1 first so the existing single-feature round-trip fixture is stable.
  const names = ["Central Park", "Riverside Park", "Lincoln Park", "Golden Gate Park", "Prospect Park"];
  names.forEach((name, i) => layer.set(i + 1, { OBJECTID: i + 1, NAME: name }));
  return new Map([[`${SEED_SERVICE}::${SEED_LAYER}`, layer]]);
}

function newCatalogState(): CatalogState {
  return { features: seedFeatureStore(), nextObjectId: 1000, jobs: new Map(), nextJobSeq: 1 };
}

/** Number of polls before the job lifecycle mock reports `Succeeded`. */
const JOB_SUCCESS_AFTER_POLLS = 3;

/** Stateful tool handlers keyed by tool name; absent ⇒ echo the tool's sampleOutput. */
function buildToolHandlers(
  state: CatalogState,
): Map<string, (args: Record<string, unknown>) => Record<string, unknown>> {
  const handlers = new Map<string, (args: Record<string, unknown>) => Record<string, unknown>>();

  handlers.set("honua_query_features", (args) => {
    const key = `${String(args.serviceId)}::${Number(args.layerId)}`;
    const layer = state.features.get(key) ?? new Map<number, Record<string, unknown>>();
    let rows = [...layer.values()].sort((a, b) => Number(a.OBJECTID) - Number(b.OBJECTID));
    if (Array.isArray(args.objectIds)) {
      const wanted = new Set((args.objectIds as unknown[]).map((v) => Number(v)));
      rows = rows.filter((r) => wanted.has(Number(r.OBJECTID)));
    }
    const total = rows.length;
    const offset = decodeFeatureOffset(args);
    const limit = clampLimit(args.limit);
    const page = rows.slice(offset, offset + limit);
    const nextOffset = offset + page.length;
    const out: Record<string, unknown> = {
      features: page.map((attributes) => ({ attributes })),
      count: page.length,
      totalCount: total,
      resultOffset: offset,
    };
    if (nextOffset < total) {
      out.nextCursor = encodeCursor(nextOffset);
      out.exceededTransferLimit = true;
    } else {
      out.exceededTransferLimit = false;
    }
    return out;
  });

  handlers.set("honua_edit_features", (args) => {
    const key = `${String(args.serviceId)}::${Number(args.layerId)}`;
    let layer = state.features.get(key);
    if (!layer) {
      layer = new Map<number, Record<string, unknown>>();
      state.features.set(key, layer);
    }
    const addResults = (asArray(args.adds) as { attributes?: Record<string, unknown> }[]).map((add) => {
      const objectId = state.nextObjectId++;
      layer.set(objectId, { ...(add.attributes ?? {}), OBJECTID: objectId });
      return { objectId, success: true };
    });
    const updateResults = (asArray(args.updates) as { objectId?: number; attributes?: Record<string, unknown> }[]).map(
      (u) => {
        const objectId = Number(u.objectId);
        const existing = layer.get(objectId);
        if (!existing) {
          return { objectId, success: false };
        }
        layer.set(objectId, { ...existing, ...(u.attributes ?? {}), OBJECTID: objectId });
        return { objectId, success: true };
      },
    );
    const deleteResults = (asArray(args.deletes) as number[]).map((raw) => {
      const objectId = Number(raw);
      return { objectId, success: layer.delete(objectId) };
    });
    return { addResults, updateResults, deleteResults };
  });

  handlers.set("honua_execute_plan", () => {
    const seq = state.nextJobSeq++;
    const jobId = `job-${String(seq).padStart(3, "0")}`;
    const resultPackageId = `res-${jobId}`;
    state.jobs.set(jobId, { jobId, polls: 0, resultPackageId });
    return { jobId, status: "Submitted" };
  });

  return handlers;
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
  const state = newCatalogState();
  const handlers = buildToolHandlers(state);

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

    const handler = handlers.get(tool.name);
    const output = handler ? handler(request.params.arguments ?? {}) : tool.sampleOutput;
    return {
      content: [{ type: "text", text: JSON.stringify(output) }],
      structuredContent: output,
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

    const uri = request.params.uri;

    // Dynamic job lifecycle resource: honua://jobs/{id} advances a documented
    // Submitted→Running→Succeeded state machine on each poll.
    const jobMatch = /^honua:\/\/jobs\/([^/]+)$/.exec(uri);
    if (jobMatch) {
      return readJobResource(state, jobMatch[1], uri);
    }
    // Dynamic result package (produced by a Succeeded job) or the seeded packages.
    const resultMatch = /^honua:\/\/results\/([^/]+)$/.exec(uri);
    if (resultMatch && !resources.some((r) => r.uri === uri)) {
      return jsonResource(uri, {
        resultPackageId: resultMatch[1],
        status: "Ready",
        artifacts: [{ kind: "FeatureService", uri: `honua://services/svc-pub-${resultMatch[1]}` }],
      });
    }

    const resource = resources.find((r) => r.uri === uri);
    if (!resource) {
      throw new McpError(ErrorCode.InvalidParams, `Unknown resource: ${uri}`, {
        code: "not_found",
        error: { kind: "UnknownDataset", message: `Unknown resource: ${uri}` },
      } satisfies StructuredOperatorError);
    }
    return {
      contents: [{ uri: resource.uri, mimeType: resource.mimeType, text: JSON.stringify(resource.contents) }],
    };
  });

  return server;
}

function readJobResource(state: CatalogState, jobId: string, uri: string): { contents: unknown[] } {
  const job = state.jobs.get(jobId);
  if (!job) {
    throw new McpError(ErrorCode.InvalidParams, `Unknown job: ${jobId}`, {
      code: "not_found",
      error: { kind: "UnknownProcess", message: `Unknown job: ${jobId}` },
    } satisfies StructuredOperatorError);
  }
  job.polls++;
  const succeeded = job.polls >= JOB_SUCCESS_AFTER_POLLS;
  const status = succeeded ? "Succeeded" : "Running";
  const fraction = Math.min(job.polls / JOB_SUCCESS_AFTER_POLLS, 1);
  const body: Record<string, unknown> = {
    jobId: job.jobId,
    status,
    progress: { fraction: Number(fraction.toFixed(4)), message: `step ${job.polls}` },
  };
  if (succeeded) {
    body.resultPackageId = job.resultPackageId;
    body.resultUri = `honua://results/${job.resultPackageId}`;
  }
  return jsonResource(uri, body);
}

function jsonResource(uri: string, body: unknown): { contents: unknown[] } {
  return { contents: [{ uri, mimeType: "application/json", text: JSON.stringify(body) }] };
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function clampLimit(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) {
    return 100;
  }
  return Math.min(Math.floor(n), 1000);
}

/** Resolve a feature-page offset from an explicit `resultOffset` or a page `cursor`. */
function decodeFeatureOffset(args: Record<string, unknown>): number {
  if (typeof args.cursor === "string") {
    return decodeCursor(args.cursor);
  }
  const off = Number(args.resultOffset);
  return Number.isFinite(off) && off >= 0 ? Math.floor(off) : 0;
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
