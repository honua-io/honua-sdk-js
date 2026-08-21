import { readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import path from "node:path";

import { ADMIN_OPERATIONS, type AdminOperationId, HonuaAdminClient } from "../../control-plane/index.js";
import {
  type LocalInstallProfile,
  cloudInstallHandoff,
  getHonuaLocalStatus,
  installHonuaLocal,
  renderLocalCompose,
} from "../../local-install.js";
import {
  type AdminOneTimeSecretOperationId,
  AdminSecretPersistenceError,
  isAdminOneTimeSecretOperation,
  prepareAdminSecretSink,
  writeAdminOneTimeSecret,
} from "../admin-secret-output.js";
import type { ParsedArgs } from "../args.js";
import { ArgError, getArray, getBoolean, getNumber, getString } from "../args.js";
import type { CommandContext } from "../command.js";
import { resolveAdminConnection } from "../config.js";
import { printLine, renderJson } from "../output.js";

const ADMIN_GROUPS = new Set(["connect", "import", "publish", "configure", "secure", "release", "operate"]);

const ADMIN_HELP = `honua admin — complete Honua control-plane client

USAGE
  honua admin <group> <operationId> [options]
  honua admin api <operationId> [options]
  honua admin operations [group]
  honua admin install local|cloud|status [options]

GROUPS
  connect  import  publish  configure  secure  release  operate

REQUEST OPTIONS
  --body <json|@file>       JSON request body
  --path <name=value>       Path parameter (repeatable)
  --query <name=value>      Query parameter (repeatable)
  --header <name=value>     Request header (repeatable)
  --secret-output <path>    Required private file sink for one-time secret responses
  --dry-run                 Print the resolved operation request without sending it
  --yes                     Required for mutating REST operations
  --profile <name>          Use a named profile from the Honua config file
  --admin-key <key>         Root admin key (or HONUA_ADMIN_KEY)
  --json                    Machine-readable output

The api escape hatch exposes every operation in the pinned 396-operation Admin OpenAPI contract.
See docs/admin-cli-reference.md for the generated inventory.`;

export async function adminCommand(parsed: ParsedArgs, ctx: CommandContext): Promise<void> {
  const group = parsed.positionals[0];
  if (!group || group === "help") {
    printLine(ADMIN_HELP);
    return;
  }
  if (group === "operations") {
    printOperations(parsed.positionals[1]);
    return;
  }
  if (group === "install") {
    await installCommand(parsed);
    return;
  }
  if (group !== "api" && !ADMIN_GROUPS.has(group)) {
    throw new ArgError(`Unknown admin group: ${group}`);
  }

  const operationId = parsed.positionals[1];
  if (!operationId || !isOperationId(operationId)) {
    throw new ArgError(`Unknown or missing admin operationId: ${operationId ?? "(missing)"}`);
  }
  const descriptor = ADMIN_OPERATIONS[operationId];
  if (group !== "api" && descriptor.group !== group) {
    throw new ArgError(
      `${operationId} belongs to the ${descriptor.group} group. Use ` +
        `honua admin ${descriptor.group} ${operationId}, or the api escape hatch.`,
    );
  }

  const request = {
    path: assignments(getArray(parsed, "path"), "path"),
    query: assignments(getArray(parsed, "query"), "query"),
    headers: stringAssignments(getArray(parsed, "header"), "header"),
    body: readBody(getString(parsed, "body")),
  };
  if (getBoolean(parsed, "dry-run")) {
    printLine(renderJson({ operationId, ...descriptor, request, executed: false }));
    return;
  }
  const secretOutput = getString(parsed, "secret-output");
  const oneTimeSecret = isAdminOneTimeSecretOperation(operationId);
  if (oneTimeSecret && !secretOutput) {
    throw new ArgError(
      `Admin operation ${operationId} returns one-time secret material. Re-run with --secret-output <new-private-file>.`,
    );
  }
  if (!oneTimeSecret && secretOutput) {
    throw new ArgError("--secret-output is valid only for an Admin operation that returns one-time secret material.");
  }
  if (descriptor.mutating && !getBoolean(parsed, "yes")) {
    throw new ArgError(`Admin operation ${operationId} mutates state. Re-run with --yes or inspect it with --dry-run.`);
  }

  const connection = resolveAdminConnection({
    baseUrl: ctx.baseUrl,
    apiKey: ctx.apiKey,
    adminKey: ctx.adminKey,
    profile: ctx.profile,
  });
  const client = new HonuaAdminClient({
    baseUrl: connection.baseUrl,
    apiKey: connection.apiKey,
    adminKey: connection.adminKey,
  });
  if (!oneTimeSecret) {
    const result = await callDynamic(client, operationId, compactRequest(request));
    printLine(renderJson(result.data));
    return;
  }

  if (!secretOutput) throw new Error("internal error: one-time-secret sink validation was bypassed");
  const sink = await prepareAdminSecretSink(secretOutput);
  try {
    const result = await callDynamic(client, operationId, compactRequest(request));
    printLine(renderJson(await writeAdminOneTimeSecret(operationId, result.data, sink)));
  } catch (error) {
    await sink.abort();
    if (error instanceof AdminSecretPersistenceError) {
      throw await handleSecretPersistenceFailure(client, error);
    }
    if (error instanceof ArgError || isSafeSecretResponseError(error)) throw error;
    throw new Error(`Admin one-time-secret operation ${operationId} failed; server details were suppressed.`);
  }
}

async function handleSecretPersistenceFailure(
  client: HonuaAdminClient,
  error: AdminSecretPersistenceError,
): Promise<ArgError> {
  if (error.recoveryPath && isRecoveryPreferred(error.operationId)) {
    return new ArgError(
      `Admin operation ${error.operationId} completed, but its requested sink could not be finalized. ` +
        `The one-time material is retained in the verified private recovery file ${error.recoveryPath}.`,
    );
  }

  const rollback = rollbackOperation(error.operationId, error.resource);
  if (!rollback) {
    return new ArgError(
      error.operationId === "issueAdminOperatorBearer"
        ? `Admin operation ${error.operationId} completed, but its one-time material could not be persisted. The short-lived bearer cannot be revoked; wait for it to expire before retrying.`
        : `Admin operation ${error.operationId} completed, but its resource identity could not be verified for compensating rollback. Inspect server state before retrying.`,
    );
  }

  try {
    await callDynamic(client, rollback.operationId, { path: { id: rollback.resourceId } });
  } catch {
    return new ArgError(
      `Admin operation ${error.operationId} completed, but private-file persistence and compensating rollback both failed. Inspect the server resource ${rollback.resourceId} before retrying.${error.recoveryPath ? ` One-time material remains in ${error.recoveryPath}.` : ""}`,
    );
  }

  if (error.recoveryPath) {
    try {
      await rm(error.recoveryPath, { force: true });
    } catch {
      return new ArgError(
        `Admin operation ${error.operationId} was rolled back after persistence failed, but the private ` +
          `recovery file ${error.recoveryPath} could not be removed. Delete it before retrying.`,
      );
    }
  }
  return new ArgError(
    `Admin operation ${error.operationId} was rolled back because its one-time material could not be committed to the requested private file.`,
  );
}

function isRecoveryPreferred(operationId: AdminOneTimeSecretOperationId): boolean {
  return (
    operationId === "rotateAdminApiKey" ||
    operationId === "rotateEmbedKey" ||
    operationId === "issueAdminOperatorBearer"
  );
}

function rollbackOperation(
  operationId: AdminOneTimeSecretOperationId,
  resource: Readonly<Record<string, unknown>>,
): { readonly operationId: AdminOperationId; readonly resourceId: string } | null {
  const resourceId = typeof resource.id === "string" && resource.id.trim() !== "" ? resource.id : null;
  if (!resourceId) return null;
  if (operationId === "createAdminApiKey" || operationId === "rotateAdminApiKey") {
    return { operationId: "revokeAdminApiKey", resourceId };
  }
  if (operationId === "registerOAuthClient") {
    return { operationId: "deleteOAuthClient", resourceId };
  }
  if (operationId === "createEmbedKey" || operationId === "rotateEmbedKey") {
    return { operationId: "revokeEmbedKey", resourceId };
  }
  return null;
}

async function installCommand(parsed: ParsedArgs): Promise<void> {
  const action = parsed.positionals[1];
  const directory = path.resolve(getString(parsed, "directory") ?? ".honua");
  if (action === "cloud") {
    printLine(renderJson(cloudInstallHandoff(parsed.positionals[2] ?? "aws")));
    return;
  }
  if (action === "status") {
    printLine(renderJson(await getHonuaLocalStatus(directory)));
    return;
  }
  if (action !== "local") throw new ArgError("Usage: honua admin install local|cloud|status");
  const profile = (getString(parsed, "profile") ?? "quickstart") as LocalInstallProfile;
  if (profile !== "quickstart" && profile !== "gp-dev") {
    throw new ArgError("Local install --profile must be quickstart or gp-dev.");
  }
  if (getBoolean(parsed, "dry-run")) {
    printLine(
      renderJson({
        action: "install-local",
        directory,
        profile,
        compose: renderLocalCompose({ profile }),
        executed: false,
      }),
    );
    return;
  }
  if (!getBoolean(parsed, "yes")) {
    throw new ArgError(
      "Local install creates files and starts Docker containers. Re-run with --yes or inspect with --dry-run.",
    );
  }
  const result = await installHonuaLocal({
    directory,
    profile,
    httpPort: getNumber(parsed, "http-port"),
    timeoutMs: getNumber(parsed, "timeout-ms"),
  });
  printLine(renderJson(result));
}

function printOperations(group: string | undefined): void {
  if (group && !ADMIN_GROUPS.has(group)) throw new ArgError(`Unknown admin group: ${group}`);
  const rows = Object.entries(ADMIN_OPERATIONS)
    .filter(([, descriptor]) => !group || descriptor.group === group)
    .map(([operationId, descriptor]) => ({ operationId, ...descriptor }));
  printLine(renderJson(rows));
}

function isOperationId(value: string): value is AdminOperationId {
  return Object.hasOwn(ADMIN_OPERATIONS, value);
}

function assignments(values: readonly string[], kind: string): Record<string, unknown> {
  return Object.fromEntries(values.map((value) => splitAssignment(value, kind, parseScalar)));
}

function stringAssignments(values: readonly string[], kind: string): Record<string, string> {
  return Object.fromEntries(values.map((value) => splitAssignment(value, kind, (raw) => raw)));
}

function splitAssignment<T>(value: string, kind: string, parse: (raw: string) => T): [string, T] {
  const separator = value.indexOf("=");
  if (separator <= 0) throw new ArgError(`--${kind} must be name=value, got: ${value}`);
  return [value.slice(0, separator), parse(value.slice(separator + 1))];
}

function parseScalar(value: string): unknown {
  if (value === "true") return true;
  if (value === "false") return false;
  if (value === "null") return null;
  if (value !== "" && Number.isFinite(Number(value))) return Number(value);
  if (value.startsWith("[") || value.startsWith("{")) {
    try {
      return JSON.parse(value);
    } catch {
      throw new ArgError(`Invalid JSON parameter value: ${value}`);
    }
  }
  return value;
}

function readBody(value: string | undefined): unknown {
  if (!value) return undefined;
  const raw = value.startsWith("@") ? readFileSync(value.slice(1), "utf8") : value;
  try {
    return JSON.parse(raw);
  } catch {
    throw new ArgError("--body must be JSON or @file containing JSON.");
  }
}

function compactRequest(request: {
  path: Record<string, unknown>;
  query: Record<string, unknown>;
  headers: Record<string, string>;
  body: unknown;
}): Record<string, unknown> {
  return {
    ...(Object.keys(request.path).length > 0 ? { path: request.path } : {}),
    ...(Object.keys(request.query).length > 0 ? { query: request.query } : {}),
    ...(Object.keys(request.headers).length > 0 ? { headers: request.headers } : {}),
    ...(request.body !== undefined ? { body: request.body } : {}),
  };
}

function callDynamic(
  client: HonuaAdminClient,
  operationId: AdminOperationId,
  request: Record<string, unknown>,
): Promise<{ readonly data: unknown }> {
  const call = client.call as unknown as (
    id: AdminOperationId,
    value: Record<string, unknown>,
  ) => Promise<{ readonly data: unknown }>;
  return call.call(client, operationId, request);
}

function isSafeSecretResponseError(error: unknown): boolean {
  return (
    error instanceof Error &&
    /returned an invalid one-time-secret response; no output was emitted\.$/.test(error.message)
  );
}
