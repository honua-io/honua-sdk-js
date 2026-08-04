#!/usr/bin/env node

/**
 * Generate the zero-install playground project for every qualifying gallery
 * sample (#958 REQ-001, the S2 half of the scaffold work).
 *
 * A gallery sample cannot be opened in StackBlitz or CodeSandbox as it sits in
 * `examples/`: those projects build through the repository's Vite configs,
 * which alias `@honua/sdk-js` onto the repository's own `src/` tree, so a
 * browser playground cloning the directory alone would have nothing to
 * resolve. This script emits a *standalone* project per qualifying sample —
 * same committed source, a plain Vite config, and a package.json pinned to the
 * published packages — under `playgrounds/<id>/`, and derives the provider
 * links from that directory.
 *
 * Following `scripts/build-sample-bundles.mjs` (#656), every catalog entry gets
 * exactly one decision and every exclusion carries a machine-readable category,
 * so "sample X has no playground" is always an answered question rather than an
 * omission. The qualification is derived, not asserted: the audited
 * `runtimeHosting` verdict already recorded for the bundle gallery supplies the
 * data-origin dimension, and everything else is read from the sample's own
 * committed source (its imports, its assets, its Vite config).
 *
 * Run with:
 *   npm run samples:playgrounds:generate   # write projects + catalog overlay
 *   npm run samples:playgrounds:check      # fail on drift
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadTemplateManifest, playgroundUrl } from "../packages/create-honua-app/lib/templates.mjs";
import { SAMPLE_BUNDLE_AUDIT } from "./build-sample-bundles.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGE_ROOT = path.join(ROOT, "packages/create-honua-app");
const CATALOG_PATH = "samples/catalog.v2.json";
const OVERLAY_PATH = "samples/contract/v2/migrations/catalog.v1-to-v2.json";
const PLAYGROUND_ROOT = "playgrounds";
const ARTIFACT_PATH = "samples/dist/sample-playgrounds.v1.json";
const ARTIFACT_SCHEMA_PATH = "samples/contract/v2/schemas/sample-playgrounds.schema.json";
export const ARTIFACT_FORMAT = "honua.sdk.sample-playgrounds.v1";

/** Machine-readable exclusion categories, one per reason a sample cannot ship a playground. */
export const PLAYGROUND_EXCLUSION_CATEGORIES = [
  "lifecycle-not-active",
  "unsupported-support-tier",
  "audit-pending",
  "requires-data-origin",
  "shared-repository-source",
  "repository-vite-kit",
  "unpublished-entrypoint",
  "unpinned-dependency",
  "binary-asset",
  "browser-configuration",
];

/** Catalog support tiers that may never gain a new public runnable surface (mirrors #656). */
const INELIGIBLE_SUPPORT_TIERS = new Set(["internal", "deprecated"]);

/**
 * Published versions a generated playground may depend on. A sample whose
 * source imports anything outside this table is excluded rather than pinned to
 * a guess — the playground has to install from the registry, so every bare
 * specifier needs a version somebody reviewed.
 *
 * The SDK pin is not repeated here: it is read from the scaffold's template
 * manifest so the starters and the sample playgrounds can never drift onto
 * different published SDK releases.
 */
const PINNED_DEPENDENCIES = Object.freeze({
  "maplibre-gl": "5.24.0",
  "@bufbuild/protobuf": "2.13.0",
  "@connectrpc/connect": "2.1.2",
  "@connectrpc/connect-web": "2.1.2",
});

/**
 * Peers the published SDK's own modules import statically. They are installed
 * in every playground for the same reason the scaffold templates pin them: a
 * bundler resolves the SDK's transport module whether or not the app calls it.
 */
const ALWAYS_INSTALLED = ["@bufbuild/protobuf", "@connectrpc/connect", "@connectrpc/connect-web"];

const PINNED_DEV_DEPENDENCIES = Object.freeze({
  "@types/node": "24.13.3",
  typescript: "5.9.3",
  vite: "8.2.0",
});

/**
 * Shared example sources a playground may carry a copy of, with the specifier
 * rewrite that makes the copy resolve. Each entry is a file that imports no
 * repository code of its own, so copying it is a move, not a fork; anything
 * else that escapes the sample directory excludes the sample instead.
 */
const COPYABLE_SHARED_SOURCES = new Map([
  [
    "../../shared/maplibre-vite-worker.js",
    {
      source: "examples/shared/maplibre-vite-worker.ts",
      target: "src/maplibre-vite-worker.ts",
      rewrite: "./maplibre-vite-worker.js",
    },
  ],
]);

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".css", ".html", ".json", ".svg", ".txt", ".md"]);
const IMPORT_PATTERN = /(?:^|[^\w$])(?:import|export)\s*(?:[\w*{}\n\r\t, $]*?from\s*)?["']([^"']+)["']/g;
const DYNAMIC_IMPORT_PATTERN = /\bimport\(\s*["']([^"']+)["']\s*\)/g;
const HTML_MODULE_PATTERN = /<script[^>]*\ssrc=["']([^"']+)["']/g;
const ENV_PATTERN = /import\.meta\.env\.(VITE_[A-Z0-9_]+)/g;
const SDK_PACKAGE = "@honua/sdk-js";

function readJson(file) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, file), "utf8"));
}

function listFiles(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs
    .readdirSync(directory, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))
    .flatMap((entry) => {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) return listFiles(full);
      return entry.isFile() ? [full] : [];
    });
}

/** Bare npm specifiers one file imports. */
export function bareImportsOfFile(file) {
  const text = fs.readFileSync(file, "utf8");
  const specifiers = new Set();
  for (const [, specifier] of text.matchAll(IMPORT_PATTERN)) specifiers.add(specifier);
  for (const [, specifier] of text.matchAll(DYNAMIC_IMPORT_PATTERN)) specifiers.add(specifier);
  return [...specifiers].filter((specifier) => !specifier.startsWith(".") && !specifier.startsWith("/")).sort();
}

/** Read the committed source a playground would carry, and everything it references. */
export function analyzeSampleSource(sampleRoot) {
  const sourceFiles = listFiles(path.join(sampleRoot, "src")).map((file) => path.relative(sampleRoot, file));
  const indexHtml = fs.existsSync(path.join(sampleRoot, "index.html")) ? ["index.html"] : [];
  const files = [...indexHtml, ...sourceFiles];
  const specifiers = new Set();
  const envVars = new Set();
  const binaryFiles = [];
  for (const relative of files) {
    if (!SOURCE_EXTENSIONS.has(path.extname(relative))) {
      binaryFiles.push(relative);
      continue;
    }
    const text = fs.readFileSync(path.join(sampleRoot, relative), "utf8");
    for (const [, specifier] of text.matchAll(IMPORT_PATTERN)) specifiers.add(specifier);
    for (const [, specifier] of text.matchAll(DYNAMIC_IMPORT_PATTERN)) specifiers.add(specifier);
    if (relative.endsWith(".html")) {
      for (const [, specifier] of text.matchAll(HTML_MODULE_PATTERN)) specifiers.add(specifier);
    }
    for (const [, name] of text.matchAll(ENV_PATTERN)) envVars.add(name);
  }
  const publicFiles = listFiles(path.join(sampleRoot, "public")).map((file) => path.relative(sampleRoot, file));
  return {
    files,
    publicFiles,
    binaryFiles: [...binaryFiles, ...publicFiles.filter((file) => !SOURCE_EXTENSIONS.has(path.extname(file)))],
    escapingImports: [...specifiers].filter((specifier) => specifier.startsWith("../")).sort(),
    bareImports: [...specifiers].filter((specifier) => !specifier.startsWith(".") && !specifier.startsWith("/")).sort(),
    envVars: [...envVars].sort(),
  };
}

/** Public entrypoints of the SDK, read from the manifest that declares what ships. */
export function publishedSdkEntrypoints(rootManifest) {
  return new Set(
    Object.keys(rootManifest.exports ?? {}).map((key) => (key === "." ? SDK_PACKAGE : `${SDK_PACKAGE}/${key.slice(2)}`)),
  );
}

/** Strip a CSS/asset suffix so `maplibre-gl/dist/maplibre-gl.css` resolves to its package. */
export function bareSpecifierPackage(specifier) {
  const segments = specifier.split("/");
  return specifier.startsWith("@") ? segments.slice(0, 2).join("/") : segments[0];
}

/**
 * One decision per catalog sample: a playground project, or a categorized
 * exclusion. Everything except the data-origin verdict is derived from the
 * sample's own committed tree.
 */
export function evaluateSamplePlaygroundEligibility(sample, context) {
  const exclude = (category, detail) => ({ id: sample.id, qualified: false, category, detail });
  if (sample.lifecycle.state !== "active") {
    return exclude("lifecycle-not-active", `Catalog lifecycle is ${sample.lifecycle.state}.`);
  }
  if (INELIGIBLE_SUPPORT_TIERS.has(sample.supportTier)) {
    return exclude("unsupported-support-tier", `Support tier ${sample.supportTier} may not gain a public runnable surface.`);
  }
  const audit = context.audit.get(sample.id);
  if (!audit) return exclude("audit-pending", "No audited runtime-hosting verdict for this active sample.");
  if (audit.runtimeHosting !== "self-contained") {
    return exclude(
      "requires-data-origin",
      `Audited runtimeHosting is ${audit.runtimeHosting}; a playground would need a generated data origin.`,
    );
  }

  // Structural truth first, in the spirit of scripts/build-sample-bundles.mjs:
  // "this project cannot be built outside the repository at all" is more
  // fundamental than any single import it happens to make.
  const viteConfig = fs.readFileSync(path.join(ROOT, sample.sourcePath, "vite.config.ts"), "utf8");
  if (viteConfig.includes("_kit/vite.config") || viteConfig.includes("createSampleViteConfig")) {
    return exclude("repository-vite-kit", "Builds through the shared example kit rather than a plain Vite config.");
  }

  const analysis = context.analyze(path.join(ROOT, sample.sourcePath));
  const unshareable = analysis.escapingImports.filter((specifier) => !COPYABLE_SHARED_SOURCES.has(specifier));
  if (unshareable.length > 0) {
    return exclude(
      "shared-repository-source",
      `Source imports repository files outside the sample: ${unshareable.join(", ")}.`,
    );
  }
  const sharedSources = analysis.escapingImports.map((specifier) => ({
    from: specifier,
    ...COPYABLE_SHARED_SOURCES.get(specifier),
  }));
  const bareImports = [...analysis.bareImports];
  for (const shared of sharedSources) {
    for (const specifier of bareImportsOfFile(path.join(ROOT, shared.source))) {
      if (!bareImports.includes(specifier)) bareImports.push(specifier);
    }
  }
  if (analysis.binaryFiles.length > 0) {
    return exclude("binary-asset", `Needs committed non-source assets: ${analysis.binaryFiles.join(", ")}.`);
  }
  if (analysis.envVars.length > 0) {
    return exclude("browser-configuration", `Default lane reads browser configuration: ${analysis.envVars.join(", ")}.`);
  }

  const dependencies = {};
  for (const specifier of bareImports) {
    if (specifier === SDK_PACKAGE || specifier.startsWith(`${SDK_PACKAGE}/`)) {
      if (!context.sdkEntrypoints.has(specifier)) {
        return exclude("unpublished-entrypoint", `${specifier} is not a published SDK entrypoint.`);
      }
      dependencies[SDK_PACKAGE] = context.sdkVersion;
      continue;
    }
    const packageName = bareSpecifierPackage(specifier);
    const pin = PINNED_DEPENDENCIES[packageName];
    if (!pin) return exclude("unpinned-dependency", `${packageName} has no reviewed published pin.`);
    dependencies[packageName] = pin;
  }
  for (const packageName of ALWAYS_INSTALLED) dependencies[packageName] = PINNED_DEPENDENCIES[packageName];

  return {
    id: sample.id,
    qualified: true,
    projectPath: `${PLAYGROUND_ROOT}/${sample.id}`,
    files: analysis.files,
    sharedSources,
    dependencies: Object.fromEntries(Object.entries(dependencies).sort(([left], [right]) => left.localeCompare(right))),
    auditedVia: audit.auditedVia,
  };
}

/** Every catalog sample's decision, in catalog order. */
export function derivePlaygroundDecisions(catalog, context) {
  return catalog.samples
    .filter((sample) => sample.sourceKind === "root-example")
    .map((sample) => evaluateSamplePlaygroundEligibility(sample, context));
}

function projectPackageJson(decision, sample) {
  return `${JSON.stringify(
    {
      name: `honua-playground-${sample.id}`,
      private: true,
      version: "0.0.0",
      type: "module",
      description: `Zero-install playground generated from examples/${sample.id}.`,
      engines: { node: ">=20.19.0" },
      scripts: { dev: "vite", build: "vite build", preview: "vite preview", typecheck: "tsc --noEmit" },
      dependencies: decision.dependencies,
      devDependencies: PINNED_DEV_DEPENDENCIES,
    },
    null,
    2,
  )}\n`;
}

function projectTsconfig(hasTsx) {
  return `${JSON.stringify(
    {
      compilerOptions: {
        target: "ES2022",
        module: "ESNext",
        moduleResolution: "Bundler",
        strict: true,
        noEmit: true,
        skipLibCheck: true,
        verbatimModuleSyntax: true,
        allowSyntheticDefaultImports: true,
        ...(hasTsx ? { jsx: "react-jsx" } : {}),
        types: ["vite/client", "node"],
      },
      include: hasTsx ? ["src/**/*.ts", "src/**/*.tsx", "vite.config.ts"] : ["src/**/*.ts", "vite.config.ts"],
    },
    null,
    2,
  )}\n`;
}

function projectViteConfig(sample) {
  return `// Generated from examples/${sample.id} by scripts/sample-playgrounds.mjs.
// The repository build aliases @honua/sdk-js onto src/; a playground resolves
// the published package from node_modules instead, so no alias is needed.
import { defineConfig } from "vite";

export default defineConfig({
  server: { host: "127.0.0.1" },
  preview: { host: "127.0.0.1" },
  build: { outDir: "dist", emptyOutDir: true },
});
`;
}

function projectReadme(sample, decision, links) {
  const providerLines = links.map((link) => `- [Open in ${link.title}](${link.url})`).join("\n");
  return `# ${sample.title} — zero-install playground

<!-- Generated from examples/${sample.id} by scripts/sample-playgrounds.mjs. Do not edit by hand. -->

${sample.summary}

${providerLines}

## Run it locally

\`\`\`bash
npm install
npm run dev
\`\`\`

This project carries the same committed source as
[\`examples/${sample.id}\`](../../examples/${sample.id}), with one difference: it resolves
\`${SDK_PACKAGE}\` from the published package instead of the repository's \`src/\` tree, so it
runs anywhere npm does — including a browser playground. Its data comes from its own committed
source, so the default lane needs no account, no key, and no third-party request.

Edit the sample in \`examples/${sample.id}\` and run \`npm run samples:playgrounds:generate\`;
editing this copy directly fails \`npm run samples:playgrounds:check\`.
`;
}

const STACKBLITZ_RC = `{
  "installDependencies": true,
  "startCommand": "npm run dev"
}
`;

/** Files a qualifying sample's playground project is made of, as path -> contents. */
export function renderPlaygroundProject(sample, decision, links) {
  const sampleRoot = path.join(ROOT, sample.sourcePath);
  const files = new Map();
  for (const relative of decision.files) {
    let contents = fs.readFileSync(path.join(sampleRoot, relative), "utf8");
    // The only edit a copied source receives: an escaping shared-module
    // specifier is repointed at the copy carried beside it.
    for (const shared of decision.sharedSources) contents = contents.split(shared.from).join(shared.rewrite);
    files.set(relative, contents);
  }
  for (const shared of decision.sharedSources) {
    files.set(shared.target, fs.readFileSync(path.join(ROOT, shared.source), "utf8"));
  }
  files.set("package.json", projectPackageJson(decision, sample));
  files.set("tsconfig.json", projectTsconfig(decision.files.some((file) => file.endsWith(".tsx"))));
  files.set("vite.config.ts", projectViteConfig(sample));
  files.set("README.md", projectReadme(sample, decision, links));
  files.set(".stackblitzrc", STACKBLITZ_RC);
  return files;
}

function providerLinks(manifest, projectPath) {
  return manifest.playgroundProviders.map((provider) => ({
    id: provider.id,
    title: provider.title,
    url: playgroundUrl(provider, {
      owner: manifest.repository.owner,
      repository: manifest.repository.name,
      branch: manifest.repository.branch,
      path: projectPath,
    }),
  }));
}

/** The catalog overlay value a qualifying sample carries. */
export function playgroundCatalogEntry(decision, links) {
  return { projectPath: decision.projectPath, providers: links.map((link) => ({ ...link })) };
}

/**
 * The published decision list.
 *
 * This is a standalone artifact rather than a member of the site projection on
 * purpose: `site-projection.schema.json` is content-addressed by the committed
 * consumer handoff (`inputs.siteProjection.schemaBytes`/`schemaSha256`), so
 * adding even an optional property to it is a coordinated version bump that
 * `samples/contract/v2/README.md` reserves for the derived-artifact automation
 * and a honua-site migration. A new, unpinned artifact carries the same
 * information additively: consumers that want playground links read this file,
 * and the projection contract is untouched.
 */
export function renderPlaygroundArtifact(decisions, catalogEntries, sdkVersion) {
  return {
    $schema: "../contract/v2/schemas/sample-playgrounds.schema.json",
    format: ARTIFACT_FORMAT,
    schemaVersion: 1,
    sdk: { package: "@honua/sdk-js", version: sdkVersion },
    playgrounds: decisions
      .filter((decision) => decision.qualified)
      .map((decision) => ({ sampleId: decision.id, ...catalogEntries.get(decision.id) })),
    excluded: decisions
      .filter((decision) => !decision.qualified)
      .map((decision) => ({ sampleId: decision.id, category: decision.category, detail: decision.detail })),
  };
}

function validateArtifact(artifact) {
  const require_ = createRequire(import.meta.url);
  const Ajv2020 = require_("ajv/dist/2020").default;
  const addFormats = require_("ajv-formats").default;
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  const schema = readJson(ARTIFACT_SCHEMA_PATH);
  const validate = ajv.compile(schema);
  if (validate(artifact)) return;
  const detail = (validate.errors ?? []).map((error) => `${error.instancePath} ${error.message}`).join("; ");
  throw new Error(`${ARTIFACT_PATH} does not satisfy ${ARTIFACT_SCHEMA_PATH}: ${detail}`);
}

function stableJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function collectPlan() {
  const catalog = readJson(CATALOG_PATH);
  const manifest = loadTemplateManifest(PACKAGE_ROOT);
  const context = {
    audit: new Map(SAMPLE_BUNDLE_AUDIT.map((record) => [record.id, record])),
    analyze: analyzeSampleSource,
    sdkEntrypoints: publishedSdkEntrypoints(readJson("package.json")),
    sdkVersion: manifest.sdk.version,
  };
  const decisions = derivePlaygroundDecisions(catalog, context);
  const files = new Map();
  const catalogEntries = new Map();
  for (const decision of decisions) {
    if (!decision.qualified) continue;
    const sample = catalog.samples.find((entry) => entry.id === decision.id);
    const links = providerLinks(manifest, decision.projectPath);
    for (const [relative, contents] of renderPlaygroundProject(sample, decision, links)) {
      files.set(path.posix.join(decision.projectPath, relative), contents);
    }
    catalogEntries.set(decision.id, playgroundCatalogEntry(decision, links));
  }
  return { catalog, decisions, files, catalogEntries, sdkVersion: manifest.sdk.version };
}

/** Overlay updates so the generated links reach the catalog through its reviewed migration. */
function applyOverlay(catalogEntries) {
  const overlay = readJson(OVERLAY_PATH);
  let changed = false;
  for (const [id, override] of Object.entries(overlay.sampleOverrides)) {
    const entry = catalogEntries.get(id);
    const current = override.playground;
    const next = entry ? stableJson(entry) : undefined;
    if ((current === undefined ? undefined : stableJson(current)) === next) continue;
    changed = true;
    if (entry) override.playground = entry;
    else delete override.playground;
  }
  return { overlay, changed };
}

function reportDrift(problems) {
  process.stderr.write("sample playgrounds have drifted from the committed samples:\n");
  for (const problem of problems) process.stderr.write(`- ${problem}\n`);
  process.stderr.write("Run npm run samples:playgrounds:generate\n");
  process.exit(1);
}

function main() {
  const mode = process.argv[2] ?? "check";
  if (mode !== "write" && mode !== "check") {
    process.stderr.write("Usage: node scripts/sample-playgrounds.mjs [write|check]\n");
    process.exit(1);
  }
  const { decisions, files, catalogEntries, sdkVersion } = collectPlan();
  const qualified = decisions.filter((decision) => decision.qualified);
  for (const decision of decisions) {
    if (decision.qualified) continue;
    if (!PLAYGROUND_EXCLUSION_CATEGORIES.includes(decision.category)) {
      process.stderr.write(`unknown exclusion category ${decision.category} for ${decision.id}\n`);
      process.exit(1);
    }
  }
  const { overlay, changed: overlayChanged } = applyOverlay(catalogEntries);
  const artifact = renderPlaygroundArtifact(decisions, catalogEntries, sdkVersion);
  validateArtifact(artifact);
  const artifactBytes = stableJson(artifact);

  if (mode === "write") {
    fs.rmSync(path.join(ROOT, PLAYGROUND_ROOT), { recursive: true, force: true });
    for (const [relative, contents] of files) {
      const target = path.join(ROOT, relative);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, contents);
    }
    if (overlayChanged) fs.writeFileSync(path.join(ROOT, OVERLAY_PATH), stableJson(overlay));
    fs.writeFileSync(path.join(ROOT, ARTIFACT_PATH), artifactBytes);
    process.stdout.write(
      `samplePlaygroundsWritten=${qualified.length} excluded=${decisions.length - qualified.length}${
        overlayChanged ? " overlay=updated (run npm run samples:migrate:v1)" : ""
      }\n`,
    );
    return;
  }

  const problems = [];
  // Tracked files only: a local `npm install` inside a playground must not be
  // mistaken for generator output.
  const listed = execFileSync("git", ["ls-files", "--", PLAYGROUND_ROOT], { cwd: ROOT, encoding: "utf8" });
  const committed = new Set(listed.split("\n").filter((line) => line.length > 0));
  for (const [relative, contents] of files) {
    if (!committed.has(relative)) {
      problems.push(`${relative} is missing`);
      continue;
    }
    if (fs.readFileSync(path.join(ROOT, relative), "utf8") !== contents) problems.push(`${relative} has drifted`);
  }
  for (const relative of committed) {
    if (!files.has(relative)) problems.push(`${relative} is not generated by any qualifying sample`);
  }
  if (overlayChanged) problems.push(`${OVERLAY_PATH} playground entries have drifted`);
  const committedArtifact = fs.existsSync(path.join(ROOT, ARTIFACT_PATH))
    ? fs.readFileSync(path.join(ROOT, ARTIFACT_PATH), "utf8")
    : "";
  if (committedArtifact !== artifactBytes) problems.push(`${ARTIFACT_PATH} has drifted`);
  if (problems.length > 0) reportDrift(problems);

  process.stdout.write(`samplePlaygrounds=ok qualified=${qualified.length} excluded=${decisions.length - qualified.length}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
