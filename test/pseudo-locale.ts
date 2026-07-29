/** Deterministic pseudo-locale used by component qualification tests. */

const ACCENTS: Readonly<Record<string, string>> = Object.freeze({
  a: "ȧ",
  e: "ḗ",
  i: "ī",
  o: "õ",
  u: "ū",
  A: "Ȧ",
  E: "Ḗ",
  I: "Ī",
  O: "Õ",
  U: "Ū",
});

export const PSEUDO_LOCALE_MIN_EXPANSION = 1.35;

/**
 * Expand a string in a stable, visibly accented pseudo-locale.
 *
 * The padding is intentional: a short label such as "Map" must exercise the
 * same growth pressure as a longer translated sentence. It contains no
 * randomness or environment-dependent locale APIs, so snapshots and CI runs
 * receive the same input every time.
 */
export function pseudoLocale(value: string): string {
  const accented = Array.from(value, (character) => ACCENTS[character] ?? character).join("");
  const minimumLength = Math.ceil(Array.from(value).length * PSEUDO_LOCALE_MIN_EXPANSION);
  const padding = "·".repeat(Math.max(0, minimumLength - Array.from(accented).length));
  return `⟦${accented}${padding}⟧`;
}

export function pseudoLocaleExpansion(value: string): number {
  return Array.from(pseudoLocale(value)).length / Math.max(1, Array.from(value).length);
}

/** Assert that a rendered pseudo-localized label survived the DOM unchanged. */
export function assertPseudoLabelPreserved(root: ShadowRoot, expected: string): void {
  // jsdom has no layout engine. This assertion therefore proves the rendered
  // path did not shorten the label in markup/ARIA (including an ellipsis),
  // while a browser lane can add physical clientWidth/scrollWidth evidence.
  const html = root.innerHTML;
  if (!html.includes(expected)) {
    throw new Error(`pseudo-localized label was not rendered: ${expected}`);
  }
  if (html.includes("…") || html.includes("...")) {
    throw new Error("rendered component contains an ellipsis/truncated label");
  }
}
