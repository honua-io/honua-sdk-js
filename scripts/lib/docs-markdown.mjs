import { isMap, parseDocument } from "yaml";

export function markdownBody(source) {
  const openingBlock = /^\uFEFF?---[\t ]*\r?\n([\s\S]*?)\r?\n---[\t ]*(?:\r?\n|$)/u.exec(source);
  if (!openingBlock) return source;

  const metadata = parseDocument(openingBlock[1]);
  if (metadata.errors.length > 0 || !isMap(metadata.contents)) return source;
  return source.slice(openingBlock[0].length);
}
