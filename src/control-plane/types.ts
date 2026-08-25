import type { Capability, Protocol, SourceDescriptor, SourceLocator } from "../contract/index.js";
import type { HonuaCacheValidator } from "../core/cache-state.js";
import type { QueryMethod } from "../core/types.js";
import type { HonuaMapPackage } from "../runtime/index.js";

export const HONUA_CONTROL_PLANE_BASE_PATH = "/api/v1/admin" as const;

/**
 * Server-wide capability manifest path (`honua.capability_manifest.v1`). Sits
 * outside the admin base path — the manifest describes the whole deployment,
 * not an admin resource.
 */
export const HONUA_CAPABILITY_MANIFEST_PATH = "/api/v1/capabilities/manifest" as const;

export type HonuaControlPlaneCapability =
  | "hosted-maps"
  | "map-packages"
  | "imports"
  | "api-tokens"
  | "workspaces"
  | "connections"
  | "sharing"
  | "capabilities"
  | "raw";

/** Options for {@link HonuaControlPlaneClient.getCapabilityManifest}. */
export interface HonuaCapabilityManifestOptions extends HonuaControlPlaneRequestOptions {
  /** Optional environment (metadata snapshot) identifier to scope the manifest to. */
  readonly environment?: string;
  /** Optional workspace identifier to scope the manifest to. */
  readonly workspaceId?: string;
}

export interface HonuaProblemDetails {
  readonly type?: string;
  readonly title?: string;
  readonly status?: number;
  readonly detail?: string;
  readonly instance?: string;
  readonly code?: string;
  readonly errors?: Record<string, readonly string[]>;
  readonly [extra: string]: unknown;
}

export interface HonuaControlPlaneUnsupported {
  readonly supported: false;
  readonly capability: HonuaControlPlaneCapability;
  readonly statusCode?: number;
  readonly reason: string;
  readonly problem?: HonuaProblemDetails;
}

export interface HonuaControlPlaneSuccess<T> {
  readonly supported: true;
  readonly value: T;
}

export type HonuaControlPlaneResult<T> = HonuaControlPlaneSuccess<T> | HonuaControlPlaneUnsupported;

export interface HonuaControlPlaneRequestOptions {
  readonly signal?: AbortSignal;
  readonly headers?: HeadersInit;
  /**
   * Sent as the `Idempotency-Key` request header. Lets a retried mutation
   * collapse to one server-side effect. The shared command layer
   * (`./commands/index.js`) derives one deterministically from the command id,
   * the canonicalized input, and the tenant so the same logical request is
   * idempotent across the CLI, MCP, Studio, and direct JS.
   */
  readonly idempotencyKey?: string;
  /**
   * Sent as the `If-Match` request header — the optimistic-concurrency
   * validator from a prior {@link HonuaEntityValidators}. An explicit
   * `headers` entry of the same name still wins.
   */
  readonly ifMatch?: string;
}

export interface HonuaControlPlaneListOptions extends HonuaControlPlaneRequestOptions {
  readonly cursor?: string;
  readonly limit?: number;
  readonly workspaceId?: string;
  readonly q?: string;
  readonly includeDeleted?: boolean;
  readonly refresh?: boolean;
  readonly validator?: HonuaCacheValidator;
}

export interface HonuaControlPlanePage<T> {
  readonly items: readonly T[];
  readonly pagination: {
    readonly nextCursor?: string;
    readonly previousCursor?: string;
    readonly limit?: number;
    readonly total?: number;
  };
  readonly validator?: HonuaCacheValidator;
  readonly sourceUpdatedAt?: string;
}

export interface HonuaEntityValidators {
  readonly etag?: string;
  readonly lastModified?: string;
}

export interface HonuaHostedMapSummary extends HonuaEntityValidators {
  readonly id: string;
  readonly title: string;
  readonly workspaceId?: string;
  readonly packageId?: string;
  readonly status?: "Draft" | "Publishing" | "Ready" | "Failed" | "Archived" | (string & {});
  readonly visibility?: "private" | "workspace" | "public" | (string & {});
  readonly createdAt?: string;
  readonly updatedAt?: string;
  readonly links?: HonuaControlPlaneLinks;
  readonly [extra: string]: unknown;
}

export interface HonuaHostedMap extends HonuaHostedMapSummary {
  readonly description?: string;
  readonly sourceDescriptors?: readonly HonuaControlPlaneSourceDescriptor[];
  readonly mapPackage?: HonuaMapPackage;
}

export interface HonuaCreateHostedMapRequest {
  readonly title: string;
  readonly workspaceId?: string;
  readonly description?: string;
  readonly visibility?: "private" | "workspace" | "public" | (string & {});
  readonly sourceDescriptors?: readonly HonuaControlPlaneSourceDescriptor[];
  readonly mapPackage?: HonuaMapPackage;
  readonly metadata?: Record<string, unknown>;
}

export type HonuaUpdateHostedMapRequest = Partial<HonuaCreateHostedMapRequest> & {
  readonly ifMatch?: string;
};

export interface HonuaMapPackageSummary extends HonuaEntityValidators {
  readonly id: string;
  readonly mapPackageId?: string;
  readonly title?: string;
  readonly status?: string;
  readonly mapId?: string;
  readonly workspaceId?: string;
  readonly createdAt?: string;
  readonly updatedAt?: string;
  readonly expiresAt?: string;
  readonly links?: HonuaControlPlaneLinks;
  readonly [extra: string]: unknown;
}

export interface HonuaPublishMapPackageRequest {
  readonly mapId?: string;
  readonly workspaceId?: string;
  readonly package: HonuaMapPackage;
  readonly message?: string;
  readonly ifMatch?: string;
}

export interface HonuaPublishMapPackageResponse extends HonuaEntityValidators {
  readonly packageId: string;
  readonly mapPackage?: HonuaMapPackage;
  readonly job?: HonuaControlPlaneJob;
  readonly links?: HonuaControlPlaneLinks;
  readonly [extra: string]: unknown;
}

export interface HonuaControlPlaneSourceDescriptor {
  readonly id: string;
  readonly protocol: Protocol;
  readonly locator: SourceLocator;
  readonly capabilities: readonly Capability[];
  readonly schema?: SourceDescriptor["schema"];
  readonly analytics?: SourceDescriptor["analytics"];
  readonly attribution?: string;
}

export interface HonuaImportCreateRequest {
  readonly sourceKind: string;
  readonly sourceUrl?: string;
  readonly workspaceId?: string;
  readonly connectionId?: string;
  readonly title?: string;
  readonly dryRun?: boolean;
  readonly options?: Record<string, unknown>;
}

export type HonuaControlPlaneJobStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled" | (string & {});

export interface HonuaControlPlaneJob extends HonuaEntityValidators {
  readonly id: string;
  readonly type?: "import" | "publish" | (string & {});
  readonly status: HonuaControlPlaneJobStatus;
  readonly progress?: {
    readonly completed?: number;
    readonly total?: number;
    readonly message?: string;
  };
  readonly result?: unknown;
  readonly problem?: HonuaProblemDetails;
  readonly createdAt?: string;
  readonly updatedAt?: string;
  readonly links?: HonuaControlPlaneLinks;
  readonly [extra: string]: unknown;
}

export interface HonuaApiTokenCreateRequest {
  readonly name: string;
  readonly workspaceId?: string;
  readonly scopes?: readonly string[];
  readonly expiresAt?: string;
  readonly metadata?: Record<string, unknown>;
}

export interface HonuaApiToken extends HonuaEntityValidators {
  readonly id: string;
  readonly name: string;
  readonly workspaceId?: string;
  readonly scopes?: readonly string[];
  readonly status?: "active" | "revoked" | "expired" | (string & {});
  readonly prefix?: string;
  readonly createdAt?: string;
  readonly expiresAt?: string;
  readonly lastUsedAt?: string;
  readonly value?: string;
  readonly secret?: string;
  readonly token?: string;
  readonly oneTimeReveal?: string;
  readonly [extra: string]: unknown;
}

export interface HonuaWorkspaceSummary extends HonuaEntityValidators {
  readonly id: string;
  readonly name: string;
  readonly slug?: string;
  readonly createdAt?: string;
  readonly updatedAt?: string;
  readonly [extra: string]: unknown;
}

export interface HonuaConnectionSummary extends HonuaEntityValidators {
  readonly id: string;
  readonly name: string;
  readonly kind: string;
  readonly workspaceId?: string;
  readonly status?: string;
  readonly createdAt?: string;
  readonly updatedAt?: string;
  readonly value?: string;
  readonly secret?: string;
  readonly password?: string;
  readonly token?: string;
  readonly [extra: string]: unknown;
}

export interface HonuaShareRequest {
  readonly visibility: "private" | "workspace" | "public" | (string & {});
  readonly principals?: ReadonlyArray<{
    readonly type: "user" | "group" | "workspace" | (string & {});
    readonly id: string;
  }>;
  readonly ifMatch?: string;
}

export interface HonuaShareResponse extends HonuaEntityValidators {
  readonly id: string;
  readonly visibility: string;
  readonly principals?: HonuaShareRequest["principals"];
  readonly [extra: string]: unknown;
}

export interface HonuaControlPlaneLinks {
  readonly self?: string;
  readonly mapPackage?: string;
  readonly sourceDescriptor?: string;
  readonly job?: string;
  readonly [rel: string]: string | undefined;
}

export interface HonuaControlPlaneRawRequest extends HonuaControlPlaneRequestOptions {
  readonly method?: QueryMethod;
  readonly path: string;
  readonly body?: unknown;
  readonly okStatuses?: readonly number[];
}
