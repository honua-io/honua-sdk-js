#!/usr/bin/env node

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = path.join(root, "config", "root-surface.json");
const migrationDocPath = path.join(root, "docs", "root-surface-migration.md");
const runtimeFixturePath = path.join(root, "test", "root-surface", "moved-runtime.ts");
const runtimeModuleFixturePath = path.join(root, "test", "root-surface", "moved-runtime.mjs");
const typeFixturePath = path.join(root, "test", "root-surface", "moved-types.ts");
const rootSourcePath = path.join(root, "src", "index.ts");
const apiReportPath = path.join(root, "api-report", "stable-api.json");
const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));

const replacementPriority = [
  "@honua/sdk-js/contract",
  "@honua/sdk-js/auth",
  "@honua/sdk-js/map",
  "@honua/sdk-js/webmap",
  "@honua/sdk-js/geocoding",
  "@honua/sdk-js/exploration",
  "@honua/sdk-js/interactions",
  "@honua/sdk-js/filter-registry",
  "@honua/sdk-js/style",
  "@honua/sdk-js/realtime",
  "@honua/sdk-js/react",
  "@honua/sdk-js/geometry",
  "@honua/sdk-js/runtime",
  "@honua/sdk-js/expr",
  "@honua/sdk-js/cli",
  "@honua/sdk-js/migration",
  "@honua/sdk-js/esri-compat",
  "@honua/sdk-js/honua",
];

const honuaPromotions = new Set([
  "HonuaWms",
  "HonuaWmsCapabilitiesParseError",
  "HonuaWmsFeatureInfoResponse",
  "HonuaWmsImageResponse",
  "HonuaWmsLayer",
  "HonuaWmsLayerOptions",
  "HonuaWmsOptions",
  "HonuaWmts",
  "HonuaWmtsCapabilitiesParseError",
  "HonuaWmtsFeatureInfoResponse",
  "HonuaWmtsLayer",
  "HonuaWmtsLayerOptions",
  "HonuaWmtsOptions",
  "HonuaWmtsTileResponse",
  "HonuaWmtsTileset",
  "HonuaWmtsTilesetOptions",
  "WmsCapabilities",
  "WmsCapabilitiesFormats",
  "WmsCapabilitiesRequestSupport",
  "WmsCapabilitiesService",
  "WmsCapabilityBoundingBox",
  "WmsCapabilityDimension",
  "WmsCapabilityLayer",
  "WmsCapabilityStyle",
  "WmsCrs",
  "WmsFeatureInfoRequest",
  "WmsLegendRequest",
  "WmsMapRequest",
  "WmtsCapabilities",
  "WmtsCapabilitiesService",
  "WmtsCapabilityLayer",
  "WmtsCapabilityResourceUrl",
  "WmtsCapabilityStyle",
  "WmtsCapabilityTileMatrix",
  "WmtsCapabilityTileMatrixSet",
  "WmtsFeatureInfoRequest",
  "WmtsTileMode",
  "WmtsTileRequest",
  "createHonuaWms",
  "createHonuaWmts",
  "findWmsLayer",
  "findWmtsLayer",
  "findWmtsTileMatrixSet",
  "iterateWmsLayers",
  "parseWmsCapabilities",
  "parseWmtsCapabilities",
]);

function sorted(values) {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function digest(values) {
  return createHash("sha256").update(sorted(values).join("\n")).digest("hex");
}

function selectedSourceExports() {
  const text = fs.readFileSync(rootSourcePath, "utf8");
  const source = ts.createSourceFile(rootSourcePath, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const runtime = [];
  const declarations = [];
  for (const statement of source.statements) {
    if (!ts.isExportDeclaration(statement) || !statement.exportClause || !ts.isNamedExports(statement.exportClause)) {
      continue;
    }
    for (const element of statement.exportClause.elements) {
      const name = element.name.text;
      declarations.push(name);
      if (!statement.isTypeOnly && !element.isTypeOnly) runtime.push(name);
    }
  }
  return { runtime: sorted(runtime), declarations: sorted(declarations) };
}

function reportExports() {
  const report = JSON.parse(fs.readFileSync(apiReportPath, "utf8"));
  return new Map(
    report.stableEntrypoints.map((entrypoint) => [
      entrypoint.subpath,
      new Set(entrypoint.exports.map((entry) => entry.split(" — ")[0])),
    ]),
  );
}

function exportTarget(packageName) {
  const subpath = packageName === packageJson.name ? "." : `.${packageName.slice(packageJson.name.length)}`;
  const target = packageJson.exports[subpath]?.default;
  if (typeof target !== "string") throw new Error(`No runtime target for ${packageName}`);
  return path.join(root, target.replace(/^\.\//, ""));
}

async function runtimeExports(packageNames) {
  const out = new Map();
  for (const packageName of packageNames) {
    const target = exportTarget(packageName);
    const imported = await import(`${pathToFileURL(target).href}?root-surface=${Date.now()}`);
    out.set(packageName, new Set(Object.keys(imported)));
  }
  return out;
}

function chooseReplacement(name, candidates) {
  const replacement = replacementPriority.find((candidate) => candidates.get(candidate)?.has(name));
  if (replacement) return replacement;
  if (honuaPromotions.has(name)) return "@honua/sdk-js/honua";
  throw new Error(`No supported replacement subpath exports ${name}`);
}

function groupImports(migrations, kind) {
  const groups = new Map();
  for (const migration of migrations.filter((entry) => entry.kind === kind)) {
    const values = groups.get(migration.replacement) ?? [];
    values.push(migration.symbol);
    groups.set(migration.replacement, values);
  }
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
}

function migrationRuntimeFixture(manifest) {
  const lines = [
    "/** Generated by scripts/root-surface.mjs. Every moved runtime symbol is imported from its replacement. */",
  ];
  let index = 0;
  const aliases = [];
  for (const [replacement, symbols] of groupImports(manifest.migrations, "runtime")) {
    const imports = symbols.sort().map((symbol) => {
      const alias = `movedRuntime${String(index).padStart(4, "0")}`;
      index += 1;
      aliases.push(alias);
      return `${symbol} as ${alias}`;
    });
    const inline = `import { ${imports.join(", ")} } from "${replacement}";`;
    lines.push(inline.length <= 120 ? inline : `import {\n  ${imports.join(",\n  ")},\n} from "${replacement}";`);
  }
  lines.push("", `void [\n  ${aliases.join(",\n  ")},\n];`, "");
  return lines.join("\n");
}

function migrationTypeFixture(manifest) {
  const lines = [
    "/** Generated by scripts/root-surface.mjs. Every moved type-only symbol is imported from its replacement. */",
  ];
  let index = 0;
  for (const [replacement, symbols] of groupImports(manifest.migrations, "type")) {
    const imports = symbols.sort().map((symbol) => {
      const alias = `MovedType${String(index).padStart(4, "0")}`;
      index += 1;
      return `${symbol} as ${alias}`;
    });
    const inline = `import type { ${imports.join(", ")} } from "${replacement}";`;
    lines.push(
      inline.length <= 120 ? inline : `import type {\n  ${imports.join(",\n  ")},\n} from "${replacement}";`,
    );
  }
  // Import resolution itself is the compatibility proof. Referencing imported
  // aliases as bare types would require inventing arguments for generic APIs.
  lines.push("");
  return lines.join("\n");
}

function migrationDoc(manifest) {
  const counts = manifest.migrations.reduce((out, entry) => {
    out[entry.replacement] = (out[entry.replacement] ?? 0) + 1;
    return out;
  }, {});
  const lines = [
    "# Root import migration",
    "",
    "The package root is the reviewed connect → query → explain → mount workflow. No advanced API was deleted: every symbol moved from the transition-era root remains on the replacement subpath below and is compile-tested from a packed consumer.",
    "",
    "This table is generated from [`config/root-surface.json`](../config/root-surface.json). Run `npm run verify:root-surface` to detect barrel, replacement, fixture, or documentation drift.",
    "",
    `Baseline: ${manifest.baseline.runtimeCount} runtime and ${manifest.baseline.declarationCount} declaration symbols. Final root: ${manifest.final.runtime.length} runtime and ${manifest.final.declarations.length} declaration symbols.`,
    "",
    "## Replacement summary",
    "",
    "| Replacement | Moved symbols |",
    "| --- | ---: |",
    ...Object.entries(counts)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([replacement, count]) => `| \`${replacement}\` | ${count} |`),
    "",
    "## Exact symbol mapping",
    "",
    "| Former root symbol | Kind | Replacement import |",
    "| --- | --- | --- |",
    ...manifest.migrations.map(
      (entry) => `| \`${entry.symbol}\` | ${entry.kind} | \`${entry.replacement}\` |`,
    ),
    "",
  ];
  return lines.join("\n");
}

function generatedArtifacts(manifest) {
  return new Map([
    [migrationDocPath, migrationDoc(manifest)],
    [runtimeFixturePath, migrationRuntimeFixture(manifest)],
    [runtimeModuleFixturePath, migrationRuntimeFixture(manifest)],
    [typeFixturePath, migrationTypeFixture(manifest)],
  ]);
}

function writeArtifacts(manifest) {
  fs.mkdirSync(path.dirname(runtimeFixturePath), { recursive: true });
  for (const [file, content] of generatedArtifacts(manifest)) fs.writeFileSync(file, content);
}

async function initialize() {
  if (fs.existsSync(manifestPath)) throw new Error("Refusing to overwrite existing config/root-surface.json");
  const selected = selectedSourceExports();
  const declarationsByPackage = reportExports();
  const baselineDeclarations = sorted(declarationsByPackage.get(packageJson.name) ?? []);
  const baselineRuntime = sorted(Object.keys(await import(`${pathToFileURL(exportTarget(packageJson.name)).href}?baseline`)));
  const runtimePackages = replacementPriority.filter((entry) => !entry.endsWith("/honua"));
  const runtimeByPackage = await runtimeExports(runtimePackages);
  runtimeByPackage.set("@honua/sdk-js/honua", new Set(declarationsByPackage.get("@honua/sdk-js/honua") ?? []));

  const finalRuntime = new Set(selected.runtime);
  const finalDeclarations = new Set(selected.declarations);
  const baselineRuntimeSet = new Set(baselineRuntime);
  const migrations = baselineDeclarations
    .filter((symbol) => !finalDeclarations.has(symbol))
    .map((symbol) => {
      const kind = baselineRuntimeSet.has(symbol) ? "runtime" : "type";
      const candidates = kind === "runtime" ? runtimeByPackage : declarationsByPackage;
      return { symbol, kind, replacement: chooseReplacement(symbol, candidates) };
    });
  const promotions = selected.declarations
    .filter((symbol) => !baselineDeclarations.includes(symbol))
    .map((symbol) => ({ symbol, kind: finalRuntime.has(symbol) ? "runtime" : "type" }));
  const manifest = {
    $comment:
      "Reviewed final root surface for issue #451. Generated migration rows partition the b6e89a4 transition-era root; do not hand-edit without regenerating fixtures and migration documentation.",
    schemaVersion: 1,
    inclusionRule: [
      "Include symbols used directly by the committed connect-query-explain-mount golden root workflow.",
      "Include the minimal protocol-neutral input, output, error, policy, and lifecycle vocabulary needed to name that workflow.",
      "Promote only the planner vocabulary required to explain and mount the common workflow; the complete query-planner subpath remains experimental.",
      "Runtime exports must be SSR/worker safe at module evaluation and must not load optional renderer, model, DuckDB, Arrow, Cesium, React, or app-platform peers.",
      "Move every protocol-specific, renderer-specific, application-state, migration, styling, realtime, offline, analytics, and low-level wire symbol to its focused supported subpath.",
    ],
    evidence: {
      northStarDecision: "docs/decisions/north-star-sdk-application-kernel.md",
      goldenFixture: "test/root-surface/golden.ts",
      goldenRuntimeAssertion: "test/root-surface/golden.test.ts",
      usageRoots: ["README.md", "INSTALL.md", "docs", "examples", "mcp", "test/integration"],
      dependencyBoundary: "docs/decisions/north-star-sdk-application-kernel.md#dependency-direction",
    },
    baseline: {
      commit: "b6e89a4d2eab25a73557deb3da5bc372e570ce79",
      runtimeCount: baselineRuntime.length,
      runtimeSha256: digest(baselineRuntime),
      declarationCount: baselineDeclarations.length,
      declarationSha256: digest(baselineDeclarations),
    },
    final: selected,
    promotions,
    migrations,
  };
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  writeArtifacts(manifest);
  process.stdout.write(
    `rootSurfaceInitialized runtime=${selected.runtime.length} declarations=${selected.declarations.length} moved=${migrations.length} promoted=${promotions.length}\n`,
  );
}

function declarationExports(file) {
  const program = ts.createProgram([file], {
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    target: ts.ScriptTarget.ES2022,
    skipLibCheck: true,
    noEmit: true,
  });
  const checker = program.getTypeChecker();
  const source = program.getSourceFile(file);
  const symbol = source && checker.getSymbolAtLocation(source);
  return new Set(symbol ? checker.getExportsOfModule(symbol).map((entry) => entry.getName()) : []);
}

async function check() {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const failures = [];
  const builtRuntime = sorted(Object.keys(await import(`${pathToFileURL(exportTarget(packageJson.name)).href}?check`)));
  const builtDeclarations = sorted(declarationExports(path.join(root, packageJson.exports["."].types.replace(/^\.\//, ""))));
  if (JSON.stringify(builtRuntime) !== JSON.stringify(manifest.final.runtime)) failures.push("built root runtime differs from manifest");
  if (JSON.stringify(builtDeclarations) !== JSON.stringify(manifest.final.declarations)) {
    failures.push("built root declarations differ from manifest");
  }
  const stablePlannerRuntime = ["executeQueryPlan", "explainQuery", "hashQueryPlan"];
  if (!stablePlannerRuntime.every((symbol) => manifest.final.runtime.includes(symbol))) {
    failures.push("manifest is missing the reviewed stable root query-planner subset");
  }
  const plannerContractMarker = "the stable root promotes a reviewed query-planner subset";
  const forbiddenBlanketClaims = [
    "the experimental subpaths are subpath-only",
    "experimental (subpath-only — not re-exported from the root barrels)",
  ];
  for (const documentationFile of ["README.md", "INSTALL.md"]) {
    const prose = fs
      .readFileSync(path.join(root, documentationFile), "utf8")
      .toLocaleLowerCase("en-US")
      .replace(/\s+/g, " ");
    if (!prose.includes(plannerContractMarker)) {
      failures.push(`${documentationFile} does not document the reviewed stable root query-planner subset`);
    }
    for (const forbidden of forbiddenBlanketClaims) {
      if (prose.includes(forbidden)) {
        failures.push(`${documentationFile} incorrectly claims every experimental subpath is root-excluded`);
      }
    }
  }
  const promotionNames = new Set(manifest.promotions.map((entry) => entry.symbol));
  const reconstructedRuntime = sorted([
    ...manifest.final.runtime.filter((symbol) => !promotionNames.has(symbol)),
    ...manifest.migrations.filter((entry) => entry.kind === "runtime").map((entry) => entry.symbol),
  ]);
  const reconstructedDeclarations = sorted([
    ...manifest.final.declarations.filter((symbol) => !promotionNames.has(symbol)),
    ...manifest.migrations.map((entry) => entry.symbol),
  ]);
  if (reconstructedRuntime.length !== manifest.baseline.runtimeCount || digest(reconstructedRuntime) !== manifest.baseline.runtimeSha256) {
    failures.push("manifest does not partition the reviewed baseline runtime surface");
  }
  if (
    reconstructedDeclarations.length !== manifest.baseline.declarationCount ||
    digest(reconstructedDeclarations) !== manifest.baseline.declarationSha256
  ) {
    failures.push("manifest does not partition the reviewed baseline declaration surface");
  }

  const replacements = sorted(manifest.migrations.map((entry) => entry.replacement));
  const replacementRuntime = await runtimeExports(replacements);
  const replacementDeclarations = new Map(
    replacements.map((packageName) => {
      const subpath = packageName === packageJson.name ? "." : `.${packageName.slice(packageJson.name.length)}`;
      return [
        packageName,
        declarationExports(path.join(root, packageJson.exports[subpath].types.replace(/^\.\//, ""))),
      ];
    }),
  );
  for (const migration of manifest.migrations) {
    const available =
      migration.kind === "runtime"
        ? replacementRuntime.get(migration.replacement)?.has(migration.symbol)
        : replacementDeclarations.get(migration.replacement)?.has(migration.symbol);
    if (!available) failures.push(`${migration.replacement} does not export moved ${migration.kind} ${migration.symbol}`);
  }
  for (const [file, expected] of generatedArtifacts(manifest)) {
    const actual = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
    if (actual !== expected) failures.push(`${path.relative(root, file)} is out of date`);
  }
  if (failures.length > 0) {
    process.stderr.write(`Root-surface verification FAILED:\n${failures.map((entry) => `  - ${entry}`).join("\n")}\n`);
    process.exit(1);
  }
  process.stdout.write(
    `rootSurface=ok runtime=${builtRuntime.length} declarations=${builtDeclarations.length} moved=${manifest.migrations.length} replacements=${replacements.length}\n`,
  );
}

if (process.argv.includes("--initialize")) await initialize();
else if (process.argv.includes("--write-artifacts")) {
  writeArtifacts(JSON.parse(fs.readFileSync(manifestPath, "utf8")));
} else await check();
