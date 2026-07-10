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
  /** Monotonic optimistic-concurrency token for isolated demo edits. */
  readonly revision?: number;
  /** True only for records that are dedicated to the resettable demo-edit profile. */
  readonly safeDemoRecord?: boolean;
}

export interface IncidentEditPatch {
  readonly status: IncidentStatus;
  readonly assignedTo: string;
}

export interface IncidentEditRequest {
  readonly incidentId: string;
  readonly expectedRevision: number;
  readonly idempotencyKey: string;
  readonly patch: IncidentEditPatch;
}

export interface IncidentResetRequest {
  readonly incidentId: string;
  readonly idempotencyKey: string;
}

export type IncidentEditOutcome = "applied" | "duplicate" | "conflict" | "blocked" | "reset";

export interface IncidentEditReceipt {
  readonly outcome: IncidentEditOutcome;
  readonly operation: "edit" | "reset";
  readonly idempotencyKey: string;
  readonly incident?: IncidentFeature;
  readonly expectedRevision?: number;
  readonly actualRevision?: number;
  readonly reason: string;
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
