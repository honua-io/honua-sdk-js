import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  binFromManifest,
  binMap,
  checkDocumentedCommands,
  checkMarkdown,
  packageIndex,
  packageNameFromSpec,
  parseNpxInvocation,
  resolveNpxInvocation,
  shellCommands,
  tokenize,
} from "../../scripts/docs-executable-commands.mjs";

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");

/**
 * A throwaway checkout whose manifests are written by the test, so the expected
 * resolution is computed from the documented npm rule rather than read back out
 * of whatever this repository happens to publish today.
 */
function fixtureRoot(manifests, pages) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "honua-docs-commands-"));
  test.after(() => fs.rmSync(root, { force: true, recursive: true }));
  for (const [location, manifest] of Object.entries(manifests)) {
    const file = location === "." ? "package.json" : path.join("node_modules", ...location.split("/"), "package.json");
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), JSON.stringify(manifest));
  }
  for (const [file, content] of Object.entries(pages ?? {})) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), content);
  }
  return root;
}

const SDK_MANIFEST = {
  bin: { honua: "./dist/src/cli/bin.js", "honua-plugin-certify": "./dist/src/plugin/bin.js" },
  name: "@honua/sdk-js",
  version: "0.1.9-beta.0",
};

test("a package spec names its package, and a path or URL names none", () => {
  assert.equal(packageNameFromSpec("@honua/sdk-js"), "@honua/sdk-js");
  assert.equal(packageNameFromSpec("@honua/sdk-js@0.1.9-beta.0"), "@honua/sdk-js");
  assert.equal(packageNameFromSpec("vitest@^3"), "vitest");
  assert.equal(packageNameFromSpec("./local-cli"), undefined);
  assert.equal(packageNameFromSpec("https://example.com/pkg.tgz"), undefined);
  assert.equal(packageNameFromSpec("file:../tool"), undefined);
});

test("the bin shorthand is the package name without its scope", () => {
  assert.deepEqual(binMap({ bin: "./cli.js", name: "@honua/tool" }), { tool: "./cli.js" });
  assert.deepEqual(binMap({ name: "@honua/tool" }), {});
});

test("npm picks a bin exactly as libnpmexec does", () => {
  // One bin: taken whatever it is named. `@honua/honua-migrate` publishes only
  // `honua-js-migrate`, and `npx @honua/honua-migrate --help` really does run it.
  assert.equal(binFromManifest({ bin: { "honua-js-migrate": "./cli.js" }, name: "@honua/honua-migrate" }), "honua-js-migrate");
  // Two keys aliasing one file are still one executable.
  assert.equal(binFromManifest({ bin: { a: "./cli.js", b: "./cli.js" }, name: "tool" }), "a");
  // Two real bins, one named after the package: that one wins.
  assert.equal(binFromManifest({ bin: { other: "./b.js", tool: "./a.js" }, name: "@scope/tool" }), "tool");
  // Two real bins, neither named after the package: npm refuses. This is #1596.
  assert.equal(binFromManifest(SDK_MANIFEST), undefined);
  assert.equal(binFromManifest({ name: "no-bins" }), undefined);
});

test("quoting holds an argument together and a backslash escapes one character", () => {
  assert.deepEqual(tokenize(`npx -p @honua/sdk-js honua query "a b" 'c d'`), ["npx", "-p", "@honua/sdk-js", "honua", "query", "a b", "c d"]);
  assert.deepEqual(tokenize("npx tool --where a\\ b"), ["npx", "tool", "--where", "a b"]);
  assert.deepEqual(tokenize('npx tool --empty ""'), ["npx", "tool", "--empty", ""]);
});

test("a block yields the commands a reader would run, not the prose around them", () => {
  const commands = shellCommands(
    [
      "$ npm install --save-dev @honua/honua-migrate",
      "HONUA_BASE_URL=https://demo.honua.io npx -p @honua/sdk-js honua services",
      "npx tool \\",
      "  --report out.json",
      "curl https://example.com/a#fragment && npx other",
    ].join("\n"),
  );
  assert.deepEqual(
    commands.map((entry) => entry.tokens),
    [
      ["npm", "install", "--save-dev", "@honua/honua-migrate"],
      ["npx", "-p", "@honua/sdk-js", "honua", "services"],
      ["npx", "tool", "--report", "out.json"],
      ["curl", "https://example.com/a#fragment"],
      ["npx", "other"],
    ],
  );
  assert.ok(commands.every((entry) => entry.inComment === false));
});

test("a comment that offers a command offers it to the reader too", () => {
  const commands = shellCommands("npm i -g @honua/sdk-js   # or, without installing: npx -p @honua/sdk-js honua <command>");
  assert.deepEqual(commands[0].tokens, ["npm", "i", "-g", "@honua/sdk-js"]);
  assert.deepEqual(commands[1], { inComment: true, tokens: ["npx", "-p", "@honua/sdk-js", "honua", "<command>"] });
  // A comment with no command in it stays a comment.
  assert.deepEqual(shellCommands("npm ci   # install root deps").length, 1);
});

test("npx flags are separated from the package and the command", () => {
  assert.deepEqual(parseNpxInvocation(tokenize("npx --yes --package @honua/sdk-js honua services")), {
    packages: ["@honua/sdk-js"],
    positional: ["honua", "services"],
  });
  assert.deepEqual(parseNpxInvocation(tokenize("npx -y -p=@honua/sdk-js honua")), { packages: ["@honua/sdk-js"], positional: ["honua"] });
  // `--registry` consumes the token after it; the package is still the next positional.
  assert.deepEqual(parseNpxInvocation(tokenize("npx --registry https://registry.npmjs.org vitest run")), {
    packages: [],
    positional: ["vitest", "run"],
  });
  assert.deepEqual(parseNpxInvocation(tokenize("npx -p a -p b cmd")), { packages: ["a", "b"], positional: ["cmd"] });
});

test("the documented form in issue #1596 fails for the reason npm reports", () => {
  const index = packageIndex(fixtureRoot({ ".": SDK_MANIFEST }));
  const result = resolveNpxInvocation(parseNpxInvocation(tokenize("npx --yes @honua/sdk-js honua --help")), index);
  assert.equal(result.status, "failed");
  assert.match(result.reason, /cannot determine an executable/);
  assert.match(result.reason, /honua, honua-plugin-certify/);
  assert.equal(result.suggestion, "npx -p @honua/sdk-js honua");

  // And the corrected form resolves to the bin the documentation means.
  const corrected = resolveNpxInvocation(parseNpxInvocation(tokenize("npx -p @honua/sdk-js honua --help")), index);
  assert.deepEqual(corrected, { executable: "honua", package: "@honua/sdk-js", status: "ok" });
});

test("a bin name written where npx expects a package is a registry miss", () => {
  const index = packageIndex(fixtureRoot({ ".": SDK_MANIFEST }));
  const result = resolveNpxInvocation(parseNpxInvocation(tokenize("npx honua-plugin-certify --verify ./report.json")), index);
  assert.equal(result.status, "failed");
  assert.match(result.reason, /fetches its first argument as a package/);
  assert.equal(result.suggestion, "npx -p @honua/sdk-js honua-plugin-certify");

  // Unless the block installed the package that publishes it first.
  const installed = resolveNpxInvocation(parseNpxInvocation(tokenize("npx honua-plugin-certify")), index, {
    installedBins: new Set(["honua-plugin-certify"]),
  });
  assert.deepEqual(installed, { executable: "honua-plugin-certify", status: "ok", via: "local-install" });
});

test("a package that resolves swallows a bin name written after it", () => {
  const index = packageIndex(fixtureRoot({ ".": { bin: { "honua-js-migrate": "./cli.js" }, name: "@honua/honua-migrate" } }));
  const result = resolveNpxInvocation(parseNpxInvocation(tokenize("npx @honua/honua-migrate honua-js-migrate scan ./src")), index);
  assert.equal(result.status, "failed");
  assert.match(result.reason, /passed to honua-js-migrate as an argument, not run as the command/);
  assert.equal(result.suggestion, "npx -p @honua/honua-migrate honua-js-migrate");

  // Arguments that are not the bin name are just arguments, and resolve.
  assert.equal(resolveNpxInvocation(parseNpxInvocation(tokenize("npx @honua/honua-migrate scan ./src")), index).status, "ok");
});

test("`--package` must actually publish the command named after it", () => {
  const index = packageIndex(fixtureRoot({ ".": SDK_MANIFEST }));
  const result = resolveNpxInvocation(parseNpxInvocation(tokenize("npx -p @honua/sdk-js honua-mcp")), index);
  assert.equal(result.status, "failed");
  assert.match(result.reason, /publishes honua, honua-plugin-certify, not honua-mcp/);
});

test("a package no manifest on disk describes is unverified, never guessed", () => {
  const index = packageIndex(fixtureRoot({ ".": SDK_MANIFEST }));
  assert.equal(resolveNpxInvocation(parseNpxInvocation(tokenize("npx create-vite my-app")), index).status, "unverified");
  assert.equal(resolveNpxInvocation(parseNpxInvocation(tokenize("npx -p unknown-pkg some-bin")), index).status, "unverified");
  // A hoisted copy is proof enough that a package by that name exists.
  const hoisted = packageIndex(fixtureRoot({ ".": SDK_MANIFEST, playwright: { bin: { playwright: "cli.js" }, name: "playwright" } }));
  assert.deepEqual(resolveNpxInvocation(parseNpxInvocation(tokenize("npx playwright test")), hoisted), {
    executable: "playwright",
    package: "playwright",
    status: "ok",
  });
});

test("an install earlier in the same block counts, and one in the prose does not", () => {
  const root = fixtureRoot(
    { ".": SDK_MANIFEST, "@honua/honua-migrate": { bin: { "honua-js-migrate": "./cli.js" }, name: "@honua/honua-migrate" } },
    {
      "docs/installed.md": "Text.\n\n```bash\nnpm install --save-dev @honua/honua-migrate\nnpx honua-js-migrate scan ./src\n```\n",
      "docs/prose-only.md": "Install `@honua/honua-migrate` first.\n\n```bash\nnpx honua-js-migrate scan ./src\n```\n",
    },
  );
  // The dependency has to be declared for its bins to enter the bin index.
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ ...SDK_MANIFEST, dependencies: { "@honua/honua-migrate": "^0.1.3" } }));
  const index = packageIndex(root);

  const installed = checkMarkdown(fs.readFileSync(path.join(root, "docs/installed.md"), "utf8"), "docs/installed.md", index);
  assert.deepEqual(installed.map((entry) => entry.status), ["ok"]);
  assert.equal(installed[0].via, "local-install");

  const proseOnly = checkMarkdown(fs.readFileSync(path.join(root, "docs/prose-only.md"), "utf8"), "docs/prose-only.md", index);
  assert.deepEqual(proseOnly.map((entry) => entry.status), ["failed"]);
});

test("only shell blocks are read, and the reported location is the block", () => {
  const index = packageIndex(fixtureRoot({ ".": SDK_MANIFEST }));
  const markdown = ["Prose that mentions npx @honua/sdk-js honua.", "", "```ts doc-test=skip reason=\"x\"", "// npx @honua/sdk-js honua", "```", "", "```sh", "npx @honua/sdk-js honua", "```", ""].join("\n");
  const results = checkMarkdown(markdown, "docs/mixed.md", index);
  assert.equal(results.length, 1);
  assert.equal(results[0].location, "docs/mixed.md:7");
  assert.equal(results[0].command, "npx @honua/sdk-js honua");
  assert.equal(results[0].status, "failed");
});

test("every npx command this repository documents resolves an executable", () => {
  const report = checkDocumentedCommands(REPO_ROOT);
  assert.deepEqual(
    report.results.filter((result) => result.status === "failed"),
    [],
  );
  // A gate that checks nothing passes trivially; the corpus has to be non-empty,
  // and the documented CLI entry point in particular has to be among the rows.
  assert.ok(report.summary.checked > 20, `expected a non-trivial corpus, checked ${report.summary.checked}`);
  const cli = report.results.filter((result) => result.package === "@honua/sdk-js");
  assert.ok(
    cli.some((result) => result.executable === "honua"),
    "the README CLI quickstart must be among the checked commands",
  );
  assert.ok(cli.every((result) => result.status === "ok"));
});
