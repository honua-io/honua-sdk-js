const ACCENTS = new Map([
  ["a", "á"],
  ["e", "ë"],
  ["i", "ï"],
  ["o", "ö"],
  ["u", "ü"],
  ["A", "Á"],
  ["E", "Ë"],
  ["I", "Ï"],
  ["O", "Ö"],
  ["U", "Ü"],
]);

function graphemes(value) {
  if (typeof Intl.Segmenter === "function") {
    return [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(value)].map((part) => part.segment);
  }
  return [...value];
}

/**
 * Expands a string by at least 35% while retaining readable accented text.
 * The transformation is deterministic and leaves whitespace in place so it
 * can safely be applied to text nodes and accessible-name attributes.
 */
export function pseudoLocalize(value) {
  if (!value.trim()) return value;
  const expanded = [...value].map((character) => ACCENTS.get(character) ?? character).join("");
  const targetLength = Math.ceil(graphemes(value).length * 1.35);
  const padding = "·".repeat(Math.max(0, targetLength - graphemes(expanded).length));
  return `［${expanded}${padding}］`;
}

export function expansionRatio(original, localized) {
  const sourceLength = graphemes(original).length;
  const localizedLength = graphemes(localized).length - 2;
  return sourceLength === 0 ? 1 : localizedLength / sourceLength;
}

