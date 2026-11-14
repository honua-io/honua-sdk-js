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

interface RenamedNames {
  readonly reason: string;
  readonly names: Readonly<Record<string, string>>;
}

interface RetiredNameExceptions {
  readonly renamed: RenamedNames;
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
// Old names renamed outright (no deprecated aliases): old -> new.
const renamed = new Map(Object.entries(exceptions.renamed.names));
const allowed = new Set([
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

function collectExports(): Map<string, ExportedName[]> {
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
  return names;
}

describe("public names use the Honua vocabulary", () => {
  let exported: Map<string, ExportedName[]>;

  beforeAll(() => {
    exported = collectExports();
  }, 120_000);

  it("exports no retired term outside the reviewed exceptions", () => {
    const unlisted = [...exported.keys()].filter((name) => containsRetiredTerm(name) && !allowed.has(name));
    expect(unlisted).toEqual([]);
  });

  it("keeps every exception exported, so the lists only shrink", () => {
    const stale = [...allowed].filter((name) => !exported.has(name));
    expect(stale).toEqual([]);
  });

  it("exports none of the renamed pre-vocabulary names", () => {
    const stillExported = [...renamed.keys()].filter((name) => exported.has(name));
    expect(stillExported).toEqual([]);
  });

  it("exports every replacement name with no retired term", () => {
    const problems = [...renamed].filter(([, next]) => !exported.has(next) || containsRetiredTerm(next));
    expect(problems).toEqual([]);
  });

  it("keeps the renamed value exports off the runtime modules", async () => {
    const modules = await Promise.all([
      import("../src/runtime/index.js"),
      import("../src/control-plane/index.js"),
      import("../src/studio/index.js"),
      import("../src/generated-app/index.js"),
    ]);
    const leaked = modules.flatMap((module) => [...renamed.keys()].filter((name) => name in module));
    expect(leaked).toEqual([]);
  });
});

describe("docs and examples use the current names", () => {
  const DOC_ROOTS = ["README.md", "INSTALL.md", "docs", "examples"];
  const SKIPPED = new Set(["node_modules", "dist", "decisions"]);

  const DOC_FILE = /\.(md|ts|tsx|mjs|html)$/;
  // The one doc that lists the old names, as the migration table.
  const RENAMES_DOC = path.join("docs", "vocabulary-renames.md");

  function documentFiles(entry: string): string[] {
    const full = path.join(ROOT, entry);
    if (!existsSync(full)) return [];
    if (statSync(full).isFile()) return DOC_FILE.test(entry) ? [entry] : [];
    return readdirSync(full)
      .filter((child) => !SKIPPED.has(child))
      .flatMap((child) => documentFiles(path.join(entry, child)));
  }

  it("never names a renamed pre-vocabulary name", () => {
    const pattern = new RegExp(`\\b(${[...renamed.keys()].join("|")})\\b`);
    const offenders = DOC_ROOTS.flatMap(documentFiles).filter(
      (file) => file !== RENAMES_DOC && pattern.test(readFileSync(path.join(ROOT, file), "utf8")),
    );
    expect(offenders).toEqual([]);
  });

  it("lists every renamed export in the vocabulary renames doc", () => {
    const doc = readFileSync(path.join(ROOT, RENAMES_DOC), "utf8");
    const listed = new Map(
      [...doc.matchAll(/^\| `(\w+)` \| `(\w+)` \|$/gm)].map((match) => [match[1], match[2]] as const),
    );
    const missing = [...renamed].filter(([old, next]) => listed.get(old) !== next).map(([old]) => old);
    expect(missing).toEqual([]);
  });
});
