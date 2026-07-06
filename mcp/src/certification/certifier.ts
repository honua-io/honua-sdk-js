import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  type AuthMode,
  type SuiteProvenance,
  readNegotiatedProtocolVersion,
  resolveSuiteGitSha,
} from "../provenance.js";
import {
  AUTH_ERROR_CODES,
  type ContractOutcome,
  type ListPage,
  checkAuthContract,
  checkInvalidArgsContract,
  checkPaginationContract,
} from "./contracts.js";
import { buildInvalidArgsInputs, buildRoundTripInputs, resolveRoundTripEnv } from "./fixtures.js";
import { checkConformance, checkWellFormed, validateAgainstSchema } from "./json-schema.js";
import { runDeepContracts } from "./lifecycle.js";
import {
  type JsonSchema,
  type StandardToolEntry,
  buildReferenceToolLookup,
  loadSchemaFile,
  loadSchemaIndex,
} from "./schema-index.js";
import type { CertTargetMode } from "./target.js";

/** Per-tool certification record (machine-readable). */
export interface ToolCertification {
  name: string;
  discovered: true;
  /** inputSchema is structurally valid JSON Schema (draft 2020-12 dialect). */
  schemaValid: boolean;
  /** Whether the server advertises a structured-output schema for this tool. */
  hasOutputSchema: boolean;
  /** Matched standard tool (by referenceToolName / alias), if any. */
  standardName: string | null;
  /** Conformant to the matched standard schema. `null` when no standard match. */
  conformant: boolean | null;
  /** Server-advertised read-only hint; round-trip only runs for read-only tools. */
  readOnly: boolean;
  /** Round-trip outcome. `skipped` when not read-only or no fixture input. */
  roundTrip: "passed" | "failed" | "skipped";
  /** Whether structuredContent validated against the advertised outputSchema. `null` when not exercised. */
  structuredOutputValidated: boolean | null;
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

/** A cross-cutting contract check against the certified surface. */
export interface ContractCheck {
  contract:
    | "output-schema"
    | "error-shape"
    | "auth-unauthenticated"
    | "list-pagination"
    | "query-pagination"
    | "mutating-round-trip"
    | "mutating-permission-denied"
    | "async-job-lifecycle";
  target: string;
  status: "passed" | "failed" | "skipped";
  detail: string;
}

export interface CertificationReport {
  schemaVersion: 2;
  generatedAt: string;
  server: { name: string; version: string };
  protocol: {
    mcpTransport: string;
    honuaTransport: string | null;
    backend: "mock-upstream" | "live";
    targetMode: CertTargetMode;
    surface: string;
  };
  standard: { source: string; indexDate: string; dialect: string };
  /** Self-proving provenance: what was certified, with which suite, how authed. */
  provenance: SuiteProvenance;
  summary: {
    pass: boolean;
    toolsDiscovered: number;
    toolsSchemaValid: number;
    toolsConformanceChecked: number;
    toolsConformant: number;
    toolsRoundTripped: number;
    toolsOutputValidated: number;
    resourcesDiscovered: number;
    promptsDiscovered: number;
    contractsChecked: number;
    contractsPassed: number;
    contractsFailed: number;
    contractsSkipped: number;
    knownGaps: number;
    failures: number;
  };
  tools: ToolCertification[];
  resources: ResourceCertification[];
  prompts: { name: string; discovered: true }[];
  contracts: ContractCheck[];
  knownGaps: KnownGap[];
}

export interface CertifyOptions {
  /** Authenticated, connected MCP client to certify. */
  client: Client;
  /** Which target the client is connected to. */
  targetMode: CertTargetMode;
  /** Backend behind the surface (mock upstream or a live server). */
  backend: "mock-upstream" | "live";
  /** Human-readable label of the certified surface. */
  surface: string;
  /** Logical Honua backend transport for the artifact, if known. */
  honuaTransport?: string | null;
  /** Open a fresh, unauthenticated client for the auth contract (optional). */
  connectUnauthenticated?: (() => Promise<Client>) | undefined;
  /** How the authenticated client reached the surface (recorded in provenance). */
  authMode?: AuthMode;
  /** Environment used to resolve round-trip identifiers. */
  env?: NodeJS.ProcessEnv;
}

const STANDARD_SOURCE = "geospatial-mcp@54cbd49 (spec/schemas)";

/** Determine whether a discovered tool is safe to round-trip (read-only). */
export function isReadOnlyTool(tool: { name: string; annotations?: { readOnlyHint?: boolean } }): boolean {
  if (tool.annotations && typeof tool.annotations.readOnlyHint === "boolean") {
    return tool.annotations.readOnlyHint;
  }
  const mutating = /(create|update|delete|publish|apply_.*write|execute|edit|deploy|cancel|propose)/i;
  return !mutating.test(tool.name);
}

interface AdvertisedTool {
  name: string;
  inputSchema?: unknown;
  outputSchema?: unknown;
  annotations?: { readOnlyHint?: boolean };
}

/**
 * Connect an MCP client to the certified surface and produce a deterministic
 * certification report. The client is already connected (offline mock upstream,
 * a live `/mcp`, or the stdio proxy); certify never owns its lifecycle.
 */
export async function certify(options: CertifyOptions): Promise<CertificationReport> {
  const { client } = options;
  const roundTripEnv = resolveRoundTripEnv(options.env);
  const roundTripInputs = buildRoundTripInputs(roundTripEnv);

  const index = loadSchemaIndex();
  const referenceLookup = buildReferenceToolLookup(index);

  const serverInfo = client.getServerVersion() ?? { name: "unknown", version: "0.0.0" };

  const { tools: advertisedTools, pages: toolPages } = await listAllTools(client);
  const { resources: advertisedResources, pages: resourcePages } = await listAllResources(client);
  const prompts = await listPromptsSafely(client);

  const tools: ToolCertification[] = [];
  const advertisedNames = new Set<string>();
  for (const tool of advertisedTools) {
    advertisedNames.add(tool.name);
    tools.push(await certifyTool(client, tool, referenceLookup, roundTripInputs));
  }

  const resources: ResourceCertification[] = advertisedResources.map((r) => ({
    name: r.name,
    uri: r.uri,
    discovered: true,
  }));

  const contracts: ContractCheck[] = [];
  contracts.push(paginationCheck("tools", toolPages));
  contracts.push(paginationCheck("resources", resourcePages));
  collectOutputSchemaContracts(tools, contracts);
  contracts.push(await runErrorShapeContract(client, advertisedTools));
  await runAuthContracts(options, advertisedTools, advertisedResources, contracts);

  // Deep contracts: mutating round-trip, unauthenticated-write refusal, async job
  // lifecycle, and query pagination. Safe by construction — mutations only run
  // against the disposable offline mock or an explicit scratch target.
  const deep = await runDeepContracts({
    client,
    advertisedToolNames: advertisedNames,
    isDisposableBackend: options.backend === "mock-upstream",
    connectUnauthenticated: options.connectUnauthenticated,
    env: options.env,
  });
  contracts.push(...deep);

  const knownGaps = collectKnownGaps(index, advertisedNames, referenceLookup);

  const gitSha = resolveSuiteGitSha(options.env);
  const provenance: SuiteProvenance = {
    suiteGitSha: gitSha.sha,
    suiteGitShaSource: gitSha.source,
    targetUrl: options.surface,
    protocolVersion: readNegotiatedProtocolVersion(client),
    toolCount: advertisedTools.length,
    authMode: options.authMode ?? (options.backend === "mock-upstream" ? "bearer" : "unknown"),
  };

  return assembleReport({
    serverInfo: serverInfo as { name: string; version: string },
    index,
    options,
    tools,
    resources,
    prompts,
    contracts,
    knownGaps,
    provenance,
  });
}

async function listAllTools(client: Client): Promise<{ tools: AdvertisedTool[]; pages: ListPage[] }> {
  const tools: AdvertisedTool[] = [];
  const pages: ListPage[] = [];
  let cursor: string | undefined;
  do {
    const resp = await client.listTools(cursor ? { cursor } : undefined);
    tools.push(...(resp.tools as AdvertisedTool[]));
    pages.push({ keys: resp.tools.map((t) => t.name), nextCursor: resp.nextCursor });
    cursor = resp.nextCursor;
  } while (cursor && pages.length < 100);
  return { tools, pages };
}

async function listAllResources(
  client: Client,
): Promise<{ resources: { name: string; uri: string }[]; pages: ListPage[] }> {
  const resources: { name: string; uri: string }[] = [];
  const pages: ListPage[] = [];
  let cursor: string | undefined;
  do {
    const resp = await client.listResources(cursor ? { cursor } : undefined);
    resources.push(...resp.resources.map((r) => ({ name: r.name, uri: r.uri })));
    pages.push({ keys: resp.resources.map((r) => r.uri), nextCursor: resp.nextCursor });
    cursor = resp.nextCursor;
  } while (cursor && pages.length < 100);
  return { resources, pages };
}

async function listPromptsSafely(client: Client): Promise<{ name: string; discovered: true }[]> {
  try {
    const response = await client.listPrompts();
    return response.prompts.map((p) => ({ name: p.name, discovered: true as const }));
  } catch {
    return [];
  }
}

async function certifyTool(
  client: Client,
  tool: AdvertisedTool,
  referenceLookup: Map<string, StandardToolEntry>,
  roundTripInputs: Record<string, Record<string, unknown>>,
): Promise<ToolCertification> {
  const errors: string[] = [];
  const notes: string[] = [];

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

  const readOnly = isReadOnlyTool(tool);
  let roundTrip: ToolCertification["roundTrip"] = "skipped";
  let structuredOutputValidated: boolean | null = null;
  const fixtureInput = roundTripInputs[tool.name];
  if (readOnly && fixtureInput !== undefined) {
    const outcome = await roundTripTool(client, tool, fixtureInput, errors, notes);
    roundTrip = outcome.roundTrip;
    structuredOutputValidated = outcome.structuredOutputValidated;
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
    structuredOutputValidated,
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
): Promise<{ roundTrip: ToolCertification["roundTrip"]; structuredOutputValidated: boolean | null }> {
  try {
    const result = (await client.callTool({ name: tool.name, arguments: input })) as {
      isError?: boolean;
      content?: unknown;
      structuredContent?: unknown;
    };
    if (result.isError) {
      errors.push("round-trip: tool returned isError=true");
      return { roundTrip: "failed", structuredOutputValidated: null };
    }
    if (tool.outputSchema && result.structuredContent !== undefined) {
      const validation = validateAgainstSchema(tool.outputSchema as JsonSchema, result.structuredContent);
      if (!validation.valid) {
        errors.push(...validation.errors.map((e) => `output-schema: structuredContent ${e}`));
        return { roundTrip: "failed", structuredOutputValidated: false };
      }
      return { roundTrip: "passed", structuredOutputValidated: true };
    }
    if (tool.outputSchema && result.structuredContent === undefined) {
      errors.push("output-schema: outputSchema advertised but no structuredContent returned");
      return { roundTrip: "failed", structuredOutputValidated: false };
    }
    return { roundTrip: "passed", structuredOutputValidated: null };
  } catch (err) {
    errors.push(`round-trip: ${err instanceof Error ? err.message : String(err)}`);
    return { roundTrip: "failed", structuredOutputValidated: null };
  }
}

function paginationCheck(target: string, pages: ListPage[]): ContractCheck {
  const paginated = pages.length > 1 || (pages[0]?.nextCursor !== undefined && pages[0]?.nextCursor !== null);
  if (!paginated) {
    return {
      contract: "list-pagination",
      target,
      status: "skipped",
      detail: `${target} list is a single page (no nextCursor advertised)`,
    };
  }
  const outcome = checkPaginationContract(pages);
  return {
    contract: "list-pagination",
    target,
    status: outcome.ok ? "passed" : "failed",
    detail: outcome.ok
      ? `${target} list paginated across ${pages.length} pages; nextCursor honored and terminated`
      : outcome.errors.join("; "),
  };
}

function collectOutputSchemaContracts(tools: ToolCertification[], contracts: ContractCheck[]): void {
  for (const tool of tools) {
    if (tool.structuredOutputValidated === null) {
      continue;
    }
    contracts.push({
      contract: "output-schema",
      target: tool.name,
      status: tool.structuredOutputValidated ? "passed" : "failed",
      detail: tool.structuredOutputValidated
        ? "structuredContent validated against advertised outputSchema"
        : "structuredContent did not validate against advertised outputSchema",
    });
  }
}

async function runErrorShapeContract(client: Client, advertised: AdvertisedTool[]): Promise<ContractCheck> {
  const invalidInputs = buildInvalidArgsInputs();
  const advertisedNames = new Set(advertised.map((t) => t.name));
  const target = Object.keys(invalidInputs).find((name) => advertisedNames.has(name));
  if (!target) {
    return {
      contract: "error-shape",
      target: "(none)",
      status: "skipped",
      detail: "no advertised tool has an invalid-args fixture",
    };
  }
  try {
    const result = (await client.callTool({ name: target, arguments: invalidInputs[target] })) as {
      isError?: boolean;
      structuredContent?: unknown;
    };
    const outcome = checkInvalidArgsContract(result);
    return contractFromOutcome("error-shape", target, outcome);
  } catch (err) {
    return {
      contract: "error-shape",
      target,
      status: "failed",
      detail: `invalid arguments raised a protocol error instead of a structured tool error: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }
}

async function runAuthContracts(
  options: CertifyOptions,
  advertised: AdvertisedTool[],
  resources: { uri: string }[],
  contracts: ContractCheck[],
): Promise<void> {
  if (!options.connectUnauthenticated) {
    contracts.push({
      contract: "auth-unauthenticated",
      target: "tools/call",
      status: "skipped",
      detail: "target does not support an unauthenticated pass",
    });
    contracts.push({
      contract: "auth-unauthenticated",
      target: "resources/read",
      status: "skipped",
      detail: "target does not support an unauthenticated pass",
    });
    return;
  }

  let unauth: Client | undefined;
  try {
    unauth = await options.connectUnauthenticated();

    // tools/call without credentials.
    const toolTarget = advertised.find((t) => isReadOnlyTool(t)) ?? advertised[0];
    if (toolTarget) {
      const roundTripInputs = buildRoundTripInputs(resolveRoundTripEnv(options.env));
      const args = roundTripInputs[toolTarget.name] ?? {};
      contracts.push(await authCheckToolsCall(unauth, toolTarget.name, args));
    }

    // resources/read without credentials.
    if (resources[0]) {
      contracts.push(await authCheckResourcesRead(unauth, resources[0].uri));
    }
  } catch (err) {
    contracts.push({
      contract: "auth-unauthenticated",
      target: "tools/call",
      status: "failed",
      detail: `unauthenticated pass could not be established: ${err instanceof Error ? err.message : String(err)}`,
    });
  } finally {
    if (unauth) {
      await unauth.close().catch(() => {});
    }
  }
}

async function authCheckToolsCall(client: Client, name: string, args: Record<string, unknown>): Promise<ContractCheck> {
  try {
    const result = await client.callTool({ name, arguments: args });
    if ((result as { isError?: boolean }).isError !== true) {
      return {
        contract: "auth-unauthenticated",
        target: "tools/call",
        status: "failed",
        detail: `unauthenticated tools/call on ${name} returned a non-error result — auth boundary not enforced`,
      };
    }
    return contractFromOutcome("auth-unauthenticated", "tools/call", checkAuthContract(result));
  } catch (err) {
    // A structured McpError carrying an auth code also satisfies the contract.
    return contractFromOutcome("auth-unauthenticated", "tools/call", checkAuthContract(err));
  }
}

async function authCheckResourcesRead(client: Client, uri: string): Promise<ContractCheck> {
  try {
    await client.readResource({ uri });
    return {
      contract: "auth-unauthenticated",
      target: "resources/read",
      status: "failed",
      detail: `unauthenticated resources/read on ${uri} succeeded — auth boundary not enforced`,
    };
  } catch (err) {
    return contractFromOutcome("auth-unauthenticated", "resources/read", checkAuthContract(err));
  }
}

function contractFromOutcome(
  contract: ContractCheck["contract"],
  target: string,
  outcome: ContractOutcome,
): ContractCheck {
  return {
    contract,
    target,
    status: outcome.ok ? "passed" : "failed",
    detail: outcome.ok ? "contract satisfied" : outcome.errors.join("; "),
  };
}

function collectKnownGaps(
  index: ReturnType<typeof loadSchemaIndex>,
  advertisedNames: Set<string>,
  referenceLookup: Map<string, StandardToolEntry>,
): KnownGap[] {
  const gaps: KnownGap[] = [];
  // Advertised names that resolve to a standard entry through the SDK-local
  // reference aliases (e.g. honua_dry_run_plan → validate_plan) also count as
  // covering that standard tool.
  const coveredStandardNames = new Set<string>();
  for (const name of advertisedNames) {
    const entry = referenceLookup.get(name);
    if (entry) {
      coveredStandardNames.add(entry.standardName);
    }
  }
  for (const tool of index.tools) {
    if (!coveredStandardNames.has(tool.standardName)) {
      gaps.push({
        kind: "standard-tool",
        name: tool.standardName,
        family: tool.family,
        detail:
          tool.implementationStatus === "known-gap"
            ? "standard family not yet implemented as a discrete tool"
            : `reference tool ${tool.referenceToolName ?? "(unnamed)"} not advertised by the certified surface`,
      });
    }
  }
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
  options: CertifyOptions;
  tools: ToolCertification[];
  resources: ResourceCertification[];
  prompts: { name: string; discovered: true }[];
  contracts: ContractCheck[];
  knownGaps: KnownGap[];
  provenance: SuiteProvenance;
}): CertificationReport {
  const { serverInfo, index, options, tools, resources, prompts, contracts, knownGaps, provenance } = args;

  const toolsSchemaValid = tools.filter((t) => t.schemaValid).length;
  const conformanceChecked = tools.filter((t) => t.conformant !== null);
  const toolsConformant = conformanceChecked.filter((t) => t.conformant === true).length;
  const toolsRoundTripped = tools.filter((t) => t.roundTrip === "passed").length;
  const toolsOutputValidated = tools.filter((t) => t.structuredOutputValidated === true).length;

  const contractsChecked = contracts.filter((c) => c.status !== "skipped").length;
  const contractsPassed = contracts.filter((c) => c.status === "passed").length;
  const contractsFailed = contracts.filter((c) => c.status === "failed").length;
  const contractsSkipped = contracts.filter((c) => c.status === "skipped").length;

  const toolFailures = tools.reduce((acc, t) => acc + t.errors.length, 0);
  const failures = toolFailures + contractsFailed;
  const pass = failures === 0;

  return {
    schemaVersion: 2,
    generatedAt: new Date().toISOString(),
    server: serverInfo,
    protocol: {
      mcpTransport: options.targetMode === "stdio-proxy" ? "stdio→streamable-http" : "streamable-http",
      honuaTransport: options.honuaTransport ?? null,
      backend: options.backend,
      targetMode: options.targetMode,
      surface: options.surface,
    },
    standard: { source: STANDARD_SOURCE, indexDate: index.date, dialect: index.dialect },
    provenance,
    summary: {
      pass,
      toolsDiscovered: tools.length,
      toolsSchemaValid,
      toolsConformanceChecked: conformanceChecked.length,
      toolsConformant,
      toolsRoundTripped,
      toolsOutputValidated,
      resourcesDiscovered: resources.length,
      promptsDiscovered: prompts.length,
      contractsChecked,
      contractsPassed,
      contractsFailed,
      contractsSkipped,
      knownGaps: knownGaps.length,
      failures,
    },
    tools,
    resources,
    prompts,
    contracts,
    knownGaps,
  };
}

// Re-export for artifact/report consumers.
export { AUTH_ERROR_CODES };
