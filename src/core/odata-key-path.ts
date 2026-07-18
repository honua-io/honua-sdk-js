/**
 * Encode an OData key predicate without hiding its structural grammar.
 *
 * Quotes plus the `,` / `=` delimiters outside quoted literals remain
 * visible to direct and JSON-batch OData parsers. Unsafe value characters
 * are percent-encoded by Unicode code point so non-BMP string keys remain
 * valid path data rather than splitting or truncating the target URL.
 *
 * @internal
 */
export function encodeOdataKeyPredicatePath(key: string | number): string {
  const raw = String(key);
  let output = "";
  let inQuote = false;
  for (const character of raw) {
    if (character === "'") {
      inQuote = !inQuote;
      output += "'";
      continue;
    }
    if (!inQuote && (character === "," || character === "=")) {
      output += character;
      continue;
    }
    output += /[A-Za-z0-9\-._~]/.test(character) ? character : encodeURIComponent(character);
  }
  return output;
}
