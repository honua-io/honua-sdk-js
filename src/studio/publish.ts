/**
 * Versioned publication, share, and embed request/response contracts for
 * generated Studio artifacts. These extend the established control-plane
 * patterns: {@link HonuaShareRequest} / {@link HonuaShareResponse} are
 * re-exported from `control-plane/types` (single source of truth — not
 * re-declared) so Console and MCP can reach the share contract from the one
 * `@honua/sdk-js/studio` path without taking on the full control-plane client.
 *
 * @experimental Not yet covered by the SDK's semver contract — these shapes
 *   may change in any minor release prior to `1.0.0`.
 * @module
 */

import type { HonuaStudioPackage, HonuaStudioPackageFamily } from "./types.js";

// Re-exported from the canonical control-plane definition. Do not duplicate.
export type { HonuaShareRequest, HonuaShareResponse } from "../control-plane/types.js";

/**
 * Request to publish a Studio package of any family.
 *
 * @experimental
 */
export interface StudioPublishRequest<T = HonuaStudioPackage> {
  readonly packageFamily: HonuaStudioPackageFamily | (string & {});
  readonly package: T;
  readonly title?: string;
  readonly description?: string;
  readonly workspaceId?: string;
  readonly visibility?: "private" | "workspace" | "public" | (string & {});
  readonly message?: string;
  readonly ifMatch?: string;
  readonly [extra: string]: unknown;
}

/**
 * Response from publishing a Studio package.
 *
 * @experimental
 */
export interface StudioPublishResponse {
  readonly packageId: string;
  readonly packageFamily: HonuaStudioPackageFamily | (string & {});
  readonly status?: string;
  readonly job?: { readonly id: string; readonly status: string; readonly [k: string]: unknown };
  readonly links?: Record<string, string | undefined>;
  readonly [extra: string]: unknown;
}

/**
 * Client-side descriptor for embedding a published package. `token` and
 * `embedUrl` are server-issued; this type only carries an already-issued
 * descriptor — it does not imply a token-minting call within the SDK.
 *
 * @experimental
 */
export interface StudioEmbedConfig {
  readonly packageId: string;
  readonly packageFamily: HonuaStudioPackageFamily | (string & {});
  readonly embedUrl?: string;
  readonly token?: string;
  readonly expiresAt?: string;
  readonly options?: Record<string, unknown>;
  readonly [extra: string]: unknown;
}
