import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

import sampleKitManifest from "../examples/_kit/manifest.v1.json" with { type: "json" };

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const SHARED_DESIGN_IMPORT = "../../_kit/design/index.css";

function hasActiveSharedDesignImport(source: string): boolean {
  const file = ts.createSourceFile("sample-entry.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  return file.statements.some(
    (statement) =>
      ts.isImportDeclaration(statement) &&
      statement.importClause === undefined &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      statement.moduleSpecifier.text === SHARED_DESIGN_IMPORT,
  );
}

function sampleEntrySource(sampleId: string): string {
  const root = path.join(REPO_ROOT, "examples", sampleId, "src");
  const entry = ["main.ts", "main.tsx"].find((name) => fs.existsSync(path.join(root, name)));
  if (entry === undefined) return "";
  return fs.readFileSync(path.join(root, entry), "utf8");
}

describe("sample design language adoption", () => {
  it("keeps every qualified catalog sample connected to the shared design entrypoint", () => {
    const missing = sampleKitManifest.samples
      .map((sample) => (hasActiveSharedDesignImport(sampleEntrySource(sample.id)) ? undefined : sample.id))
      .filter((sampleId): sampleId is string => sampleId !== undefined);

    expect(missing).toEqual([]);
  });

  it("requires an active side-effect import rather than a comment or string literal", () => {
    expect(hasActiveSharedDesignImport('// import "../../_kit/design/index.css";')).toBe(false);
    expect(hasActiveSharedDesignImport('const documentation = "../../_kit/design/index.css";')).toBe(false);
    expect(hasActiveSharedDesignImport('import "../../_kit/design/index.css";')).toBe(true);
  });
});
