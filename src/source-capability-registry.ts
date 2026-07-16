import type { SourceDescriptor } from "./contract/types.js";
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
  readonly sourceDescriptorMatches?: CapabilitySourceDescriptorMatcher;
}

export type CapabilitySourceDescriptorMatcher = (
  descriptor: Pick<SourceDescriptor, "id" | "protocol" | "locator">,
) => boolean;

const evidenceProfiles = new WeakMap<CapabilityEvidenceProfile, CapabilityEvidenceRuntimeIndex>();
const evaluatedProfiles = new WeakMap<CapabilityProfile, CapabilitySourceDescriptorMatcher | undefined>();

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

export function registerCapabilityProfile(
  profile: CapabilityProfile,
  sourceDescriptorMatches: CapabilitySourceDescriptorMatcher | undefined,
): CapabilityProfile {
  evaluatedProfiles.set(profile, sourceDescriptorMatches);
  return profile;
}

export function isRegisteredCapabilityProfile(profile: CapabilityProfile): boolean {
  return evaluatedProfiles.has(profile);
}

export function matchesRegisteredCapabilityProfileSource(
  profile: CapabilityProfile,
  descriptor: Pick<SourceDescriptor, "id" | "protocol" | "locator">,
): boolean {
  const sourceDescriptorMatches = evaluatedProfiles.get(profile);
  if (sourceDescriptorMatches === undefined) return false;
  try {
    return sourceDescriptorMatches(descriptor);
  } catch {
    // Descriptor access and endpoint validation are caller-controlled. Collapse
    // every malformed/proxy failure into the public fail-closed mismatch.
    return false;
  }
}
