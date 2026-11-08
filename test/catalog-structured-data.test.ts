// @vitest-environment jsdom

import { afterEach, expect, it } from "vitest";
import { contributeCatalogStructuredData } from "../src/catalog-components/structured-data.js";

afterEach(() => document.head.replaceChildren());

it("merges subject contributions and removes only the disconnected contributor", () => {
  const projection = {
    "@context": { schema: "https://schema.org/", dcat: "http://www.w3.org/ns/dcat#" },
    "@graph": [{ "@id": "https://catalog.example/datasets/1", "schema:name": "Rivers" }],
  };
  const releaseFirst = contributeCatalogStructuredData(document, {}, projection);
  const releaseSecond = contributeCatalogStructuredData(document, {}, projection);
  const read = () =>
    JSON.parse(document.querySelector("script[data-honua-catalog-structured-data]")?.textContent ?? "null");
  expect(read()["@graph"]).toHaveLength(1);
  releaseFirst();
  expect(read()["@graph"]).toHaveLength(1);
  releaseSecond();
  expect(read()).toBeNull();
});

it("serializes hostile strings as inert text and preserves server-owned data blocks", () => {
  const serverBlock = document.createElement("script");
  serverBlock.type = "application/ld+json";
  serverBlock.textContent = '{"@id":"https://catalog.example/server"}';
  document.head.append(serverBlock);
  const clear = contributeCatalogStructuredData(
    document,
    {},
    {
      "@context": { schema: "https://schema.org/" },
      "@graph": [{ "@id": "https://catalog.example/1", "schema:name": "</script><img src=x>" }],
    },
  );
  const block = document.querySelector("script[data-honua-catalog-structured-data]");
  expect(block?.textContent).not.toContain("<");
  expect(JSON.parse(block?.textContent ?? "null")["@graph"][0]["schema:name"]).toBe("</script><img src=x>");
  expect(document.querySelector("img")).toBeNull();
  clear();
  expect(document.head.contains(serverBlock)).toBe(true);
});
