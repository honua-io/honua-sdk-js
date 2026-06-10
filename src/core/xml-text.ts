/**
 * Single-pass XML text decoding used by the WMS/WMTS capabilities parsers.
 *
 * Decoding XML entities with a chain of independent `String.prototype.replace`
 * calls is unsafe: an earlier substitution (for example `&amp;` -> `&`) can
 * synthesize characters that a later substitution then re-interprets, causing
 * double-unescaping (CodeQL `js/double-escaping`). Walking the input exactly
 * once and emitting each decoded character directly avoids that class of bug —
 * a `&` produced by decoding `&amp;` is final and never re-scanned.
 */

const NAMED_ENTITIES: Record<string, string> = {
  lt: "<",
  gt: ">",
  amp: "&",
  apos: "'",
  quot: '"',
};

const CDATA_OPEN = "<![CDATA[";
const CDATA_CLOSE = "]]>";

/**
 * Decode XML character data in a single forward pass.
 *
 * Handles `<![CDATA[…]]>` sections (emitted verbatim), the five predefined
 * named entities (`&lt;`, `&gt;`, `&amp;`, `&apos;`, `&quot;`), and numeric
 * character references (`&#1234;` / `&#x1F4A9;`). Any `&` that does not begin
 * a recognized reference is emitted literally.
 */
export function decodeXmlText(text: string): string {
  let result = "";
  let i = 0;
  const length = text.length;

  while (i < length) {
    const char = text[i];

    if (char === "<" && text.startsWith(CDATA_OPEN, i)) {
      const end = text.indexOf(CDATA_CLOSE, i + CDATA_OPEN.length);
      if (end < 0) {
        // Unterminated CDATA: emit the remainder verbatim.
        result += text.slice(i + CDATA_OPEN.length);
        break;
      }
      result += text.slice(i + CDATA_OPEN.length, end);
      i = end + CDATA_CLOSE.length;
      continue;
    }

    if (char === "&") {
      const semicolon = text.indexOf(";", i + 1);
      if (semicolon > i) {
        const entity = text.slice(i + 1, semicolon);
        const decoded = decodeEntity(entity);
        if (decoded !== undefined) {
          result += decoded;
          i = semicolon + 1;
          continue;
        }
      }
    }

    result += char;
    i += 1;
  }

  return result;
}

function decodeEntity(entity: string): string | undefined {
  const named = NAMED_ENTITIES[entity];
  if (named !== undefined) {
    return named;
  }

  if (entity.length >= 2 && entity.charCodeAt(0) === 35 /* '#' */) {
    const isHex = entity.charCodeAt(1) === 120 /* 'x' */ || entity.charCodeAt(1) === 88 /* 'X' */;
    const digits = isHex ? entity.slice(2) : entity.slice(1);
    if (digits === "") {
      return undefined;
    }
    const codePoint = isHex ? Number.parseInt(digits, 16) : Number.parseInt(digits, 10);
    if (Number.isNaN(codePoint) || codePoint < 0 || codePoint > 0x10ffff) {
      return undefined;
    }
    try {
      return String.fromCodePoint(codePoint);
    } catch {
      return undefined;
    }
  }

  return undefined;
}
