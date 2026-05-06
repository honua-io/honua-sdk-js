import type { FeatureSelectionTarget, FilterClause } from "@honua/sdk-js/exploration";
import type { HonuaExtent } from "@honua/sdk-js/honua";

export const INCIDENT_SOURCE_ID = "incident-ops";
export const CREW_SOURCE_ID = "response-crews";
export const OPS_LAYER_ID = "unified-ops-features";

export type UnifiedOpsSourceId = typeof INCIDENT_SOURCE_ID | typeof CREW_SOURCE_ID;
export type UnifiedOpsModuleId = "incident-command" | "analysis-review";
export type UnifiedOpsRecordKind = "incident" | "crew";
export type UnifiedOpsSeverity = "critical" | "high" | "medium" | "low";
export type UnifiedOpsStatus = "open" | "assigned" | "monitoring" | "resolved" | "available" | "enroute" | "staged";

export interface UnifiedOpsFeature {
  readonly id: string;
  readonly sourceId: UnifiedOpsSourceId;
  readonly kind: UnifiedOpsRecordKind;
  readonly title: string;
  readonly type: string;
  readonly severity: UnifiedOpsSeverity;
  readonly status: UnifiedOpsStatus;
  readonly district: string;
  readonly coordinate: readonly [number, number];
  readonly updatedAt: string;
  readonly etaMinutes?: number;
  readonly impactScore?: number;
  readonly assignment?: string;
  readonly summary: string;
  readonly relatedIds: ReadonlyArray<string>;
  readonly attachments: ReadonlyArray<string>;
}

export interface UnifiedOpsSourceMetadata {
  readonly title: string;
  readonly protocol: string;
  readonly active: boolean;
  readonly cache: {
    readonly status: "hit" | "stale" | "refreshing";
    readonly updatedAt: number;
    readonly ttlMs: number;
  };
  readonly diagnostics: ReadonlyArray<string>;
}

export interface UnifiedOpsScenarioStep {
  readonly label: string;
  readonly description: string;
  readonly event:
    | {
        readonly type: "upsert";
        readonly feature: UnifiedOpsFeature;
      }
    | {
        readonly type: "delete";
        readonly sourceId: UnifiedOpsSourceId;
        readonly id: string;
      };
}

export interface UnifiedOpsSummary {
  readonly visible: number;
  readonly activeIncidents: number;
  readonly criticalIncidents: number;
  readonly availableCrews: number;
  readonly averageEtaMinutes: number;
}

export interface UnifiedOpsChartBucket {
  readonly id: UnifiedOpsSeverity;
  readonly label: string;
  readonly count: number;
  readonly targets: ReadonlyArray<FeatureSelectionTarget>;
  readonly filter: FilterClause;
}

export interface UnifiedOpsProjectionResult {
  readonly rows: ReadonlyArray<UnifiedOpsFeature>;
  readonly incidentRows: ReadonlyArray<UnifiedOpsFeature>;
  readonly crewRows: ReadonlyArray<UnifiedOpsFeature>;
  readonly summary: UnifiedOpsSummary;
  readonly buckets: ReadonlyArray<UnifiedOpsChartBucket>;
}

export interface UnifiedOpsJobResult {
  readonly kind: "analysis-draft" | "snapshot-diagnostics";
  readonly title: string;
  readonly summary: string;
  readonly draftId?: string;
  readonly diagnostics?: UnifiedOpsSnapshotDiagnostics;
}

export interface UnifiedOpsSnapshotDiagnostics {
  readonly sourceCount: number;
  readonly activeSourceCount: number;
  readonly filterCount: number;
  readonly selectedFeatureCount: number;
  readonly realtimeRecordCount: number;
  readonly jobCount: number;
  readonly draftCount: number;
  readonly activeViewId?: string;
  readonly modulePanelCount: number;
  readonly warnings: ReadonlyArray<string>;
}

export interface UnifiedOpsSavedSnapshot {
  readonly id: string;
  readonly savedAt: string;
}

export interface UnifiedOpsMapPreset {
  readonly id: string;
  readonly label: string;
  readonly extent: HonuaExtent;
}
