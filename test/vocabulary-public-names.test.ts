import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { beforeAll, describe, expect, it } from "vitest";

// Guards the shared Honua vocabulary (honua-server docs/concepts/domain/README.md and
// scripts/ci/retired-terms.v1.json) on the exported surface of every package entrypoint.

const ROOT = path.resolve(import.meta.dirname, "..");
const RETIRED_TERMS = [
  "mappackage",
  "apppackage",
  "workspace",
  "webmap",
  "hostedlayer",
  "hostedmap",
  "portalitem",
  "apitoken",
  "servingtarget",
  "contentitem",
  "metadatav2resource",
  "metadatav2publication",
  "esrifeature",
];

interface ExceptionGroup {
  readonly reason: string;
  readonly names: readonly string[];
}

interface RetiredNameExceptions {
  readonly deprecatedAliases: ExceptionGroup;
  readonly foreignFormat: ExceptionGroup;
  readonly technicalWorkspace: ExceptionGroup;
  readonly pendingRename: ExceptionGroup;
}

interface ExportedName {
  readonly entrypoint: string;
  readonly symbol: ts.Symbol;
}

const exceptions = JSON.parse(
  readFileSync(path.join(ROOT, "test/fixtures/vocabulary/retired-name-exceptions.json"), "utf8"),
) as RetiredNameExceptions;
const deprecatedAliases = new Set(exceptions.deprecatedAliases.names);
const allowed = new Set([
  ...exceptions.deprecatedAliases.names,
  ...exceptions.foreignFormat.names,
  ...exceptions.technicalWorkspace.names,
  ...exceptions.pendingRename.names,
]);

function containsRetiredTerm(name: string): boolean {
  const normalized = name.replaceAll("_", "").toLowerCase();
  return RETIRED_TERMS.some((term) => normalized.includes(term));
}

function entrypointSources(): Map<string, string> {
  const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")) as {
    exports: Record<string, { types?: string } | string>;
  };
  const sources = new Map<string, string>();
  for (const [subpath, target] of Object.entries(pkg.exports)) {
    if (typeof target !== "object" || !target.types) continue;
    const base = path.join(ROOT, target.types.replace(/^\.\/dist\//, "").replace(/\.d\.ts$/, ""));
    const source = [`${base}.ts`, `${base}.tsx`].find((candidate) => existsSync(candidate));
    if (source) sources.set(subpath, source);
  }
  return sources;
}

function collectExports(): { checker: ts.TypeChecker; names: Map<string, ExportedName[]> } {
  const sources = entrypointSources();
  const program = ts.createProgram([...sources.values()], {
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    jsx: ts.JsxEmit.ReactJSX,
    noEmit: true,
    skipLibCheck: true,
    types: [],
  });
  const checker = program.getTypeChecker();
  const names = new Map<string, ExportedName[]>();
  for (const [entrypoint, file] of sources) {
    const sourceFile = program.getSourceFile(file);
    const moduleSymbol = sourceFile && checker.getSymbolAtLocation(sourceFile);
    if (!moduleSymbol) continue;
    for (const symbol of checker.getExportsOfModule(moduleSymbol)) {
      const entries = names.get(symbol.name) ?? [];
      entries.push({ entrypoint, symbol });
      names.set(symbol.name, entries);
    }
  }
  return { checker, names };
}

function deprecationReplacement(checker: ts.TypeChecker, symbol: ts.Symbol): string | undefined {
  const target = symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
  for (const declaration of target.declarations ?? []) {
    const tag = ts.getJSDocTags(declaration).find((candidate) => candidate.tagName.text === "deprecated");
    const text = typeof tag?.comment === "string" ? tag.comment : ts.getTextOfJSDocComment(tag?.comment);
    const replacement = text?.match(/^Use (\w+)\./)?.[1];
    if (replacement) return replacement;
  }
  return undefined;
}

describe("public names use the Honua vocabulary", () => {
  let checker: ts.TypeChecker;
  let exported: Map<string, ExportedName[]>;

  beforeAll(() => {
    ({ checker, names: exported } = collectExports());
  }, 120_000);

  it("exports no retired term outside the reviewed exceptions", () => {
    const unlisted = [...exported.keys()].filter((name) => containsRetiredTerm(name) && !allowed.has(name));
    expect(unlisted).toEqual([]);
  });

  it("keeps every exception exported, so the lists only shrink", () => {
    const stale = [...allowed].filter((name) => !exported.has(name));
    expect(stale).toEqual([]);
  });

  it("marks every deprecated alias with a vocabulary-clean replacement from the same entrypoint", () => {
    const problems: string[] = [];
    for (const name of deprecatedAliases) {
      for (const { entrypoint, symbol } of exported.get(name) ?? []) {
        const replacement = deprecationReplacement(checker, symbol);
        const sameEntrypoint = exported.get(replacement ?? "")?.some((entry) => entry.entrypoint === entrypoint);
        if (!replacement || containsRetiredTerm(replacement) || !sameEntrypoint) problems.push(`${entrypoint} ${name}`);
      }
    }
    expect(problems).toEqual([]);
  });

  it("keeps deprecated value aliases identical to their replacements", async () => {
    const runtime = (await import("../src/runtime/index.js")) as Record<string, unknown>;
    const controlPlane = (await import("../src/control-plane/index.js")) as Record<string, unknown>;
    expect(runtime.loadMapPackage).toBe(runtime.loadMapDocument);
    expect(runtime.HonuaMapPackageError).toBe(runtime.HonuaMapDocumentError);
    expect(runtime.HONUA_MAP_PACKAGE_FORMAT_V1).toBe(runtime.HONUA_MAP_DOCUMENT_FORMAT_V1);
    expect(controlPlane.HonuaApiTokensClient).toBe(controlPlane.HonuaApiKeysClient);
    expect(controlPlane.HonuaHostedMapsClient).toBe(controlPlane.HonuaSavedMapsClient);
  });
});

describe("docs and examples use the current names", () => {
  const DOC_ROOTS = ["README.md", "docs", "examples"];
  const SKIPPED = new Set(["node_modules", "dist", "decisions"]);

  const DOC_FILE = /\.(md|ts|tsx|mjs|html)$/;

  function documentFiles(entry: string): string[] {
    const full = path.join(ROOT, entry);
    if (!existsSync(full)) return [];
    if (statSync(full).isFile()) return DOC_FILE.test(entry) ? [entry] : [];
    return readdirSync(full)
      .filter((child) => !SKIPPED.has(child))
      .flatMap((child) => documentFiles(path.join(entry, child)));
  }

  it("never names a deprecated alias", () => {
    const pattern = new RegExp(`\\b(${[...deprecatedAliases].join("|")})\\b`);
    const offenders = DOC_ROOTS.flatMap(documentFiles).filter((file) =>
      pattern.test(readFileSync(path.join(ROOT, file), "utf8")),
    );
    expect(offenders).toEqual([]);
  });
});
