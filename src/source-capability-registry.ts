import type {
  CapabilityEvidenceProfile,
  CapabilityProfile,
  CapabilityTruth,
  IsoInstant,
} from "./source-capability-types.js";

export interface CapabilityObservationWindow {
  readonly truth: CapabilityTruth;
  readonly observedAt: bigint;
  readonly expiresAt: bigint;
  readonly expiresAtText: IsoInstant;
}

export interface CapabilityEvidenceRuntimeEntry {
  readonly observations: readonly CapabilityObservationWindow[];
}

export interface CapabilityEvidenceRuntimeIndex {
  readonly entries: readonly CapabilityEvidenceRuntimeEntry[];
}

const evidenceProfiles = new WeakMap<CapabilityEvidenceProfile, CapabilityEvidenceRuntimeIndex>();
const evaluatedProfiles = new WeakSet<CapabilityProfile>();

export function registerCapabilityEvidenceProfile(
  profile: CapabilityEvidenceProfile,
  index: CapabilityEvidenceRuntimeIndex,
): CapabilityEvidenceProfile {
  evidenceProfiles.set(profile, index);
  return profile;
}

export function capabilityEvidenceRuntimeIndex(
  profile: CapabilityEvidenceProfile,
): CapabilityEvidenceRuntimeIndex | undefined {
  return evidenceProfiles.get(profile);
}

export function registerCapabilityProfile(profile: CapabilityProfile): CapabilityProfile {
  evaluatedProfiles.add(profile);
  return profile;
}

export function isRegisteredCapabilityProfile(profile: CapabilityProfile): boolean {
  return evaluatedProfiles.has(profile);
}
