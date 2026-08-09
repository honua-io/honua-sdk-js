import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { parseCapabilitiesXml } from "../src/core/capabilities-xml.js";

const xmlText = fc
  .array(fc.constantFrom("a", "Z", "0", " ", "\t", "\n", "<", ">", "&", '"', "'", "é", "🌊"), {
    maxLength: 512,
  })
  .map((characters) => characters.join(""));

describe("capabilities XML fuzzing", () => {
  it("round-trips arbitrary valid XML text through entity decoding", () => {
    fc.assert(
      fc.property(xmlText, (text) => {
        const xml = `<root>${encodeXmlText(text)}</root>`;
        expect(parseCapabilitiesXml(xml, "WMS").text).toBe(text);
      }),
      { numRuns: 1_000 },
    );
  });

  it("fails arbitrary untrusted documents with an Error or returns a frozen root", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 4_096 }), (xml) => {
        let root: ReturnType<typeof parseCapabilitiesXml>;

        try {
          root = parseCapabilitiesXml(xml, "WMTS");
        } catch (error) {
          expect(error).toBeInstanceOf(Error);
          return;
        }

        expect(Object.isFrozen(root)).toBe(true);
        expect(root.name.length).toBeGreaterThan(0);
      }),
      { numRuns: 1_000 },
    );
  });
});

function encodeXmlText(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
