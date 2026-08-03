export interface SkipAttestationRenewalPolicy {
  /** Re-observe an attestation this many days before its policy horizon. */
  renewWithinDays: number;
  /** Warn this many days before the horizon; must be strictly less than renewWithinDays. */
  alertWithinDays: number;
}

export interface SkipAttestationLane {
  sampleId: string;
  mode: string;
  targetMode: string | null;
  declaredStatus: string;
  evidencePath: string;
  overlayExpiresAt: string | null;
  command: string;
}

export interface PlannedSkipAttestationLane extends SkipAttestationLane {
  observedAt: string;
  reason: string | null;
  /** observedAt + configuration.evidenceExpiry.nonExecutedMaxDays. */
  policyExpiresAt: string;
  daysRemaining: number;
  lapsed: boolean;
  action: "renew" | "hold";
  alert: boolean;
}

export interface SkipAttestationRenewalPlan {
  now: string;
  policy: SkipAttestationRenewalPolicy;
  nonExecutedMaxDays: number;
  lanes: PlannedSkipAttestationLane[];
}

export const MIGRATION_PATH: string;
export const V1_CATALOG_PATH: string;
export const EVIDENCE_SCHEMA_PATH: string;
export const SKIP_ATTESTATION_RENEWAL_POLICY: Readonly<SkipAttestationRenewalPolicy>;
export const CANONICAL_EVIDENCE_KEYS: readonly string[];

export function skipAttestationLanes(
  migration: Record<string, any>,
  catalogV1: Record<string, any>,
): SkipAttestationLane[];

export function planSkipAttestationRenewal(options: {
  migration: Record<string, any>;
  catalogV1: Record<string, any>;
  now?: string;
  policy?: Partial<SkipAttestationRenewalPolicy>;
  projectRoot?: string;
  readEvidence?: (evidencePath: string) => Promise<Record<string, any>>;
}): Promise<SkipAttestationRenewalPlan>;

export function evidenceSchemaReference(evidencePath: string): string;

export function canonicalAttestation<T extends Record<string, any>>(evidence: T, evidencePath: string): T;

export function serializeAttestation(evidence: Record<string, any>): string;

export function assertRenewedAttestation<T extends Record<string, any>>(
  renewed: T,
  context: { lane: Record<string, any>; previous: Record<string, any> },
): T;

export function formatRenewalPlan(
  plan: SkipAttestationRenewalPlan,
  options?: { renewed?: readonly string[] },
): string;

export function renewalAlertMessage(
  lane: PlannedSkipAttestationLane,
  policy?: SkipAttestationRenewalPolicy,
): string;
