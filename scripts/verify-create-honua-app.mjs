#!/usr/bin/env node

// Structural gate for the `create-honua-app` scaffold (#958).
//
// A stale starter is a broken funnel, so the checks below hold the published
// package to the same discipline as a documentation snippet:
//   1. every template the manifest advertises exists, with the files a Vite
//      project needs to install and run;
//   2. dependency versions are exact pins, and the SDK pin is the one version
//      the manifest declares (never a range that can drift under a consumer);
//   3. the committed fixture each template serves is byte-identical to the
//      reviewed sample fixture pack, so the offline lane cannot rot;
//   4. the zero-install playground links the manifest derives are plain,
//      query-free https URLs that address a real project directory;
//   5. the `maplibre-gl` pin names a major the SDK's optional-peer range
//      actually supports (#1004), so a starter can never scaffold an app onto a
//      renderer major the SDK does not claim.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadTemplateManifest, playgroundLinks, templateRoot } from "../packages/create-honua-app/lib/templates.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGE_ROOT = path.join(ROOT, "packages/create-honua-app");
const FIXTURE_PACK_ROOT = path.join(ROOT, "samples/fixtures/first-map/v1");
const FIXTURE_FILES = ["layer.json", "features.json"];
const REQUIRED_TEMPLATE_FILES = [
  "package.json",
  "tsconfig.json",
  "vite.config.ts",
  "index.html",
  "README.md",
  "_gitignore",
  ".stackblitzrc",
  "fixtures/layer.json",
  "fixtures/features.json",
];
const REQUIRED_TEMPLATE_SCRIPTS = ["dev", "build", "preview", "typecheck"];
const EXACT_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const FORBIDDEN_TEMPLATE_ENTRIES = new Set(["node_modules", "package-lock.json", "dist", ".gitignore"]);

/**
 * Peers whose template pin must stay inside the SDK's declared peer range
 * rather than drift on its own (#1004).
 *
 * A scaffolded app installs the SDK **from the registry**, so its `maplibre-gl`
 * pin must satisfy the peer range of the *published* SDK version the template
 * pins — not just the range in this working tree. The templates therefore stay
 * on MapLibre 5 until a release carrying `^5.0.0 || ^6.0.0` is published;
 * pinning 6.x today makes `npm install` fail with ERESOLVE against
 * `@honua/sdk-js@0.1.2-beta.0`, whose published range is `^5.0.0`. What this
 * gate can enforce offline is the invariant that matters either way: the pinned
 * major is one the SDK supports at all.
 */
const PEER_TRACKED_TEMPLATE_DEPENDENCIES = ["maplibre-gl"];

const errors = [];

function report(message) {
  errors.push(message);
}

/** Majors named by a simple `^X.Y.Z || ^A.B.C` peer range, ascending. */
function peerRangeMajors(range) {
  return [...String(range).matchAll(/\^(\d+)\./g)].map((match) => Number(match[1])).sort((left, right) => left - right);
}

function digest(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function parseUrl(value) {
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}

/** Split a repository URL into host/owner/name so it can be compared exactly. */
function parseGitHubRepository(value) {
  const url = parseUrl(value.replace(/^git\+/, ""));
  if (!url) return undefined;
  const [owner, name, ...rest] = url.pathname.replace(/^\//, "").replace(/\.git$/, "").split("/");
  if (!owner || !name || rest.length > 0) return undefined;
  return { host: url.host, owner, name };
}

function verifyPackageManifest() {
  const manifest = readJson(path.join(PACKAGE_ROOT, "package.json"));
  if (manifest.name !== "create-honua-app") report("packages/create-honua-app/package.json name must be create-honua-app");
  if (manifest.type !== "module") report("packages/create-honua-app/package.json must declare type module");
  const bin = manifest.bin?.["create-honua-app"];
  if (typeof bin !== "string") report("packages/create-honua-app/package.json must declare a create-honua-app bin");
  else {
    const binPath = path.join(PACKAGE_ROOT, bin);
    if (!fs.existsSync(binPath)) report(`declared bin ${bin} does not exist`);
    else if (!fs.readFileSync(binPath, "utf8").startsWith("#!/usr/bin/env node")) {
      report(`declared bin ${bin} must start with a node shebang`);
    }
  }
  for (const entry of ["bin", "lib", "templates", "templates.manifest.json", "README.md", "LICENSE"]) {
    if (!manifest.files?.includes(entry)) report(`packages/create-honua-app/package.json files must include ${entry}`);
    if (!fs.existsSync(path.join(PACKAGE_ROOT, entry))) report(`packages/create-honua-app/${entry} is missing`);
  }
  const rootLicense = readJson(path.join(ROOT, "package.json")).license;
  if (manifest.license !== rootLicense) report(`packages/create-honua-app license must be ${rootLicense}`);
  return manifest;
}

function verifyTemplate(manifest, template) {
  const root = templateRoot(manifest, template.id, PACKAGE_ROOT);
  const label = `template ${template.id}`;
  if (!fs.existsSync(root)) {
    report(`${label}: directory ${path.relative(ROOT, root)} is missing`);
    return;
  }
  if (path.join(ROOT, template.path) !== root) report(`${label}: manifest path does not resolve to the template directory`);

  for (const relative of [...REQUIRED_TEMPLATE_FILES, template.entryFile]) {
    if (!fs.existsSync(path.join(root, relative))) report(`${label}: missing ${relative}`);
  }
  for (const entry of fs.readdirSync(root)) {
    if (FORBIDDEN_TEMPLATE_ENTRIES.has(entry)) report(`${label}: ${entry} must not be committed inside a template`);
  }

  const templatePackage = path.join(root, "package.json");
  if (!fs.existsSync(templatePackage)) return;
  const projectManifest = readJson(templatePackage);
  if (projectManifest.private !== true) report(`${label}: package.json must set private true`);
  if (projectManifest.type !== "module") report(`${label}: package.json must declare type module`);
  for (const script of REQUIRED_TEMPLATE_SCRIPTS) {
    if (typeof projectManifest.scripts?.[script] !== "string") report(`${label}: package.json must declare a ${script} script`);
  }
  const dependencies = { ...projectManifest.dependencies, ...projectManifest.devDependencies };
  for (const [name, range] of Object.entries(dependencies)) {
    if (!EXACT_VERSION_PATTERN.test(range)) report(`${label}: ${name} must be pinned to an exact version, found ${range}`);
  }
  for (const dependency of template.dependencies) {
    if (!Object.hasOwn(projectManifest.dependencies ?? {}, dependency)) {
      report(`${label}: manifest declares ${dependency} but package.json does not depend on it`);
    }
  }
  const sdkPin = projectManifest.dependencies?.[manifest.sdk.package];
  if (sdkPin !== manifest.sdk.version) {
    report(`${label}: ${manifest.sdk.package} must be pinned to ${manifest.sdk.version}, found ${sdkPin ?? "nothing"}`);
  }

  for (const peer of PEER_TRACKED_TEMPLATE_DEPENDENCIES) {
    const pin = projectManifest.dependencies?.[peer];
    if (typeof pin !== "string") continue;
    const declaredRange = readJson(path.join(ROOT, "package.json")).peerDependencies?.[peer];
    const majors = declaredRange ? peerRangeMajors(declaredRange) : [];
    if (majors.length === 0) {
      report(`${label}: the SDK declares no parseable ${peer} peer range, so the template pin cannot be checked`);
      continue;
    }
    const pinnedMajor = Number(pin.split(".")[0]);
    if (!majors.includes(pinnedMajor)) {
      report(
        `${label}: ${peer} is pinned to ${pin}, which is outside the SDK peer range ${declaredRange} (supported majors: ${majors.join(", ")})`,
      );
    }
  }

  for (const fixture of FIXTURE_FILES) {
    const templateFixture = path.join(root, "fixtures", fixture);
    const packFixture = path.join(FIXTURE_PACK_ROOT, fixture);
    if (!fs.existsSync(templateFixture) || !fs.existsSync(packFixture)) continue;
    if (digest(templateFixture) !== digest(packFixture)) {
      report(`${label}: fixtures/${fixture} has drifted from samples/fixtures/first-map/v1/${fixture}`);
    }
  }

  for (const link of playgroundLinks(manifest, template)) {
    const provider = manifest.playgroundProviders.find((entry) => entry.id === link.providerId);
    const expectedOrigin = new URL(provider.urlTemplate).origin;
    const url = parseUrl(link.url);
    // Origin equality, not a substring test: this gates the host the published
    // playground page sends readers to.
    if (!url || url.protocol !== "https:" || url.origin !== expectedOrigin) {
      report(`${label}: ${link.providerId} playground link must be an https URL on ${expectedOrigin}`);
      continue;
    }
    if (url.search !== "" || url.hash !== "") {
      report(`${label}: ${link.providerId} playground link must not carry a query or fragment`);
    }
    if (!url.pathname.endsWith(`/${template.path}`)) {
      report(`${label}: ${link.providerId} playground link does not address the template directory`);
    }
  }
}

const packageManifest = verifyPackageManifest();
const manifest = loadTemplateManifest(PACKAGE_ROOT);
const repository = parseGitHubRepository(readJson(path.join(ROOT, "package.json")).repository?.url ?? "");
if (
  !repository ||
  repository.host !== "github.com" ||
  repository.owner !== manifest.repository.owner ||
  repository.name !== manifest.repository.name
) {
  report(
    `templates.manifest.json repository must match the root package repository (${manifest.repository.owner}/${manifest.repository.name} on github.com)`,
  );
}
for (const template of manifest.templates) verifyTemplate(manifest, template);

if (errors.length > 0) {
  process.stderr.write("create-honua-app verification failed:\n");
  for (const error of errors) process.stderr.write(`- ${error}\n`);
  process.exit(1);
}

process.stdout.write(
  `createHonuaApp=ok version=${packageManifest.version} templates=${manifest.templates.length} sdk=${manifest.sdk.package}@${manifest.sdk.version}\n`,
);
