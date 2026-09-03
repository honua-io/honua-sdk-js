/**
 * The 2026.1 command catalog: real commands over the existing control-plane and
 * Studio resource clients.
 *
 * These four cover one end-to-end slice of the terminal release journey —
 * probe a connection, start an import, publish a map package, and save a Studio
 * draft as an immutable version — and exercise every capability the shared
 * layer promises: idempotency, dry run, cancellation, validation, typed errors,
 * and deterministic receipts. Each command owns its own sequencing, which is
 * why `studio.draft.saveVersion` performs the optimistic-generation check here
 * rather than in four transports.
 *
 * ## Where the concurrency check is bracketed, not atomic
 *
 * `studio.draft.saveVersion` cannot make its generation check atomic with the
 * write, because the Studio lifecycle API offers nothing to make it atomic
 * with: `POST /package-drafts/{draftId}/content-versions` takes no request body
 * (`HonuaStudioDraftsClient.createContentVersion`, and the pinned contract
 * fixture `test/fixtures/studio-lifecycle/content-version-create.v1.json`) and
 * `HonuaStudioRequestOptions` has no `ifMatch` — unlike its control-plane
 * sibling `HonuaControlPlaneRequestOptions`. The one optimistic-concurrency
 * primitive in the surface is the `generation` field on the
 * `PUT /package-drafts/{draftId}` *body* (`StudioPackageDraftReplaceRequest`),
 * which this route has no analogue for.
 *
 * So the command brackets the write instead of pretending the check was
 * atomic: it reads the generation before, re-reads it after, and raises a
 * `conflict` naming the version it created if the draft moved at any point.
 * `generation` is documented to increment on every successful `PUT`
 * (`StudioPackageDraft`), so no concurrent edit can slip through the bracket
 * unseen. When honua-server grows a real precondition on this route, the
 * bracket collapses into it and the second read goes away.
 *
 * @experimental
 * @module
 */

import type { HonuaMapPackage } from "../../runtime/index.js";
import type { StudioContentVersion } from "../../studio/lifecycle-types.js";
import type {
  HonuaControlPlaneJob,
  HonuaControlPlaneResult,
  HonuaEntityValidators,
  HonuaPublishMapPackageResponse,
} from "../types.js";
import { HonuaCommandError } from "./errors.js";
import type { HonuaAnyCommand, HonuaCommand, HonuaCommandResourceRef } from "./types.js";

// ---------------------------------------------------------------------------
// connection.test
// ---------------------------------------------------------------------------

/** Input for {@link connectionTestCommand}. */
export interface ConnectionTestInput {
  /** Existing connection to probe. */
  readonly connectionId: string;
}

/** Server probe result. Left open: the probe payload is deployment-specific. */
export interface ConnectionTestOutput {
  readonly ok?: boolean;
  readonly status?: string;
  readonly detail?: string;
  readonly [extra: string]: unknown;
}

/**
 * `POST /connections/{connectionId}/test` — probe a stored connection.
 *
 * The server does not consume an idempotency key or a workspace body. Keep the
 * command identity limited to the connection route so receipts describe the
 * request the server actually processed.
 */
export const connectionTestCommand: HonuaCommand<ConnectionTestInput, ConnectionTestOutput> = {
  id: "connection.test",
  title: "Test a connection",
  description: "Probe a stored control-plane connection and report whether the server can reach it.",
  mode: "read",
  resourceKind: "connection",
  inputSchema: {
    type: "object",
    description: "Identifies the stored connection to probe.",
    properties: {
      connectionId: { type: "string", minLength: 1, description: "Identifier of the stored connection." },
    },
    required: ["connectionId"],
    additionalProperties: false,
  },
  plan(context) {
    return {
      method: "POST",
      path: connectionTestPath(context.input.connectionId),
      summary: `Probe connection ${context.input.connectionId}`,
      resourceRef: connectionRef(context.input),
    };
  },
  async execute(context) {
    const result = await context.controlPlane.raw<ConnectionTestOutput>({
      method: "POST",
      path: connectionTestPath(context.input.connectionId),
      ...context.requestOptions(),
    });
    const value = unwrap(result, this.id, {
      correlationId: context.correlationId,
      idempotencyKey: context.idempotencyKey,
    });
    return {
      output: value ?? {},
      ...(value?.ok === false ? { status: "denied" as const } : {}),
      resourceRef: connectionRef(context.input),
    };
  },
};

function connectionTestPath(connectionId: string): string {
  return `/connections/${encodeURIComponent(connectionId)}/test`;
}

function connectionRef(input: ConnectionTestInput): HonuaCommandResourceRef {
  return {
    type: "connection",
    id: input.connectionId,
  };
}

// ---------------------------------------------------------------------------
// import.create
// ---------------------------------------------------------------------------

/**
 * Input for {@link importCreateCommand}.
 *
 * The server's own `dryRun` request field is deliberately not exposed: dry run
 * is a command-layer concept here, and two spellings of it would let one
 * transport preview while another executed.
 */
export interface ImportCreateInput {
  readonly sourceKind: string;
  readonly sourceUrl?: string;
  readonly connectionId?: string;
  readonly workspaceId?: string;
  readonly title?: string;
  readonly options?: Record<string, unknown>;
}

/** `POST /imports` — enqueue an import job. */
export const importCreateCommand: HonuaCommand<ImportCreateInput, HonuaControlPlaneJob> = {
  id: "import.create",
  title: "Create an import job",
  description: "Enqueue a control-plane import job for a source URL or a stored connection.",
  mode: "action",
  resourceKind: "import-job",
  inputSchema: {
    type: "object",
    description: "Describes the source to import.",
    properties: {
      sourceKind: { type: "string", minLength: 1, description: "Import source kind, e.g. `geojson` or `postgis`." },
      sourceUrl: { type: "string", minLength: 1, description: "Source URL, when the import reads a location." },
      connectionId: { type: "string", minLength: 1, description: "Stored connection, when the import reads a system." },
      workspaceId: { type: "string", minLength: 1, description: "Workspace that will own the imported content." },
      title: { type: "string", minLength: 1, description: "Human title for the resulting content." },
      options: { type: "object", description: "Import-kind-specific options, passed through verbatim." },
    },
    required: ["sourceKind"],
    additionalProperties: false,
  },
  validate(input) {
    // JSON Schema cannot say "one of these two", and this has to run before the
    // dry-run short circuit: a preview that accepts an import with no source
    // would be a preview of a request the server never sees.
    if (!input.sourceUrl && !input.connectionId) {
      return [{ path: "", message: "one of `sourceUrl` or `connectionId` is required" }];
    }
    return [];
  },
  plan(context) {
    const { input } = context;
    return {
      method: "POST",
      path: "/imports",
      summary: `Import ${input.sourceKind} from ${input.sourceUrl ?? input.connectionId ?? "(unspecified source)"}`,
      resourceRef: {
        type: "import-job",
        ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
      },
    };
  },
  async execute(context) {
    const { input } = context;
    const result = await context.controlPlane.imports.create(
      {
        sourceKind: input.sourceKind,
        ...(input.sourceUrl ? { sourceUrl: input.sourceUrl } : {}),
        ...(input.connectionId ? { connectionId: input.connectionId } : {}),
        ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
        ...(input.title ? { title: input.title } : {}),
        ...(input.options ? { options: input.options } : {}),
      },
      context.requestOptions(),
    );
    const job = unwrap(result, this.id, {
      correlationId: context.correlationId,
      idempotencyKey: context.idempotencyKey,
    });
    return {
      output: job,
      resourceRef: {
        type: "import-job",
        ...(job?.id ? { id: job.id } : {}),
        ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
        ...(job?.links?.self ? { href: job.links.self } : {}),
      },
      ...(validatorsOf(job) ? { validators: validatorsOf(job) } : {}),
      ...(job?.problem ? { problem: job.problem } : {}),
    };
  },
};

// ---------------------------------------------------------------------------
// map-package.publish
// ---------------------------------------------------------------------------

/**
 * Input for {@link mapPackagePublishCommand}.
 *
 * There is no approval field, and the schema is closed: publication approval is
 * a server decision, and no transport may express one. The optimistic-
 * concurrency validator travels on `HonuaCommandInvocation.ifMatch`, not in the
 * input, so it can never become part of the idempotency identity.
 */
export interface MapPackagePublishInput {
  /** Hosted map the package belongs to. */
  readonly mapId?: string;
  readonly workspaceId?: string;
  /** The `honua_map_package.v1` document to publish. */
  readonly package: HonuaMapPackage;
  /** Publication message recorded with the version. */
  readonly message?: string;
}

/** `POST /packages` — publish a map package version. */
export const mapPackagePublishCommand: HonuaCommand<MapPackagePublishInput, HonuaPublishMapPackageResponse> = {
  id: "map-package.publish",
  title: "Publish a map package",
  description: "Publish a map package version. Approval and visibility remain server-side decisions.",
  mode: "action",
  resourceKind: "map-package",
  inputSchema: {
    type: "object",
    description: "The map package to publish and where it belongs.",
    properties: {
      mapId: { type: "string", minLength: 1, description: "Hosted map the package version belongs to." },
      workspaceId: { type: "string", minLength: 1, description: "Owning workspace." },
      package: { type: "object", description: "The `honua_map_package.v1` document." },
      message: { type: "string", description: "Publication message recorded with the version." },
    },
    required: ["package"],
    additionalProperties: false,
  },
  plan(context) {
    const { input } = context;
    return {
      method: "POST",
      path: "/packages",
      summary: input.mapId ? `Publish a package version for map ${input.mapId}` : "Publish a map package version",
      resourceRef: {
        type: "map-package",
        ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
      },
    };
  },
  async execute(context) {
    const { input } = context;
    const result = await context.controlPlane.packages.publish(
      {
        package: input.package,
        ...(input.mapId ? { mapId: input.mapId } : {}),
        ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
        ...(input.message ? { message: input.message } : {}),
      },
      context.requestOptions(),
    );
    const response = unwrap(result, this.id, {
      correlationId: context.correlationId,
      idempotencyKey: context.idempotencyKey,
    });
    return {
      output: response,
      resourceRef: {
        type: "map-package",
        ...(response?.packageId ? { id: response.packageId } : {}),
        ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
        ...(response?.links?.self ? { href: response.links.self } : {}),
      },
      ...(validatorsOf(response) ? { validators: validatorsOf(response) } : {}),
    };
  },
};

// ---------------------------------------------------------------------------
// studio.draft.saveVersion
// ---------------------------------------------------------------------------

/** Input for {@link studioDraftSaveVersionCommand}. */
export interface StudioDraftSaveVersionInput {
  readonly draftId: string;
  /**
   * Last-seen draft `generation`. When supplied, the command brackets the write
   * with a generation read on each side and fails with a `conflict` error if
   * the draft moved — the optimistic-concurrency sequencing every transport
   * would otherwise reimplement.
   *
   * The check is *detected*, not *enforced*: the route accepts no precondition,
   * so a concurrent edit surfaces as a loud conflict naming the version that
   * was created rather than as a rejected write. See this module's
   * "Where the concurrency check is bracketed, not atomic".
   */
  readonly generation?: number;
}

/** `POST /package-drafts/{draftId}/content-versions` — save a draft as an immutable version. */
export const studioDraftSaveVersionCommand: HonuaCommand<StudioDraftSaveVersionInput, StudioContentVersion> = {
  id: "studio.draft.saveVersion",
  title: "Save a Studio draft as a version",
  description: "Freeze a mutable Studio package draft into an immutable content version, checking the generation.",
  mode: "action",
  resourceKind: "studio-content-version",
  inputSchema: {
    type: "object",
    description: "Identifies the draft to freeze.",
    properties: {
      draftId: { type: "string", minLength: 1, description: "Mutable draft identifier." },
      generation: { type: "integer", minimum: 0, description: "Last-seen draft generation for concurrency checking." },
    },
    required: ["draftId"],
    additionalProperties: false,
  },
  plan(context) {
    return {
      method: "POST",
      path: `/package-drafts/${encodeURIComponent(context.input.draftId)}/content-versions`,
      summary: `Save draft ${context.input.draftId} as an immutable content version`,
      resourceRef: { type: "studio-package-draft", id: context.input.draftId },
    };
  },
  async execute(context) {
    const studio = context.studio;
    if (!studio) {
      throw new HonuaCommandError(
        "transport",
        this.id,
        "studio.draft.saveVersion requires a Studio lifecycle client; construct the runtime with `studio`.",
        { correlationId: context.correlationId, idempotencyKey: context.idempotencyKey },
      );
    }
    // The Studio lifecycle client takes `{ signal, headers }` rather than the
    // control-plane option bag, so the idempotency key is threaded as the
    // header it becomes — and only onto the mutating call.
    const options = context.requestOptions();
    const readOptions = {
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.headers ? { headers: options.headers } : {}),
    };
    // The command-owned key goes on last: the runtime already refuses a caller
    // header that would replace it, and this keeps the value on the wire equal
    // to the value the receipt records even if that guard is ever relaxed.
    const writeOptions = {
      ...readOptions,
      headers: { ...headersToRecord(options.headers), "Idempotency-Key": context.idempotencyKey },
    };

    if (context.input.generation !== undefined) {
      const draft = await studio.drafts.get(context.input.draftId, readOptions);
      if (draft.generation !== context.input.generation) {
        throw new HonuaCommandError(
          "conflict",
          this.id,
          `Studio draft ${context.input.draftId} moved from generation ${context.input.generation} to ${draft.generation}; reload and retry.`,
          { correlationId: context.correlationId, idempotencyKey: context.idempotencyKey, statusCode: 409 },
        );
      }
    }

    const version = await studio.drafts.createContentVersion(context.input.draftId, writeOptions);

    // The lifecycle API exposes no precondition on the content-version POST, so
    // the pre-read alone leaves a window in which another editor's `PUT` lands
    // between the check and the write. When the caller asked for concurrency
    // protection, close the bracket: re-read and refuse to report a success we
    // cannot vouch for. The created version is named so the caller can
    // reconcile it rather than lose track of it.
    if (context.input.generation !== undefined) {
      const after = await studio.drafts.get(context.input.draftId, readOptions);
      if (after.generation !== context.input.generation) {
        throw new HonuaCommandError(
          "conflict",
          this.id,
          `Studio draft ${context.input.draftId} moved from generation ${context.input.generation} to ${after.generation} while version ${version?.versionId ?? "(unknown)"} was being cut; reconcile that version, then reload and retry.`,
          { correlationId: context.correlationId, idempotencyKey: context.idempotencyKey, statusCode: 409 },
        );
      }
    }

    return {
      output: version,
      resourceRef: {
        type: "studio-content-version",
        ...(version?.versionId ? { id: version.versionId } : {}),
      },
    };
  },
};

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/** Every command id in the 2026.1 catalog, in registry order. */
export const HONUA_COMMAND_IDS = [
  "connection.test",
  "import.create",
  "map-package.publish",
  "studio.draft.saveVersion",
] as const;

/** One of {@link HONUA_COMMAND_IDS}. */
export type HonuaCommandId = (typeof HONUA_COMMAND_IDS)[number];

/**
 * The shared registry every transport dispatches through. MCP tool schemas,
 * CLI help, Studio clients, and JS methods all project from these entries.
 */
export const HONUA_COMMANDS = {
  "connection.test": connectionTestCommand,
  "import.create": importCreateCommand,
  "map-package.publish": mapPackagePublishCommand,
  "studio.draft.saveVersion": studioDraftSaveVersionCommand,
} as const satisfies Record<HonuaCommandId, HonuaAnyCommand>;

/** Type guard narrowing an arbitrary string to a registered command id. */
export function isHonuaCommandId(value: string): value is HonuaCommandId {
  return Object.hasOwn(HONUA_COMMANDS, value);
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/**
 * Unwrap a {@link HonuaControlPlaneResult}, converting the "this deployment
 * does not expose the capability" arm into a typed `transport` failure so every
 * transport reports the gap the same way.
 */
function unwrap<T>(
  result: HonuaControlPlaneResult<T>,
  commandId: string,
  trace: { readonly correlationId: string; readonly idempotencyKey: string },
): T {
  if (result.supported) return result.value;
  throw new HonuaCommandError("transport", commandId, result.reason, {
    correlationId: trace.correlationId,
    idempotencyKey: trace.idempotencyKey,
    ...(result.statusCode !== undefined ? { statusCode: result.statusCode } : {}),
    ...(result.problem ? { problem: result.problem } : {}),
  });
}

function headersToRecord(headers: HeadersInit | undefined): Record<string, string> {
  if (!headers) return {};
  if (headers instanceof Headers) return Object.fromEntries(headers.entries());
  if (Array.isArray(headers)) return Object.fromEntries(headers);
  return { ...headers };
}

function validatorsOf(value: HonuaEntityValidators | undefined): HonuaEntityValidators | undefined {
  if (!value) return undefined;
  const etag = value.etag;
  const lastModified = value.lastModified;
  if (!etag && !lastModified) return undefined;
  return { ...(etag ? { etag } : {}), ...(lastModified ? { lastModified } : {}) };
}
