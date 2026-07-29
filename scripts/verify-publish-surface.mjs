#!/usr/bin/env node

/**
 * Publish-surface integrity gate.
 *
 * The stale-npm incident (npm `latest` pinned at 0.0.6 while trunk shipped
 * 0.0.19; `@honua/react` / `@honua/geometry` documented but 404ing) showed
 * that nothing asserted the artifact we publish contains the surface the
 * docs advertise. This script makes that structurally impossible to regress:
 *
 *   1. Root tarball: `npm pack --dry-run --json` must contain every file that
 *      `package.json` `exports` (types + default), `browser`/`unpkg`/`jsdelivr`,
 *      and `bin` reference.
 *   2. Split packages: every `@honua/...` package documented in
 *      `docs/split-packages.md` must exist under `dist/packages/`, and each
 *      split package's own `exports` must resolve to real files on disk.
 *   3. Root and split tarballs must contain no executable filenames or magic
 *      signatures, even when the repository has an ignored build cache.
 *
 * Prerequisites: `npm run build`, `npm run build:browser`, and
 * `npm run build:split-packages` have all run. Wired into CI and into the
 * publish workflow immediately before `npm publish`.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { scanBinaryArtifactFiles } from "./lib/binary-artifact-policy.mjs";
import { runNpmSync } from "./lib/npm-cli.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const failures = [];

function packFilePaths(directory) {
  const result = runNpmSync(["pack", "--dry-run", "--json", "--ignore-scripts"], {
    cwd: directory,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    const detail = [result.error?.message, result.stdout?.trim(), result.stderr?.trim()]
      .filter(Boolean)
      .join("\n");
    throw new Error(`npm pack exited ${result.status ?? "with a spawn error"}: ${detail}`, {
      cause: result.error,
    });
  }
  const report = JSON.parse(result.stdout);
  return new Set((report[0]?.files ?? []).map((file) => file.path));
}

function rejectBinaryArtifacts(label, root, files) {
  for (const violation of scanBinaryArtifactFiles({ root, paths: [...files] })) {
    failures.push(`${label} contains forbidden binary artifact "${violation.file}" (${violation.reason})`);
  }
}

function collectExportFiles(pkg) {
  const wanted = new Set();
  const visit = (value) => {
    if (typeof value === "string") {
      if (value.startsWith("./")) wanted.add(value.slice(2));
      return;
    }
    if (value && typeof value === "object") {
      for (const v of Object.values(value)) visit(v);
    }
  };
  visit(pkg.exports ?? {});
  for (const key of ["browser", "unpkg", "jsdelivr", "types", "main", "module"]) {
    if (typeof pkg[key] === "string") wanted.add(pkg[key].replace(/^\.\//, ""));
  }
  if (pkg.bin && typeof pkg.bin === "object") {
    for (const v of Object.values(pkg.bin)) wanted.add(String(v).replace(/^\.\//, ""));
  }
  return wanted;
}

// --- 1. Root tarball contents vs package.json surface -----------------------
const rootPkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const tarballFiles = packFilePaths(ROOT);
rejectBinaryArtifacts("root tarball", ROOT, tarballFiles);

for (const file of collectExportFiles(rootPkg)) {
  if (!tarballFiles.has(file)) {
    failures.push(`root tarball is missing "${file}" (referenced by package.json surface)`);
  }
}

// --- 2. Documented split packages exist and are internally consistent -------
const splitDocs = fs.readFileSync(path.join(ROOT, "docs", "split-packages.md"), "utf8");
const documented = new Set([...splitDocs.matchAll(/`(@honua\/[a-z0-9-]+)`/g)].map((m) => m[1]));
documented.delete("@honua/sdk-js"); // the root package, packed above

const packagesRoot = path.join(ROOT, "dist", "packages");
const builtDirs = fs.existsSync(packagesRoot)
  ? fs.readdirSync(packagesRoot).filter((d) => fs.existsSync(path.join(packagesRoot, d, "package.json")))
  : [];
const builtByName = new Map(
  builtDirs.map((dir) => {
    const pkg = JSON.parse(fs.readFileSync(path.join(packagesRoot, dir, "package.json"), "utf8"));
    return [pkg.name, { dir, pkg }];
  }),
);

for (const name of documented) {
  const built = builtByName.get(name);
  if (!built) {
    failures.push(`"${name}" is documented in docs/split-packages.md but not produced under dist/packages/`);
    continue;
  }
  const base = path.join(packagesRoot, built.dir);
  rejectBinaryArtifacts(`split package ${name}`, base, packFilePaths(base));
  for (const file of collectExportFiles(built.pkg)) {
    if (!fs.existsSync(path.join(base, file))) {
      failures.push(`split package ${name}: exports reference "${file}" but the file is absent from ${built.dir}/`);
    }
  }
}

if (failures.length > 0) {
  process.stderr.write("Publish-surface verification FAILED:\n");
  for (const f of failures) process.stderr.write(`  - ${f}\n`);
  process.stderr.write(
    "\nThe artifact does not match the documented surface. Run the full build " +
      "(build, build:browser, build:split-packages) or fix the docs/exports drift before publishing.\n",
  );
  process.exit(1);
}

process.stdout.write(
  `publishSurface=ok rootFiles=${tarballFiles.size} splitPackages=${[...documented].sort().join(",")}\n`,
);
