import type { FeatureId } from "@honua/sdk-js/contract";

export type IncidentSeverity = "critical" | "high" | "medium" | "low";
export type IncidentStatus = "open" | "assigned" | "monitoring" | "resolved";

export interface IncidentRelatedRecord {
  readonly id: string;
  readonly label: string;
  readonly status: string;
}

export interface IncidentAttachment {
  readonly id: string;
  readonly name: string;
  readonly kind: string;
}

export interface IncidentFeature {
  readonly id: string;
  readonly title: string;
  readonly type: string;
  readonly severity: IncidentSeverity;
  readonly status: IncidentStatus;
  readonly assignedTo: string;
  readonly updatedAt: string;
  readonly reportedAt: string;
  readonly coordinate: readonly [number, number];
  readonly etaMinutes: number;
  readonly affectedAssets: number;
  readonly summary: string;
  readonly relatedRecords: ReadonlyArray<IncidentRelatedRecord>;
  readonly attachments: ReadonlyArray<IncidentAttachment>;
}

export interface IncidentScenarioStep {
  readonly label: string;
  readonly description: string;
  readonly kind: "upsert" | "delete";
  readonly incident?: IncidentFeature;
  readonly id?: FeatureId;
}

export interface IncidentSummary {
  readonly total: number;
  readonly active: number;
  readonly critical: number;
  readonly resolved: number;
  readonly etaAverage: number;
}

export interface IncidentProjectionResult {
  readonly incidents: IncidentFeature[];
  readonly summary: IncidentSummary;
}
