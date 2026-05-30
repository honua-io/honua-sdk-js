/**
 * Browser-safe content + metadata-v2 contracts for `honua-console`.
 *
 * These types describe the **SDK-projected** view of the shared content model:
 * the canonical server DTOs (Metadata v2, content items, packages, sharing,
 * embeds, provenance) remain authoritative, and this module only names the
 * stable, browser-safe subset Console renders. Every interface keeps an open
 * index signature so additive server fields survive a round-trip without a
 * Console-specific copy of the protocol types.
 *
 * Ownership legend used across the Console contracts:
 * - **server-owned**: canonical wire shape produced by `honua-server`.
 * - **SDK-projected**: the normalized browser-safe view defined here.
 * - **Console-rendered**: UI state derived from an SDK projection.
 *
 * @module
 */

export const HONUA_CONSOLE_METADATA_FORMAT_V2 = "honua_metadata.v2" as const;
export type HonuaConsoleMetadataFormat = typeof HONUA_CONSOLE_METADATA_FORMAT_V2;

/**
 * Discriminator for a Console content item. Unknown server kinds widen to
 * `string` so the Console browser can still list (and flag) them.
 */
export type HonuaConsoleContentKind =
  | "map"
  | "map-package"
  | "app"
  | "app-package"
  | "dashboard"
  | "report"
  | "dataset"
  | "connection"
  | (string & {});

export type HonuaConsoleVisibility = "private" | "workspace" | "public" | (string & {});

/**
 * Sharing reference for a content item. Mirrors the control-plane share shape
 * but is content-scoped and embed-aware for Console surfaces.
 */
export interface HonuaConsoleSharing {
  readonly visibility: HonuaConsoleVisibility;
  readonly principals?: ReadonlyArray<{
    readonly type: "user" | "group" | "workspace" | (string & {});
    readonly id: string;
    readonly role?: "viewer" | "editor" | "owner" | (string & {});
  }>;
  readonly embed?: HonuaConsoleEmbed;
  readonly [extra: string]: unknown;
}

/**
 * Embed projection: the browser-safe descriptor Console uses to render an
 * embed dialog / iframe without re-deriving the server embed policy.
 */
export interface HonuaConsoleEmbed {
  readonly enabled: boolean;
  readonly url?: string;
  readonly allowedOrigins?: ReadonlyArray<string>;
  readonly token?: string;
  readonly [extra: string]: unknown;
}

/**
 * Provenance projection: lineage / authorship Console renders in detail views.
 */
export interface HonuaConsoleProvenance {
  readonly createdBy?: string;
  readonly createdAt?: string;
  readonly updatedBy?: string;
  readonly updatedAt?: string;
  readonly source?: string;
  readonly generatedBy?: "user" | "import" | "builder" | "agent" | (string & {});
  readonly derivedFrom?: ReadonlyArray<{
    readonly id: string;
    readonly kind?: HonuaConsoleContentKind;
    readonly relation?: "source" | "fork" | "import" | (string & {});
  }>;
  readonly [extra: string]: unknown;
}

/**
 * Metadata v2 projection. `format` pins the contract version so Console can
 * reject (and surface) an unexpected metadata wire version.
 */
export interface HonuaConsoleMetadata {
  readonly format?: HonuaConsoleMetadataFormat;
  readonly title?: string;
  readonly description?: string;
  readonly summary?: string;
  readonly tags?: ReadonlyArray<string>;
  readonly thumbnailUrl?: string;
  readonly extent?: readonly [number, number, number, number];
  readonly license?: string;
  readonly attribution?: string;
  readonly locale?: string;
  readonly custom?: Readonly<Record<string, unknown>>;
  readonly [extra: string]: unknown;
}

/**
 * SDK-projected content item. This is the unit a Console content browser lists,
 * filters, and opens. The package payload (map/app/dashboard/report) is loaded
 * separately and referenced via {@link HonuaConsoleContentItem.packageId}.
 */
export interface HonuaConsoleContentItem {
  readonly id: string;
  readonly kind: HonuaConsoleContentKind;
  readonly title: string;
  readonly workspaceId?: string;
  readonly packageId?: string;
  readonly version?: string;
  readonly status?: "draft" | "published" | "archived" | "failed" | (string & {});
  readonly metadata?: HonuaConsoleMetadata;
  readonly sharing?: HonuaConsoleSharing;
  readonly provenance?: HonuaConsoleProvenance;
  readonly etag?: string;
  readonly [extra: string]: unknown;
}

/** Recognized Console content kinds with a first-class SDK projection. */
export const HONUA_CONSOLE_KNOWN_CONTENT_KINDS: ReadonlyArray<HonuaConsoleContentKind> = [
  "map",
  "map-package",
  "app",
  "app-package",
  "dashboard",
  "report",
  "dataset",
  "connection",
];

/**
 * Returns `true` when the content kind has a first-class SDK projection. Console
 * can still list unknown kinds, but should flag them as unsupported in detail
 * views rather than assuming a projection exists.
 */
export function isKnownConsoleContentKind(kind: string): kind is HonuaConsoleContentKind {
  return HONUA_CONSOLE_KNOWN_CONTENT_KINDS.includes(kind as HonuaConsoleContentKind);
}
