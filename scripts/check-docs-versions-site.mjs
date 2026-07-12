#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SITE = path.join(ROOT, "dist", "docs-site");
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "docs", "versions.json"), "utf8"));

function requireText(file, needles) {
  const text = fs.readFileSync(path.join(SITE, file), "utf8");
  for (const needle of needles) {
    if (!text.includes(needle)) throw new Error(`${file} is missing ${needle}`);
  }
  return text;
}

const marker = `data-sdk-docs-current="${manifest.current}"`;
for (const file of ["index.html", "guides/index.html", "guides/quickstart.html", "gallery.html", "api/index.html"]) {
  requireText(file, [marker, manifest.current, "documentation-versions.html"]);
}

const builtManifest = fs.readFileSync(path.join(SITE, "versions.json"), "utf8");
const sourceManifest = fs.readFileSync(path.join(ROOT, "docs", "versions.json"), "utf8");
if (builtManifest !== sourceManifest) throw new Error("built versions.json differs from the source manifest");

const versionsPage = requireText("guides/documentation-versions.html", [manifest.current, "current-prerelease"]);
for (const entry of manifest.versions) {
  if (!versionsPage.includes(entry.version)) throw new Error(`version page omits ${entry.version}`);
  if (entry.status === "archived" && !versionsPage.includes(`${entry.docs.sourceBase}/README.md`)) {
    throw new Error(`version page omits tagged source fallback for ${entry.version}`);
  }
}

const apiIndex = requireText("api/index.html", ["Switch documentation version"]);
for (const entry of manifest.versions) {
  if (!apiIndex.includes(entry.version)) throw new Error(`API version navigation omits ${entry.version}`);
}

process.stdout.write(`docs version site: ${manifest.versions.length} releases, current ${manifest.current}\n`);
