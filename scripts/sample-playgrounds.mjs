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
 * A sample audited `same-origin-fixture-service` gets its data from a Node mock
 * server the repository runs beside it, which a browser playground has no way to
 * start. `PLAYGROUND_FIXTURE_ORIGINS` closes that gap the way the scaffold
 * starters already do: the generated project serves the reviewed fixture pack
 * from its own Vite dev/preview server, so the default lane still needs no
 * account, no key, and no third-party request.
 *
 * The links a reader reaches for live in three places, all written from this one
 * derivation: the catalog overlay (what a gallery card renders), the standalone
 * artifact below, and a managed block in the sample's own
 * `examples/<id>/README.md` (#958 REQ-001) — nobody hand-maintains a playground
 * URL, so none of them can go stale.
 *
 * Run with:
 *   npm run samples:playgrounds:generate   # write projects + catalog overlay + sample READMEs
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

/**
 * Managed region in a sample's own README (#958 REQ-001's second half).
 *
 * The markers are the anchor, not the content: once a block exists, only the
 * text between them is generated, so a maintainer may move the call to action
 * wherever it reads best without the generator putting it back. A sample that
 * newly qualifies has no markers yet, so `write` inserts the block at the end of
 * the introduction; a sample that stops qualifying has its block removed rather
 * than left pointing at a project that no longer exists.
 */
export const SAMPLE_README_START = "<!-- sample-playground:start -->";
export const SAMPLE_README_END = "<!-- sample-playground:end -->";

/** Machine-readable exclusion categories, one per reason a sample cannot ship a playground. */
export const PLAYGROUND_EXCLUSION_CATEGORIES = [
  "lifecycle-not-active",
  "unsupported-support-tier",
  "audit-pending",
  "requires-data-origin",
  "shared-repository-source",
  "repository-vite-kit",
  "unpublished-entrypoint",
  "unreleased-sdk-surface",
  "unpinned-dependency",
  "binary-asset",
  "browser-configuration",
];

/** Catalog support tiers that may never gain a new public runnable surface (mirrors #656). */
const INELIGIBLE_SUPPORT_TIERS = new Set(["internal", "deprecated"]);

/**
 * Source changes that are valid in this checkout but absent from a currently
 * pinned public SDK release. These samples remain internal source-mode evidence
 * until the template pin advances and the generator re-evaluates them.
 */
export const UNRELEASED_PLAYGROUND_SDK_SURFACES = new Map([
  [
    "columnar-query-quickstart",
    {
      unavailableVersions: ["0.1.4-beta.0"],
      surface: "createApacheArrowResponseDecoder({ importModule })",
    },
  ],
  [
    "stac-imagery-browser",
    {
      unavailableVersions: ["0.1.4-beta.0"],
      surface: "@honua/sdk-js/stac and @honua/sdk-js/pmtiles",
    },
  ],
  [
    "coverages-wcs-basic",
    {
      unavailableVersions: ["0.1.4-beta.0"],
      surface: "@honua/sdk-js/coverages",
    },
  ],
]);

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
  // The MapLibre major this repository's example sources are written against.
  // `examples/shared/maplibre-vite-worker.ts`, which every map sample carries a
  // copy of, imports `setWorkerUrl` and `maplibre-gl/dist/maplibre-gl-worker.mjs`
  // — both v6-only — so a playground pinned to v5 fails to resolve the module at
  // all. The scaffold starters carry the same shim and the same pin
  // (`packages/create-honua-app/templates/*/src/maplibre-worker.ts`), so a
  // reader who scaffolds and a reader who opens a playground get one renderer.
  "maplibre-gl": "6.1.0",
  "apache-arrow": "17.0.0",
  "@bufbuild/protobuf": "2.13.0",
  "@connectrpc/connect": "2.1.2",
  "@connectrpc/connect-web": "2.1.2",
  react: "19.2.8",
  "react-dom": "19.2.8",
  // The SDK's geometry module wraps one `@turf/*` package per operation and
  // imports every one of them statically; see ALWAYS_INSTALLED.
  "@turf/area": "7.3.5",
  "@turf/bbox": "7.3.5",
  "@turf/boolean-contains": "7.3.5",
  "@turf/boolean-intersects": "7.3.5",
  "@turf/boolean-within": "7.3.5",
  "@turf/buffer": "7.3.5",
  "@turf/centroid": "7.3.5",
  "@turf/convex": "7.3.5",
  "@turf/difference": "7.3.5",
  "@turf/helpers": "7.3.5",
  "@turf/intersect": "7.3.5",
  "@turf/length": "7.3.5",
  "@turf/nearest-point": "7.3.5",
  "@turf/simplify": "7.3.5",
  "@turf/union": "7.3.5",
  "terra-draw": "1.32.0",
  "terra-draw-maplibre-gl-adapter": "1.4.1",
});

/**
 * Optional peers a sample loads at runtime rather than importing statically.
 *
 * The dependency derivation reads the sample's own import statements, which is
 * exactly right for everything a bundler resolves — but an SDK factory that
 * `import()`s an optional peer on demand leaves no static specifier to find.
 * The playground then installs, builds and mounts a map whose feature never
 * initialises, which is a worse link than none. Each entry is the peer set one
 * sample's own README already names as required for its lane.
 */
const SAMPLE_RUNTIME_PEERS = new Map([
  ["sketch-editing", ["terra-draw", "terra-draw-maplibre-gl-adapter"]],
]);

/**
 * Type packages a pinned runtime dependency needs before the generated project
 * can run its own `npm run typecheck`. They are installed only when the sample
 * actually imports the runtime package, so a vanilla playground never grows
 * React types it has no use for.
 */
const PINNED_TYPE_DEPENDENCIES = Object.freeze({
  react: { "@types/react": "19.2.18" },
  "react-dom": { "@types/react-dom": "19.2.4" },
});

/**
 * Peers the published SDK's own modules import statically. They are installed
 * in every playground for the same reason the scaffold templates pin them: a
 * bundler resolves the SDK's transport module whether or not the app calls it.
 *
 * The `@turf/*` packages are here for exactly that reason and no other. They are
 * *optional* peers, so an app that never calls a geometry operation should not
 * need them — but `@honua/sdk-js`'s geometry module imports all fifteen with
 * static named imports, and any entrypoint whose module graph reaches it drags
 * them in. Left uninstalled, Vite substitutes an optional-peer stub with no
 * named exports and the production build fails with `MISSING_EXPORT`, which is
 * how this list was found (see .github/workflows/sample-playground-live.yml).
 */
const ALWAYS_INSTALLED = [
  "@bufbuild/protobuf",
  "@connectrpc/connect",
  "@connectrpc/connect-web",
  "@turf/area",
  "@turf/bbox",
  "@turf/boolean-contains",
  "@turf/boolean-intersects",
  "@turf/boolean-within",
  "@turf/buffer",
  "@turf/centroid",
  "@turf/convex",
  "@turf/difference",
  "@turf/helpers",
  "@turf/intersect",
  "@turf/length",
  "@turf/nearest-point",
  "@turf/simplify",
  "@turf/union",
];

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

/** Directory a generated playground keeps its committed fixture documents in. */
const FIXTURE_DIRECTORY = "fixtures";

/**
 * Generated data origins, one per sample whose data comes from a repository
 * process a playground cannot start (#958 S3).
 *
 * A sample audited `same-origin-fixture-service` is served by `mock-server.mjs`
 * on the sample's own origin; StackBlitz has no such process, which is why the
 * S2 pass excluded all of them as `requires-data-origin`. The scaffold starters
 * already solved exactly this for `create-honua-app`: carry the reviewed First
 * Map fixture in the project and answer the routes from the project's own Vite
 * server. This table applies the same move to a gallery sample.
 *
 * Each entry is reviewed, but nothing here is taken on trust:
 *
 *  - every declared route must sit under one of the sample's audited
 *    `hostFixtureRoutes`, and every audited route must be covered by a declared
 *    one, so this table cannot answer a route the audit never established nor
 *    quietly drop one the sample needs;
 *  - every document is copied byte-identically out of the reviewed fixture pack
 *    (`samples/fixtures/<pack>/v1`), the same discipline
 *    `scripts/verify-create-honua-app.mjs` holds the starters to;
 *  - `sampleDocument` names the file the sample's *own* fixture lane serves for
 *    that route; the generator fails unless it carries the same JSON value, so a
 *    playground can never show data the reviewed sample does not;
 *  - `env` is the reviewed fixture-lane browser configuration (the sample's
 *    `FIXTURE_BUILD_ENV`), written into the project so its default lane is the
 *    qualified lane rather than whatever the source happens to default to.
 */
export const PLAYGROUND_FIXTURE_ORIGINS = new Map([
  [
    "react-quickstart",
    {
      pack: "samples/fixtures/first-map/v1",
      routes: [
        {
          path: "/api/v1/admin/capabilities",
          document: "capabilities.json",
          sampleDocument: "test/fixtures/honua-quickstart-demo/capabilities.json",
        },
        {
          path: "/rest/services/natural-earth/FeatureServer/0/query",
          document: "features.json",
          sampleDocument: "test/fixtures/honua-quickstart-demo/query-features.json",
        },
      ],
      env: {
        VITE_HONUA_REACT_BASE_URL: "",
        VITE_HONUA_REACT_LAYER_ID: "0",
        VITE_HONUA_REACT_SERVICE_ID: "natural-earth",
        VITE_HONUA_REACT_WHERE: "1=1",
      },
    },
  ],
]);

/**
 * Names and values a generated `.env` may never carry. A playground is a public
 * project directory, so the one thing this generator must never learn to do is
 * commit a credential; a declaration that looks like one fails the run instead
 * of shipping.
 */
const SECRET_SHAPED_ENV_NAME = /(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|BEARER)/;
const MAX_ENV_VALUE_LENGTH = 64;

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".css", ".html", ".json", ".svg", ".txt", ".md"]);
const IMPORT_PATTERN = /(?:^|[^\w$])(?:import|export)\s*(?:[\w*{}\n\r\t, $]*?from\s*)?["']([^"']+)["']/g;
const DYNAMIC_IMPORT_PATTERN = /\bimport\(\s*["']([^"']+)["']\s*\)/g;
const HTML_MODULE_PATTERN = /<script[^>]*\ssrc=["']([^"']+)["']/g;
const ENV_PATTERN = /import\.meta\.env\.(VITE_[A-Z0-9_]+)/g;
const SDK_PACKAGE = "@honua/sdk-js";

function readJson(file) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, file), "utf8"));
}

function fileExists(file) {
  return fs.existsSync(path.join(ROOT, file));
}

/** Normalize filesystem-relative paths before they enter generated JSON or diagnostics. */
export function portableRelativePath(file) {
  return file.split(path.win32.sep).join(path.posix.sep);
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
  const sourceFiles = listFiles(path.join(sampleRoot, "src")).map((file) => portableRelativePath(path.relative(sampleRoot, file)));
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
  const publicFiles = listFiles(path.join(sampleRoot, "public")).map((file) =>
    portableRelativePath(path.relative(sampleRoot, file)),
  );
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
 * Resolve, and prove, the generated data origin declared for one sample.
 *
 * Returns `undefined` when no origin is declared — the sample keeps its
 * `requires-data-origin` exclusion. A declaration that does not agree with the
 * audit or with the reviewed fixtures throws: this table is repository
 * configuration, so a wrong entry is a bug to fix, never a sample to drop.
 */
export function resolveFixtureOrigin(sample, audit, { readJson: read = readJson, exists = fileExists } = {}) {
  const declaration = PLAYGROUND_FIXTURE_ORIGINS.get(sample.id);
  if (!declaration) return undefined;
  const fail = (message) => {
    throw new Error(`playground fixture origin for ${sample.id}: ${message}`);
  };
  const auditedRoutes = audit.hostFixtureRoutes ?? [];
  if (auditedRoutes.length === 0) {
    fail(`the audited ${audit.runtimeHosting} verdict declares no hostFixtureRoutes to serve`);
  }
  const documents = [];
  for (const route of declaration.routes) {
    if (!auditedRoutes.some((audited) => route.path === audited || route.path.startsWith(`${audited}/`))) {
      fail(`route ${route.path} is outside the audited hostFixtureRoutes (${auditedRoutes.join(", ")})`);
    }
    const packDocument = `${declaration.pack}/${route.document}`;
    if (!exists(packDocument)) fail(`${packDocument} is not a committed fixture document`);
    if (!exists(route.sampleDocument)) fail(`${route.sampleDocument} is not a committed fixture document`);
    // The playground must show what the reviewed sample shows. The pack is the
    // byte source (one reviewed copy for every generated project); the sample's
    // own lane document is the equality witness.
    if (stableJson(read(packDocument)) !== stableJson(read(route.sampleDocument))) {
      fail(`${packDocument} and ${route.sampleDocument} describe different data for ${route.path}`);
    }
    documents.push({ source: packDocument, target: `${FIXTURE_DIRECTORY}/${route.document}` });
  }
  for (const audited of auditedRoutes) {
    if (!declaration.routes.some((route) => route.path === audited || route.path.startsWith(`${audited}/`))) {
      fail(`audited route ${audited} has no declared fixture document`);
    }
  }
  const env = Object.entries(declaration.env ?? {});
  for (const [name, value] of env) {
    if (!/^VITE_[A-Z0-9_]+$/.test(name)) fail(`${name} is not a Vite browser configuration name`);
    if (SECRET_SHAPED_ENV_NAME.test(name)) fail(`${name} is credential-shaped and may not be committed`);
    if (typeof value !== "string" || value.length > MAX_ENV_VALUE_LENGTH || /[\s"'#\\]/.test(value)) {
      fail(`${name} must be a short, plain, quote-free value`);
    }
  }
  return {
    pack: declaration.pack,
    routes: declaration.routes.map(({ path: route, document }) => ({ path: route, document })),
    documents,
    env: Object.fromEntries(env.sort(([left], [right]) => left.localeCompare(right))),
  };
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
  const unreleasedSurface = UNRELEASED_PLAYGROUND_SDK_SURFACES.get(sample.id);
  if (unreleasedSurface?.unavailableVersions.includes(context.sdkVersion)) {
    return exclude(
      "unreleased-sdk-surface",
      `${unreleasedSurface.surface} is not published by ${SDK_PACKAGE}@${context.sdkVersion}; ` +
        "the repository sample remains source-mode evidence until a post-merge SDK release is pinned and regenerated.",
    );
  }
  // Data first: a project that cannot answer its own requests is not a
  // playground, whatever else is true of its source.
  const resolveOrigin = context.resolveFixtureOrigin ?? resolveFixtureOrigin;
  const fixtureOrigin = audit.runtimeHosting === "self-contained" ? undefined : resolveOrigin(sample, audit);
  if (audit.runtimeHosting !== "self-contained" && !fixtureOrigin) {
    return exclude(
      "requires-data-origin",
      `Audited runtimeHosting is ${audit.runtimeHosting} and no reviewed fixture origin is declared, ` +
        "so a generated playground would have no data to serve.",
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
  // Browser configuration is only a blocker when the generated project cannot
  // answer it. A declared fixture origin carries the reviewed fixture-lane
  // values, so those variables are configuration the playground supplies.
  const unanswered = analysis.envVars.filter((name) => !Object.hasOwn(fixtureOrigin?.env ?? {}, name));
  if (unanswered.length > 0) {
    return exclude("browser-configuration", `Default lane reads browser configuration: ${unanswered.join(", ")}.`);
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
  for (const packageName of SAMPLE_RUNTIME_PEERS.get(sample.id) ?? []) {
    const pin = PINNED_DEPENDENCIES[packageName];
    if (!pin) return exclude("unpinned-dependency", `${packageName} has no reviewed published pin.`);
    dependencies[packageName] = pin;
  }

  const devDependencies = { ...PINNED_DEV_DEPENDENCIES };
  for (const packageName of Object.keys(dependencies)) {
    Object.assign(devDependencies, PINNED_TYPE_DEPENDENCIES[packageName] ?? {});
  }

  return {
    id: sample.id,
    qualified: true,
    projectPath: `${PLAYGROUND_ROOT}/${sample.id}`,
    files: analysis.files,
    sharedSources,
    ...(fixtureOrigin ? { fixtureOrigin } : {}),
    dependencies: Object.fromEntries(Object.entries(dependencies).sort(([left], [right]) => left.localeCompare(right))),
    devDependencies: Object.fromEntries(
      Object.entries(devDependencies).sort(([left], [right]) => left.localeCompare(right)),
    ),
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
  // No `overrides` block: the pinned SDK release declares `maplibre-gl` at
  // `^5.0.0 || ^6.0.0` (#1004), so the v6 pin these projects need now resolves
  // on its own. An override here would outlive the conflict it was written for
  // and silence the next one.
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
      devDependencies: decision.devDependencies,
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

function generatedViteHeader(sample) {
  return `// Generated from examples/${sample.id} by scripts/sample-playgrounds.mjs.
// The repository build aliases @honua/sdk-js onto src/; a playground resolves
// the published package from node_modules instead, so no alias is needed.`;
}

function projectViteConfig(sample, decision) {
  const origin = decision.fixtureOrigin;
  if (!origin) {
    return `${generatedViteHeader(sample)}
import { defineConfig } from "vite";

export default defineConfig({
  server: { host: "127.0.0.1" },
  preview: { host: "127.0.0.1" },
  build: { outDir: "dist", emptyOutDir: true },
});
`;
  }
  const routes = origin.routes
    .map((route) => `  [${JSON.stringify(route.path)}, ${JSON.stringify(route.document)}],`)
    .join("\n");
  return `${generatedViteHeader(sample)}
//
// examples/${sample.id} reads its data from a Node fixture server the repository
// runs beside it; a browser playground has no such process. This config answers
// the same routes from the project's own dev and preview server, so the default
// lane needs no account, no key, and no third-party request. Every document
// under fixtures/ is a byte-identical copy of ${origin.pack};
// npm run samples:playgrounds:check fails the moment either drifts.
import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";

import { type Plugin, defineConfig } from "vite";

/** Same-origin path -> committed fixture document answering it. */
const FIXTURE_ROUTES: ReadonlyArray<readonly [string, string]> = [
${routes}
];

function fixtureDocument(name: string): string {
  return readFileSync(fileURLToPath(new URL(\`./${FIXTURE_DIRECTORY}/\${name}\`, import.meta.url)), "utf8");
}

function honuaFixtureService(): Plugin {
  const documents = new Map(FIXTURE_ROUTES.map(([route, name]) => [route, fixtureDocument(name)]));
  const middleware = (request: IncomingMessage, response: ServerResponse, next: () => void): void => {
    // Path-only matching: the SDK's adapters append their own query strings,
    // exactly as the sample's repository fixture server assumes.
    const body = documents.get(new URL(request.url ?? "/", "http://localhost").pathname);
    if (body === undefined) {
      next();
      return;
    }
    response.setHeader("content-type", "application/json; charset=utf-8");
    response.setHeader("cache-control", "no-store");
    response.end(body);
  };
  return {
    name: "honua-fixture-service",
    configureServer(server) {
      server.middlewares.use(middleware);
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware);
    },
  };
}

export default defineConfig({
  plugins: [honuaFixtureService()],
  server: { host: "127.0.0.1" },
  preview: { host: "127.0.0.1" },
  build: { outDir: "dist", emptyOutDir: true },
});
`;
}

/**
 * The reviewed fixture lane's browser configuration, as a project-local `.env`.
 *
 * Vite loads this in dev, preview and build alike, so the playground runs the
 * configuration the repository qualifies rather than whatever the sample's
 * source happens to fall back to. Only plain, non-credential values reach here;
 * `resolveFixtureOrigin` refuses anything else.
 */
function projectEnvFile(sample, origin) {
  const lines = [
    `# Generated from examples/${sample.id} by scripts/sample-playgrounds.mjs. Do not edit by hand.`,
    "# The reviewed fixture lane's browser configuration. Point these at a live",
    "# service to run the identical code against real data.",
    ...Object.entries(origin.env).map(([name, value]) => `${name}=${value}`),
  ];
  return `${lines.join("\n")}\n`;
}

function projectReadme(sample, decision, links) {
  const providerLines = links.map((link) => `- [Open in ${link.title}](${link.url})`).join("\n");
  const origin = decision.fixtureOrigin;
  const dataSection = origin
    ? `## Where its data comes from

\`examples/${sample.id}\` is served by a Node fixture server the repository runs beside it
(\`npm run demo:*:mock\`). A browser playground cannot start that process, so this project
serves the same reviewed documents from its own Vite dev and preview server:

${origin.routes.map((route) => `- \`${route.path}\` → \`${FIXTURE_DIRECTORY}/${route.document}\``).join("\n")}

Every file under \`${FIXTURE_DIRECTORY}/\` is a byte-identical copy of
[\`${origin.pack}\`](../../${origin.pack}), and \`.env\` carries the reviewed fixture lane's
configuration. The default lane therefore needs no account, no key, and no third-party request.
`
    : `## Where its data comes from

Its own committed source, so the default lane needs no account, no key, and no third-party request.
`;
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
runs anywhere npm does — including a browser playground.

${dataSection}
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
  // The reviewed fixture documents are copied verbatim: the generated origin
  // serves the same bytes the sample's repository fixture server serves.
  for (const document of decision.fixtureOrigin?.documents ?? []) {
    files.set(document.target, fs.readFileSync(path.join(ROOT, document.source), "utf8"));
  }
  files.set("package.json", projectPackageJson(decision, sample));
  files.set("tsconfig.json", projectTsconfig(decision.files.some((file) => file.endsWith(".tsx"))));
  files.set("vite.config.ts", projectViteConfig(sample, decision));
  files.set("README.md", projectReadme(sample, decision, links));
  files.set(".stackblitzrc", STACKBLITZ_RC);
  if (decision.fixtureOrigin && Object.keys(decision.fixtureOrigin.env).length > 0) {
    files.set(".env", projectEnvFile(sample, decision.fixtureOrigin));
  }
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

/**
 * The managed block a qualifying sample's own README carries.
 *
 * Deliberately short, and deliberately free of anything that changes on a
 * release: these files sit inside the sample-qualification digest, so a block
 * that restated the pinned SDK version would re-qualify five samples every time
 * a version moved. What it carries is exactly what cannot be hand-maintained —
 * the provider URLs and the project they boot.
 */
export function renderSampleReadmeBlock(sample, decision, links) {
  const relativeProject = path.posix.relative(sample.sourcePath, decision.projectPath);
  return [
    SAMPLE_README_START,
    "<!-- Generated by scripts/sample-playgrounds.mjs. Do not edit by hand; run npm run samples:playgrounds:generate. -->",
    "",
    "## Run it without installing anything",
    "",
    links.map((link) => `[Open in ${link.title}](${link.url})`).join(" · "),
    "",
    `Each link boots [\`${decision.projectPath}\`](${relativeProject}), a generated standalone copy of this`,
    "sample's committed source that resolves `@honua/sdk-js` from the published package instead of this",
    "repository's `src/` tree. Change the sample here and run `npm run samples:playgrounds:generate`.",
    SAMPLE_README_END,
  ].join("\n");
}

/**
 * Splice the managed block into a sample README.
 *
 * With markers present the block is replaced where it sits. Without them the
 * block is inserted at the end of the introduction — immediately before the
 * first `## ` section, or at the end of a README that has none — which puts the
 * call to action above the local-run instructions it replaces for a reader who
 * only wants to look.
 */
export function spliceSampleReadme(readme, block) {
  const start = readme.indexOf(SAMPLE_README_START);
  const end = readme.indexOf(SAMPLE_README_END);
  if (start >= 0 && end > start) {
    return `${readme.slice(0, start)}${block}${readme.slice(end + SAMPLE_README_END.length)}`;
  }
  if (start >= 0 || end >= 0) {
    throw new Error(`sample README playground markers are malformed (${SAMPLE_README_START} / ${SAMPLE_README_END})`);
  }
  const section = readme.match(/^## .*$/m);
  if (!section) return `${readme.trimEnd()}\n\n${block}\n`;
  return `${readme.slice(0, section.index)}${block}\n\n${readme.slice(section.index)}`;
}

/** Drop the managed block, and the blank lines it introduced, from a sample README. */
export function removeSampleReadmeBlock(readme) {
  const start = readme.indexOf(SAMPLE_README_START);
  const end = readme.indexOf(SAMPLE_README_END);
  if (start < 0 && end < 0) return readme;
  if (start < 0 || end < start) {
    throw new Error(`sample README playground markers are malformed (${SAMPLE_README_START} / ${SAMPLE_README_END})`);
  }
  const before = readme.slice(0, start).replace(/\n+$/, "\n");
  const after = readme.slice(end + SAMPLE_README_END.length).replace(/^\n+/, "");
  return after.length === 0 ? before : `${before}\n${after}`;
}

/** The catalog overlay value a qualifying sample carries. */
export function playgroundCatalogEntry(decision, links) {
  return { projectPath: decision.projectPath, providers: links.map((link) => ({ ...link })) };
}

/**
 * Where a generated playground's data comes from, published so a reader never
 * has to open the project to find out. This lives in the standalone artifact
 * rather than in the catalog: the catalog carries the links a card renders, and
 * nothing a card does not use.
 */
export function playgroundDataOrigin(decision) {
  const origin = decision.fixtureOrigin;
  if (!origin) return { kind: "committed-sample-source" };
  return {
    kind: "generated-fixture-service",
    fixturePack: origin.pack,
    routes: origin.routes.map((route) => route.path),
  };
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
      .map((decision) => ({
        sampleId: decision.id,
        ...catalogEntries.get(decision.id),
        dataOrigin: playgroundDataOrigin(decision),
      })),
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
    resolveFixtureOrigin,
    sdkEntrypoints: publishedSdkEntrypoints(readJson("package.json")),
    sdkVersion: manifest.sdk.version,
  };
  const decisions = derivePlaygroundDecisions(catalog, context);
  const files = new Map();
  const catalogEntries = new Map();
  // Sample READMEs are spliced, not generated: the file is hand-written and
  // only the managed block belongs to this script, so each entry is the whole
  // desired file rather than a fragment.
  const sampleReadmes = new Map();
  for (const decision of decisions) {
    const sample = catalog.samples.find((entry) => entry.id === decision.id);
    const readmePath = path.posix.join(sample.sourcePath, "README.md");
    const readme = fs.existsSync(path.join(ROOT, readmePath))
      ? fs.readFileSync(path.join(ROOT, readmePath), "utf8")
      : undefined;
    if (!decision.qualified) {
      // A sample that stops qualifying must lose its links, not keep them.
      if (readme !== undefined && readme.includes(SAMPLE_README_START)) {
        sampleReadmes.set(readmePath, removeSampleReadmeBlock(readme));
      }
      continue;
    }
    const links = providerLinks(manifest, decision.projectPath);
    for (const [relative, contents] of renderPlaygroundProject(sample, decision, links)) {
      files.set(path.posix.join(decision.projectPath, relative), contents);
    }
    catalogEntries.set(decision.id, playgroundCatalogEntry(decision, links));
    if (readme === undefined) {
      throw new Error(`${readmePath} is missing; a qualifying sample must document its playground`);
    }
    sampleReadmes.set(readmePath, spliceSampleReadme(readme, renderSampleReadmeBlock(sample, decision, links)));
  }
  return { catalog, decisions, files, catalogEntries, sampleReadmes, sdkVersion: manifest.sdk.version };
}

/** Overlay updates so the generated links reach the catalog through its reviewed migration. */
function applyOverlay(catalogEntries, decisions) {
  const overlay = readJson(OVERLAY_PATH);
  const decisionIds = new Set(decisions.map((decision) => decision.id));
  let changed = false;
  const synchronize = (owner, id) => {
    if (!decisionIds.has(id)) return;
    const entry = catalogEntries.get(id);
    const current = owner.playground;
    const next = entry ? stableJson(entry) : undefined;
    if ((current === undefined ? undefined : stableJson(current)) === next) return;
    changed = true;
    if (entry) owner.playground = entry;
    else delete owner.playground;
  };
  for (const [id, override] of Object.entries(overlay.sampleOverrides)) {
    synchronize(override, id);
  }
  for (const sample of overlay.addedSamples) synchronize(sample, sample.id);
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
  const { decisions, files, catalogEntries, sampleReadmes, sdkVersion } = collectPlan();
  const qualified = decisions.filter((decision) => decision.qualified);
  for (const decision of decisions) {
    if (decision.qualified) continue;
    if (!PLAYGROUND_EXCLUSION_CATEGORIES.includes(decision.category)) {
      process.stderr.write(`unknown exclusion category ${decision.category} for ${decision.id}\n`);
      process.exit(1);
    }
  }
  const { overlay, changed: overlayChanged } = applyOverlay(catalogEntries, decisions);
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
    let readmesWritten = 0;
    for (const [relative, contents] of sampleReadmes) {
      const target = path.join(ROOT, relative);
      if (fs.readFileSync(target, "utf8") === contents) continue;
      fs.writeFileSync(target, contents);
      readmesWritten += 1;
    }
    if (overlayChanged) fs.writeFileSync(path.join(ROOT, OVERLAY_PATH), stableJson(overlay));
    fs.writeFileSync(path.join(ROOT, ARTIFACT_PATH), artifactBytes);
    process.stdout.write(
      `samplePlaygroundsWritten=${qualified.length} excluded=${decisions.length - qualified.length} sampleReadmes=${readmesWritten}${
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
  // The links a sample's own README publishes come from this same derivation,
  // so a stale, invented or orphaned playground URL fails here rather than
  // waiting for a reader to click it.
  for (const [relative, contents] of sampleReadmes) {
    if (fs.readFileSync(path.join(ROOT, relative), "utf8") !== contents) {
      problems.push(`${relative} playground block has drifted`);
    }
  }
  if (overlayChanged) problems.push(`${OVERLAY_PATH} playground entries have drifted`);
  // Tracked, not merely present: `.gitignore`'s `dist/` rule matches
  // `samples/dist/` at any depth, so an untracked artifact reads as correct in
  // a working tree and as missing in a fresh checkout. Ask git, not the disk.
  const trackedArtifact = execFileSync("git", ["ls-files", "--", ARTIFACT_PATH], { cwd: ROOT, encoding: "utf8" }).trim();
  if (trackedArtifact.length === 0) {
    problems.push(`${ARTIFACT_PATH} is not tracked by git (check .gitignore); a fresh checkout would not have it`);
  }
  const committedArtifact = fs.existsSync(path.join(ROOT, ARTIFACT_PATH))
    ? fs.readFileSync(path.join(ROOT, ARTIFACT_PATH), "utf8")
    : "";
  if (committedArtifact !== artifactBytes) problems.push(`${ARTIFACT_PATH} has drifted`);
  if (problems.length > 0) reportDrift(problems);

  process.stdout.write(
    `samplePlaygrounds=ok qualified=${qualified.length} excluded=${decisions.length - qualified.length} sampleReadmes=${sampleReadmes.size}\n`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
