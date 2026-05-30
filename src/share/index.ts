/**
 * `@honua/sdk-js/share` — browser-safe Share, embed-token, public-link, and
 * open-data contract types and helpers.
 *
 * The long-term Console runtime is .NET/Blazor, but generated apps and
 * embeddable map surfaces need browser-safe contracts that match honua-server
 * and `honua-sdk-dotnet`. This subpath projects that shared vocabulary into
 * TypeScript so browser code consumes Share/embed/open-data state without
 * inventing a second contract:
 *
 * - Contract types mirror the server JSON wire names exactly (a parsed `fetch`
 *   body assigns straight into them).
 * - {@link parseEmbedTokenFromFragment} enforces fragment-only embed bearer
 *   tokens and rejects query-string placements.
 * - Denial helpers model anonymous-safe access state without leaking item
 *   identity or private titles.
 * - Open-data helpers project a held read model into DCAT / Schema.org output.
 *
 * This entrypoint owns no transport: it consumes server responses that are
 * already available. Admin/write share operations live on
 * `@honua/sdk-js/control-plane`.
 *
 * @experimental This entrypoint is not yet covered by the SDK's semver contract
 *   — the surface may change in any minor release prior to `1.0.0`.
 * @module
 */

export {
  HONUA_EMBED_AUDIENCES,
  HONUA_SHARE_ACCESS_TIERS,
} from "./types.js";
export type {
  HonuaEmbedAudience,
  HonuaEmbedRedemption,
  HonuaEmbedToken,
  HonuaPublicLinkResolution,
  HonuaPublicLinkToken,
  HonuaShareAccessTier,
  HonuaShareDependencyConflict,
  HonuaShareItemType,
  HonuaShareProjection,
} from "./types.js";

export {
  HONUA_SHARE_DENIAL_MESSAGES,
  denialFromHttpStatus,
  denyShareAccess,
  grantShareAccess,
  isShareAccessDenied,
  isShareAccessGranted,
} from "./denial.js";
export type {
  HonuaEmbedAccessState,
  HonuaPublicLinkAccessState,
  HonuaShareAccessDenied,
  HonuaShareAccessGranted,
  HonuaShareAccessKind,
  HonuaShareAccessState,
  HonuaShareDenialReason,
} from "./denial.js";

export {
  HONUA_EMBED_TOKEN_FRAGMENT_PARAM,
  hasQueryStringEmbedToken,
  parseEmbedTokenFromFragment,
} from "./embed-token.js";
export type {
  HonuaEmbedTokenParseOk,
  HonuaEmbedTokenParseRejected,
  HonuaEmbedTokenParseResult,
  HonuaEmbedTokenRejectionReason,
  ParseEmbedTokenOptions,
} from "./embed-token.js";

export {
  toDcatDataset,
  toSchemaOrgDataset,
} from "./open-data.js";
export type {
  DcatDataset,
  DcatDistribution,
  HonuaOpenDataDistribution,
  HonuaOpenDataReadProjection,
  SchemaOrgDataDownload,
  SchemaOrgDataset,
} from "./open-data.js";
