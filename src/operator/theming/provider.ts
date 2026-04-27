/**
 * `ThemeProvider` writes operator tokens onto a host element as CSS
 * custom properties. The provider is the only place reference components
 * read tokens from; embedders that want to rebrand swap the provider or
 * pass overrides instead of forking components.
 *
 * @module
 */

import {
  DEFAULT_OPERATOR_TOKENS,
  type OperatorThemeTokens,
  type OperatorTokenId,
  tokenIdToCssVariable,
} from "./tokens.js";

/**
 * Minimal element duck-type — anything with `style.setProperty` works.
 * Avoids requiring `HTMLElement` so the provider is testable without a
 * DOM.
 */
export interface ThemeTargetElement {
  style: { setProperty(name: string, value: string): void };
}

export interface ThemeProvider {
  /** Returns the merged tokens, defaults filled in for unspecified ids. */
  resolved(): Readonly<Record<OperatorTokenId, string | number>>;
  /** Apply the merged tokens onto a host element as CSS custom properties. */
  apply(target: ThemeTargetElement): void;
}

export function createThemeProvider(overrides?: OperatorThemeTokens): ThemeProvider {
  const merged: Record<OperatorTokenId, string | number> = { ...DEFAULT_OPERATOR_TOKENS };
  if (overrides) {
    for (const [id, value] of Object.entries(overrides) as ReadonlyArray<[OperatorTokenId, string | number]>) {
      if (value !== undefined) merged[id] = value;
    }
  }
  return {
    resolved: () => merged,
    apply(target: ThemeTargetElement): void {
      for (const [id, value] of Object.entries(merged) as ReadonlyArray<[OperatorTokenId, string | number]>) {
        target.style.setProperty(tokenIdToCssVariable(id), String(value));
      }
    },
  };
}
