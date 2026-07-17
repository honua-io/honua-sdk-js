import { describe, expect, it, vi } from "vitest";

import { OGC_CAPABILITIES_XML_LIMITS, parseCapabilitiesXml } from "../src/core/capabilities-xml.js";

describe("bounded capabilities XML", () => {
  it("retains namespace-local names, attributes, entities, and in-root CDATA", () => {
    const root = parseCapabilitiesXml(
      `<ows:Capabilities xmlns:ows="urn:ogc" xmlns:xlink="urn:xlink" version="1.0.0">
        <ows:Title xlink:role="label">Honua &amp; <![CDATA[terrain <maps>]]></ows:Title>
      </ows:Capabilities>`,
      "WMTS",
    );

    expect(root.localName).toBe("Capabilities");
    expect(root.attributes.version).toBe("1.0.0");
    expect(root.children[0]).toMatchObject({
      name: "ows:Title",
      localName: "Title",
      attributes: { "xlink:role": "label", role: "label" },
      text: "Honua & terrain <maps>",
    });
  });

  it.each([
    ["CDATA before", "<![CDATA[before]]><root/>"],
    ["empty CDATA before", "<![CDATA[]]><root/>"],
    ["CDATA after", "<root/><![CDATA[after]]>"],
    ["whitespace CDATA after", "<root/><![CDATA[ \n]]>"],
  ])("rejects %s the single document root", (_name, xml) => {
    expect(() => parseCapabilitiesXml(xml, "WMS")).toThrow(/CDATA outside its root element/u);
  });

  it.each([
    ["non-XML whitespace before", "\u00a0<root/>"],
    ["non-XML whitespace after", "<root/>\u00a0"],
    ["ordinary text before", "outside<root/>"],
    ["ordinary text after", "<root/>outside"],
  ])("rejects %s the single document root", (_name, xml) => {
    expect(() => parseCapabilitiesXml(xml, "WMS")).toThrow(/text outside its root element/u);
  });

  it.each([
    ["leading tag whitespace", "< root/>"],
    ["whitespace after the empty-element slash", "<root/ >"],
    ["attributes without XML whitespace", '<root first="1"second="2"/>'],
  ])("rejects malformed tag syntax: %s", (_name, xml) => {
    expect(() => parseCapabilitiesXml(xml, "WMS")).toThrow();
  });

  it.each([
    ["multi-colon element", "<a:b:c/>"],
    ["empty element local name", "<a:/>"],
    ["multi-colon attribute", '<root a:b:c="value"/>'],
    ["empty attribute local name", '<root a:="value"/>'],
  ])("rejects an invalid QName: %s", (_name, xml) => {
    expect(() => parseCapabilitiesXml(xml, "WMS")).toThrow(/invalid (?:element|attribute) name/u);
  });

  it("does not misclassify an xmlns-prefixed ordinary attribute as a namespace declaration", () => {
    expect(() =>
      parseCapabilitiesXml('<root xmlns:a="urn:a" xmlnsfoo="first" a:xmlnsfoo="namespace-local collision"/>', "WMS"),
    ).toThrow(/repeats namespace-local attribute "xmlnsfoo"/u);
  });

  it("applies the depth ceiling to self-closing elements", () => {
    const wrappers = OGC_CAPABILITIES_XML_LIMITS.maxDepth;
    const opening = "<node>".repeat(wrappers);
    const closing = "</node>".repeat(wrappers);

    expect(() => parseCapabilitiesXml(`${opening}${closing}`, "WMS")).not.toThrow();
    expect(() => parseCapabilitiesXml(`${opening}<leaf/>${closing}`, "WMS")).toThrow(
      new RegExp(`${OGC_CAPABILITIES_XML_LIMITS.maxDepth}-level XML limit`, "u"),
    );
  });

  it("retains the element, attribute-count, attribute-byte, text-byte, and document-byte ceilings", () => {
    const tooManyElements = `<root>${"<node/>".repeat(OGC_CAPABILITIES_XML_LIMITS.maxElements)}</root>`;
    expect(() => parseCapabilitiesXml(tooManyElements, "WMS")).toThrow(/element limit/u);

    const tooManyAttributes = Array.from(
      { length: OGC_CAPABILITIES_XML_LIMITS.maxAttributesPerElement + 1 },
      (_, index) => `a${index}=""`,
    ).join(" ");
    expect(() => parseCapabilitiesXml(`<root ${tooManyAttributes}/>`, "WMS")).toThrow(/attribute count/u);

    const oversizedAttribute = "x".repeat(OGC_CAPABILITIES_XML_LIMITS.maxAttributeBytes + 1);
    expect(() => parseCapabilitiesXml(`<root value="${oversizedAttribute}"/>`, "WMS")).toThrow(/bounded value limit/u);

    const oversizedText = "x".repeat(OGC_CAPABILITIES_XML_LIMITS.maxTextBytes + 1);
    expect(() => parseCapabilitiesXml(`<root>${oversizedText}</root>`, "WMS")).toThrow(/bounded text limit/u);

    const textFragment = "x".repeat(1_024);
    const fragmentedOversizedText = `<root>${`${textFragment}<node/>`.repeat(
      OGC_CAPABILITIES_XML_LIMITS.maxTextBytes / textFragment.length + 1,
    )}</root>`;
    expect(() => parseCapabilitiesXml(fragmentedOversizedText, "WMS")).toThrow(/bounded text limit/u);

    const multibyteDocument = `<root>${"é".repeat(OGC_CAPABILITIES_XML_LIMITS.maxBytes / 2)}</root>`;
    expect(multibyteDocument.length).toBeLessThan(OGC_CAPABILITIES_XML_LIMITS.maxBytes);
    expect(() => parseCapabilitiesXml(multibyteDocument, "WMS")).toThrow(/byte XML limit/u);
  });

  it.each([
    ["DOCTYPE", '<!DOCTYPE root [<!ENTITY value "unsafe">]><root/>'],
    ["custom entity", "<root>&custom;</root>"],
    ["forbidden numeric entity", "<root>&#0;</root>"],
    ["unterminated entity", "<root>&amp</root>"],
  ])("rejects hostile entity input: %s", (_name, xml) => {
    expect(() => parseCapabilitiesXml(xml, "WMS")).toThrow(/DOCTYPE|ENTITY|entity/u);
  });

  it("accounts for fragmented cumulative text in linear input volume", () => {
    const NativeTextEncoder = globalThis.TextEncoder;
    const nativeEncoder = new NativeTextEncoder();
    let encodedCodeUnits = 0;
    class CountingTextEncoder {
      public encode(value = ""): Uint8Array {
        encodedCodeUnits += value.length;
        return nativeEncoder.encode(value);
      }
    }
    vi.stubGlobal("TextEncoder", CountingTextEncoder);
    try {
      const fragment = "x".repeat(32);
      const fragments = 2_000;
      const xml = `<root>${`${fragment}<node/>`.repeat(fragments)}</root>`;
      const root = parseCapabilitiesXml(xml, "WMS");

      expect(root.text).toBe(fragment.repeat(fragments));
      expect(encodedCodeUnits).toBeLessThanOrEqual(xml.length * 2);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
