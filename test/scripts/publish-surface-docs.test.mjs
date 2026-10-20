import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { documentedSplitPackages } from "../../scripts/lib/publish-surface-docs.mjs";

const section = "## Packages produced by the split build\n\n| Package | Subpath |\n|---|---|\n| `@honua/sdk` | `@honua/sdk-js/honua` |\n";

test("external dependency and subpath mentions do not claim split production", () => {
  assert.deepEqual([...documentedSplitPackages(`External \`@honua/honua-migrate\`.\n${section}\nExternal \`@honua/other\`.\n## Other packages\n| \`@honua/external\` | |`)], ["@honua/sdk"]);
});

test("missing and empty production tables fail closed", () => {
  assert.throws(() => documentedSplitPackages("External `@honua/sdk`."), /produced-packages section/);
  assert.throws(() => documentedSplitPackages("## Packages produced by the split build\nNo table."), /production table header/);
});

test("duplicate production claims fail closed", () => {
  assert.throws(() => documentedSplitPackages(`${section}| \`@honua/sdk\` | |\n`), /repeats/);
});

test("published documentation claims all five actual split packages", () => {
  const docs = readFileSync(new URL("../../docs/split-packages.md", import.meta.url), "utf8");
  assert.deepEqual([...documentedSplitPackages(docs)].sort(), ["@honua/app-platform", "@honua/geometry", "@honua/react", "@honua/sdk", "@honua/sdk-esri-compat"]);
});

test("malformed production rows cannot silently disappear beside a valid package", () => {
  for (const row of ["| @honua/missing-backticks | |", "| `@honua/sdk/invalid` | |", "| `@honua/valid` | missing closing separator"]) {
    assert.throws(() => documentedSplitPackages(`${section}${row}\n`), /Malformed produced-package table row/);
  }
});
