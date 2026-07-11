import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  discoverMarkdownFiles,
  extractSnippets,
  validateSnippetImports,
  validateSnippets,
} from "../../scripts/docs-snippets.mjs";

const packageJson = { exports: { ".": {}, "./map": {}, "./react": {} }, name: "@honua/sdk-js" };
const exportedSymbols = new Map([
  [".", new Set(["connect"])],
  ["./map", new Set(["mountMap"])],
  ["./react", new Set(["HonuaMap"])],
]);

test("discovers Markdown deterministically while excluding generated trees", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "honua-docs-"));
  fs.mkdirSync(path.join(root, "docs", "generated"), { recursive: true });
  fs.writeFileSync(path.join(root, "README.md"), "# Readme\n");
  fs.writeFileSync(path.join(root, "docs", "z.md"), "# Z\n");
  fs.writeFileSync(path.join(root, "docs", "a.md"), "# A\n");
  fs.writeFileSync(path.join(root, "docs", "generated", "ignored.md"), "# Generated\n");
  assert.deepEqual(discoverMarkdownFiles(root, ["README.md", "docs"]), ["README.md", "docs/a.md", "docs/z.md"]);
});

test("extracts supported fences with source traceability", () => {
  const snippets = extractSnippets(
    ["text", "```ts", 'import { connect } from "@honua/sdk-js";', "```", "", "~~~javascript", "const x = 1;", "~~~"].join(
      "\n",
    ),
    "docs/start.md",
  );
  assert.deepEqual(
    snippets.map(({ directive, language, location }) => ({ directive, language, location })),
    [
      { directive: "compile", language: "ts", location: "docs/start.md:2" },
      { directive: "compile", language: "javascript", location: "docs/start.md:6" },
    ],
  );
});

test("requires a reason for skipped pseudocode", () => {
  assert.throws(() => extractSnippets("```ts doc-test=skip\nnot code\n```", "docs/pseudo.md"), /requires a non-empty reason/);
  const [snippet] = extractSnippets(
    '```ts doc-test=skip reason="abbreviated pseudocode"\nnot code\n```',
    "docs/pseudo.md",
  );
  assert.equal(snippet.directive, "skip");
});

test("reports invalid syntax with the Markdown location", () => {
  const snippets = extractSnippets("```ts\nconst value: = 1\n```", "docs/broken.md");
  assert.throws(() => validateSnippets({ files: [{ snippets }], packageJson, exportedSymbols }), /docs\/broken\.md:1/);
});

test("rejects stale package paths and public symbols", () => {
  const [stalePath] = extractSnippets(
    '```ts\nimport { connect } from "@honua/sdk-js/missing";\n```',
    "docs/path.md",
  );
  const [staleSymbol] = extractSnippets(
    '```ts\nimport { oldMount } from "@honua/sdk-js/map";\n```',
    "docs/symbol.md",
  );
  assert.deepEqual(validateSnippetImports(stalePath, packageJson, exportedSymbols), [
    "docs/path.md:1: package path @honua/sdk-js/missing is not exported",
  ]);
  assert.deepEqual(validateSnippetImports(staleSymbol, packageJson, exportedSymbols), [
    "docs/symbol.md:1: @honua/sdk-js/map has no exported member oldMount",
  ]);
});

test("accepts valid self-package imports and ignores external packages", () => {
  const snippets = extractSnippets(
    [
      "```ts",
      'import { connect } from "@honua/sdk-js";',
      'import { mountMap } from "@honua/sdk-js/map";',
      'import { HonuaMap } from "@honua/react";',
      'import maplibregl from "maplibre-gl";',
      "void connect; void mountMap; void HonuaMap; void maplibregl;",
      "```",
    ].join("\n"),
    "docs/valid.md",
  );
  assert.deepEqual(validateSnippets({ files: [{ snippets }], packageJson, exportedSymbols }), {
    compiled: 1,
    files: 1,
    skipped: 0,
  });
});
