import type { IncidentEditReceipt, IncidentEditRequest, IncidentFeature, IncidentResetRequest } from "./types.js";

export type IncidentExecutionLane = "live" | "replay" | "fixture-edit";

export interface IncidentMutationGuardInput {
  readonly lane: IncidentExecutionLane;
  readonly live: boolean;
  readonly authorized: boolean;
  readonly safeEditProfile: boolean;
  readonly sourceIdentity: string;
  readonly incident?: IncidentFeature;
}

export interface IncidentMutationGuard {
  readonly enabled: boolean;
  readonly reason: string;
}

export interface SafeIncidentEditorOptions {
  readonly baseline: IncidentFeature;
  readonly now?: () => number;
  publish(incident: IncidentFeature, idempotencyKey: string, operation: "edit" | "reset" | "external"): void;
}

export interface SafeIncidentEditor {
  readonly current: IncidentFeature;
  edit(request: IncidentEditRequest): IncidentEditReceipt;
  reset(request: IncidentResetRequest): IncidentEditReceipt;
  simulateConcurrentUpdate(): IncidentFeature;
}

export const SAFE_DEMO_EDIT_SOURCE_ID = "incident-ops-fixture-isolated";
export const SAFE_DEMO_INCIDENT_ID = "DEMO-EDIT-0001";

export function evaluateIncidentMutationGuard(input: IncidentMutationGuardInput): IncidentMutationGuard {
  if (!input.incident) return { enabled: false, reason: "Select the isolated demo record to stage an edit." };
  if (!input.incident.safeDemoRecord || input.incident.id !== SAFE_DEMO_INCIDENT_ID) {
    return { enabled: false, reason: "This record is not part of the isolated resettable demo-edit profile." };
  }
  if (input.lane === "replay") {
    return { enabled: false, reason: "Replay fallback is read-only and never submits mutations." };
  }
  if (!input.live) return { enabled: false, reason: "Mutation is disabled while the stream is not authoritative." };
  if (!input.authorized) return { enabled: false, reason: "The current session is not authorized for demo editing." };
  if (!input.safeEditProfile) {
    return { enabled: false, reason: "The source does not advertise an isolated resettable demo-edit profile." };
  }
  if (input.lane === "live" && input.sourceIdentity !== "maui-incidents-demo-edits") {
    return { enabled: false, reason: "Live mutation is restricted to the dedicated maui-incidents-demo-edits source." };
  }
  if (input.lane === "fixture-edit" && input.sourceIdentity !== SAFE_DEMO_EDIT_SOURCE_ID) {
    return { enabled: false, reason: "Fixture mutation source identity did not match the isolated profile." };
  }
  return { enabled: true, reason: "Isolated demo editing is enabled." };
}

export function createSafeIncidentEditor(options: SafeIncidentEditorOptions): SafeIncidentEditor {
  if (!options.baseline.safeDemoRecord || options.baseline.id !== SAFE_DEMO_INCIDENT_ID) {
    throw new Error("Safe incident editor requires the dedicated demo record.");
  }
  const now = options.now ?? (() => Date.now());
  const baseline = cloneIncident(options.baseline);
  let current = cloneIncident(options.baseline);
  const receipts = new Map<string, IncidentEditReceipt>();

  function duplicate(receipt: IncidentEditReceipt): IncidentEditReceipt {
    return {
      ...receipt,
      outcome: "duplicate",
      reason: `Idempotency key already completed with ${receipt.outcome}.`,
    };
  }

  return {
    get current() {
      return current;
    },
    edit(request) {
      const prior = receipts.get(request.idempotencyKey);
      if (prior) return duplicate(prior);
      if (request.incidentId !== SAFE_DEMO_INCIDENT_ID) {
        const blocked: IncidentEditReceipt = {
          outcome: "blocked",
          operation: "edit",
          idempotencyKey: request.idempotencyKey,
          reason: "Only the dedicated demo record can be edited.",
        };
        receipts.set(request.idempotencyKey, blocked);
        return blocked;
      }
      const actualRevision = current.revision ?? 0;
      if (request.expectedRevision !== actualRevision) {
        const conflict: IncidentEditReceipt = {
          outcome: "conflict",
          operation: "edit",
          idempotencyKey: request.idempotencyKey,
          incident: cloneIncident(current),
          expectedRevision: request.expectedRevision,
          actualRevision,
          reason: `Revision conflict: expected ${request.expectedRevision}, current ${actualRevision}.`,
        };
        receipts.set(request.idempotencyKey, conflict);
        return conflict;
      }
      current = {
        ...current,
        ...request.patch,
        revision: actualRevision + 1,
        updatedAt: new Date(now()).toISOString(),
      };
      const applied: IncidentEditReceipt = {
        outcome: "applied",
        operation: "edit",
        idempotencyKey: request.idempotencyKey,
        incident: cloneIncident(current),
        expectedRevision: request.expectedRevision,
        actualRevision: current.revision,
        reason: "Edit accepted and published through the realtime reconciliation path.",
      };
      receipts.set(request.idempotencyKey, applied);
      options.publish(current, request.idempotencyKey, "edit");
      return applied;
    },
    reset(request) {
      const prior = receipts.get(request.idempotencyKey);
      if (prior) return duplicate(prior);
      if (request.incidentId !== SAFE_DEMO_INCIDENT_ID) {
        const blocked: IncidentEditReceipt = {
          outcome: "blocked",
          operation: "reset",
          idempotencyKey: request.idempotencyKey,
          reason: "Only the dedicated demo record can be reset.",
        };
        receipts.set(request.idempotencyKey, blocked);
        return blocked;
      }
      current = {
        ...cloneIncident(baseline),
        revision: (current.revision ?? 0) + 1,
        updatedAt: new Date(now()).toISOString(),
      };
      const reset: IncidentEditReceipt = {
        outcome: "reset",
        operation: "reset",
        idempotencyKey: request.idempotencyKey,
        incident: cloneIncident(current),
        actualRevision: current.revision,
        reason: "Demo record reset idempotently and republished through realtime state.",
      };
      receipts.set(request.idempotencyKey, reset);
      options.publish(current, request.idempotencyKey, "reset");
      return reset;
    },
    simulateConcurrentUpdate() {
      current = {
        ...current,
        assignedTo: "Parallel Demo Operator",
        revision: (current.revision ?? 0) + 1,
        updatedAt: new Date(now()).toISOString(),
      };
      options.publish(current, `external-${current.revision}`, "external");
      return cloneIncident(current);
    },
  };
}

function cloneIncident(incident: IncidentFeature): IncidentFeature {
  return {
    ...incident,
    coordinate: [...incident.coordinate] as [number, number],
    relatedRecords: incident.relatedRecords.map((record) => ({ ...record })),
    attachments: incident.attachments.map((attachment) => ({ ...attachment })),
  };
}
