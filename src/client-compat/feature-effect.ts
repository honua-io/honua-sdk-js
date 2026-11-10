/**
 * ArcGIS `FeatureEffect` shim.
 *
 * Included features keep the layer symbol. `includedEffect` (bloom, and other
 * CSS filter strings) is stored and is not a second paint pass. Excluded
 * features are repainted from `excludedEffect`: `grayscale(...)` draws them
 * gray, and `opacity(N%)` sets that gray's alpha. The filter `where` is the
 * same clause an in-memory feature layer already evaluates.
 */
export interface FeatureEffectCompatOptions {
  filter?: unknown;
  includedEffect?: string;
  excludedEffect?: string;
  excludedLabelsVisible?: boolean;
}

export class FeatureEffectCompat {
  public filter: unknown;
  public includedEffect: string | undefined;
  public excludedEffect: string | undefined;
  public excludedLabelsVisible: boolean;

  public constructor(options: FeatureEffectCompatOptions = {}) {
    this.filter = options.filter;
    this.includedEffect = options.includedEffect;
    this.excludedEffect = options.excludedEffect;
    this.excludedLabelsVisible = options.excludedLabelsVisible ?? true;
  }
}
