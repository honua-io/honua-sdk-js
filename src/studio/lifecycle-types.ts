/**
 * Typed request/response models for the Studio package lifecycle API
 * (`/api/v{version}/studio` in `honua-server`), backing
 * {@link HonuaStudioLifecycleClient}.
 *
 * Canonical request/response DTOs are generated from the SHA-pinned Studio
 * OpenAPI document in `honua-server`; semantic helpers reuse the existing
 * {@link StudioPackageDiagnostic} / {@link HonuaStudioPackageFamily}
 * projections from `./validation.js` / `./types.js`.
 *
 * @experimental Not yet covered by the SDK's semver contract — these shapes
 *   may change in any minor release prior to `1.0.0`.
 * @module
 */

import type {
  components as StudioOpenApiComponents,
  operations as StudioOpenApiOperations,
} from "./generated/studio-api.js";
import type { HonuaStudioPackageFamily } from "./types.js";
import type { StudioPackageDiagnostic } from "./validation.js";

type StudioOpenApiSchemas = StudioOpenApiComponents["schemas"];

/**
 * Successful `ApiResponse<T>` envelope every Studio lifecycle endpoint wraps
 * its payload in. The source-generated JSON context omits `null`-valued
 * properties, so `message` is present only on responses that carry one (for
 * example the draft-delete response).
 *
 * @experimental
 */
export interface StudioApiResponse<T> {
  readonly success: true;
  readonly data: T;
  readonly timestamp: string;
  readonly message?: string;
}

// ---------------------------------------------------------------------------
// Package-family capability discovery
// ---------------------------------------------------------------------------

/** Depth of validation a package family currently receives. */
export type StudioValidationDepth = "full" | "envelope" | (string & {});

/** Deployment persistence backing for Studio lifecycle data. */
export type StudioPersistenceMode = "postgres" | "in-memory" | (string & {});

/** Support level a deployment advertises for a package family. */
export type StudioPackageFamilySupportLevel = "supported" | "limited" | (string & {});

/**
 * One package-family-scoped operation name as returned by
 * `GET /package-families`. `draft.delete` is available on every family but,
 * per the API doc, is not itself advertised as a per-family capability
 * operation.
 */
export type StudioPackageFamilyOperation =
  | "draft.create"
  | "draft.read"
  | "draft.update"
  | "validate"
  | "preview-plan"
  | "content-version.create"
  | "content-version.read"
  | "content-version.compare"
  | "publish-request.create"
  | "reopen"
  | "rollback"
  | (string & {});

/** Capability descriptor for one Studio package family. */
export interface StudioPackageFamilyCapability {
  readonly family: HonuaStudioPackageFamily | (string & {});
  readonly schemaVersion: string;
  readonly format: string;
  readonly supportLevel: StudioPackageFamilySupportLevel;
  readonly supportedOperations: readonly StudioPackageFamilyOperation[];
  readonly validationDepth: StudioValidationDepth;
  readonly limitations?: readonly string[];
  readonly maxPackageBytes: number;
  readonly durable: boolean;
  readonly persistenceMode?: StudioPersistenceMode;
  readonly [extra: string]: unknown;
}

/** `GET /package-families` response payload — every registered package family. */
export interface StudioPackageFamilyCapabilities {
  readonly families: readonly StudioPackageFamilyCapability[];
  readonly [extra: string]: unknown;
}

// ---------------------------------------------------------------------------
// Package envelope
// ---------------------------------------------------------------------------

/** Reference to a source a package envelope binds to. */
export interface StudioBindingRef {
  readonly key: string;
  readonly kind: string;
  readonly ref: string;
  readonly crs?: string;
  readonly srid?: number;
  readonly requiredPermissions?: readonly string[];
  readonly [extra: string]: unknown;
}

/** Dependency lineage entry (e.g. on a content item's version) carried on an envelope. */
export interface StudioDependencyRef {
  readonly kind: string;
  readonly ref: string;
  readonly versionId?: string;
  readonly required?: boolean;
  readonly [extra: string]: unknown;
}

/** Provenance lineage entry (e.g. the prompt or plan that generated the package). */
export interface StudioProvenanceRef {
  readonly kind: string;
  readonly ref: string;
  readonly rel: string;
  readonly [extra: string]: unknown;
}

/** Route/visibility a package declares it wants to publish to. */
export interface StudioPublicationIntent {
  readonly route?: string;
  readonly visibility?: "private" | "organization" | "public" | (string & {});
  readonly [extra: string]: unknown;
}

/** `StudioValidationSummary.status` — see the API doc's "Validation And Preview" section. */
export type StudioValidationStatus = "not-validated" | "valid" | "warning" | "invalid";

/**
 * Validation summary persisted on a draft or captured on a content version.
 * Returned directly by `POST /package-drafts/{draftId}/validate` and embedded
 * in every {@link StudioPackageEnvelope.validation}.
 */
export interface StudioValidationSummary {
  readonly status: StudioValidationStatus;
  readonly diagnostics?: readonly StudioPackageDiagnostic[];
  readonly unsupportedCapabilities?: readonly string[];
  readonly generatedAt?: string;
  readonly [extra: string]: unknown;
}

/**
 * `StudioPackageEnvelope` — the wire shape shared by every package family.
 * `schemaVersion` and `format` must match the descriptor
 * {@link StudioPackageFamilyCapability} returns for `family` from
 * `GET /package-families`. `body` is deliberately generic: for `map`/`app` it
 * is validated against the existing `honua_map_package.v1` /
 * `honua_app_package.v1` models (pass `HonuaMapPackage` /
 * `HonuaGeneratedAppPackage` as `TBody` for full typing); every other family
 * currently receives only envelope-level validation.
 *
 * @experimental
 */
export interface StudioPackageEnvelope<TBody = Record<string, unknown>> {
  readonly family: HonuaStudioPackageFamily | (string & {});
  readonly schemaVersion: string;
  readonly format: string;
  readonly bindings?: readonly StudioBindingRef[];
  readonly dependencies?: readonly StudioDependencyRef[];
  readonly validation?: StudioValidationSummary;
  readonly publicationIntent?: StudioPublicationIntent;
  readonly provenance?: readonly StudioProvenanceRef[];
  readonly body: TBody;
}

// ---------------------------------------------------------------------------
// Drafts
// ---------------------------------------------------------------------------

/** A mutable Studio package draft. `generation` increments on every successful `PUT`. */
export interface StudioPackageDraft {
  readonly draftId: string;
  readonly itemId: string;
  readonly family: HonuaStudioPackageFamily | (string & {});
  readonly packageKey: string;
  readonly workspaceId?: string;
  readonly ownerId?: string;
  readonly generation: number;
  readonly envelope: StudioPackageEnvelope;
  readonly baseVersionId?: string;
  readonly createdAt?: string;
  readonly updatedAt?: string;
  readonly [extra: string]: unknown;
}

/**
 * `POST /package-drafts` request body. `packageKey` is trimmed, limited to
 * 200 characters, and may contain only letters, numbers, dash, underscore, or
 * dot. Omit `itemId` to let the server allocate a new Studio content item;
 * omit `ownerId` to use the authenticated actor id.
 */
export interface StudioPackageDraftCreateRequest {
  readonly packageKey: string;
  readonly workspaceId?: string;
  readonly ownerId?: string;
  readonly itemId?: string;
  readonly envelope: StudioPackageEnvelope;
}

/**
 * `PUT /package-drafts/{draftId}` request body. `workspaceId` uses replace
 * semantics: omit it or send an empty string to clear the stored workspace.
 * Omit `ownerId` to preserve the existing owner. Omit `generation` to update
 * from the current server-loaded generation (last-write-wins); include the
 * last-seen `generation` for strict optimistic-concurrency protection — a
 * stale value throws {@link HonuaStudioError} with
 * `code: "generation-conflict"` (`409`).
 */
export interface StudioPackageDraftReplaceRequest {
  readonly packageKey: string;
  readonly workspaceId?: string;
  readonly ownerId?: string;
  readonly envelope: StudioPackageEnvelope;
  readonly generation?: number;
}

// ---------------------------------------------------------------------------
// Preview
// ---------------------------------------------------------------------------

/**
 * `POST /package-drafts/{draftId}/preview-plan` response. `gp`, `etl`, and
 * `workflow` drafts return `requiresJob: true, synchronous: false`; every
 * other family returns `requiresJob: false, synchronous: true`.
 */
export interface StudioPreviewPlan {
  readonly requiresJob: boolean;
  readonly synchronous: boolean;
  readonly steps: readonly string[];
  readonly [extra: string]: unknown;
}

// ---------------------------------------------------------------------------
// Content versions
// ---------------------------------------------------------------------------

/**
 * An immutable Studio content version. Never edited in place — call
 * `versions.reopen` to continue work as a new mutable draft.
 */
export interface StudioContentVersion {
  readonly versionId: string;
  readonly itemId: string;
  readonly family: HonuaStudioPackageFamily | (string & {});
  readonly versionNumber: number;
  readonly contentHash: string;
  readonly envelope: StudioPackageEnvelope;
  readonly validation?: StudioValidationSummary;
  readonly dependencies?: readonly StudioDependencyRef[];
  readonly provenance?: readonly StudioProvenanceRef[];
  readonly baseDraftId?: string;
  readonly createdAt?: string;
  readonly createdBy?: string;
  readonly [extra: string]: unknown;
}

/** `GET /content-items/{itemId}/versions` response — empty `versions` when none exist. */
export interface StudioContentVersionListResponse {
  readonly itemId: string;
  readonly versions: readonly StudioContentVersion[];
  readonly [extra: string]: unknown;
}

/** `POST /content-items/{itemId}/version-comparisons` request body. */
export interface StudioVersionComparisonRequest {
  readonly baseVersionId: string;
  readonly compareVersionId: string;
}

/** Added/removed/unchanged partition for one comparison facet. */
export interface StudioVersionComparisonDiff<T> {
  readonly added?: readonly T[];
  readonly removed?: readonly T[];
  readonly unchanged?: readonly T[];
  readonly [extra: string]: unknown;
}

/**
 * `POST /content-items/{itemId}/version-comparisons` response — compares two
 * immutable versions by content hash, dependencies, validation, and
 * provenance. The exact diff shape is not yet OpenAPI-pinned server-side;
 * the documented facets are typed here and every field keeps its own open
 * index signature so an unrecognized server addition still round-trips.
 */
export interface StudioVersionComparison {
  readonly itemId: string;
  readonly baseVersionId: string;
  readonly compareVersionId: string;
  readonly contentHashChanged: boolean;
  readonly dependencies?: StudioVersionComparisonDiff<StudioDependencyRef>;
  readonly provenance?: StudioVersionComparisonDiff<StudioProvenanceRef>;
  readonly validation?: {
    readonly base?: StudioValidationSummary;
    readonly compare?: StudioValidationSummary;
    readonly [extra: string]: unknown;
  };
  readonly [extra: string]: unknown;
}

// ---------------------------------------------------------------------------
// Publication requests
// ---------------------------------------------------------------------------

/**
 * Compatibility lifecycle states understood by the bounded poller. The
 * canonical OpenAPI wire states are `pending`, `accepted`, and `rejected`;
 * these normalized names also retain the richer proposal states exposed by
 * pre-contract SDK builds without claiming they are present in the schema.
 *
 * - `AwaitingApproval` — the proposal is persisted and queued for a
 *   *separate* approving principal. Non-terminal.
 * - `Approved` — an approver (never the proposer — see the module doc on
 *   {@link HonuaStudioPublicationRequestsClient}) cleared the proposal.
 *   Non-terminal: publication has not executed yet.
 * - `Executing` — the publication operation is running. Non-terminal.
 * - `Active` — the publication is live. **The only state that carries a final
 *   publication URL.**
 * - `Rejected` — an approver declined the proposal. Terminal, not successful.
 * - `Failed` — execution failed after approval. Terminal, not successful.
 *
 * @experimental
 */
export type StudioPublicationLifecycleState =
  | "AwaitingApproval"
  | "Approved"
  | "Executing"
  | "Active"
  | "Rejected"
  | "Failed";

/**
 * `StudioPublicationRequest.status` as it arrives on the wire.
 *
 * Starts with the generated contract's `accepted` / `rejected` / `pending`
 * values and retains the pre-contract {@link StudioPublicationLifecycleState}
 * compatibility values. The union stays open to
 * `(string & {})` so a state this SDK release does not know about still
 * round-trips instead of crashing the client — but an unrecognized value is
 * never treated as terminal and never as success. Normalize with
 * {@link normalizeStudioPublicationStatus} rather than comparing strings.
 *
 * @experimental
 */
export type StudioPublicationRequestStatus =
  | StudioOpenApiSchemas["StudioPublicationRequest"]["status"]
  | StudioPublicationLifecycleState
  | (string & {});

/**
 * The five distinct identifiers a publication proposal joins together, each
 * addressing a different system:
 *
 * - `operationInstanceId` — the server-side publication operation instance.
 * - `proposalId` — the governance proposal awaiting a separate approver.
 * - `proposalUri` — the addressable location of that proposal. This is the
 *   *proposal* resource, never the published artifact; the final publication
 *   URL is {@link StudioPublicationRequest.publicationUrl} and appears only at
 *   `Active`.
 * - `auditId` — the immutable audit-log entry for the submission.
 * - `correlationId` — the caller-visible correlation id threaded through
 *   telemetry for the whole submit/approve/execute chain.
 *
 * All five are optional: a deployment that has not enabled the proposal
 * workflow returns only the ones it produces. Every one that *is* returned is
 * preserved verbatim end to end by this client.
 *
 * @experimental
 */
export interface StudioPublicationIdentifiers {
  readonly operationInstanceId?: string;
  readonly proposalId?: string;
  readonly proposalUri?: string;
  readonly auditId?: string;
  readonly correlationId?: string;
}

/**
 * `POST /content-items/{itemId}/versions/{versionId}/publish-requests`
 * request body. `intent` overrides the version envelope's
 * `publicationIntent` when supplied; an invalid override fails with `400`
 * before a request is persisted. The canonical `warningAcknowledgement`
 * spelling is optional audit text for `warning`-status versions.
 *
 * `contentHash` pins the exact immutable version bytes being proposed, and
 * `idempotencyKey` gives the submission a stable identity so a retried or
 * replayed submit resolves to the same proposal instead of creating a second
 * one.
 *
 * A submission body may **not** carry approval or policy-override fields —
 * see {@link HonuaStudioPublicationRequestsClient.create}, which rejects them
 * client-side before any request is sent.
 */
export type StudioPublicationRequestInput = StudioOpenApiSchemas["CreateStudioPublicationRequest"] & {
  /** @deprecated Not present in the canonical Studio OpenAPI contract. */
  readonly warningAcknowledgment?: string;
  /** @deprecated Not present in the canonical Studio OpenAPI contract. */
  readonly contentHash?: string;
  /** @deprecated Not present in the canonical Studio OpenAPI contract. */
  readonly idempotencyKey?: string;
  /** @deprecated Not present in the canonical Studio OpenAPI contract. */
  readonly correlationId?: string;
  readonly [extra: string]: unknown;
};

/**
 * A persisted publication request (proposal).
 *
 * Under the legacy synchronous behaviour, versions whose captured validation
 * status is `invalid` still produce a durable request with
 * `status: "rejected"` and do not move the published pointer, while
 * `valid`/`warning` versions are `"accepted"` and do move it. Under the
 * proposal workflow the request starts at `AwaitingApproval` and is walked to
 * a terminal state by {@link HonuaStudioPublicationRequestsClient.poll}.
 *
 * `publicationUrl` is meaningful **only** when the status normalizes to
 * `Active`; the client never surfaces it from any other state, even if a
 * server sends one.
 */
export type StudioPublicationRequest = Omit<StudioOpenApiSchemas["StudioPublicationRequest"], "status"> & {
  readonly status: StudioPublicationRequestStatus;
} & StudioPublicationIdentifiers & {
    /** @deprecated Not present in the canonical Studio OpenAPI contract. */
    readonly contentHash?: string;
    /** @deprecated Not present in the canonical Studio OpenAPI contract. */
    readonly publicationUrl?: string;
    /** @deprecated Not present in the canonical Studio OpenAPI contract. */
    readonly reason?: string;
    /** @deprecated Not present in the canonical Studio OpenAPI contract. */
    readonly createdBy?: string;
    /** @deprecated Not present in the canonical Studio OpenAPI contract. */
    readonly updatedAt?: string;
    readonly [extra: string]: unknown;
  };

// ---------------------------------------------------------------------------
// Reopen
// ---------------------------------------------------------------------------

/**
 * `POST /content-items/{itemId}/versions/{versionId}/reopen` request body.
 * No fields are documented as required; this is intentionally open for a
 * future owner/workspace override.
 */
export interface StudioReopenVersionRequest {
  readonly ownerId?: string;
  readonly workspaceId?: string;
  readonly [extra: string]: unknown;
}

// ---------------------------------------------------------------------------
// Rollback requests
// ---------------------------------------------------------------------------

/** Which content-item pointer(s) a rollback request moves. */
export type StudioRollbackPointer = "current" | "published" | "both";

/** `POST /content-items/{itemId}/rollback-requests` request body. */
export interface StudioRollbackRequestInput {
  readonly versionId: string;
  readonly pointer: StudioRollbackPointer;
  readonly message?: string;
  readonly [extra: string]: unknown;
}

/** The Studio content item's current/published version pointers. */
export interface StudioContentItemPointers {
  readonly itemId: string;
  readonly currentVersionId?: string;
  readonly publishedVersionId?: string;
  readonly [extra: string]: unknown;
}

/** A persisted rollback request, carrying the resulting content-item pointers. */
export interface StudioRollbackRequest {
  readonly requestId: string;
  readonly itemId: string;
  readonly versionId: string;
  readonly pointer: StudioRollbackPointer;
  readonly pointers: StudioContentItemPointers;
  readonly createdAt?: string;
  readonly createdBy?: string;
  readonly [extra: string]: unknown;
}

// ---------------------------------------------------------------------------
// Content-item and draft enumeration (honua-server#3003)
// ---------------------------------------------------------------------------

/**
 * A Studio content item's *derived* lifecycle state, as computed by the server
 * from the item's pointers:
 *
 * - `draft` — no immutable version has been saved yet (`currentVersionId` is
 *   absent);
 * - `current` — a saved version exists but is not published;
 * - `published` — `publishedVersionId` is set.
 *
 * This is deliberately distinct from a joined publication's *route* lifecycle
 * ({@link StudioPublicationRouteLifecycle}), which describes the Content
 * Publication Registry route rather than the Studio item.
 *
 * @experimental
 */
export type StudioContentItemState = "draft" | "current" | "published";

/**
 * The route lifecycle a joined Content Publication Registry publication
 * reports. Kept open (`string & {}`) because the registry owns this vocabulary
 * and may add values without a Studio change.
 *
 * @experimental
 */
export type StudioPublicationRouteLifecycle = "active" | "suspended" | "archived" | (string & {});

/**
 * The publication-registry lifecycle badge joined onto a
 * {@link StudioContentItemListRow} (REQ-004), so a content browser can render
 * lifecycle state without one extra call per row.
 *
 * The registry has no foreign key back to Studio: the join uses the convention
 * that a publication's `sourceContentId` equals the Studio `itemId`. The badge
 * therefore reflects the *route's* current state, which can be newer than the
 * version Studio considers current or published, and is absent entirely when
 * no publication references the item.
 *
 * @experimental
 */
export interface StudioContentItemPublicationBadge {
  readonly publicationId: string;
  readonly routeSlug: string;
  readonly routePath: string;
  readonly lifecycle: StudioPublicationRouteLifecycle;
  readonly activeRevision: number;
  readonly updatedAt: string;
  readonly [extra: string]: unknown;
}

/**
 * One row of `GET /content-items`. This is a *summary* projection, not a full
 * content item: it deliberately carries no envelope. Fetch
 * `contentVersions.get(itemId, versionId)` for package content.
 *
 * @experimental
 */
export type StudioContentItemListRow = StudioOpenApiSchemas["StudioContentItemSummary"] & {
  /** @deprecated Not present in the canonical Studio OpenAPI contract. */
  readonly createdBy?: string;
  /** @deprecated Not present in the canonical Studio OpenAPI contract. */
  readonly updatedBy?: string;
  /** @deprecated Not present in the canonical Studio OpenAPI contract. */
  readonly publication?: StudioContentItemPublicationBadge;
  readonly [extra: string]: unknown;
};

/**
 * A page of an opaque keyset-paginated Studio listing.
 *
 * `total` counts every row matching the query across *all* pages, not the page
 * length. `nextCursor` is the opaque cursor to pass back as `cursor` for the
 * following page; on the last page the server sends `null`, and its
 * source-generated JSON context omits `null` properties, so it arrives as
 * either `null` or absent — treat both as "no more pages" (which is exactly
 * what {@link isStudioListExhausted} does).
 *
 * @experimental
 */
export interface StudioListPage<TItem> {
  readonly items: readonly TItem[];
  readonly total: number;
  readonly nextCursor?: string | null;
  readonly [extra: string]: unknown;
}

/** `GET /content-items` response. @experimental */
export type StudioContentItemListResponse = StudioListPage<StudioContentItemListRow>;

/**
 * `GET /package-drafts` response. Rows are full {@link StudioPackageDraft}
 * objects — identical to `GET /package-drafts/{draftId}` — and carry no
 * publication badge: drafts are mutable and pre-publication by definition.
 *
 * @experimental
 */
export type StudioPackageDraftListResponse = StudioListPage<StudioPackageDraft>;

/**
 * Query filters shared by `GET /content-items` and `GET /package-drafts`.
 *
 * `family` accepts one of the package-family values published by the canonical
 * contract. An unknown family is rejected by the server with `400`.
 *
 * `search` is a case-insensitive substring match against `packageKey` only — there
 * is no full-text index in this slice.
 *
 * `ownerId` is an exact match against the recorded owner. Note that with
 * `Studio:EndUserAuthorization:Enabled` on, the server **forces** a non-admin
 * caller's effective owner filter to their own resolved id and ignores this
 * value; it is honored as supplied only for admins, or while that flag is off.
 *
 * @experimental
 */
export type StudioListFilterOptions = NonNullable<
  StudioOpenApiOperations["listStudioPackageDrafts"]["parameters"]["query"]
>;

/** `GET /package-drafts` filters. @experimental */
export type StudioPackageDraftListOptions = NonNullable<
  StudioOpenApiOperations["listStudioPackageDrafts"]["parameters"]["query"]
>;

/**
 * `GET /content-items` filters — the shared set plus `state`, a filter over
 * the derived lifecycle state.
 *
 * @experimental
 */
export type StudioContentItemListOptions = NonNullable<
  StudioOpenApiOperations["listStudioContentItems"]["parameters"]["query"]
>;
