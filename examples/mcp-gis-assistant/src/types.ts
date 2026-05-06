import type { HonuaSourceCacheStatus } from "@honua/sdk-js/app-workspace";
import type { FilterClause, LinkedViewQueryProjection } from "@honua/sdk-js/exploration";
import type { HonuaExtent } from "@honua/sdk-js/honua";

export type AssistantCapabilityStatus = "supported" | "degraded" | "unsupported";
export type AssistantDataMode = "fixture" | "cloud";
export type AssistantSeverity = "info" | "warning" | "error";

export interface AssistantDiagnostic {
  readonly level: AssistantSeverity;
  readonly code: string;
  readonly title: string;
  readonly detail: string;
}

export interface AssistantService {
  readonly id: string;
  readonly name: string;
  readonly type: string;
  readonly status: AssistantCapabilityStatus;
  readonly layerCount: number;
}

export interface AssistantLayer {
  readonly id: number;
  readonly serviceId: string;
  readonly sourceId: string;
  readonly name: string;
  readonly geometryType: "point" | "line" | "polygon";
  readonly featureCount: number;
}

export interface AssistantField {
  readonly name: string;
  readonly alias: string;
  readonly type: string;
}

export interface AssistantSourceMetadata {
  readonly service: AssistantService;
  readonly layer: AssistantLayer;
  readonly fields: readonly AssistantField[];
  readonly extent: HonuaExtent;
  readonly cache: {
    readonly status: HonuaSourceCacheStatus;
    readonly source: AssistantDataMode;
    readonly updatedAt: number;
    readonly revalidateAfterMs: number;
  };
  readonly capabilities: {
    readonly listServices: AssistantCapabilityStatus;
    readonly describeLayer: AssistantCapabilityStatus;
    readonly queryFeatures: AssistantCapabilityStatus;
    readonly statistics: AssistantCapabilityStatus;
    readonly realtime: AssistantCapabilityStatus;
  };
  readonly diagnostics: readonly AssistantDiagnostic[];
}

export interface AssistantFeature {
  readonly id: string;
  readonly title: string;
  readonly x: number;
  readonly y: number;
  readonly attributes: Readonly<Record<string, string | number>>;
}

export interface AssistantDataset {
  readonly workspaceId: string;
  readonly mode: AssistantDataMode;
  readonly activeSourceId: string;
  readonly services: readonly AssistantService[];
  readonly layers: readonly AssistantLayer[];
  readonly metadata: AssistantSourceMetadata;
  readonly features: readonly AssistantFeature[];
  readonly diagnostics: readonly AssistantDiagnostic[];
}

export interface AssistantToolCall {
  readonly id: string;
  readonly name: "list_services" | "describe_layer" | "query_features" | "count_features";
  readonly arguments: Readonly<Record<string, unknown>>;
  readonly result: unknown;
  readonly startedAt: number;
  readonly durationMs: number;
  readonly status: "ok" | "error";
}

export interface AssistantDraftQuery {
  readonly id: string;
  readonly label: string;
  readonly where: string;
  readonly filters: Readonly<Record<string, FilterClause>>;
  readonly projection: LinkedViewQueryProjection;
  readonly estimatedCount: number;
}

export interface AssistantBoundedSummary {
  readonly totalMatched: number;
  readonly returned: number;
  readonly limit: number;
  readonly truncated: boolean;
  readonly rows: readonly AssistantFeature[];
}

export interface AssistantTurn {
  readonly id: string;
  readonly userText: string;
  readonly assistantText: string;
  readonly toolCalls: readonly AssistantToolCall[];
  readonly summary?: AssistantBoundedSummary;
  readonly draft?: AssistantDraftQuery;
  readonly diagnostics: readonly AssistantDiagnostic[];
}
