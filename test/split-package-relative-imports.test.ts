import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { missingRelativeImports } from "../scripts/lib/split-package-relative-imports.mjs";

const roots: string[] = [];

function appPlatformCopy(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "honua-split-imports-"));
  roots.push(root);
  fs.mkdirSync(path.join(root, "web-components"));
  fs.mkdirSync(path.join(root, "esri-compat"));
  fs.writeFileSync(
    path.join(root, "web-components", "elements.js"),
    'import { applyToFeatures } from "../widget-capabilities.js";\nexport const tag = "honua-legend";\n',
  );
  fs.writeFileSync(
    path.join(root, "esri-compat", "feature-layer.js"),
    'export { applyToFeatures as applyFeatureEdits } from "../widget-capabilities.js";\n',
  );
  fs.writeFileSync(path.join(root, "widget-capabilities.js"), "export function applyToFeatures() {}\n");
  fs.writeFileSync(
    path.join(root, "readme.js"),
    'const example = "from \\"../not-an-import.js\\"";\nimport "@honua/sdk";\nconst name = "../missing.js";\nimport(name);\n',
  );
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("split package relative imports", () => {
  it("fails when widget-capabilities.js is removed from the app-platform copy and passes when restored", () => {
    const root = appPlatformCopy();
    expect(missingRelativeImports(root)).toEqual([]);

    fs.rmSync(path.join(root, "widget-capabilities.js"));
    expect(missingRelativeImports(root)).toEqual([
      { file: "esri-compat/feature-layer.js", specifier: "../widget-capabilities.js" },
      { file: "web-components/elements.js", specifier: "../widget-capabilities.js" },
    ]);

    fs.writeFileSync(path.join(root, "widget-capabilities.js"), "export function applyToFeatures() {}\n");
    expect(missingRelativeImports(root)).toEqual([]);
  });

  it("rejects a relative import that resolves outside the copied package", () => {
    const root = appPlatformCopy();
    const outside = path.join(path.dirname(root), "outside.js");
    fs.writeFileSync(outside, "export const value = 1;\n");
    fs.writeFileSync(path.join(root, "web-components", "elements.js"), 'import { value } from "../../outside.js";\n');
    try {
      expect(missingRelativeImports(root)).toEqual([
        { file: "web-components/elements.js", specifier: "../../outside.js" },
      ]);
    } finally {
      fs.rmSync(outside, { force: true });
    }
  });

  it("ignores comments, package specifiers, and non-literal dynamic imports", () => {
    const root = appPlatformCopy();
    fs.writeFileSync(
      path.join(root, "web-components", "elements.js"),
      [
        '// import "../comment.js";',
        '/* from "../block.js" */',
        'import { applyToFeatures } from "../widget-capabilities.js";',
        'import("@honua/sdk");',
        'const specifier = "../absent.js";',
        "import(/* @vite-ignore */ specifier);",
        'const hint = `Run import("./optional.js") to enable this feature`;',
        "const prose = 'from \"./nope.js\"';",
        "const loaded = await import(`./${name}.js`);",
        "",
      ].join("\n"),
    );
    expect(missingRelativeImports(root)).toEqual([]);
  });

  it("still sees a relative import inside a template substitution", () => {
    const root = appPlatformCopy();
    fs.writeFileSync(
      path.join(root, "web-components", "elements.js"),
      'export const loaded = `${import("./needed.js")}`;\n',
    );
    expect(missingRelativeImports(root)).toEqual([{ file: "web-components/elements.js", specifier: "./needed.js" }]);
  });

  it("requires the declaration sibling for an import written in a declaration file", () => {
    const root = appPlatformCopy();
    fs.writeFileSync(path.join(root, "widget-capabilities.js"), "export function applyToFeatures() {}\n");
    fs.writeFileSync(
      path.join(root, "widget-capabilities-user.d.ts"),
      'import { applyToFeatures } from "./widget-capabilities.js";\n',
    );
    expect(missingRelativeImports(root)).toEqual([
      { file: "widget-capabilities-user.d.ts", specifier: "./widget-capabilities.js" },
    ]);

    fs.writeFileSync(path.join(root, "widget-capabilities.d.ts"), "export function applyToFeatures(): void;\n");
    expect(missingRelativeImports(root)).toEqual([]);
  });
});
