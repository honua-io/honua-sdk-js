#!/usr/bin/env node

// Pre-publish artifact gate for `create-honua-app` (#958 S2).
//
// `scripts/verify-create-honua-app.mjs` checks the source tree, which is not
// what a user installs. This checks the tarball: `npm pack` decides what ships,
// and a `files` omission or an npm default-ignore rule (`.gitignore` is dropped
// from every package, which is why the templates carry `_gitignore`) would ship
// a scaffold that cannot find its own templates while every source-tree gate
// stayed green. Mirrors the split-package pre-publish discipline in
// scripts/verify-publish-surface.mjs (declared entrypoints must be inside the
// tarball, no binary artifacts) and scripts/verify-split-packages.mjs (install
// the packed artifact into a temporary consumer and use it).
//
// Run with: npm run create-app:verify:package

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadTemplateManifest } from "../packages/create-honua-app/lib/templates.mjs";
import { scanBinaryArtifactFiles } from "./lib/binary-artifact-policy.mjs";
import { runNpmSync } from "./lib/npm-cli.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGE_ROOT = path.join(ROOT, "packages/create-honua-app");
const FORBIDDEN_TARBALL_ENTRIES = [/(^|\/)node_modules\//, /(^|\/)package-lock\.json$/, /(^|\/)\.gitignore$/, /(^|\/)dist\//];

const failures = [];

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function npm(args, cwd) {
  const result = runNpmSync(args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (result.error || result.status !== 0) {
    const detail = [result.error?.message, result.stdout?.trim(), result.stderr?.trim()].filter(Boolean).join("\n");
    throw new Error(`npm ${args.join(" ")} exited ${result.status ?? "with a spawn error"}: ${detail}`);
  }
  return result.stdout;
}

/** Paths `npm pack` would publish, as they appear inside the tarball. */
function packedFiles() {
  const report = JSON.parse(npm(["pack", "--dry-run", "--json", "--ignore-scripts"], PACKAGE_ROOT));
  return new Set((report[0]?.files ?? []).map((file) => file.path));
}

function listSourceFiles(directory, prefix) {
  return fs
    .readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) =>
      entry.isDirectory()
        ? listSourceFiles(path.join(directory, entry.name), `${prefix}${entry.name}/`)
        : [`${prefix}${entry.name}`],
    );
}

function verifyTarballContents(packed, manifest, packageManifest) {
  const required = new Set(["package.json", "README.md", "LICENSE", "templates.manifest.json"]);
  for (const target of Object.values(packageManifest.bin ?? {})) required.add(target.replace(/^\.\//, ""));
  for (const file of listSourceFiles(path.join(PACKAGE_ROOT, "lib"), "lib/")) required.add(file);
  for (const template of manifest.templates) {
    for (const file of listSourceFiles(path.join(PACKAGE_ROOT, "templates", template.id), `templates/${template.id}/`)) {
      required.add(file);
    }
  }
  for (const file of [...required].sort()) {
    if (!packed.has(file)) failures.push(`tarball is missing ${file}`);
  }
  for (const file of packed) {
    for (const pattern of FORBIDDEN_TARBALL_ENTRIES) {
      if (pattern.test(file)) failures.push(`tarball contains forbidden entry ${file}`);
    }
  }
  for (const violation of scanBinaryArtifactFiles({ root: PACKAGE_ROOT, paths: [...packed] })) {
    failures.push(`tarball contains forbidden binary artifact "${violation.file}" (${violation.reason})`);
  }
}

/** Install the packed artifact into a throwaway consumer and scaffold with it. */
function verifyInstalledScaffold(manifest) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "create-honua-app-pack-"));
  try {
    const packed = JSON.parse(npm(["pack", "--json", "--ignore-scripts", "--pack-destination", workspace], PACKAGE_ROOT));
    const tarball = path.join(workspace, packed[0].filename);
    const consumer = path.join(workspace, "consumer");
    fs.mkdirSync(consumer);
    fs.writeFileSync(
      path.join(consumer, "package.json"),
      `${JSON.stringify({ name: "create-honua-app-consumer", private: true, version: "0.0.0" }, null, 2)}\n`,
    );
    npm(["install", "--no-audit", "--no-fund", "--ignore-scripts", tarball], consumer);
    const installedBin = path.join(consumer, "node_modules/create-honua-app/bin/create-honua-app.mjs");
    if (!fs.existsSync(installedBin)) {
      failures.push("the installed package does not expose bin/create-honua-app.mjs");
      return;
    }
    for (const template of manifest.templates) {
      const target = path.join(consumer, `scaffold-${template.id}`);
      const result = spawnSync(process.execPath, [installedBin, target, "--template", template.id], {
        cwd: consumer,
        encoding: "utf8",
      });
      if (result.status !== 0) {
        failures.push(`scaffolding ${template.id} from the packed package exited ${result.status}: ${result.stderr}`);
        continue;
      }
      for (const relative of ["package.json", "index.html", template.entryFile, ".gitignore"]) {
        if (!fs.existsSync(path.join(target, relative))) {
          failures.push(`scaffold from the packed ${template.id} template is missing ${relative}`);
        }
      }
      const scaffolded = readJson(path.join(target, "package.json"));
      if (scaffolded.dependencies?.[manifest.sdk.package] !== manifest.sdk.version) {
        failures.push(`scaffold from the packed ${template.id} template does not pin ${manifest.sdk.package}`);
      }
    }
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
}

const packageManifest = readJson(path.join(PACKAGE_ROOT, "package.json"));
const manifest = loadTemplateManifest(PACKAGE_ROOT);
verifyTarballContents(packedFiles(), manifest, packageManifest);
verifyInstalledScaffold(manifest);

if (failures.length > 0) {
  process.stderr.write("create-honua-app package verification failed:\n");
  for (const failure of failures) process.stderr.write(`- ${failure}\n`);
  process.exit(1);
}

process.stdout.write(
  `createHonuaAppPackage=ok name=${packageManifest.name} version=${packageManifest.version} templates=${manifest.templates.length}\n`,
);
