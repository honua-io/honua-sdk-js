// Generated from honua-io/honua-server@e8bff849ceef1ff039f443d4db932e526484e474
// Source: docs/developer/api-specs/studio-api.json (sha256:8bbe64c9a7ef78ce9132f29460f33d5920142986294ac25c133743ddb4586116)
// Do not edit by hand; run npm run studio-client:generate.

export type paths = {
    readonly "/{kind}/{id}/export": {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path?: never;
            readonly cookie?: never;
        };
        readonly get?: never;
        readonly put?: never;
        readonly post: operations["exportStudioDeliverable"];
        readonly delete?: never;
        readonly options?: never;
        readonly head?: never;
        readonly patch?: never;
        readonly trace?: never;
    };
    readonly "/ai/capabilities": {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path?: never;
            readonly cookie?: never;
        };
        readonly get: operations["getStudioAiCapabilities"];
        readonly put?: never;
        readonly post?: never;
        readonly delete?: never;
        readonly options?: never;
        readonly head?: never;
        readonly patch?: never;
        readonly trace?: never;
    };
    readonly "/ai/chat": {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path?: never;
            readonly cookie?: never;
        };
        readonly get?: never;
        readonly put?: never;
        readonly post: operations["streamStudioAiChat"];
        readonly delete?: never;
        readonly options?: never;
        readonly head?: never;
        readonly patch?: never;
        readonly trace?: never;
    };
    readonly "/app-packages/generate": {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path?: never;
            readonly cookie?: never;
        };
        readonly get?: never;
        readonly put?: never;
        readonly post: operations["generateStudioAppPackage"];
        readonly delete?: never;
        readonly options?: never;
        readonly head?: never;
        readonly patch?: never;
        readonly trace?: never;
    };
    readonly "/content-items": {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path?: never;
            readonly cookie?: never;
        };
        readonly get: operations["listStudioContentItems"];
        readonly put?: never;
        readonly post?: never;
        readonly delete?: never;
        readonly options?: never;
        readonly head?: never;
        readonly patch?: never;
        readonly trace?: never;
    };
    readonly "/content-items/{itemId}/rollback-requests": {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path?: never;
            readonly cookie?: never;
        };
        readonly get?: never;
        readonly put?: never;
        readonly post: operations["createStudioRollbackRequest"];
        readonly delete?: never;
        readonly options?: never;
        readonly head?: never;
        readonly patch?: never;
        readonly trace?: never;
    };
    readonly "/content-items/{itemId}/version-comparisons": {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path?: never;
            readonly cookie?: never;
        };
        readonly get?: never;
        readonly put?: never;
        readonly post: operations["compareStudioContentVersions"];
        readonly delete?: never;
        readonly options?: never;
        readonly head?: never;
        readonly patch?: never;
        readonly trace?: never;
    };
    readonly "/content-items/{itemId}/versions": {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path?: never;
            readonly cookie?: never;
        };
        readonly get: operations["listStudioContentVersions"];
        readonly put?: never;
        readonly post?: never;
        readonly delete?: never;
        readonly options?: never;
        readonly head?: never;
        readonly patch?: never;
        readonly trace?: never;
    };
    readonly "/content-items/{itemId}/versions/{versionId}": {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path?: never;
            readonly cookie?: never;
        };
        readonly get: operations["getStudioContentVersion"];
        readonly put?: never;
        readonly post?: never;
        readonly delete?: never;
        readonly options?: never;
        readonly head?: never;
        readonly patch?: never;
        readonly trace?: never;
    };
    readonly "/content-items/{itemId}/versions/{versionId}/publish-requests": {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path?: never;
            readonly cookie?: never;
        };
        readonly get?: never;
        readonly put?: never;
        readonly post: operations["createStudioPublicationRequest"];
        readonly delete?: never;
        readonly options?: never;
        readonly head?: never;
        readonly patch?: never;
        readonly trace?: never;
    };
    readonly "/content-items/{itemId}/versions/{versionId}/publish-requests/{requestId}": {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path?: never;
            readonly cookie?: never;
        };
        readonly get: operations["getStudioPublicationRequest"];
        readonly put?: never;
        readonly post?: never;
        readonly delete?: never;
        readonly options?: never;
        readonly head?: never;
        readonly patch?: never;
        readonly trace?: never;
    };
    readonly "/content-items/{itemId}/versions/{versionId}/reopen": {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path?: never;
            readonly cookie?: never;
        };
        readonly get?: never;
        readonly put?: never;
        readonly post: operations["reopenStudioContentVersion"];
        readonly delete?: never;
        readonly options?: never;
        readonly head?: never;
        readonly patch?: never;
        readonly trace?: never;
    };
    readonly "/map-packages/generate": {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path?: never;
            readonly cookie?: never;
        };
        readonly get?: never;
        readonly put?: never;
        readonly post: operations["generateStudioMapPackage"];
        readonly delete?: never;
        readonly options?: never;
        readonly head?: never;
        readonly patch?: never;
        readonly trace?: never;
    };
    readonly "/package-drafts": {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path?: never;
            readonly cookie?: never;
        };
        readonly get: operations["listStudioPackageDrafts"];
        readonly put?: never;
        readonly post: operations["createStudioPackageDraft"];
        readonly delete?: never;
        readonly options?: never;
        readonly head?: never;
        readonly patch?: never;
        readonly trace?: never;
    };
    readonly "/package-drafts/{draftId}": {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path: {
                readonly draftId: components["parameters"]["DraftId"];
            };
            readonly cookie?: never;
        };
        readonly get: operations["getStudioPackageDraft"];
        readonly put: operations["updateStudioPackageDraft"];
        readonly post?: never;
        readonly delete: operations["deleteStudioPackageDraft"];
        readonly options?: never;
        readonly head?: never;
        readonly patch?: never;
        readonly trace?: never;
    };
    readonly "/package-drafts/{draftId}/content-versions": {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path?: never;
            readonly cookie?: never;
        };
        readonly get?: never;
        readonly put?: never;
        readonly post: operations["createStudioContentVersion"];
        readonly delete?: never;
        readonly options?: never;
        readonly head?: never;
        readonly patch?: never;
        readonly trace?: never;
    };
    readonly "/package-drafts/{draftId}/preview-plan": {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path?: never;
            readonly cookie?: never;
        };
        readonly get?: never;
        readonly put?: never;
        readonly post: operations["previewStudioPackageDraft"];
        readonly delete?: never;
        readonly options?: never;
        readonly head?: never;
        readonly patch?: never;
        readonly trace?: never;
    };
    readonly "/package-drafts/{draftId}/validate": {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path?: never;
            readonly cookie?: never;
        };
        readonly get?: never;
        readonly put?: never;
        readonly post: operations["validateStudioPackageDraft"];
        readonly delete?: never;
        readonly options?: never;
        readonly head?: never;
        readonly patch?: never;
        readonly trace?: never;
    };
    readonly "/package-families": {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path?: never;
            readonly cookie?: never;
        };
        readonly get: operations["listStudioPackageFamilies"];
        readonly put?: never;
        readonly post?: never;
        readonly delete?: never;
        readonly options?: never;
        readonly head?: never;
        readonly patch?: never;
        readonly trace?: never;
    };
};
export type webhooks = Record<string, never>;
export type components = {
    schemas: {
        readonly ApiResponseAiCapabilities: components["schemas"]["GenericApiResponse"];
        readonly ApiResponseContentItemList: {
            readonly data: components["schemas"]["StudioContentItemListResponse"];
            readonly success: boolean;
        };
        readonly ApiResponseContentVersion: {
            readonly data: components["schemas"]["StudioContentVersion"];
            readonly success: boolean;
        };
        readonly ApiResponseContentVersionList: {
            readonly data: components["schemas"]["StudioContentVersionListResponse"];
            readonly success: boolean;
        };
        readonly ApiResponseDraft: {
            readonly data: components["schemas"]["StudioPackageDraft"];
            readonly success: boolean;
        };
        readonly ApiResponseDraftList: {
            readonly data: components["schemas"]["StudioPackageDraftListResponse"];
            readonly success: boolean;
        };
        readonly ApiResponseExport: components["schemas"]["GenericApiResponse"];
        readonly ApiResponseGeneratedPackage: components["schemas"]["GenericApiResponse"];
        readonly ApiResponsePackageFamilies: components["schemas"]["GenericApiResponse"];
        readonly ApiResponsePreviewPlan: components["schemas"]["GenericApiResponse"];
        readonly ApiResponsePublicationRequest: {
            readonly data: components["schemas"]["StudioPublicationRequest"];
            readonly success: boolean;
        };
        readonly ApiResponseRollback: components["schemas"]["GenericApiResponse"];
        readonly ApiResponseValidation: components["schemas"]["GenericApiResponse"];
        readonly ApiResponseVersionComparison: components["schemas"]["GenericApiResponse"];
        readonly CompareStudioContentVersionsRequest: {
            readonly leftVersionId: components["schemas"]["Uuid"];
            readonly rightVersionId: components["schemas"]["Uuid"];
        };
        readonly CreateStudioPackageDraftRequest: {
            readonly envelope: components["schemas"]["StudioPackageEnvelope"];
            readonly itemId?: components["schemas"]["Uuid"];
            readonly ownerId?: string;
            readonly packageKey: string;
            readonly workspaceId?: string;
        };
        readonly CreateStudioPublicationRequest: {
            readonly intent?: {
                readonly [key: string]: unknown;
            };
            readonly warningAcknowledgement?: string;
        };
        readonly CreateStudioRollbackRequest: {
            /**
             * @default current
             * @enum {string}
             */
            readonly pointer?: "current" | "published" | "both";
            readonly reason?: string;
            readonly targetVersionId: components["schemas"]["Uuid"];
        };
        readonly GenerateStudioPackageRequest: {
            readonly [key: string]: unknown;
        };
        readonly GenericApiResponse: {
            readonly data?: {
                readonly [key: string]: unknown;
            };
            readonly success: boolean;
        };
        readonly ProblemDetails: {
            readonly detail?: string;
            readonly instance?: string;
            readonly status?: number;
            readonly title?: string;
            /** Format: uri */
            readonly type?: string;
        };
        readonly SaveStudioContentVersionRequest: {
            readonly changeNote?: string;
        };
        readonly StudioAiChatEvent: {
            readonly errorCode?: string;
            readonly text?: string;
            readonly type: string;
        };
        readonly StudioAiChatRequest: {
            readonly messages: readonly {
                readonly [key: string]: unknown;
            }[];
            readonly model?: string;
            readonly provider?: string;
            readonly tools?: readonly {
                readonly [key: string]: unknown;
            }[];
        };
        readonly StudioContentItemListResponse: {
            readonly items: readonly components["schemas"]["StudioContentItemSummary"][];
            readonly nextCursor?: string | null;
            /** Format: int64 */
            readonly total: number;
        };
        readonly StudioContentItemSummary: {
            readonly createdAt: components["schemas"]["Timestamp"];
            readonly currentVersionId?: components["schemas"]["Uuid"];
            readonly family: components["schemas"]["StudioPackageFamily"];
            readonly itemId: components["schemas"]["Uuid"];
            readonly ownerId?: string | null;
            readonly packageKey: string;
            readonly publishedVersionId?: components["schemas"]["Uuid"];
            /** @enum {string} */
            readonly state: "draft" | "current" | "published";
            readonly updatedAt: components["schemas"]["Timestamp"];
            readonly workspaceId?: string | null;
        };
        readonly StudioContentVersion: {
            readonly contentHash: string;
            readonly createdAt: components["schemas"]["Timestamp"];
            readonly dependencies: readonly {
                readonly [key: string]: unknown;
            }[];
            readonly envelope: components["schemas"]["StudioPackageEnvelope"];
            readonly itemId: components["schemas"]["Uuid"];
            readonly ownerId?: string | null;
            readonly packageKey: string;
            readonly provenance: readonly {
                readonly [key: string]: unknown;
            }[];
            readonly validation: components["schemas"]["StudioValidationSummary"];
            readonly versionId: components["schemas"]["Uuid"];
            readonly versionNumber: number;
            readonly workspaceId?: string | null;
        };
        readonly StudioContentVersionListResponse: {
            readonly itemId: components["schemas"]["Uuid"];
            readonly versions: readonly components["schemas"]["StudioContentVersion"][];
        };
        readonly StudioPackageDraft: {
            readonly createdAt: components["schemas"]["Timestamp"];
            readonly draftId: components["schemas"]["Uuid"];
            readonly envelope: components["schemas"]["StudioPackageEnvelope"];
            readonly family: components["schemas"]["StudioPackageFamily"];
            /** Format: int64 */
            readonly generation: number;
            readonly itemId: components["schemas"]["Uuid"];
            readonly ownerId?: string | null;
            readonly packageKey: string;
            readonly updatedAt: components["schemas"]["Timestamp"];
            readonly validation: components["schemas"]["StudioValidationSummary"];
            readonly workspaceId?: string | null;
        };
        readonly StudioPackageDraftListResponse: {
            readonly items: readonly components["schemas"]["StudioPackageDraft"][];
            readonly nextCursor?: string | null;
            /** Format: int64 */
            readonly total: number;
        };
        readonly StudioPackageEnvelope: {
            readonly body?: {
                readonly [key: string]: unknown;
            } | null;
            readonly family: components["schemas"]["StudioPackageFamily"];
            readonly format?: string | null;
            readonly publicationIntent?: {
                readonly [key: string]: unknown;
            } | null;
            readonly schemaVersion: string;
        };
        /** @enum {string} */
        readonly StudioPackageFamily: "query" | "analysis" | "map" | "dashboard" | "report" | "form" | "app" | "workflow" | "gp" | "etl";
        readonly StudioPublicationRequest: {
            readonly createdAt: components["schemas"]["Timestamp"];
            readonly intent?: {
                readonly [key: string]: unknown;
            } | null;
            readonly itemId: components["schemas"]["Uuid"];
            readonly requestedBy?: string | null;
            readonly requestId: components["schemas"]["Uuid"];
            /** @enum {string} */
            readonly status: "accepted" | "pending" | "rejected";
            readonly validation: components["schemas"]["StudioValidationSummary"];
            readonly versionId: components["schemas"]["Uuid"];
            readonly warningAcknowledgement?: string | null;
        };
        readonly StudioValidationSummary: {
            readonly diagnostics: readonly {
                readonly [key: string]: unknown;
            }[];
            /** @enum {string} */
            readonly status: "not-validated" | "valid" | "warning" | "invalid";
        };
        /** Format: date-time */
        readonly Timestamp: string;
        readonly UpdateStudioPackageDraftRequest: components["schemas"]["CreateStudioPackageDraftRequest"] & {
            /** Format: int64 */
            readonly generation?: number;
        };
        /** Format: uuid */
        readonly Uuid: string;
    };
    responses: {
        /** @description Studio AI provider capabilities. */
        readonly AiCapabilities: {
            headers: {
                readonly [name: string]: unknown;
            };
            content: {
                readonly "application/json": components["schemas"]["ApiResponseAiCapabilities"];
            };
        };
        /** @description Cursor-paginated content-item page. */
        readonly ContentItemList: {
            headers: {
                readonly [name: string]: unknown;
            };
            content: {
                readonly "application/json": components["schemas"]["ApiResponseContentItemList"];
            };
        };
        /** @description Immutable content version. */
        readonly ContentVersion: {
            headers: {
                readonly [name: string]: unknown;
            };
            content: {
                readonly "application/json": components["schemas"]["ApiResponseContentVersion"];
            };
        };
        /** @description Content versions. */
        readonly ContentVersionList: {
            headers: {
                readonly [name: string]: unknown;
            };
            content: {
                readonly "application/json": components["schemas"]["ApiResponseContentVersionList"];
            };
        };
        /** @description Studio package draft. */
        readonly Draft: {
            headers: {
                readonly [name: string]: unknown;
            };
            content: {
                readonly "application/json": components["schemas"]["ApiResponseDraft"];
            };
        };
        /** @description Cursor-paginated draft page. */
        readonly DraftList: {
            headers: {
                readonly [name: string]: unknown;
            };
            content: {
                readonly "application/json": components["schemas"]["ApiResponseDraftList"];
            };
        };
        /** @description Export result or binary deliverable. */
        readonly Export: {
            headers: {
                readonly [name: string]: unknown;
            };
            content: {
                readonly "application/json": components["schemas"]["ApiResponseExport"];
                readonly "application/pdf": string;
                readonly "image/png": string;
            };
        };
        /** @description Generated draft package. */
        readonly GeneratedPackage: {
            headers: {
                readonly [name: string]: unknown;
            };
            content: {
                readonly "application/json": components["schemas"]["ApiResponseGeneratedPackage"];
            };
        };
        /** @description Package family capabilities. */
        readonly PackageFamilies: {
            headers: {
                readonly [name: string]: unknown;
            };
            content: {
                readonly "application/json": components["schemas"]["ApiResponsePackageFamilies"];
            };
        };
        /** @description Preview plan. */
        readonly PreviewPlan: {
            headers: {
                readonly [name: string]: unknown;
            };
            content: {
                readonly "application/json": components["schemas"]["ApiResponsePreviewPlan"];
            };
        };
        /** @description RFC 7807 error. */
        readonly Problem: {
            headers: {
                readonly [name: string]: unknown;
            };
            content: {
                readonly "application/problem+json": components["schemas"]["ProblemDetails"];
            };
        };
        /** @description Durable publication request. */
        readonly PublicationRequest: {
            headers: {
                readonly [name: string]: unknown;
            };
            content: {
                readonly "application/json": components["schemas"]["ApiResponsePublicationRequest"];
            };
        };
        /** @description Rollback result. */
        readonly Rollback: {
            headers: {
                readonly [name: string]: unknown;
            };
            content: {
                readonly "application/json": components["schemas"]["ApiResponseRollback"];
            };
        };
        /** @description Validation result. */
        readonly Validation: {
            headers: {
                readonly [name: string]: unknown;
            };
            content: {
                readonly "application/json": components["schemas"]["ApiResponseValidation"];
            };
        };
        /** @description Version comparison. */
        readonly VersionComparison: {
            headers: {
                readonly [name: string]: unknown;
            };
            content: {
                readonly "application/json": components["schemas"]["ApiResponseVersionComparison"];
            };
        };
    };
    parameters: {
        readonly Cursor: string;
        readonly DraftId: components["schemas"]["Uuid"];
        readonly Family: components["schemas"]["StudioPackageFamily"];
        readonly ItemId: components["schemas"]["Uuid"];
        readonly Limit: number;
        readonly OwnerId: string;
        readonly RequestId: components["schemas"]["Uuid"];
        readonly Search: string;
        readonly State: "draft" | "current" | "published";
        readonly VersionId: components["schemas"]["Uuid"];
        readonly WorkspaceId: string;
    };
    requestBodies: {
        readonly AiChat: {
            readonly content: {
                readonly "application/json": components["schemas"]["StudioAiChatRequest"];
            };
        };
        readonly CompareVersions: {
            readonly content: {
                readonly "application/json": components["schemas"]["CompareStudioContentVersionsRequest"];
            };
        };
        readonly CreateDraft: {
            readonly content: {
                readonly "application/json": components["schemas"]["CreateStudioPackageDraftRequest"];
            };
        };
        readonly CreatePublicationRequest: {
            readonly content: {
                readonly "application/json": components["schemas"]["CreateStudioPublicationRequest"];
            };
        };
        readonly CreateRollback: {
            readonly content: {
                readonly "application/json": components["schemas"]["CreateStudioRollbackRequest"];
            };
        };
        readonly GeneratePackage: {
            readonly content: {
                readonly "application/json": components["schemas"]["GenerateStudioPackageRequest"];
            };
        };
        readonly SaveVersion: {
            readonly content: {
                readonly "application/json": components["schemas"]["SaveStudioContentVersionRequest"];
            };
        };
        readonly UpdateDraft: {
            readonly content: {
                readonly "application/json": components["schemas"]["UpdateStudioPackageDraftRequest"];
            };
        };
    };
    headers: never;
    pathItems: never;
};
export type $defs = Record<string, never>;
export interface operations {
    readonly exportStudioDeliverable: {
        readonly parameters: {
            readonly query: {
                readonly format: "pdf" | "png";
                readonly store?: boolean;
                readonly versionId?: components["schemas"]["Uuid"];
            };
            readonly header?: never;
            readonly path: {
                readonly id: components["schemas"]["Uuid"];
                readonly kind: "map" | "dashboard" | "report";
            };
            readonly cookie?: never;
        };
        readonly requestBody?: never;
        readonly responses: {
            readonly 200: components["responses"]["Export"];
            readonly default: components["responses"]["Problem"];
        };
    };
    readonly getStudioAiCapabilities: {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path?: never;
            readonly cookie?: never;
        };
        readonly requestBody?: never;
        readonly responses: {
            readonly 200: components["responses"]["AiCapabilities"];
            readonly default: components["responses"]["Problem"];
        };
    };
    readonly streamStudioAiChat: {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path?: never;
            readonly cookie?: never;
        };
        readonly requestBody: components["requestBodies"]["AiChat"];
        readonly responses: {
            /** @description Server-sent Studio AI chat event stream. */
            readonly 200: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content: {
                    readonly "text/event-stream": components["schemas"]["StudioAiChatEvent"];
                };
            };
            readonly default: components["responses"]["Problem"];
        };
    };
    readonly generateStudioAppPackage: {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path?: never;
            readonly cookie?: never;
        };
        readonly requestBody: components["requestBodies"]["GeneratePackage"];
        readonly responses: {
            readonly 201: components["responses"]["GeneratedPackage"];
            readonly default: components["responses"]["Problem"];
        };
    };
    readonly listStudioContentItems: {
        readonly parameters: {
            readonly query?: {
                readonly cursor?: components["parameters"]["Cursor"];
                readonly family?: components["parameters"]["Family"];
                readonly limit?: components["parameters"]["Limit"];
                readonly ownerId?: components["parameters"]["OwnerId"];
                readonly search?: components["parameters"]["Search"];
                readonly state?: components["parameters"]["State"];
                readonly workspaceId?: components["parameters"]["WorkspaceId"];
            };
            readonly header?: never;
            readonly path?: never;
            readonly cookie?: never;
        };
        readonly requestBody?: never;
        readonly responses: {
            readonly 200: components["responses"]["ContentItemList"];
            readonly default: components["responses"]["Problem"];
        };
    };
    readonly createStudioRollbackRequest: {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path: {
                readonly itemId: components["parameters"]["ItemId"];
            };
            readonly cookie?: never;
        };
        readonly requestBody: components["requestBodies"]["CreateRollback"];
        readonly responses: {
            readonly 201: components["responses"]["Rollback"];
            readonly default: components["responses"]["Problem"];
        };
    };
    readonly compareStudioContentVersions: {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path: {
                readonly itemId: components["parameters"]["ItemId"];
            };
            readonly cookie?: never;
        };
        readonly requestBody: components["requestBodies"]["CompareVersions"];
        readonly responses: {
            readonly 200: components["responses"]["VersionComparison"];
            readonly default: components["responses"]["Problem"];
        };
    };
    readonly listStudioContentVersions: {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path: {
                readonly itemId: components["parameters"]["ItemId"];
            };
            readonly cookie?: never;
        };
        readonly requestBody?: never;
        readonly responses: {
            readonly 200: components["responses"]["ContentVersionList"];
            readonly default: components["responses"]["Problem"];
        };
    };
    readonly getStudioContentVersion: {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path: {
                readonly itemId: components["parameters"]["ItemId"];
                readonly versionId: components["parameters"]["VersionId"];
            };
            readonly cookie?: never;
        };
        readonly requestBody?: never;
        readonly responses: {
            readonly 200: components["responses"]["ContentVersion"];
            readonly default: components["responses"]["Problem"];
        };
    };
    readonly createStudioPublicationRequest: {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path: {
                readonly itemId: components["parameters"]["ItemId"];
                readonly versionId: components["parameters"]["VersionId"];
            };
            readonly cookie?: never;
        };
        readonly requestBody: components["requestBodies"]["CreatePublicationRequest"];
        readonly responses: {
            readonly 201: components["responses"]["PublicationRequest"];
            readonly default: components["responses"]["Problem"];
        };
    };
    readonly getStudioPublicationRequest: {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path: {
                readonly itemId: components["parameters"]["ItemId"];
                readonly requestId: components["parameters"]["RequestId"];
                readonly versionId: components["parameters"]["VersionId"];
            };
            readonly cookie?: never;
        };
        readonly requestBody?: never;
        readonly responses: {
            readonly 200: components["responses"]["PublicationRequest"];
            readonly default: components["responses"]["Problem"];
        };
    };
    readonly reopenStudioContentVersion: {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path: {
                readonly itemId: components["parameters"]["ItemId"];
                readonly versionId: components["parameters"]["VersionId"];
            };
            readonly cookie?: never;
        };
        readonly requestBody?: never;
        readonly responses: {
            readonly 201: components["responses"]["Draft"];
            readonly default: components["responses"]["Problem"];
        };
    };
    readonly generateStudioMapPackage: {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path?: never;
            readonly cookie?: never;
        };
        readonly requestBody: components["requestBodies"]["GeneratePackage"];
        readonly responses: {
            readonly 201: components["responses"]["GeneratedPackage"];
            readonly default: components["responses"]["Problem"];
        };
    };
    readonly listStudioPackageDrafts: {
        readonly parameters: {
            readonly query?: {
                readonly cursor?: components["parameters"]["Cursor"];
                readonly family?: components["parameters"]["Family"];
                readonly limit?: components["parameters"]["Limit"];
                readonly ownerId?: components["parameters"]["OwnerId"];
                readonly search?: components["parameters"]["Search"];
                readonly workspaceId?: components["parameters"]["WorkspaceId"];
            };
            readonly header?: never;
            readonly path?: never;
            readonly cookie?: never;
        };
        readonly requestBody?: never;
        readonly responses: {
            readonly 200: components["responses"]["DraftList"];
            readonly default: components["responses"]["Problem"];
        };
    };
    readonly createStudioPackageDraft: {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path?: never;
            readonly cookie?: never;
        };
        readonly requestBody: components["requestBodies"]["CreateDraft"];
        readonly responses: {
            readonly 201: components["responses"]["Draft"];
            readonly default: components["responses"]["Problem"];
        };
    };
    readonly getStudioPackageDraft: {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path: {
                readonly draftId: components["parameters"]["DraftId"];
            };
            readonly cookie?: never;
        };
        readonly requestBody?: never;
        readonly responses: {
            readonly 200: components["responses"]["Draft"];
            readonly default: components["responses"]["Problem"];
        };
    };
    readonly updateStudioPackageDraft: {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path: {
                readonly draftId: components["parameters"]["DraftId"];
            };
            readonly cookie?: never;
        };
        readonly requestBody: components["requestBodies"]["UpdateDraft"];
        readonly responses: {
            readonly 200: components["responses"]["Draft"];
            readonly default: components["responses"]["Problem"];
        };
    };
    readonly deleteStudioPackageDraft: {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path: {
                readonly draftId: components["parameters"]["DraftId"];
            };
            readonly cookie?: never;
        };
        readonly requestBody?: never;
        readonly responses: {
            /** @description Draft deleted. */
            readonly 204: {
                headers: {
                    readonly [name: string]: unknown;
                };
                content?: never;
            };
            readonly default: components["responses"]["Problem"];
        };
    };
    readonly createStudioContentVersion: {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path: {
                readonly draftId: components["parameters"]["DraftId"];
            };
            readonly cookie?: never;
        };
        readonly requestBody?: components["requestBodies"]["SaveVersion"];
        readonly responses: {
            readonly 201: components["responses"]["ContentVersion"];
            readonly default: components["responses"]["Problem"];
        };
    };
    readonly previewStudioPackageDraft: {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path: {
                readonly draftId: components["parameters"]["DraftId"];
            };
            readonly cookie?: never;
        };
        readonly requestBody?: never;
        readonly responses: {
            readonly 200: components["responses"]["PreviewPlan"];
            readonly default: components["responses"]["Problem"];
        };
    };
    readonly validateStudioPackageDraft: {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path: {
                readonly draftId: components["parameters"]["DraftId"];
            };
            readonly cookie?: never;
        };
        readonly requestBody?: never;
        readonly responses: {
            readonly 200: components["responses"]["Validation"];
            readonly default: components["responses"]["Problem"];
        };
    };
    readonly listStudioPackageFamilies: {
        readonly parameters: {
            readonly query?: never;
            readonly header?: never;
            readonly path?: never;
            readonly cookie?: never;
        };
        readonly requestBody?: never;
        readonly responses: {
            readonly 200: components["responses"]["PackageFamilies"];
            readonly default: components["responses"]["Problem"];
        };
    };
}
