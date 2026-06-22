import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { buildRoundTripInputs, resolveRoundTripEnv } from "./fixtures.js";
import { checkConformance, checkWellFormed, validateAgainstSchema } from "./json-schema.js";
import {
  type JsonSchema,
  type StandardToolEntry,
  buildReferenceToolLookup,
  loadSchemaFile,
  loadSchemaIndex,
} from "./schema-index.js";

/** Per-tool certification record (machine-readable). */
export interface ToolCertification {
  name: string;
  discovered: true;
  /** inputSchema is structurally valid JSON Schema (draft 2020-12 dialect). */
  schemaValid: boolean;
  /** Whether the server advertises a structured-output schema for this tool. */
  hasOutputSchema: boolean;
  /** Matched standard tool (by referenceToolName), if any. */
  standardName: string | null;
  /** Conformant to the matched standard schema. `null` when no standard match. */
  conformant: boolean | null;
  /** Server-advertised read-only hint; round-trip only runs for read-only tools. */
  readOnly: boolean;
  /** Round-trip outcome. `skipped` when not read-only or no fixture input. */
  roundTrip: "passed" | "failed" | "skipped";
  errors: string[];
  notes: string[];
}

/** Per-resource certification record. */
export interface ResourceCertification {
  name: string;
  uri: string;
  discovered: true;
}

/** A standard capability advertised by the spec but not implemented here. */
export interface KnownGap {
  kind: "standard-tool" | "advertised-tool";
  name: string;
  family?: string;
  detail: string;
}

export interface CertificationReport {
  schemaVersion: 1;
  generatedAt: string;
  server: { name: string; version: string };
  protocol: { mcpTransport: string; honuaTransport: string | null; backend: "fixture" | "live" };
  standard: { source: string; indexDate: string; dialect: string };
  summary: {
    pass: boolean;
    toolsDiscovered: number;
    toolsSchemaValid: number;
    toolsConformanceChecked: number;
    toolsConformant: number;
    toolsRoundTripped: number;
    resourcesDiscovered: number;
    promptsDiscovered: number;
    knownGaps: number;
    failures: number;
  };
  tools: ToolCertification[];
  resources: ResourceCertification[];
  prompts: { name: string; discovered: true }[];
  knownGaps: KnownGap[];
}

export interface CertifyOptions {
  /** MCP server to certify. */
  server: McpServer;
  /** Logical Honua backend transport (grpc-web/rest) for the artifact, if known. */
  honuaTransport?: string | null;
  /** Whether the backend is the offline fixture or a live server. */
  backend?: "fixture" | "live";
  /** Environment used to resolve round-trip identifiers. */
  env?: NodeJS.ProcessEnv;
}

const STANDARD_SOURCE = "geospatial-mcp@968d7d7 (spec/schemas)";

/** Determine whether a discovered tool is safe to round-trip (read-only). */
export function isReadOnlyTool(tool: { name: string; annotations?: { readOnlyHint?: boolean } }): boolean {
  // Honor an explicit server annotation when present (forward-compatible with
  // the honua-server /mcp surface that advertises readOnlyHint).
  if (tool.annotations && typeof tool.annotations.readOnlyHint === "boolean") {
    return tool.annotations.readOnlyHint;
  }
  // The @honua/mcp-server tool surface is read-only by construction: every tool
  // is an inspection/projection that never mutates server state. Tools whose
  // names imply mutation are conservatively treated as NOT read-only.
  const mutating = /(create|update|delete|publish|apply_.*write|execute|edit|deploy|cancel)/i;
  return !mutating.test(tool.name);
}

/**
 * Connect an MCP client to the given server over an in-memory transport and
 * produce a deterministic certification report. No network access, no model
 * calls — the only I/O is the in-process MCP round-trip and reading vendored
 * schema files.
 */
export async function certify(options: CertifyOptions): Promise<CertificationReport> {
  const { server } = options;
  const backend = options.backend ?? "fixture";
  const roundTripEnv = resolveRoundTripEnv(options.env);
  const roundTripInputs = buildRoundTripInputs(roundTripEnv);

  const index = loadSchemaIndex();
  const referenceLookup = buildReferenceToolLookup(index);

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "honua-mcp-certifier", version: "1.0.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  try {
    const serverInfo = client.getServerVersion() ?? { name: "unknown", version: "0.0.0" };

    const toolsResponse = await client.listTools();
    const resourcesResponse = await client.listResources();
    const prompts = await listPromptsSafely(client);

    const tools: ToolCertification[] = [];
    const advertisedNames = new Set<string>();

    for (const tool of toolsResponse.tools) {
      advertisedNames.add(tool.name);
      const record = await certifyTool(client, tool, referenceLookup, roundTripInputs);
      tools.push(record);
    }

    const resources: ResourceCertification[] = resourcesResponse.resources.map((r) => ({
      name: r.name,
      uri: r.uri,
      discovered: true,
    }));

    const knownGaps = collectKnownGaps(index, advertisedNames, referenceLookup);

    const report = assembleReport({
      serverInfo: serverInfo as { name: string; version: string },
      index,
      backend,
      honuaTransport: options.honuaTransport ?? null,
      tools,
      resources,
      prompts,
      knownGaps,
    });

    return report;
  } finally {
    await client.close();
    await server.close();
  }
}

async function listPromptsSafely(client: Client): Promise<{ name: string; discovered: true }[]> {
  try {
    const response = await client.listPrompts();
    return response.prompts.map((p) => ({ name: p.name, discovered: true as const }));
  } catch {
    // Server does not advertise the prompts capability — not a failure.
    return [];
  }
}

interface AdvertisedTool {
  name: string;
  inputSchema?: unknown;
  outputSchema?: unknown;
  annotations?: { readOnlyHint?: boolean };
}

async function certifyTool(
  client: Client,
  tool: AdvertisedTool,
  referenceLookup: Map<string, StandardToolEntry>,
  roundTripInputs: Record<string, Record<string, unknown>>,
): Promise<ToolCertification> {
  const errors: string[] = [];
  const notes: string[] = [];

  // 1. inputSchema well-formedness.
  const wellFormed = checkWellFormed(tool.inputSchema);
  if (!wellFormed.wellFormed) {
    errors.push(...wellFormed.errors.map((e) => `inputSchema not well-formed: ${e}`));
  }

  const hasOutputSchema = tool.outputSchema !== undefined && tool.outputSchema !== null;
  if (hasOutputSchema) {
    const outputWellFormed = checkWellFormed(tool.outputSchema);
    if (!outputWellFormed.wellFormed) {
      errors.push(...outputWellFormed.errors.map((e) => `outputSchema not well-formed: ${e}`));
    }
  } else {
    notes.push("no structured output schema advertised");
  }

  // 2. Conformance against the matched standard schema (if any).
  const standardEntry = referenceLookup.get(tool.name);
  let conformant: boolean | null = null;
  if (standardEntry) {
    const standardSchema = loadSchemaFile(standardEntry.schema);
    if (wellFormed.wellFormed) {
      const result = checkConformance(tool.inputSchema as JsonSchema, standardSchema);
      conformant = result.conformant;
      if (!result.conformant) {
        errors.push(...result.violations.map((v) => `conformance: ${v}`));
      }
      notes.push(...result.notes);
    } else {
      conformant = false;
      errors.push("conformance: skipped — inputSchema is not well-formed");
    }
  }

  // 3. Round-trip for read-only tools with a fixture input.
  const readOnly = isReadOnlyTool(tool);
  let roundTrip: ToolCertification["roundTrip"] = "skipped";
  const fixtureInput = roundTripInputs[tool.name];
  if (readOnly && fixtureInput !== undefined) {
    roundTrip = await roundTripTool(client, tool, fixtureInput, errors, notes);
  } else if (!readOnly) {
    notes.push("round-trip skipped: tool is not read-only");
  } else {
    notes.push("round-trip skipped: no fixture input");
  }

  return {
    name: tool.name,
    discovered: true,
    schemaValid: wellFormed.wellFormed,
    hasOutputSchema,
    standardName: standardEntry?.standardName ?? null,
    conformant,
    readOnly,
    roundTrip,
    errors,
    notes,
  };
}

async function roundTripTool(
  client: Client,
  tool: AdvertisedTool,
  input: Record<string, unknown>,
  errors: string[],
  notes: string[],
): Promise<ToolCertification["roundTrip"]> {
  try {
    const result = (await client.callTool({ name: tool.name, arguments: input })) as {
      isError?: boolean;
      content?: unknown;
      structuredContent?: unknown;
    };
    if (result.isError) {
      errors.push("round-trip: tool returned isError=true");
      return "failed";
    }
    // Validate structured output against the advertised output schema, if any.
    if (tool.outputSchema && result.structuredContent !== undefined) {
      const validation = validateAgainstSchema(tool.outputSchema as JsonSchema, result.structuredContent);
      if (!validation.valid) {
        errors.push(...validation.errors.map((e) => `round-trip output: ${e}`));
        return "failed";
      }
    } else if (tool.outputSchema && result.structuredContent === undefined) {
      notes.push("round-trip: output schema advertised but no structuredContent returned");
    }
    return "passed";
  } catch (err) {
    errors.push(`round-trip: ${err instanceof Error ? err.message : String(err)}`);
    return "failed";
  }
}

function collectKnownGaps(
  index: ReturnType<typeof loadSchemaIndex>,
  advertisedNames: Set<string>,
  referenceLookup: Map<string, StandardToolEntry>,
): KnownGap[] {
  const gaps: KnownGap[] = [];

  // Standard tools not advertised by this server (absence is a gap, not a fail).
  for (const tool of index.tools) {
    const referenceName = tool.referenceToolName;
    const advertised = referenceName ? advertisedNames.has(referenceName) : false;
    if (!advertised) {
      gaps.push({
        kind: "standard-tool",
        name: tool.standardName,
        family: tool.family,
        detail:
          tool.implementationStatus === "known-gap"
            ? "standard family not yet implemented as a discrete tool"
            : `reference tool ${referenceName ?? "(unnamed)"} not advertised by @honua/mcp-server`,
      });
    }
  }

  // Tools this server advertises that are not in the standard index.
  for (const name of advertisedNames) {
    if (!referenceLookup.has(name)) {
      gaps.push({
        kind: "advertised-tool",
        name,
        detail: "advertised tool has no matching geospatial-mcp standard schema (validated for well-formedness only)",
      });
    }
  }

  return gaps;
}

function assembleReport(args: {
  serverInfo: { name: string; version: string };
  index: ReturnType<typeof loadSchemaIndex>;
  backend: "fixture" | "live";
  honuaTransport: string | null;
  tools: ToolCertification[];
  resources: ResourceCertification[];
  prompts: { name: string; discovered: true }[];
  knownGaps: KnownGap[];
}): CertificationReport {
  const { serverInfo, index, backend, honuaTransport, tools, resources, prompts, knownGaps } = args;

  const toolsSchemaValid = tools.filter((t) => t.schemaValid).length;
  const conformanceChecked = tools.filter((t) => t.conformant !== null);
  const toolsConformant = conformanceChecked.filter((t) => t.conformant === true).length;
  const toolsRoundTripped = tools.filter((t) => t.roundTrip === "passed").length;
  const failures = tools.reduce((acc, t) => acc + t.errors.length, 0);
  const pass = failures === 0;

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    server: serverInfo,
    protocol: { mcpTransport: "in-memory", honuaTransport, backend },
    standard: { source: STANDARD_SOURCE, indexDate: index.date, dialect: index.dialect },
    summary: {
      pass,
      toolsDiscovered: tools.length,
      toolsSchemaValid,
      toolsConformanceChecked: conformanceChecked.length,
      toolsConformant,
      toolsRoundTripped,
      resourcesDiscovered: resources.length,
      promptsDiscovered: prompts.length,
      knownGaps: knownGaps.length,
      failures,
    },
    tools,
    resources,
    prompts,
    knownGaps,
  };
}
