/**
 * Bounded XML tree used by the WMS/WMTS capabilities readers.
 *
 * This is deliberately not a general XML implementation. It accepts the XML
 * 1.0 subset used by OGC service metadata, matches namespace-qualified names
 * by their local suffix, and rejects declarations that could introduce
 * external entities. Every allocation is covered by a small fixed budget so a
 * capabilities response cannot turn metadata discovery into an unbounded
 * parser workload.
 *
 * @internal
 */

import { decodeXmlText } from "./xml-text.js";

export const OGC_CAPABILITIES_XML_LIMITS = Object.freeze({
  maxBytes: 2 * 1024 * 1024,
  maxElements: 12_000,
  maxDepth: 32,
  maxAttributesPerElement: 64,
  maxAttributeBytes: 64 * 1024,
  maxTextBytes: 512 * 1024,
});

export interface CapabilitiesXmlElement {
  readonly name: string;
  readonly localName: string;
  readonly attributes: Readonly<Record<string, string>>;
  readonly children: readonly CapabilitiesXmlElement[];
  readonly text: string;
}

interface MutableCapabilitiesXmlElement {
  name: string;
  localName: string;
  attributes: Record<string, string>;
  children: MutableCapabilitiesXmlElement[];
  text: string;
}

export function parseCapabilitiesXml(xml: string, family: "WMS" | "WMTS"): CapabilitiesXmlElement {
  if (typeof xml !== "string" || xml.length === 0) throw new Error(`${family} Capabilities body is empty`);
  if (utf8Length(xml) > OGC_CAPABILITIES_XML_LIMITS.maxBytes) {
    throw new Error(`${family} Capabilities exceeds the ${OGC_CAPABILITIES_XML_LIMITS.maxBytes}-byte XML limit`);
  }
  const declarationProbe = xml.toLowerCase();
  if (declarationProbe.includes("<!doctype") || declarationProbe.includes("<!entity")) {
    throw new Error(`${family} Capabilities rejects DOCTYPE and ENTITY declarations`);
  }

  let cursor = xml.charCodeAt(0) === 0xfeff ? 1 : 0;
  let root: MutableCapabilitiesXmlElement | undefined;
  const stack: MutableCapabilitiesXmlElement[] = [];
  let elements = 0;

  while (cursor < xml.length) {
    const angle = xml.indexOf("<", cursor);
    if (angle < 0) {
      appendText(stack.at(-1), xml.slice(cursor), family);
      cursor = xml.length;
      break;
    }
    appendText(stack.at(-1), xml.slice(cursor, angle), family);
    if (xml.startsWith("<!--", angle)) {
      const end = xml.indexOf("-->", angle + 4);
      if (end < 0) throw new Error(`${family} Capabilities contains an unterminated comment`);
      cursor = end + 3;
      continue;
    }
    if (xml.startsWith("<![CDATA[", angle)) {
      const end = xml.indexOf("]]>", angle + 9);
      if (end < 0) throw new Error(`${family} Capabilities contains unterminated CDATA`);
      appendDecodedText(stack.at(-1), xml.slice(angle + 9, end), family);
      cursor = end + 3;
      continue;
    }
    if (xml.startsWith("<?", angle)) {
      const end = xml.indexOf("?>", angle + 2);
      if (end < 0) throw new Error(`${family} Capabilities contains an unterminated processing instruction`);
      cursor = end + 2;
      continue;
    }
    if (xml.startsWith("<!", angle)) {
      throw new Error(`${family} Capabilities contains an unsupported XML declaration`);
    }

    const close = findTagEnd(xml, angle);
    if (close < 0) throw new Error(`${family} Capabilities contains an unterminated tag`);
    const closing = xml.charCodeAt(angle + 1) === 47;
    const raw = xml.slice(angle + (closing ? 2 : 1), close).trim();
    if (closing) {
      const expected = stack.at(-1);
      if (!expected || raw !== expected.name) {
        throw new Error(
          `${family} Capabilities has mismatched closing tag </${raw}>${expected ? `; expected </${expected.name}>` : ""}`,
        );
      }
      stack.pop();
      cursor = close + 1;
      continue;
    }

    const selfClosing = raw.endsWith("/");
    const body = selfClosing ? raw.slice(0, -1).trim() : raw;
    const { name, attributes } = parseOpeningTag(body, family);
    elements += 1;
    if (elements > OGC_CAPABILITIES_XML_LIMITS.maxElements) {
      throw new Error(`${family} Capabilities exceeds the ${OGC_CAPABILITIES_XML_LIMITS.maxElements}-element limit`);
    }
    if (!selfClosing && stack.length + 1 > OGC_CAPABILITIES_XML_LIMITS.maxDepth) {
      throw new Error(`${family} Capabilities exceeds the ${OGC_CAPABILITIES_XML_LIMITS.maxDepth}-level XML limit`);
    }
    const node: MutableCapabilitiesXmlElement = {
      name,
      localName: localName(name),
      attributes,
      children: [],
      text: "",
    };
    const parent = stack.at(-1);
    if (parent) parent.children.push(node);
    else if (root) throw new Error(`${family} Capabilities contains multiple root elements`);
    else root = node;
    if (!selfClosing) stack.push(node);
    cursor = close + 1;
  }

  if (stack.length > 0) {
    throw new Error(`${family} Capabilities contains an unclosed <${stack.at(-1)!.name}> element`);
  }
  if (!root) throw new Error(`${family} Capabilities contains no root element`);
  return freezeElement(root);
}

export function xmlChild(
  node: CapabilitiesXmlElement | undefined,
  localName: string,
): CapabilitiesXmlElement | undefined {
  return node?.children.find((child) => child.localName === localName);
}

export function xmlChildren(
  node: CapabilitiesXmlElement | undefined,
  localName: string,
): readonly CapabilitiesXmlElement[] {
  return node?.children.filter((child) => child.localName === localName) ?? [];
}

export function xmlAttribute(node: CapabilitiesXmlElement, name: string): string | undefined {
  return node.attributes[name] ?? node.attributes[localName(name)];
}

export function xmlText(node: CapabilitiesXmlElement | undefined): string | undefined {
  if (!node) return undefined;
  const value = node.text.trim();
  return value.length > 0 ? value : undefined;
}

function appendText(node: MutableCapabilitiesXmlElement | undefined, value: string, family: string): void {
  if (!node || value.length === 0) return;
  appendDecodedText(node, decodeXmlText(value), family);
}

function appendDecodedText(node: MutableCapabilitiesXmlElement | undefined, value: string, family: string): void {
  if (!node || value.length === 0) return;
  if (utf8Length(node.text) + utf8Length(value) > OGC_CAPABILITIES_XML_LIMITS.maxTextBytes) {
    throw new Error(`${family} Capabilities element text exceeds the bounded text limit`);
  }
  node.text += value;
}

function parseOpeningTag(body: string, family: string): { name: string; attributes: Record<string, string> } {
  let cursor = 0;
  while (cursor < body.length && !isWhitespace(body.charCodeAt(cursor))) cursor += 1;
  const name = body.slice(0, cursor);
  if (!validXmlName(name)) throw new Error(`${family} Capabilities contains an invalid element name`);
  const attributes: Record<string, string> = Object.create(null) as Record<string, string>;
  let count = 0;
  while (cursor < body.length) {
    while (cursor < body.length && isWhitespace(body.charCodeAt(cursor))) cursor += 1;
    if (cursor >= body.length) break;
    const nameStart = cursor;
    while (cursor < body.length && !isWhitespace(body.charCodeAt(cursor)) && body[cursor] !== "=") cursor += 1;
    const attributeName = body.slice(nameStart, cursor);
    if (!validXmlName(attributeName)) throw new Error(`${family} Capabilities contains an invalid attribute name`);
    while (cursor < body.length && isWhitespace(body.charCodeAt(cursor))) cursor += 1;
    if (body[cursor] !== "=") throw new Error(`${family} Capabilities attribute "${attributeName}" lacks '='`);
    cursor += 1;
    while (cursor < body.length && isWhitespace(body.charCodeAt(cursor))) cursor += 1;
    const quote = body[cursor];
    if (quote !== '"' && quote !== "'") {
      throw new Error(`${family} Capabilities attribute "${attributeName}" must be quoted`);
    }
    const end = body.indexOf(quote, cursor + 1);
    if (end < 0) throw new Error(`${family} Capabilities attribute "${attributeName}" is unterminated`);
    const value = decodeXmlText(body.slice(cursor + 1, end));
    if (utf8Length(value) > OGC_CAPABILITIES_XML_LIMITS.maxAttributeBytes) {
      throw new Error(`${family} Capabilities attribute "${attributeName}" exceeds the bounded value limit`);
    }
    if (Object.hasOwn(attributes, attributeName)) {
      throw new Error(`${family} Capabilities repeats attribute "${attributeName}"`);
    }
    attributes[attributeName] = value;
    const local = localName(attributeName);
    if (!attributeName.startsWith("xmlns") && !Object.hasOwn(attributes, local)) attributes[local] = value;
    count += 1;
    if (count > OGC_CAPABILITIES_XML_LIMITS.maxAttributesPerElement) {
      throw new Error(`${family} Capabilities element exceeds the bounded attribute count`);
    }
    cursor = end + 1;
  }
  return { name, attributes };
}

function findTagEnd(xml: string, start: number): number {
  let quote: '"' | "'" | undefined;
  for (let cursor = start + 1; cursor < xml.length; cursor += 1) {
    const value = xml[cursor];
    if (quote) {
      if (value === quote) quote = undefined;
    } else if (value === '"' || value === "'") quote = value;
    else if (value === ">") return cursor;
  }
  return -1;
}

function validXmlName(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_.:-]*$/.test(value);
}

function localName(value: string): string {
  const separator = value.indexOf(":");
  return separator < 0 ? value : value.slice(separator + 1);
}

function isWhitespace(value: number): boolean {
  return value === 32 || value === 9 || value === 10 || value === 13;
}

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function freezeElement(node: MutableCapabilitiesXmlElement): CapabilitiesXmlElement {
  const children = Object.freeze(node.children.map(freezeElement));
  return Object.freeze({
    name: node.name,
    localName: node.localName,
    attributes: Object.freeze({ ...node.attributes }),
    children,
    text: node.text,
  });
}
