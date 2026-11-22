/**
 * Scene-aware 3D edit proposals, review/apply receipts, and realtime
 * linked-edit reconciliation across synchronized 2D/3D views.
 *
 * Preserves vertical datum, altitude reference, precision, source version, and
 * authorization scope on every proposal and receipt. Ambiguous, lossy, or
 * unsupported 2D/3D mappings fail closed or require explicit review — they
 * never silently flatten or drop Z values.
 *
 * @experimental Held back from the beta `@honua/app-platform/scene-workspace`
 *   tier while editing and 3D qualification converge.
 * @module
 */

import type { FeatureId, SourceId } from "../contract/types.js";
import type { FeatureSelectionTarget } from "../exploration/index.js";
import type { SceneStoreIntent } from "./types.js";

/** Vertical placement reference for a 3D edit proposal. */
export type SceneAltitudeReference =
  | "ellipsoidal"
  | "relative-to-ground"
  | "clamped-to-ground"
  | "absolute-orthometric";

/** Editable 3D geometry/placement kinds. */
export type SceneEditableGeometryKind = "point" | "polyline" | "polygon" | "model-placement";

/** Vertical reference and precision context carried on every 3D edit proposal and receipt. */
export interface SceneEditVerticalContext {
  readonly crs: string;
  readonly verticalDatum: string;
  readonly altitudeReference: SceneAltitudeReference;
  readonly precisionMeters?: number;
}

/** Source edit capabilities required before a 3D edit proposal may be approved. */
export interface SceneEditCapabilityDeclaration {
  readonly canEdit: boolean;
  readonly supportsZ: boolean;
  readonly supportedGeometryKinds: readonly SceneEditableGeometryKind[];
  readonly supportedVerticalDatums: readonly string[];
  readonly supportedAltitudeReferences: readonly SceneAltitudeReference[];
  readonly sourceVersion?: string;
  readonly authorizationScope: readonly string[];
}

/** A 3D placement payload (coordinates + optional orientation/scale + attributes). */
export interface SceneEditPlacement {
  readonly coordinates: readonly [number, number, number?];
  readonly orientation?: readonly [number, number, number];
  readonly scale?: number;
  readonly attributes?: Readonly<Record<string, unknown>>;
}

/** Diagnostic emitted while validating or reconciling a 3D edit proposal. */
export interface SceneEditDiagnostic {
  readonly code:
    | "scene-edit-capability-denied"
    | "scene-edit-geometry-unsupported"
    | "scene-edit-z-flattening-forbidden"
    | "scene-edit-vertical-reference-unsupported"
    | "scene-edit-lossy-mapping-review"
    | "scene-edit-remote-deleted"
    | "scene-edit-remote-version-conflict";
  readonly severity: "warning" | "error";
  readonly message: string;
}

/** Lifecycle status of a {@link ScenePlacementEditProposal}. */
export type SceneEditProposalStatus = "ready" | "review-required" | "rejected" | "applied" | "invalidated";

/** Immutable, serializable 3D placement edit proposal. */
export interface ScenePlacementEditProposal {
  readonly proposalId: string;
  readonly sourceId: SourceId;
  readonly featureId: FeatureId;
  readonly operation: "create" | "update" | "delete";
  readonly geometryKind: SceneEditableGeometryKind;
  readonly before?: SceneEditPlacement;
  readonly after?: SceneEditPlacement;
  readonly verticalContext: SceneEditVerticalContext;
  readonly sourceVersion?: string;
  readonly authorizationScope: readonly string[];
  readonly status: SceneEditProposalStatus;
  readonly diagnostics: readonly SceneEditDiagnostic[];
}

/** Input to {@link createSceneEditProposal}. */
export interface CreateSceneEditProposalOptions {
  readonly proposalId: string;
  readonly sourceId: SourceId;
  readonly featureId: FeatureId;
  readonly operation: "create" | "update" | "delete";
  readonly geometryKind: SceneEditableGeometryKind;
  readonly before?: SceneEditPlacement;
  readonly after?: SceneEditPlacement;
  readonly verticalContext: SceneEditVerticalContext;
  readonly capabilities: SceneEditCapabilityDeclaration;
}

/** Durable receipt emitted when a reviewed 3D edit proposal is applied. */
export interface SceneEditReceipt {
  readonly receiptId: string;
  readonly proposalId: string;
  readonly sourceId: SourceId;
  readonly featureId: FeatureId;
  readonly operation: "create" | "update" | "delete";
  readonly appliedAt: string;
  readonly verticalContext: SceneEditVerticalContext;
  readonly sourceVersion?: string;
  readonly authorizationScope: readonly string[];
  readonly affectedSelectionTarget: FeatureSelectionTarget;
  readonly reconciliationIntents: readonly SceneStoreIntent[];
}

/** Realtime feature mutation notification reconciled against an active edit proposal. */
export interface SceneRealtimeFeatureEvent {
  readonly kind: "updated" | "deleted";
  readonly sourceId: SourceId;
  readonly featureId: FeatureId;
  readonly sourceVersion?: string;
}

/** Result of {@link reconcileSceneEditWithRealtime}. */
export interface SceneEditRealtimeReconciliation {
  readonly proposal: ScenePlacementEditProposal;
  readonly clearSelection: boolean;
  readonly reconciliationIntents: readonly SceneStoreIntent[];
}

/**
 * Create and validate a 3D placement edit proposal.
 *
 * Fails closed when edit capability, geometry kind, Z support, or vertical
 * reference is unsupported; never silently drops or flattens Z coordinates.
 */
export function createSceneEditProposal(options: CreateSceneEditProposalOptions): ScenePlacementEditProposal {
  const diagnostics: SceneEditDiagnostic[] = [];
  const { capabilities, verticalContext } = options;

  if (!capabilities.canEdit) {
    diagnostics.push({
      code: "scene-edit-capability-denied",
      severity: "error",
      message: `Source "${options.sourceId}" does not advertise edit capability.`,
    });
  }
  if (!capabilities.supportedGeometryKinds.includes(options.geometryKind)) {
    diagnostics.push({
      code: "scene-edit-geometry-unsupported",
      severity: "error",
      message: `Geometry kind "${options.geometryKind}" is not editable on source "${options.sourceId}".`,
    });
  }
  if (hasExplicitZ(options.after) && !capabilities.supportsZ) {
    diagnostics.push({
      code: "scene-edit-z-flattening-forbidden",
      severity: "error",
      message: `Source "${options.sourceId}" does not support Z coordinates; refusing to silently flatten 3D placement.`,
    });
  }
  if (!capabilities.supportedVerticalDatums.includes(verticalContext.verticalDatum)) {
    diagnostics.push({
      code: "scene-edit-vertical-reference-unsupported",
      severity: "error",
      message: `Vertical datum "${verticalContext.verticalDatum}" is not supported by source "${options.sourceId}".`,
    });
  }
  if (!capabilities.supportedAltitudeReferences.includes(verticalContext.altitudeReference)) {
    diagnostics.push({
      code: "scene-edit-vertical-reference-unsupported",
      severity: "error",
      message: `Altitude reference "${verticalContext.altitudeReference}" is not supported by source "${options.sourceId}".`,
    });
  }
  if (
    verticalContext.altitudeReference === "clamped-to-ground" &&
    options.after?.coordinates[2] !== undefined &&
    options.after.coordinates[2] !== 0
  ) {
    diagnostics.push({
      code: "scene-edit-lossy-mapping-review",
      severity: "warning",
      message: "Non-zero height on a clamped-to-ground placement requires explicit review before applying.",
    });
  }

  const hasError = diagnostics.some((entry) => entry.severity === "error");
  const hasWarning = diagnostics.some((entry) => entry.severity === "warning");
  const status: SceneEditProposalStatus = hasError ? "rejected" : hasWarning ? "review-required" : "ready";

  return Object.freeze({
    proposalId: options.proposalId,
    sourceId: options.sourceId,
    featureId: options.featureId,
    operation: options.operation,
    geometryKind: options.geometryKind,
    ...(options.before ? { before: options.before } : {}),
    ...(options.after ? { after: options.after } : {}),
    verticalContext: Object.freeze({ ...verticalContext }),
    ...(capabilities.sourceVersion !== undefined ? { sourceVersion: capabilities.sourceVersion } : {}),
    authorizationScope: Object.freeze([...capabilities.authorizationScope]),
    status,
    diagnostics: Object.freeze(diagnostics),
  });
}

/** Explicitly approve a `review-required` proposal after human review. */
export function approveSceneEditProposal(proposal: ScenePlacementEditProposal): ScenePlacementEditProposal {
  if (proposal.status === "rejected" || proposal.status === "invalidated") {
    throw new Error(`Cannot approve a ${proposal.status} scene edit proposal.`);
  }
  if (proposal.status === "applied") return proposal;
  return Object.freeze({ ...proposal, status: "ready" });
}

/**
 * Apply a validated 3D edit proposal through the caller's server mutation
 * executor and emit a durable receipt + cross-view reconciliation intents.
 */
export async function applySceneEditProposal(options: {
  readonly proposal: ScenePlacementEditProposal;
  readonly execute: (
    proposal: ScenePlacementEditProposal,
  ) => Promise<{ readonly receiptId: string; readonly sourceVersion?: string }>;
  readonly now?: () => string;
}): Promise<SceneEditReceipt> {
  const { proposal } = options;
  if (proposal.status !== "ready") {
    throw new Error(`Refusing to apply scene edit proposal "${proposal.proposalId}" in status "${proposal.status}".`);
  }
  const outcome = await options.execute(proposal);
  const appliedAt = (options.now ?? (() => new Date().toISOString()))();
  const target: FeatureSelectionTarget = { sourceId: proposal.sourceId, id: proposal.featureId };
  const reconciliationIntents: SceneStoreIntent[] =
    proposal.operation === "delete"
      ? [
          {
            kind: "clear-selection",
            source: "scene",
            at: appliedAt,
            historyLabel: "Deleted feature selection cleared",
          },
          { kind: "set-detail", detail: { status: "empty" }, source: "scene", at: appliedAt },
        ]
      : [
          {
            kind: "set-selection",
            selection: [target],
            source: "scene",
            at: appliedAt,
            historyLabel: "Edited feature selected",
          },
          {
            kind: "set-detail",
            detail: {
              target,
              sourceId: proposal.sourceId,
              featureId: proposal.featureId,
              status: "ready",
              ...(proposal.after?.attributes ? { attributes: proposal.after.attributes } : {}),
            },
            source: "scene",
            at: appliedAt,
          },
        ];

  return Object.freeze({
    receiptId: outcome.receiptId,
    proposalId: proposal.proposalId,
    sourceId: proposal.sourceId,
    featureId: proposal.featureId,
    operation: proposal.operation,
    appliedAt,
    verticalContext: proposal.verticalContext,
    ...((outcome.sourceVersion ?? proposal.sourceVersion)
      ? { sourceVersion: outcome.sourceVersion ?? proposal.sourceVersion }
      : {}),
    authorizationScope: proposal.authorizationScope,
    affectedSelectionTarget: target,
    reconciliationIntents: Object.freeze(reconciliationIntents),
  });
}

/**
 * Reconcile an active 3D edit proposal against an incoming realtime event.
 *
 * Remote deletions invalidate the edit proposal and emit explicit selection
 * cleanup; remote version advances transition the proposal to `review-required`
 * so stale edits cannot silently overwrite newer server state.
 */
export function reconcileSceneEditWithRealtime(
  proposal: ScenePlacementEditProposal,
  event: SceneRealtimeFeatureEvent,
): SceneEditRealtimeReconciliation {
  if (event.sourceId !== proposal.sourceId || event.featureId !== proposal.featureId) {
    return { proposal, clearSelection: false, reconciliationIntents: [] };
  }
  if (event.kind === "deleted") {
    const deleteDiag: SceneEditDiagnostic = {
      code: "scene-edit-remote-deleted",
      severity: "error",
      message: `Feature "${String(proposal.featureId)}" was deleted remotely; edit proposal invalidated.`,
    };
    const invalidated: ScenePlacementEditProposal = Object.freeze({
      ...proposal,
      status: "invalidated",
      diagnostics: Object.freeze([...proposal.diagnostics, deleteDiag]),
    });
    return {
      proposal: invalidated,
      clearSelection: true,
      reconciliationIntents: [
        { kind: "clear-selection", source: "realtime", historyLabel: "Remote deletion cleared selection" },
        { kind: "set-detail", detail: { status: "stale" }, source: "realtime" },
      ],
    };
  }
  if (
    event.sourceVersion !== undefined &&
    proposal.sourceVersion !== undefined &&
    event.sourceVersion !== proposal.sourceVersion
  ) {
    const conflictDiag: SceneEditDiagnostic = {
      code: "scene-edit-remote-version-conflict",
      severity: "warning",
      message: `Remote source version changed from "${proposal.sourceVersion}" to "${event.sourceVersion}".`,
    };
    const conflicted: ScenePlacementEditProposal = Object.freeze({
      ...proposal,
      status: "review-required",
      diagnostics: Object.freeze([...proposal.diagnostics, conflictDiag]),
    });
    return {
      proposal: conflicted,
      clearSelection: false,
      reconciliationIntents: [{ kind: "set-detail", detail: { status: "stale" }, source: "realtime" }],
    };
  }
  return { proposal, clearSelection: false, reconciliationIntents: [] };
}

function hasExplicitZ(placement: SceneEditPlacement | undefined): boolean {
  return placement !== undefined && placement.coordinates[2] !== undefined && Number.isFinite(placement.coordinates[2]);
}
