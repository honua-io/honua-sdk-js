import { createHash, randomBytes } from "node:crypto";
import { link, lstat, open, unlink } from "node:fs/promises";
import path from "node:path";

import type { AdminOperationId } from "../control-plane/index.js";
import { restrictPrivateFile, syncPrivateFileDirectory, verifyPrivateFile } from "../private-file.js";
import { ArgError } from "./args.js";

export const ADMIN_ONE_TIME_SECRET_OPERATION_IDS = [
  "createAdminApiKey",
  "rotateAdminApiKey",
  "registerOAuthClient",
  "createEmbedKey",
  "rotateEmbedKey",
  "issueAdminOperatorBearer",
] as const satisfies readonly AdminOperationId[];

export type AdminOneTimeSecretOperationId = (typeof ADMIN_ONE_TIME_SECRET_OPERATION_IDS)[number];

export interface AdminSecretOutputReceipt {
  readonly operationId: AdminOneTimeSecretOperationId;
  readonly resource: Readonly<Record<string, unknown>>;
  readonly secretWritten: boolean;
  readonly secretOutput: string;
  readonly secretSha256?: string;
}

export interface PreparedAdminSecretSink {
  readonly outputPath: string;
  commit(secret: string): Promise<{ readonly path: string; readonly sha256: string }>;
  abort(): Promise<void>;
}

export class AdminSecretPersistenceError extends Error {
  public constructor(
    public readonly operationId: AdminOneTimeSecretOperationId,
    public readonly resource: Readonly<Record<string, unknown>>,
    public readonly recoveryPath?: string,
  ) {
    super(
      recoveryPath
        ? `The one-time secret is retained in the private recovery file ${recoveryPath}.`
        : `The one-time secret for ${operationId} could not be persisted.`,
    );
    this.name = "AdminSecretPersistenceError";
  }
}

class SecretSinkCommitError extends Error {
  public constructor(public readonly recoveryPath?: string) {
    super("one-time secret sink commit failed");
  }
}

const ONE_TIME_SECRET_OPERATIONS = new Set<AdminOperationId>(ADMIN_ONE_TIME_SECRET_OPERATION_IDS);
const MAX_ONE_TIME_SECRET_BYTES = 64 * 1_024;

export function isAdminOneTimeSecretOperation(
  operationId: AdminOperationId,
): operationId is AdminOneTimeSecretOperationId {
  return ONE_TIME_SECRET_OPERATIONS.has(operationId);
}

/**
 * Reserve a same-directory private temporary file before issuing a one-time
 * credential. The completed bytes become visible at the requested path through
 * an atomic hard-link create, which refuses an existing path rather than
 * replacing it.
 */
export async function prepareAdminSecretSink(outputPath: string): Promise<PreparedAdminSecretSink> {
  const resolved = path.resolve(outputPath);
  try {
    await lstat(resolved);
    throw secretSinkError();
  } catch (error) {
    if (error instanceof ArgError) throw error;
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw secretSinkError();
  }
  const temporary = path.join(
    path.dirname(resolved),
    `.${path.basename(resolved)}.${randomBytes(12).toString("hex")}.tmp`,
  );
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let sinkIdentity: { readonly dev: bigint; readonly ino: bigint } | undefined;
  try {
    handle = await open(temporary, "wx", 0o600);
    const metadata = await handle.stat({ bigint: true });
    if (!metadata.isFile()) throw new Error("secret sink handle is not regular");
    sinkIdentity = { dev: metadata.dev, ino: metadata.ino };
    await restrictPrivateFile(temporary);
    await verifyPrivateFile(temporary);
    await requireSinkIdentity(temporary, sinkIdentity, [1n]);
    await handle.truncate(MAX_ONE_TIME_SECRET_BYTES);
    await handle.sync();
    await requireSinkIdentity(temporary, sinkIdentity, [1n]);
  } catch {
    await handle?.close().catch(() => undefined);
    if (sinkIdentity) await unlinkSinkIdentity(temporary, sinkIdentity, [1n]);
    throw secretSinkError();
  }
  if (!handle || !sinkIdentity) throw secretSinkError();
  const privateHandle = handle;
  const privateIdentity = sinkIdentity;

  let committed = false;
  let retained = false;
  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    await privateHandle.close().catch(() => undefined);
  };
  const cleanup = async (): Promise<void> => {
    await close();
    await unlinkSinkIdentity(temporary, privateIdentity, [1n, 2n]);
  };

  return {
    outputPath: resolved,
    async commit(secret) {
      if (committed) throw secretSinkError();
      if (Buffer.byteLength(secret, "utf8") > MAX_ONE_TIME_SECRET_BYTES) throw new SecretSinkCommitError();
      let linked = false;
      let durable = false;
      try {
        await requireSinkIdentity(temporary, privateIdentity, [1n]);
        await privateHandle.writeFile(secret, { encoding: "utf8" });
        await privateHandle.truncate(Buffer.byteLength(secret, "utf8"));
        await privateHandle.sync();
        durable = true;
        await requireSinkIdentity(temporary, privateIdentity, [1n]);
        await close();
        await verifyPrivateFile(temporary);
        await requireSinkIdentity(temporary, privateIdentity, [1n]);
        await link(temporary, resolved);
        linked = true;
        await verifyPrivateFile(resolved);
        await requireSinkIdentity(temporary, privateIdentity, [2n]);
        await requireSinkIdentity(resolved, privateIdentity, [2n]);
        await syncPrivateFileDirectory(resolved);
        committed = true;
        await unlink(temporary);
        await requireSinkIdentity(resolved, privateIdentity, [1n]);
        await syncPrivateFileDirectory(resolved);
        return {
          path: resolved,
          sha256: createHash("sha256").update(secret, "utf8").digest("hex"),
        };
      } catch {
        let recoveryPath: string | undefined;
        if (durable) {
          const candidate = linked ? resolved : temporary;
          try {
            await verifyPrivateFile(candidate);
            await requireSinkIdentity(candidate, privateIdentity, linked ? [1n, 2n] : [1n]);
            recoveryPath = candidate;
          } catch {
            recoveryPath = undefined;
          }
        }
        if (linked && recoveryPath !== resolved) await unlinkSinkIdentity(resolved, privateIdentity, [1n, 2n]);
        if (recoveryPath) {
          retained = true;
          if (recoveryPath === resolved) await unlinkSinkIdentity(temporary, privateIdentity, [1n, 2n]);
          throw new SecretSinkCommitError(recoveryPath);
        }
        await cleanup();
        throw new SecretSinkCommitError();
      }
    },
    async abort() {
      if (!committed && !retained) await cleanup();
    },
  };
}

async function unlinkSinkIdentity(
  filePath: string,
  expected: { readonly dev: bigint; readonly ino: bigint },
  allowedLinks: readonly bigint[],
): Promise<void> {
  try {
    await requireSinkIdentity(filePath, expected, allowedLinks);
    await unlink(filePath);
  } catch {
    // Never remove a pathname unless it still identifies the sink we created.
  }
}

async function requireSinkIdentity(
  filePath: string,
  expected: { readonly dev: bigint; readonly ino: bigint },
  allowedLinks: readonly bigint[],
): Promise<void> {
  const metadata = await lstat(filePath, { bigint: true });
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.dev !== expected.dev ||
    metadata.ino !== expected.ino ||
    !allowedLinks.includes(metadata.nlink)
  ) {
    throw new Error("One-time-secret sink pathname identity changed during issuance.");
  }
}

/** Strip one-time material and commit it only to the prepared private sink. */
export async function writeAdminOneTimeSecret(
  operationId: AdminOneTimeSecretOperationId,
  response: unknown,
  sink: PreparedAdminSecretSink,
): Promise<AdminSecretOutputReceipt> {
  const extracted = extractSecretResponse(operationId, response);
  if (extracted.secret === null) {
    await sink.abort();
    return {
      operationId,
      resource: extracted.resource,
      secretWritten: false,
      secretOutput: sink.outputPath,
    };
  }
  let committed: { readonly path: string; readonly sha256: string };
  try {
    committed = await sink.commit(extracted.secret);
  } catch (error) {
    if (error instanceof SecretSinkCommitError) {
      throw new AdminSecretPersistenceError(operationId, extracted.resource, error.recoveryPath);
    }
    throw error;
  }
  return {
    operationId,
    resource: extracted.resource,
    secretWritten: true,
    secretOutput: committed.path,
    secretSha256: committed.sha256,
  };
}

function extractSecretResponse(
  operationId: AdminOneTimeSecretOperationId,
  response: unknown,
): { readonly secret: string | null; readonly resource: Readonly<Record<string, unknown>> } {
  const root = record(response);
  if (operationId === "issueAdminOperatorBearer") {
    return {
      secret: requiredSecret(root.accessToken, operationId),
      resource: pick(root, ["expiresAt", "expiresIn", "tokenType"]),
    };
  }

  const data = record(root.data);
  if (operationId === "createAdminApiKey" || operationId === "rotateAdminApiKey") {
    return {
      secret: requiredSecret(data.key, operationId),
      resource: pick(record(data.apiKey), [
        "id",
        "name",
        "keyPrefix",
        "permissions",
        "status",
        "createdAt",
        "updatedAt",
        "expiresAt",
        "lastUsedAt",
        "rotatedAt",
        "revokedAt",
        "createdBy",
      ]),
    };
  }
  if (operationId === "createEmbedKey" || operationId === "rotateEmbedKey") {
    const embedKey = record(data.embedKey);
    return {
      secret: requiredSecret(data.key, operationId),
      resource: {
        ...pick(embedKey, [
          "id",
          "name",
          "keyPrefix",
          "status",
          "createdAt",
          "updatedAt",
          "expiresAt",
          "lastUsedAt",
          "rotatedAt",
          "revokedAt",
          "createdBy",
        ]),
        ...(isRecord(embedKey.scope)
          ? {
              scope: pick(embedKey.scope, [
                "allowedContentIds",
                "allowedEmbedOrigins",
                "allowedServiceOrigins",
                "edition",
                "integrationId",
                "rateLimitRequestsPerWindow",
                "rateLimitWindowSeconds",
                "tenantId",
              ]),
            }
          : {}),
      },
    };
  }

  const client = record(data.client);
  const clientSecret = data.clientSecret ?? null;
  if (client.clientType !== "confidential" && client.clientType !== "public") {
    throw invalidSecretResponse(operationId);
  }
  if (clientSecret !== null && (typeof clientSecret !== "string" || clientSecret.length === 0)) {
    throw invalidSecretResponse(operationId);
  }
  if (client.clientType === "confidential" && clientSecret === null) throw invalidSecretResponse(operationId);
  return {
    secret: clientSecret,
    resource: pick(client, [
      "id",
      "clientId",
      "name",
      "clientType",
      "allowedGrantTypes",
      "allowedScopes",
      "redirectUris",
      "secretPrefix",
      "status",
      "createdAt",
      "updatedAt",
      "expiresAt",
      "lastUsedAt",
      "createdBy",
    ]),
  };
}

function requiredSecret(value: unknown, operationId: AdminOneTimeSecretOperationId): string {
  if (typeof value !== "string" || value.length === 0) throw invalidSecretResponse(operationId);
  return value;
}

function pick(value: Readonly<Record<string, unknown>>, names: readonly string[]): Readonly<Record<string, unknown>> {
  return Object.fromEntries(names.filter((name) => value[name] !== undefined).map((name) => [name, value[name]]));
}

function record(value: unknown): Readonly<Record<string, unknown>> {
  if (!isRecord(value)) throw new Error("invalid");
  return value;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function invalidSecretResponse(operationId: AdminOneTimeSecretOperationId): Error {
  return new Error(
    `Admin operation ${operationId} returned an invalid one-time-secret response; no output was emitted.`,
  );
}

function secretSinkError(): ArgError {
  return new ArgError(
    "The one-time secret could not be written to a new private file. Choose a path that does not exist in a writable directory.",
  );
}
