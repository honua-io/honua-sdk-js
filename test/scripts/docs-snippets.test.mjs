import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  discoverMarkdownFiles,
  extractSnippets,
  validateSnippetWithCompiler,
  validateSnippets,
} from "../../scripts/docs-snippets.mjs";

function fixtureProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "honua-docs-"));
  fs.mkdirSync(path.join(root, "dist"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({
      exports: { ".": { types: "./dist/index.d.ts", default: "./dist/index.js" } },
      name: "@honua/sdk-js",
      type: "module",
    }),
  );
  fs.writeFileSync(
    path.join(root, "tsconfig.json"),
    JSON.stringify({ compilerOptions: { module: "NodeNext", moduleResolution: "NodeNext", strict: true, target: "ES2022" } }),
  );
  fs.writeFileSync(path.join(root, "dist", "api.d.ts"), "export declare function takesCount(value: number): void;\n");
  fs.writeFileSync(path.join(root, "dist", "tools.d.ts"), "export declare function run(): void;\n");
  fs.writeFileSync(
    path.join(root, "dist", "index.d.ts"),
    'export { takesCount } from "./api.js";\nexport * as tools from "./tools.js";\n',
  );
  fs.writeFileSync(path.join(root, "dist", "index.js"), "export {};\n");
  return root;
}

function snippet(markdown, sourcePath = "docs/example.md") {
  return extractSnippets(markdown, sourcePath)[0];
}

test("discovers Markdown deterministically while excluding generated trees", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "honua-docs-"));
  fs.mkdirSync(path.join(root, "docs", "generated"), { recursive: true });
  fs.writeFileSync(path.join(root, "README.md"), "# Readme\n");
  fs.writeFileSync(path.join(root, "docs", "z.md"), "# Z\n");
  fs.writeFileSync(path.join(root, "docs", "a.md"), "# A\n");
  fs.writeFileSync(path.join(root, "docs", "generated", "ignored.md"), "# Generated\n");
  assert.deepEqual(discoverMarkdownFiles(root, ["README.md", "docs"]), ["README.md", "docs/a.md", "docs/z.md"]);
});

test("accepts CommonMark fences indented up to three spaces and inside blockquotes", () => {
  const snippets = extractSnippets(
    [
      "   ```ts doc-test=compile",
      "   const direct: number = 1;",
      "   ```",
      "> ```typescript doc-test=compile",
      "> const quoted: number = 2;",
      "> ```",
    ].join("\n"),
    "docs/start.md",
  );
  assert.deepEqual(
    snippets.map(({ code, location }) => ({ code, location })),
    [
      { code: "   const direct: number = 1;", location: "docs/start.md:1" },
      { code: "const quoted: number = 2;", location: "docs/start.md:4" },
    ],
  );
});

test("does not treat a four-space indented fence as a fenced code block", () => {
  assert.deepEqual(extractSnippets("    ```ts doc-test=compile\n    const value = 1;\n    ```", "docs/indented.md"), []);
});

test("requires exactly one known directive and a quoted nonempty skip reason", () => {
  assert.throws(() => extractSnippets("```ts\nconst x = 1;\n```", "docs/missing.md"), /exactly one/);
  assert.throws(
    () => extractSnippets("```ts doc-test=compile doc-test=skip reason=\"x\"\nconst x = 1;\n```", "docs/duplicate.md"),
    /exactly one/,
  );
  assert.throws(
    () => extractSnippets("```ts doc-test=ignore\nconst x = 1;\n```", "docs/unknown.md"),
    /unknown doc-test directive/,
  );
  assert.throws(
    () => extractSnippets("```ts doc-test=skip reason=pseudocode\nnot code\n```", "docs/unquoted.md"),
    /reason must use a quoted value/,
  );
  assert.throws(
    () => extractSnippets('```ts doc-test=skip reason=""\nnot code\n```', "docs/empty.md"),
    /reason must not be empty/,
  );
  assert.throws(
    () =>
      extractSnippets(
        '```ts doc-test=skip reason="first" reason="second"\nnot code\n```',
        "docs/duplicate-reason.md",
      ),
    /duplicate reason attribute/,
  );
  assert.throws(
    () => extractSnippets("```ts doc-test=compile prelude=docs/host.d.ts\nvoid 0;\n```", "docs/unquoted-prelude.md"),
    /prelude must use a quoted value/,
  );
  assert.equal(
    snippet('```ts doc-test=skip reason="historical API"\nnot code\n```').directive,
    "skip",
  );
});

test("strict compiler rejects invalid assignments and SDK call arguments", () => {
  const root = fixtureProject();
  const assignment = snippet('```ts doc-test=compile\nconst count: number = "one";\n```', "docs/assignment.md");
  const sdkArgument = snippet(
    '```ts doc-test=compile\nimport { takesCount } from "@honua/sdk-js";\ntakesCount("one");\n```',
    "docs/sdk-argument.md",
  );
  assert.match(validateSnippetWithCompiler(assignment, root).join("\n"), /Type 'string' is not assignable to type 'number'/);
  assert.match(validateSnippetWithCompiler(sdkArgument, root).join("\n"), /not assignable to parameter of type 'number'/);
});

test("compiler catches missing re-exports, dynamic imports, and namespace members", () => {
  const root = fixtureProject();
  const cases = [
    snippet(
      '```ts doc-test=compile\nexport { missing } from "@honua/sdk-js";\n```',
      "docs/re-export.md",
    ),
    snippet(
      '```ts doc-test=compile\nconst sdk = await import("@honua/sdk-js");\nsdk.missing();\n```',
      "docs/dynamic.md",
    ),
    snippet(
      '```ts doc-test=compile\nimport * as sdk from "@honua/sdk-js";\nsdk.tools.missing();\n```',
      "docs/namespace.md",
    ),
  ];
  for (const candidate of cases) {
    assert.match(validateSnippetWithCompiler(candidate, root).join("\n"), /missing|no exported member/);
  }
});

test("supports an explicit repository prelude without allowing path traversal", () => {
  const root = fixtureProject();
  fs.mkdirSync(path.join(root, "docs"), { recursive: true });
  fs.writeFileSync(path.join(root, "docs", "browser-prelude.d.ts"), "declare const element: HTMLElement;\n");
  const withPrelude = snippet(
    '```ts doc-test=compile prelude="docs/browser-prelude.d.ts"\nelement.focus();\n```',
    "docs/browser.md",
  );
  assert.deepEqual(validateSnippetWithCompiler(withPrelude, root), []);
  const traversal = snippet(
    '```ts doc-test=compile prelude="../secret.ts"\nvoid 0;\n```',
    "docs/traversal.md",
  );
  assert.throws(() => validateSnippetWithCompiler(traversal, root), /without \.\. segments/);
});

test("validates a complete snippet collection", () => {
  const root = fixtureProject();
  const snippets = [
    snippet(
      '```ts doc-test=compile\nimport { takesCount, tools } from "@honua/sdk-js";\ntakesCount(1);\ntools.run();\n```',
    ),
    snippet('```ts doc-test=skip reason="historical API"\nnot code\n```'),
  ];
  assert.deepEqual(validateSnippets({ files: [{ snippets }], projectRoot: root }), {
    compiled: 1,
    files: 1,
    skipped: 1,
  });
});
