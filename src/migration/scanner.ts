import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { readAmdDependencies, readImportEqualsBinding } from "./loader-bindings.js";
import { canonicalArcGisModulePath, isArcGisModuleSpecifier } from "./module-specifiers.js";

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);
const SKIP_DIRS = new Set(["node_modules", "dist", ".git"]);

const ESRI_LEAFLET_MODULE = "esri-leaflet";

/**
 * `importClause` sentinels for usage shapes that have no source-level clause
 * text. `report.ts` maps these onto `ArcGisUsageStyle` values, so the two files
 * must agree on the exact strings.
 */
const SIDE_EFFECT_IMPORT_CLAUSE = "side-effect-import";
const REQUIRE_IMPORT_CLAUSE = "require(...)";
const DYNAMIC_IMPORT_CLAUSE = "import(...)";
/** AMD dependency-array entry: `define([...], factory)` / `require([...], callback)`. */
const AMD_DEPENDENCY_IMPORT_CLAUSE = "amd-dependency-array";
/** TypeScript import-equals: `import X = require("esri/...")`. */
const IMPORT_EQUALS_IMPORT_CLAUSE = "import-equals-require(...)";

export interface ArcGisImportHit {
  file: string;
  modulePath: string;
  importClause: string;
  symbols: string[];
}

export interface ArcGisScanReport {
  rootDir: string;
  filesScanned: number;
  filesWithArcGisImports: number;
  imports: ArcGisImportHit[];
  filesWithEsriLeafletImports?: number;
  esriLeafletImportCount?: number;
  esriLeafletImports?: ArcGisImportHit[];
  symbolUsageCounts: Record<string, number>;
  flags: string[];
}

export function scanArcGisUsage(rootDir: string): ArcGisScanReport {
  const files = collectSourceFiles(rootDir);
  const imports: ArcGisImportHit[] = [];
  const esriLeafletImports: ArcGisImportHit[] = [];
  const flags = new Set<string>();
  const symbolUsageCounts: Record<string, number> = {};

  for (const file of files) {
    const source = fs.readFileSync(file, "utf8");
    const { arcGis: fileImports, esriLeaflet: fileEsriLeafletImports } = findModuleImports(source, file);

    if (source.includes("@arcgis/core/") || fileImports.length > 0) {
      addFileLevelFlags(source, fileImports, flags);
    }

    if (fileImports.some((item) => item.importClause.startsWith("export "))) {
      flags.add("arcgis-reexports-detected");
    }
    if (fileImports.some((item) => isArcGisBarrelModulePath(item.modulePath))) {
      flags.add("arcgis-barrel-imports-detected");
    }
    if (fileImports.some((item) => item.importClause === AMD_DEPENDENCY_IMPORT_CLAUSE)) {
      flags.add("amd-dependency-arrays-detected");
    }
    if (fileImports.some((item) => item.importClause === IMPORT_EQUALS_IMPORT_CLAUSE)) {
      flags.add("typescript-import-equals-detected");
    }
    if (fileImports.some((item) => isArcGis3xDijitModulePath(item.modulePath))) {
      flags.add("arcgis-3x-dijit-detected");
    }
    if (fileEsriLeafletImports.length > 0) {
      flags.add("esri-leaflet-imports-detected");
      esriLeafletImports.push(...fileEsriLeafletImports);
    }
    if (fileImports.length === 0) {
      continue;
    }

    imports.push(...fileImports);

    for (const importHit of fileImports) {
      for (const symbol of importHit.symbols) {
        const usage = countIdentifierUsage(source, symbol);
        symbolUsageCounts[symbol] = (symbolUsageCounts[symbol] ?? 0) + usage;
      }
    }
  }

  return {
    rootDir: path.resolve(rootDir),
    filesScanned: files.length,
    filesWithArcGisImports: new Set(imports.map((item) => item.file)).size,
    imports,
    filesWithEsriLeafletImports: new Set(esriLeafletImports.map((item) => item.file)).size,
    esriLeafletImportCount: esriLeafletImports.length,
    esriLeafletImports,
    symbolUsageCounts,
    flags: Array.from(flags).sort(),
  };
}

export function summarizeArcGisScan(report: ArcGisScanReport): string {
  const topSymbols = Object.entries(report.symbolUsageCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([symbol, count]) => `${symbol}:${count}`)
    .join(", ");

  const flagText = report.flags.length > 0 ? report.flags.join(", ") : "none";
  return [
    `filesScanned=${report.filesScanned}`,
    `filesWithArcGisImports=${report.filesWithArcGisImports}`,
    `importCount=${report.imports.length}`,
    `esriLeafletImportCount=${report.esriLeafletImportCount ?? 0}`,
    `topSymbols=[${topSymbols}]`,
    `flags=[${flagText}]`,
  ].join(" ");
}

function collectSourceFiles(rootDir: string): string[] {
  const absoluteRoot = path.resolve(rootDir);
  const queue = [absoluteRoot];
  const result: string[] = [];

  while (queue.length > 0) {
    const current = queue.pop()!;
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) {
          queue.push(fullPath);
        }
        continue;
      }
      if (SOURCE_EXTENSIONS.has(path.extname(entry.name))) {
        result.push(fullPath);
      }
    }
  }

  return result;
}

/**
 * Cheap pre-filter: only files that mention an Esri-ish token can contain a
 * specifier this scanner cares about, so most of a repository never reaches
 * the parser. Substring scans are linear, unlike the anchored regexes this
 * scanner used to run over every source file (CodeQL `js/polynomial-redos`).
 */
function mayReferenceEsriModules(source: string): boolean {
  return source.includes("esri") || source.includes("@arcgis/core");
}

function scriptKindForFile(file: string): ts.ScriptKind {
  const extension = path.extname(file);
  if (extension === ".ts" || extension === ".mts" || extension === ".cts") return ts.ScriptKind.TS;
  if (extension === ".tsx") return ts.ScriptKind.TSX;
  if (extension === ".jsx") return ts.ScriptKind.JSX;
  return ts.ScriptKind.JS;
}

/**
 * Find every ArcGIS JS (and `esri-leaflet`) module reference in a file.
 *
 * Detection runs over the TypeScript AST rather than over regexes so that the
 * shapes real ArcGIS apps are written in are all covered by one pass, in source
 * order, in linear time:
 *
 * - `import ... from "<spec>"`, side-effect `import "<spec>"`
 * - `export ... from "<spec>"`
 * - `require("<spec>")` (with the local binding, if any)
 * - `import("<spec>")`
 * - AMD dependency arrays — `define([...], factory)`, `define(id, [...], factory)`,
 *   `require([...], callback)`, `require(config, [...], callback)` — with the
 *   factory parameter that receives each module
 * - TypeScript import-equals — `import X = require("<spec>")`
 */
function findModuleImports(
  source: string,
  file: string,
): { arcGis: ArcGisImportHit[]; esriLeaflet: ArcGisImportHit[] } {
  const arcGis: ArcGisImportHit[] = [];
  const esriLeaflet: ArcGisImportHit[] = [];
  if (!mayReferenceEsriModules(source)) {
    return { arcGis, esriLeaflet };
  }

  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, scriptKindForFile(file));

  const record = (modulePath: string, importClause: string, symbols: readonly string[]): void => {
    const hit: ArcGisImportHit = {
      file,
      modulePath,
      importClause,
      symbols: Array.from(new Set(symbols)),
    };
    if (isArcGisModuleSpecifier(modulePath)) {
      arcGis.push(hit);
      return;
    }
    if (modulePath === ESRI_LEAFLET_MODULE) {
      esriLeaflet.push(hit);
    }
  };

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier)) {
      const importClause = node.importClause;
      if (importClause) {
        record(
          node.moduleSpecifier.text,
          importClause.getText(sourceFile).trim(),
          importClauseLocalSymbols(importClause),
        );
      } else {
        record(node.moduleSpecifier.text, SIDE_EFFECT_IMPORT_CLAUSE, []);
      }
    } else if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      const exportClause = node.exportClause;
      const clauseText = exportClause ? exportClause.getText(sourceFile).trim() : "*";
      record(node.moduleSpecifier.text, `export ${clauseText}`, exportClauseLocalSymbols(exportClause));
    } else if (ts.isCallExpression(node)) {
      recordCallExpression(node, record);
    } else {
      const importEquals = readImportEqualsBinding(node);
      if (importEquals) {
        record(importEquals.modulePath, IMPORT_EQUALS_IMPORT_CLAUSE, [importEquals.localName]);
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return { arcGis, esriLeaflet };
}

function recordCallExpression(
  node: ts.CallExpression,
  record: (modulePath: string, importClause: string, symbols: readonly string[]) => void,
): void {
  const args = node.arguments;
  if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
    const firstArg = args.length > 0 ? args[0] : undefined;
    if (firstArg && ts.isStringLiteralLike(firstArg)) {
      record(firstArg.text, DYNAMIC_IMPORT_CLAUSE, []);
    }
    return;
  }

  const amdDependencies = readAmdDependencies(node);
  if (amdDependencies) {
    for (const dependency of amdDependencies) {
      record(
        dependency.specifier.text,
        AMD_DEPENDENCY_IMPORT_CLAUSE,
        dependency.localName ? [dependency.localName] : [],
      );
    }
    return;
  }

  if (ts.isIdentifier(node.expression) && node.expression.text === "require") {
    const firstArg = args.length > 0 ? args[0] : undefined;
    if (firstArg && ts.isStringLiteralLike(firstArg)) {
      record(firstArg.text, REQUIRE_IMPORT_CLAUSE, requireLocalSymbols(node));
    }
  }
}

/** Local binding introduced by `const X = require("...")` / `const { default: X } = require("...")`. */
function requireLocalSymbols(node: ts.CallExpression): string[] {
  let current: ts.Node = node;
  let parent: ts.Node | undefined = node.parent;

  if (
    parent &&
    ts.isPropertyAccessExpression(parent) &&
    parent.expression === current &&
    parent.name.text === "default"
  ) {
    current = parent;
    parent = parent.parent;
  }

  if (!parent || !ts.isVariableDeclaration(parent) || parent.initializer !== current) {
    return [];
  }

  if (ts.isIdentifier(parent.name)) {
    return [parent.name.text];
  }

  if (ts.isObjectBindingPattern(parent.name)) {
    for (const element of parent.name.elements) {
      const propertyName =
        element.propertyName && ts.isIdentifier(element.propertyName) ? element.propertyName.text : undefined;
      if (propertyName === "default" && ts.isIdentifier(element.name)) {
        return [element.name.text];
      }
    }
  }

  return [];
}

/**
 * Local names an import clause introduces. Namespace imports (`* as L`) are
 * deliberately excluded: the namespace object is not a construct the codemod
 * tracks, and counting it would inflate symbol usage.
 */
function importClauseLocalSymbols(importClause: ts.ImportClause): string[] {
  const symbols: string[] = [];
  if (importClause.name) {
    symbols.push(importClause.name.text);
  }
  const namedBindings = importClause.namedBindings;
  if (namedBindings && ts.isNamedImports(namedBindings)) {
    for (const element of namedBindings.elements) {
      symbols.push(element.name.text);
    }
  }
  return symbols;
}

function exportClauseLocalSymbols(exportClause: ts.NamedExportBindings | undefined): string[] {
  if (!exportClause || !ts.isNamedExports(exportClause)) {
    return [];
  }
  return exportClause.elements.map((element) => element.name.text);
}

function countIdentifierUsage(source: string, symbol: string): number {
  const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(`\\b${escaped}\\b`, "g");
  const matches = source.match(regex);
  if (!matches) {
    return 0;
  }

  // Subtract one usage that usually appears in the import declaration itself.
  return Math.max(0, matches.length - 1);
}

function addFileLevelFlags(source: string, fileImports: readonly ArcGisImportHit[], flags: Set<string>): void {
  if (/SceneView\b/.test(source) || /WebScene\b/.test(source)) {
    flags.add("scene-3d-detected");
  }
  if (/WebMap\b/.test(source)) {
    flags.add("webmap-detected");
  }
  if (fileImports.some((item) => item.importClause === DYNAMIC_IMPORT_CLAUSE)) {
    flags.add("dynamic-import-detected");
  }
  if (/ClosestFacility|ServiceArea|Geoprocessor/.test(source)) {
    flags.add("advanced-widget-or-networking-detected");
  }
  if (
    /IdentityManager|OAuthInfo|esriConfig|request\s*\.\s*interceptors|\/request["']|generateToken|Credential/i.test(
      source,
    )
  ) {
    flags.add("auth-or-request-customization-detected");
  }
  if (/\bmodule\.exports\b/.test(source) || /\bexports\.[A-Za-z_$][A-Za-z0-9_$]*\b/.test(source)) {
    flags.add("commonjs-detected");
  }
}

function isArcGisBarrelModulePath(modulePath: string): boolean {
  const normalized = canonicalArcGisModulePath(modulePath);

  return (
    normalized === "@arcgis/core/layers" ||
    normalized === "@arcgis/core/layers/support" ||
    normalized === "@arcgis/core/widgets" ||
    normalized === "@arcgis/core/geometry" ||
    normalized === "@arcgis/core/symbols" ||
    normalized === "@arcgis/core/renderers" ||
    normalized === "@arcgis/core/views" ||
    normalized === "@arcgis/core/rest/support" ||
    normalized === "@arcgis/core/identity" ||
    normalized === "@arcgis/core/core"
  );
}

/**
 * `esri/dijit/*` is the ArcGIS JS 3.x widget namespace. It has no `@arcgis/core`
 * equivalent, so it never resolves to a codemod kind; flagging it explicitly
 * keeps a 3.x viewer's widget surface visible in the report instead of letting
 * it disappear into the general unhandled-module list.
 */
function isArcGis3xDijitModulePath(modulePath: string): boolean {
  return modulePath === "esri/dijit" || modulePath.startsWith("esri/dijit/");
}
