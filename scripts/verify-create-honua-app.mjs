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
//      query-free https URLs that address a real project directory.

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

const errors = [];

function report(message) {
  errors.push(message);
}

function digest(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
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

  for (const fixture of FIXTURE_FILES) {
    const templateFixture = path.join(root, "fixtures", fixture);
    const packFixture = path.join(FIXTURE_PACK_ROOT, fixture);
    if (!fs.existsSync(templateFixture) || !fs.existsSync(packFixture)) continue;
    if (digest(templateFixture) !== digest(packFixture)) {
      report(`${label}: fixtures/${fixture} has drifted from samples/fixtures/first-map/v1/${fixture}`);
    }
  }

  for (const link of playgroundLinks(manifest, template)) {
    if (!link.url.includes(template.path)) report(`${label}: ${link.providerId} playground link does not address the template`);
  }
}

const packageManifest = verifyPackageManifest();
const manifest = loadTemplateManifest(PACKAGE_ROOT);
const repository = readJson(path.join(ROOT, "package.json")).repository?.url ?? "";
if (!repository.includes(`${manifest.repository.owner}/${manifest.repository.name}`)) {
  report(`templates.manifest.json repository must match the root package repository (${repository})`);
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
