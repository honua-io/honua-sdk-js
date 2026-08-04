export interface DeckGlCapabilityFacts {
  webgl2: boolean;
  webgl1: boolean;
  loseContextExtension: boolean;
  maxTextureSize: number;
  rendererString: string;
  deviceMemoryGiB: number | null;
  hardwareConcurrency: number;
}

export type DeckGlCapabilityTier = "supported" | "fallback-maplibre" | "unsupported";

export interface DeckGlCapabilityDecision {
  tier: DeckGlCapabilityTier;
  reasons: readonly string[];
}

export const DECK_GL_CAPABILITY_POLICY: {
  schemaVersion: 2;
  id: string;
  description: string;
  minSupportedMaxTextureSize: number;
};

export function classifyDeckGlCapability(facts: DeckGlCapabilityFacts): DeckGlCapabilityDecision;
