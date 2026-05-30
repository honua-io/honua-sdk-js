/**
 * Browser-safe Share, embed, public-link, and open-data contract types.
 *
 * These mirror the canonical honua-server Console Share contracts
 * (`ConsoleShareAccessTier`, `ConsoleEmbedAudience`, `ConsoleShareProjection`,
 * `ConsolePublicLinkResolutionResponse`, `ConsoleEmbedRedeemResponse`, …) and
 * the `honua-sdk-dotnet` console clients so generated apps, embeds, and Console
 * JS interop consume one vocabulary instead of inventing a second one. Field
 * names match the server JSON wire names exactly so a parsed `fetch` body is
 * assignable to these types without remapping.
 *
 * @module
 */

/**
 * Effective Share access tier for a content item. The share facet of an item,
 * distinct from membership visibility: `public-link` exposes opaque-token
 * access without changing membership; `public-indexed` implies the item is
 * publicly readable and eligible for catalog indexing / open-data distribution.
 *
 * Mirrors `ConsoleShareAccessTier` (`private` | `organization` | `public-link`
 * | `public-indexed`). The trailing `(string & {})` keeps the union open so a
 * future server tier round-trips without a type error while preserving
 * autocomplete on the known members.
 */
export type HonuaShareAccessTier = "private" | "organization" | "public-link" | "public-indexed" | (string & {});

/** Known {@link HonuaShareAccessTier} members, for validation/iteration. */
export const HONUA_SHARE_ACCESS_TIERS = ["private", "organization", "public-link", "public-indexed"] as const;

/**
 * Scope an embed authorization permits the redeeming surface to render.
 * Mirrors `ConsoleEmbedAudience` (`map` | `content`).
 */
export type HonuaEmbedAudience = "map" | "content" | (string & {});

/** Known {@link HonuaEmbedAudience} members. */
export const HONUA_EMBED_AUDIENCES = ["map", "content"] as const;

/**
 * Console content item category. Mirrors `ConsoleContentItemType`.
 */
export type HonuaShareItemType =
  | "service"
  | "layer"
  | "saved-map"
  | "dashboard"
  | "report"
  | "generated-app"
  | "open-data"
  | (string & {});

/**
 * A public-link token granting opaque, membership-independent read access.
 * Mirrors `ConsolePublicLinkToken`.
 *
 * The opaque {@link token} value is disclosed only in the mint response and is
 * `null`/absent on every subsequent read; callers reference a token thereafter
 * by its stable {@link tokenId}.
 */
export interface HonuaPublicLinkToken {
  /** Stable identifier (safe to surface in lists/audit; carries no capability). */
  readonly tokenId: string;
  /** Opaque token value — populated only in the mint response, else `null`. */
  readonly token?: string | null;
  /** Content item this token grants access to. */
  readonly itemId: string;
  /** ISO-8601 timestamp the token was minted. */
  readonly createdAt: string;
  /** ISO-8601 expiry; `null`/absent means it never self-expires. */
  readonly expiresAt?: string | null;
  /** Principal that minted the token (audit attribution). */
  readonly createdById?: string | null;
  /** True when the token can no longer resolve (revoked or past expiry). */
  readonly isExpired: boolean;
}

/**
 * An embed token authorizing an external surface to render an item for a
 * bounded audience and TTL. Mirrors `ConsoleEmbedToken`. Embed tokens always
 * carry a hard {@link expiresAt}.
 */
export interface HonuaEmbedToken {
  /** Stable identifier (audit/listing). */
  readonly tokenId: string;
  /** Opaque token value — populated only in the mint response. */
  readonly token?: string | null;
  /** Content item this token authorizes embedding for. */
  readonly itemId: string;
  /** Audience/scope the embed may render. */
  readonly audience: HonuaEmbedAudience;
  /** ISO-8601 timestamp the token was minted. */
  readonly createdAt: string;
  /** ISO-8601 hard expiry (always present for embed tokens). */
  readonly expiresAt: string;
  /** Principal that minted the token (audit attribution). */
  readonly createdById?: string | null;
  /** True when past expiry or embedding has been disabled on the item. */
  readonly isExpired: boolean;
}

/**
 * Server-owned Share access projection — the read model the Share panel renders
 * without resolving share state client-side. Mirrors `ConsoleShareProjection`.
 */
export interface HonuaShareProjection {
  /** Content item id. */
  readonly itemId: string;
  /** Machine-friendly item name. */
  readonly itemName: string;
  /** Human-readable title, when set. */
  readonly itemTitle?: string | null;
  /** Item category. */
  readonly itemType: HonuaShareItemType;
  /** Owner principal id, when set. */
  readonly ownerId?: string | null;
  /** Effective Share access tier. */
  readonly accessTier: HonuaShareAccessTier;
  /** True when at least one non-expired public-link token exists. */
  readonly publicLinkEnabled: boolean;
  /** Active and historical public-link tokens (token value always absent here). */
  readonly publicLinkTokens?: readonly HonuaPublicLinkToken[];
  /** True when embedding is enabled for the item. */
  readonly embedEnabled: boolean;
  /** Configured embed audience when {@link embedEnabled} is true. */
  readonly embedAudience?: HonuaEmbedAudience | null;
  /** Whether the item is currently eligible for open-data distribution. */
  readonly openDataEligible: boolean;
  /** Console verbs the requesting principal may perform on the item. */
  readonly callerPermissions?: readonly string[];
  /** True when an anonymous caller could read the item through any share mechanism. */
  readonly anonymousEligible: boolean;
  /** Logical access endpoints keyed by relation (e.g. `self`). */
  readonly endpoints?: Readonly<Record<string, string>>;
  /** ISO-8601 timestamp the share state was last updated, when state exists. */
  readonly updatedAt?: string | null;
  /** Principal that last updated the share state, when state exists. */
  readonly updatedById?: string | null;
}

/**
 * A dependency that blocks a public-sharing or embed-enablement request because
 * it is not shareable by the requested audience. Mirrors
 * `ConsoleShareDependencyConflict`.
 *
 * `itemName` is populated for authenticated callers and omitted on anonymous
 * surfaces so private titles are never leaked.
 */
export interface HonuaShareDependencyConflict {
  readonly itemId: string;
  readonly itemType?: HonuaShareItemType | null;
  readonly itemName?: string | null;
  readonly blockingReason: string;
}

/**
 * Anonymous-safe public-link / public-content resolution response. Mirrors
 * `ConsolePublicLinkResolutionResponse`. Carries only presentation metadata —
 * owner, provenance, and caller permissions are never present on this surface.
 */
export interface HonuaPublicLinkResolution {
  readonly itemId: string;
  readonly itemType: HonuaShareItemType;
  readonly title?: string | null;
  readonly summary?: string | null;
  readonly accessTier: HonuaShareAccessTier;
  readonly endpoints: Readonly<Record<string, string>>;
}

/**
 * Anonymous-safe embed redemption response. Mirrors `ConsoleEmbedRedeemResponse`.
 */
export interface HonuaEmbedRedemption {
  readonly itemId: string;
  readonly itemType: HonuaShareItemType;
  readonly title?: string | null;
  readonly audience: HonuaEmbedAudience;
  /** ISO-8601 hard expiry of the redeemed token. */
  readonly expiresAt: string;
  readonly endpoints: Readonly<Record<string, string>>;
}
