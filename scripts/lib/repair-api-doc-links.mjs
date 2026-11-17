import fs from "node:fs";
import path from "node:path";

const BLOB = "https://github.com/honua-io/honua-sdk-js/blob/trunk";
const ROOT_FILES = new Set(["LICENSE", "package.json"]);

function isExternal(href) {
  return /^(?:[a-z][a-z0-9+.-]*:|\/\/|#|mailto:|tel:)/i.test(href);
}

function splitFragment(href) {
  const index = href.indexOf("#");
  if (index === -1) return [href, ""];
  return [href.slice(0, index), href.slice(index + 1)];
}

function rootRepoFile(raw) {
  const stripped = raw.replace(/^\.\//, "");
  if (stripped.includes("/")) return null;
  return ROOT_FILES.has(stripped) ? stripped : null;
}

// TypeDoc publishes the README as the API index and leaves repository-root
// files as relative links. The guide builder already sends those to GitHub.
export function repairApiHref(href, { pageDir, siteExists, repoKind }) {
  if (!href || isExternal(href)) return href;
  const [raw, frag] = splitFragment(href);
  if (raw === "") return href;
  const sitePath = path.posix.normalize(path.posix.join(pageDir, raw));
  if (sitePath.startsWith("../") || path.posix.isAbsolute(sitePath)) return href;
  if (siteExists(sitePath)) return href;
  const repo = rootRepoFile(raw);
  if (!repo || repoKind(repo) !== "file") return href;
  const url = `${BLOB}/${repo}`;
  return frag ? `${url}#${frag}` : url;
}

export function repairApiHtml(html, context) {
  return html.replace(/(href|src)="([^"]*)"/g, (match, attr, href) => {
    const next = repairApiHref(href, context);
    return next === href ? match : `${attr}="${next}"`;
  });
}

function walkHtml(dir) {
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walkHtml(full));
    else if (entry.name.endsWith(".html")) files.push(full);
  }
  return files;
}

function contained(root, relPosix) {
  const rel = path.posix.normalize(relPosix);
  if (rel === ".." || rel.startsWith("../") || path.posix.isAbsolute(rel)) return null;
  return path.join(root, ...rel.split("/"));
}

function siteExists(apiRoot, sitePath) {
  const full = contained(apiRoot, sitePath);
  return full !== null && fs.existsSync(full);
}

function repoKind(repoRoot, repoPath) {
  const full = contained(repoRoot, repoPath);
  if (full === null || !fs.existsSync(full)) return null;
  return fs.statSync(full).isDirectory() ? "dir" : "file";
}

export function repairPublishedApiDocs(apiRoot, repoRoot) {
  let changed = 0;
  for (const file of walkHtml(apiRoot)) {
    const rel = path.relative(apiRoot, file).split(path.sep).join("/");
    const pageDir = path.posix.dirname(rel);
    const html = fs.readFileSync(file, "utf8");
    const next = repairApiHtml(html, {
      pageDir: pageDir === "." ? "" : pageDir,
      siteExists: (sitePath) => siteExists(apiRoot, sitePath),
      repoKind: (repoPath) => repoKind(repoRoot, repoPath),
    });
    if (next === html) continue;
    fs.writeFileSync(file, next);
    changed += 1;
  }
  return changed;
}
