#!/usr/bin/env node
// Deterministic internal link-checker over the built docs site
// (dist/docs-site). It parses every generated HTML file, including the TypeDoc
// api/ tree, and verifies that each internal href resolves to a real file.
// A missing fragment in api/ fails the check. Fragment drift in the guides
// stays a warning. External links are not fetched.
//
// Exit code 1 on any broken internal link. Run after `npm run docs:site`.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SITE = path.join(ROOT, "dist", "docs-site");

function walkHtml(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkHtml(full));
    else if (entry.name.endsWith(".html")) out.push(full);
  }
  return out;
}

function collectIds(html) {
  const ids = new Set();
  for (const m of html.matchAll(/\sid="([^"]+)"/g)) ids.add(m[1]);
  for (const m of html.matchAll(/\sname="([^"]+)"/g)) ids.add(m[1]);
  return ids;
}

export function auditDocsSite(siteDir) {
  const htmlFiles = walkHtml(siteDir);
  const idCache = new Map();
  const idsFor = (file) => {
    if (!idCache.has(file)) idCache.set(file, collectIds(fs.readFileSync(file, "utf8")));
    return idCache.get(file);
  };

  const broken = [];
  const fragWarnings = [];
  let internal = 0;
  let external = 0;

  for (const file of htmlFiles) {
    const html = fs.readFileSync(file, "utf8");
    const hrefs = [...html.matchAll(/(?:href|src)="([^"]+)"/g)].map((m) => m[1]);
    for (const href of hrefs) {
      if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(href)) {
        external++;
        continue;
      }
      internal++;
      const [rawPath, frag] = splitFragment(href);
      let targetFile = file;
      if (rawPath !== "") {
        targetFile = path.resolve(path.dirname(file), rawPath);
        if (!fs.existsSync(targetFile)) {
          broken.push({ file, href, reason: "missing file" });
          continue;
        }
        if (fs.statSync(targetFile).isDirectory()) targetFile = path.join(targetFile, "index.html");
      }
      const missing = missingFragment(siteDir, file, targetFile, href, frag, idsFor);
      if (missing?.api) broken.push(missing.item);
      else if (missing) fragWarnings.push(missing.item);
    }
  }
  return { htmlFiles, broken, fragWarnings, internal, external, siteDir };
}

function main() {
  if (!fs.existsSync(SITE)) {
    process.stderr.write(`error: ${path.relative(ROOT, SITE)} not found — run \`npm run docs:site\` first\n`);
    process.exit(1);
  }

  const { htmlFiles, broken, fragWarnings, internal, external } = auditDocsSite(SITE);

  const rel = (f) => path.relative(SITE, f);
  process.stdout.write(
    `link-check: ${htmlFiles.length} pages, ${internal} internal links, ${external} external links (not fetched)\n`,
  );
  for (const w of fragWarnings) process.stdout.write(`  warn ${rel(w.file)} -> ${w.href} (${w.reason})\n`);
  if (fragWarnings.length) {
    process.stdout.write(`link-check: ${fragWarnings.length} fragment-anchor warning(s) (non-fatal)\n`);
  }
  if (broken.length) {
    for (const b of broken) process.stderr.write(`  BROKEN ${rel(b.file)} -> ${b.href} (${b.reason})\n`);
    process.stderr.write(`link-check: ${broken.length} broken internal link(s)\n`);
    process.exit(1);
  }
  process.stdout.write("link-check: all internal links resolve\n");
}

function missingFragment(siteDir, file, targetFile, href, frag, idsFor) {
  if (!frag || !targetFile.endsWith(".html")) return null;
  if (idsFor(targetFile).has(decodeURIComponent(frag))) return null;
  const item = { file, href, reason: `no #${frag} in target` };
  const api = isUnderApi(siteDir, file) || isUnderApi(siteDir, targetFile);
  return { api, item };
}

function isUnderApi(siteDir, file) {
  return path.relative(siteDir, file).split(path.sep)[0] === "api";
}

function splitFragment(href) {
  const i = href.indexOf("#");
  if (i === -1) return [href, ""];
  return [href.slice(0, i), href.slice(i + 1)];
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
